const assert = require('assert/strict');
const helper = require('node-red-node-test-helper');
const fileReadNode = require('../src/file-read.js');
const fileWriteNode = require('../src/file-write.js');
const fileTransferNode = require('../src/file-transfer.js');
const directoryActionNode = require('../src/directory-action.js');
const directoryTransferNode = require('../src/directory-transfer.js');
const { FakeShareServiceClient, fakeConfigNode } = require('./helpers/fake-share');
const {
    settle,
    deferred,
    holdCalls,
    holdFirst,
    observe,
    assertQuiet,
    failFirstAbort,
    countAborts,
} = require('./helpers/close');

helper.init(require.resolve('node-red'));

// The Azure Files storage nodes against the in-memory fake share (Phase 2.8e). After close no new
// storage action starts, read-only steps stop at the next boundary, and close aborts the read-only
// call in flight. An action already started stops only between independent steps (faigling's
// "Hybrid" selection): once a file's data steps begin they run to the end, and an action stopped
// after it began changing storage fails with NODE_CLOSING. Close cancels no mutating call.
const NODES = {
    'azure-file-read': {
        module: fileReadNode,
        config: { source: 'in/report.txt', actionRead: true, target: 'file', targetType: 'msg' },
        last: 'downloadToBuffer',
        lastMutates: false,
    },
    'azure-file-write': {
        module: fileWriteNode,
        config: {
            action: 'write',
            target: 'in/new.txt',
            data: 'payload',
            dataType: 'msg',
            createDir: false,
        },
        last: 'uploadData',
        lastMutates: true,
    },
    'azure-file-transfer': {
        module: fileTransferNode,
        config: { action: 'delete', source: 'in/report.txt' },
        last: 'deleteIfExists',
        lastMutates: true,
    },
    'azure-directory-action': {
        module: directoryActionNode,
        config: { action: 'create', source: 'made', recursive: false, property: 'payload' },
        last: 'create',
        lastMutates: true,
    },
    'azure-directory-transfer': {
        module: directoryTransferNode,
        config: { action: 'move', source: 'in', destination: 'moved', recursive: false },
        last: 'rename',
        lastMutates: true,
    },
};

// An action that ended after close once it had changed storage: one error completion, which
// Node-RED reports once as the node's error, and no status or output.
function assertReported(seen, check) {
    assert.equal(seen.completions.length, 1);
    assert.ok(seen.completions[0] instanceof Error);
    check(seen.completions[0]);
    assert.deepEqual(seen.errors, [seen.completions[0]]);
    assert.equal(seen.sends, 0);
    assert.deepEqual(seen.statuses, []);
}

// Stopped at a boundary after close: NODE_CLOSING.
const assertStopped = (seen) =>
    assertReported(seen, (err) => assert.equal(err.code, 'NODE_CLOSING'));

// Ended by a storage call that failed after close: that call's own error.
const assertOwnError = (seen) =>
    assertReported(seen, (err) => assert.equal(err.message, 'storage failed'));

describe('Azure Files storage nodes: close during in-flight work (2.8e)', function () {
    this.timeout(10000);
    let service;
    let share;

    beforeEach(function (done) {
        service = new FakeShareServiceClient();
        share = service.share('share');
        share.addFile('in/report.txt', 'hello azure');
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload().then(() => helper.stopServer(done));
    });

    // Closes the node while the gated call is held, then releases it (or fails it).
    async function closeDuring(gate, n1, outcome) {
        await gate.reached;
        await settle();
        await n1.close();
        const seen = observe(helper, n1);
        gate.release(outcome);
        await settle();
        return seen;
    }

    function closeFailing(gate, n1) {
        return closeDuring(gate, n1, new Error('storage failed'));
    }

    function load(type, nodeConfig = {}) {
        return helper.load(
            [fakeConfigNode(service), NODES[type].module],
            [
                { id: 'cfg', type: 'azure-file-config' },
                {
                    id: 'n1',
                    type,
                    config: 'cfg',
                    shareName: 'share',
                    shareNameType: 'str',
                    ...NODES[type].config,
                    ...nodeConfig,
                    wires: [['out']],
                },
                { id: 'out', type: 'helper' },
            ],
        );
    }

    for (const type of Object.keys(NODES)) {
        const spec = NODES[type];

        describe(type, function () {
            it('closing while its values are read starts no storage call and completes quietly', async function () {
                await load(type);
                const n1 = helper.getNode('n1');
                const reads = holdFirst(n1, 'getValidatedProperty');
                n1.receive({ payload: 'data' });
                await settle();
                assert.equal(reads.length, 1);
                await n1.close();
                const seen = observe(helper, n1);
                await reads[0].release();
                await settle();
                assert.deepEqual(share.calls, []);
                assert.deepEqual(service.requestedShares, []);
                assertQuiet(assert, seen);
            });

            it('a value read rejected after close completes quietly', async function () {
                await load(type);
                const n1 = helper.getNode('n1');
                const reads = holdFirst(n1, 'getValidatedProperty');
                n1.receive({ payload: 'data' });
                await settle();
                await n1.close();
                const seen = observe(helper, n1);
                reads[0].reject(new Error('context store failed'));
                await settle();
                assertQuiet(assert, seen);
            });

            it('a final storage call that succeeds after close is not reported', async function () {
                await load(type);
                const n1 = helper.getNode('n1');
                const gate = share.gateOnce(spec.last);
                n1.receive({ payload: 'data' });
                const seen = await closeDuring(gate, n1);
                assertQuiet(assert, seen);
            });

            // A mutating call that fails may still have changed storage, so it is reported.
            it(`a final storage call that fails after close ${spec.lastMutates ? 'reports its own error' : 'is not reported'}`, async function () {
                await load(type);
                const n1 = helper.getNode('n1');
                const gate = share.gateOnce(spec.last);
                n1.receive({ payload: 'data' });
                const seen = await closeFailing(gate, n1);
                if (spec.lastMutates) assertOwnError(seen);
                else assertQuiet(assert, seen);
            });

            it('concurrent inputs held at their first read all complete quietly after close', async function () {
                await load(type);
                const n1 = helper.getNode('n1');
                const reads = holdCalls(n1, 'getValidatedProperty');
                n1.receive({ payload: 'a' });
                n1.receive({ payload: 'b' });
                await settle();
                assert.equal(reads.length, 2);
                await n1.close();
                const seen = observe(helper, n1);
                reads.forEach((read) => read.reject(new Error('context store failed')));
                await settle();
                assert.deepEqual(share.calls, []);
                assertQuiet(assert, seen, 2);
            });

            // Control: passes before and after the change.
            it('an action that completes before close is sent', async function () {
                await load(type);
                const n1 = helper.getNode('n1');
                const seen = observe(helper, n1);
                n1.receive({ payload: 'data' });
                await settle();
                assert.equal(seen.sends, 1);
                assert.deepEqual(seen.completions, [undefined]);
            });
        });
    }

    describe('azure-file-read read-only steps', function () {
        it('a stat that settles at close downloads nothing', async function () {
            await load('azure-file-read', { actionStat: true });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('getProperties');
            n1.receive({});
            await gate.reached;
            await settle();
            gate.release();
            const closed = n1.close();
            const seen = observe(helper, n1);
            await closed;
            await settle();
            assert.equal(
                share.attempts.some((call) => call.method === 'downloadToBuffer'),
                false,
            );
            assertQuiet(assert, seen);
        });

        it('an existence check that settles at close reports nothing', async function () {
            await load('azure-file-read', { actionRead: false, actionExists: true });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('exists');
            n1.receive({});
            await gate.reached;
            await settle();
            gate.release();
            const closed = n1.close();
            const seen = observe(helper, n1);
            await closed;
            await settle();
            assertQuiet(assert, seen);
        });

        it('closing while the target is read starts no target write', async function () {
            await load('azure-file-read');
            const n1 = helper.getNode('n1');
            // Hold only the read of the output target (msg.file); other reads go through.
            const targetReads = [];
            const read = n1.getTypedProperty.bind(n1);
            n1.getTypedProperty = (value, type, msg) => {
                if (value !== 'file' || type !== 'msg') return read(value, type, msg);
                const call = deferred();
                targetReads.push(call);
                return call.promise;
            };
            const writes = holdCalls(n1, 'setTypedProperty');
            n1.receive({});
            await settle();
            assert.equal(targetReads.length, 1);
            await n1.close();
            const seen = observe(helper, n1);
            targetReads[0].resolve({});
            await settle();
            assert.equal(writes.length, 0);
            assertQuiet(assert, seen);
        });

        for (const outcome of ['resolves', 'rejects']) {
            it(`a target write that ${outcome} after close reports nothing`, async function () {
                await load('azure-file-read');
                const n1 = helper.getNode('n1');
                const writes = holdCalls(n1, 'setTypedProperty');
                n1.receive({});
                await settle();
                assert.equal(writes.length, 1);
                await n1.close();
                const seen = observe(helper, n1);
                if (outcome === 'resolves') writes[0].resolve();
                else writes[0].reject(new Error('context store failed'));
                await settle();
                assertQuiet(assert, seen);
            });
        }
    });

    describe('started actions stop only between independent steps', function () {
        it('an append stops before resizing; a directory that already existed is no change', async function () {
            share.addFile('out/log.txt', 'old');
            await load('azure-file-write', {
                action: 'append',
                target: 'out/log.txt',
                createDir: true,
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('getProperties');
            n1.receive({ payload: '+new' });
            const seen = await closeDuring(gate, n1);
            assert.equal(share.readFile('out/log.txt'), 'old');
            assert.deepEqual(
                share.mutations().map(({ method, path }) => ({ method, path })),
                [{ method: 'createIfNotExists', path: 'out' }],
            );
            assertQuiet(assert, seen);
        });

        it('a write stops after creating its directory, before uploading', async function () {
            await load('azure-file-write', { target: 'out/new.txt', createDir: true });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('createIfNotExists', 'out');
            n1.receive({ payload: 'data' });
            const seen = await closeDuring(gate, n1);
            assert.equal(share.dirs.has('out'), true);
            assert.equal(share.files.has('out/new.txt'), false);
            assertStopped(seen);
        });

        it('an append that has changed nothing stops quietly after its existence check', async function () {
            share.addFile('out/log.txt', 'old');
            await load('azure-file-write', {
                action: 'append',
                target: 'out/log.txt',
                createDir: false,
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('exists');
            n1.receive({ payload: '+new' });
            const seen = await closeDuring(gate, n1);
            assert.equal(share.readFile('out/log.txt'), 'old');
            assert.deepEqual(share.mutations(), []);
            assert.equal(
                share.attempts.some((call) => call.method === 'getProperties'),
                false,
            );
            assertQuiet(assert, seen);
        });

        it('a write stops between directory levels and writes no file', async function () {
            await load('azure-file-write', { target: 'out/a/new.txt', createDir: true });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('createIfNotExists', 'out');
            n1.receive({ payload: 'data' });
            const seen = await closeDuring(gate, n1);
            assert.equal(share.dirs.has('out/a'), false);
            assert.equal(share.files.has('out/a/new.txt'), false);
            assertStopped(seen);
        });

        it('a copy stops before creating the destination and reports nothing', async function () {
            await load('azure-file-transfer', {
                action: 'copy',
                destination: 'in/copy.txt',
                createDir: false,
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('getProperties');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(share.files.has('in/copy.txt'), false);
            assertQuiet(assert, seen);
        });

        it('a move stops between directory levels and keeps the source', async function () {
            await load('azure-file-transfer', {
                action: 'move',
                destination: 'moved/sub/report.txt',
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('createIfNotExists', 'moved');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(share.readFile('in/report.txt'), 'hello azure');
            assert.equal(share.files.has('moved/sub/report.txt'), false);
            assertStopped(seen);
        });

        it('a move stops after creating its directory, before renaming', async function () {
            await load('azure-file-transfer', { action: 'move', destination: 'moved/report.txt' });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('createIfNotExists', 'moved');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(share.readFile('in/report.txt'), 'hello azure');
            assert.equal(share.files.has('moved/report.txt'), false);
            assertStopped(seen);
        });

        it('a move whose first directory level already existed has changed nothing and stops quietly', async function () {
            await load('azure-file-transfer', { action: 'move', destination: 'in/sub/report.txt' });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('createIfNotExists', 'in');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(share.readFile('in/report.txt'), 'hello azure');
            assert.equal(share.dirs.has('in/sub'), false);
            assertQuiet(assert, seen);
        });

        it('a recursive delete whose subdirectory was already gone has changed nothing and stops quietly', async function () {
            share.addDir('dir/s1');
            share.addDir('dir/s2');
            await load('azure-directory-action', {
                action: 'delete',
                source: 'dir',
                recursive: true,
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('deleteIfExists', 'dir/s1');
            n1.receive({});
            await gate.reached;
            // Someone else removes the subdirectory while its delete is held.
            share.dirs.delete('dir/s1');
            const seen = await closeDuring(gate, n1);
            assert.equal(share.dirs.has('dir/s2'), true);
            assertQuiet(assert, seen);
        });

        it('a recursive create stops between directory levels', async function () {
            await load('azure-directory-action', { source: 'a/b/c', recursive: true });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('createIfNotExists', 'a');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(share.dirs.has('a'), true);
            assert.equal(share.dirs.has('a/b'), false);
            assertStopped(seen);
        });

        it('a recursive delete stops after the file being deleted, before the next page', async function () {
            share.addFile('dir/a.txt', 'a').addFile('dir/b.txt', 'b');
            share.pageSize = 1;
            await load('azure-directory-action', {
                action: 'delete',
                source: 'dir',
                recursive: true,
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('deleteIfExists', 'dir/a.txt');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(share.files.has('dir/a.txt'), false);
            assert.equal(share.files.has('dir/b.txt'), true);
            assert.equal(share.dirs.has('dir'), true);
            assert.equal(
                share.calls.some((call) => call.method === 'listFilesAndDirectories:page'),
                false,
            );
            assertStopped(seen);
        });

        it('a recursive delete whose next page arrives at close deletes no further item', async function () {
            share.addFile('dir/a.txt', 'a').addFile('dir/b.txt', 'b');
            share.pageSize = 1;
            await load('azure-directory-action', {
                action: 'delete',
                source: 'dir',
                recursive: true,
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('listFilesAndDirectories:page');
            n1.receive({});
            await gate.reached;
            await settle();
            gate.release();
            const closed = n1.close();
            const seen = observe(helper, n1);
            await closed;
            await settle();
            assert.equal(share.files.has('dir/a.txt'), false);
            assert.equal(share.files.has('dir/b.txt'), true);
            assertStopped(seen);
        });

        it('a recursive delete stops after removing a subdirectory, before the next item', async function () {
            share.addDir('dir/s1');
            share.addDir('dir/s2');
            await load('azure-directory-action', {
                action: 'delete',
                source: 'dir',
                recursive: true,
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('deleteIfExists', 'dir/s1');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(share.dirs.has('dir/s1'), false);
            assert.equal(share.dirs.has('dir/s2'), true);
            assertStopped(seen);
        });

        it('a recursive delete stops before a subdirectory listed after its files', async function () {
            share.addFile('dir/a.txt', 'a').addFile('dir/s/x.txt', 'x');
            await load('azure-directory-action', {
                action: 'delete',
                source: 'dir',
                recursive: true,
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('deleteIfExists', 'dir/a.txt');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(share.files.has('dir/s/x.txt'), true);
            assert.equal(
                share.attempts.some((call) => call.path === 'dir/s'),
                false,
            );
            assertStopped(seen);
        });

        it('a recursive delete whose first page is empty stops before requesting the next', async function () {
            share.addFile('dir/a.txt', 'a');
            share.emptyFirstPage = true;
            await load('azure-directory-action', {
                action: 'delete',
                source: 'dir',
                recursive: true,
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('listFilesAndDirectories', 'dir');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(share.files.has('dir/a.txt'), true);
            assert.equal(
                share.attempts.some((call) => call.method === 'listFilesAndDirectories:page'),
                false,
            );
            assertQuiet(assert, seen);
        });

        it('a recursive delete whose file was already gone has changed nothing and stops quietly', async function () {
            share.addFile('dir/a.txt', 'a').addFile('dir/b.txt', 'b');
            await load('azure-directory-action', {
                action: 'delete',
                source: 'dir',
                recursive: true,
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('deleteIfExists', 'dir/a.txt');
            n1.receive({});
            await gate.reached;
            // Someone else removes the file while the delete is held.
            share.files.delete('dir/a.txt');
            const seen = await closeDuring(gate, n1);
            assert.equal(share.files.has('dir/b.txt'), true);
            assertQuiet(assert, seen);
        });

        it('a recursive create that finishes at close completes quietly', async function () {
            await load('azure-directory-action', { source: 'a/b', recursive: true });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('createIfNotExists', 'a/b');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(share.dirs.has('a/b'), true);
            assertQuiet(assert, seen);
        });

        it('a recursive create whose levels so far already existed stops quietly', async function () {
            share.addDir('a');
            await load('azure-directory-action', { source: 'a/b/c', recursive: true });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('createIfNotExists', 'a');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(share.dirs.has('a/b'), false);
            assertQuiet(assert, seen);
        });

        it('a recursive delete stops before deleting the directory itself once its items are gone', async function () {
            share.addFile('dir/a.txt', 'a');
            await load('azure-directory-action', {
                action: 'delete',
                source: 'dir',
                recursive: true,
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('deleteIfExists', 'dir/a.txt');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(share.files.has('dir/a.txt'), false);
            assert.equal(share.dirs.has('dir'), true);
            assertStopped(seen);
        });

        it('a recursive delete of an empty directory listed at close deletes nothing and reports nothing', async function () {
            share.addDir('empty');
            await load('azure-directory-action', {
                action: 'delete',
                source: 'empty',
                recursive: true,
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('listFilesAndDirectories', 'empty');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(share.dirs.has('empty'), true);
            assertQuiet(assert, seen);
        });

        it('a directory copy finishes the file it started, then copies no further file', async function () {
            share.addFile('in/second.txt', 'second');
            await load('azure-directory-transfer', {
                action: 'copy',
                destination: 'copied',
                recursive: true,
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('create', 'copied/report.txt');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(share.readFile('copied/report.txt'), 'hello azure');
            assert.equal(share.files.has('copied/second.txt'), false);
            assert.equal(
                share.attempts.some((call) => call.path === 'in/second.txt'),
                false,
            );
            assertStopped(seen);
        });

        it('a directory copy stops before creating a file whose source is stat-ed at close', async function () {
            await load('azure-directory-transfer', {
                action: 'copy',
                destination: 'copied',
                recursive: true,
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('getProperties', 'in/report.txt');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(share.dirs.has('copied'), true);
            assert.equal(share.files.has('copied/report.txt'), false);
            assertStopped(seen);
        });

        it('a directory copy whose last file finishes at close completes quietly', async function () {
            await load('azure-directory-transfer', {
                action: 'copy',
                destination: 'copied',
                recursive: true,
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('create', 'copied/report.txt');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(share.readFile('copied/report.txt'), 'hello azure');
            assertQuiet(assert, seen);
        });

        it('a directory move stops between directory levels and renames nothing', async function () {
            await load('azure-directory-transfer', {
                action: 'move',
                destination: 'x/y/moved',
                recursive: true,
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('createIfNotExists', 'x');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(share.dirs.has('in'), true);
            assert.equal(share.dirs.has('x/y'), false);
            assertStopped(seen);
        });
    });

    describe('azure-directory-transfer copy boundaries', function () {
        const COPY = { action: 'copy', destination: 'copied', recursive: true };

        it('a listing that arrives at close copies no file', async function () {
            await load('azure-directory-transfer', COPY);
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('listFilesAndDirectories', 'in');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(share.dirs.has('copied'), true);
            assert.equal(share.files.has('copied/report.txt'), false);
            assertStopped(seen);
        });

        it('a copy stops before listing when close comes while the destination is created', async function () {
            await load('azure-directory-transfer', COPY);
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('createIfNotExists', 'copied');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(
                share.attempts.some((call) => call.method === 'listFilesAndDirectories'),
                false,
            );
            assertStopped(seen);
        });

        it('a copy into a destination that already existed has changed nothing and stops quietly', async function () {
            share.addDir('copied');
            await load('azure-directory-transfer', COPY);
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('createIfNotExists', 'copied');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(share.files.has('copied/report.txt'), false);
            assertQuiet(assert, seen);
        });

        it('a copy stops before a subdirectory listed after its files', async function () {
            share.addFile('in/sub/x.txt', 'x');
            await load('azure-directory-transfer', COPY);
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('create', 'copied/report.txt');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(share.readFile('copied/report.txt'), 'hello azure');
            assert.equal(share.dirs.has('copied/sub'), false);
            assertStopped(seen);
        });

        it('a copy stops before requesting another page', async function () {
            share.addFile('in/second.txt', 'second');
            share.pageSize = 1;
            await load('azure-directory-transfer', COPY);
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('create', 'copied/report.txt');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(
                share.attempts.some((call) => call.method === 'listFilesAndDirectories:page'),
                false,
            );
            assertStopped(seen);
        });

        it('a copy whose destination parent already existed has changed nothing and stops quietly', async function () {
            share.addDir('p');
            await load('azure-directory-transfer', { ...COPY, destination: 'p/copied' });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('createIfNotExists', 'p');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(share.dirs.has('p/copied'), false);
            assertQuiet(assert, seen);
        });

        it('a copy stops after creating the destination parent', async function () {
            await load('azure-directory-transfer', { ...COPY, destination: 'p/copied' });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('createIfNotExists', 'p');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(share.dirs.has('p/copied'), false);
            assertStopped(seen);
        });

        it('a move stops after creating the destination parent, before renaming', async function () {
            await load('azure-directory-transfer', {
                action: 'move',
                destination: 'x/moved',
                recursive: true,
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('createIfNotExists', 'x');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(share.dirs.has('in'), true);
            assert.equal(share.dirs.has('x/moved'), false);
            assertStopped(seen);
        });
    });

    describe('a storage call that fails after close', function () {
        it('reports its own error once the write created a directory', async function () {
            await load('azure-file-write', { target: 'out/new.txt', createDir: true });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('uploadData');
            n1.receive({ payload: 'data' });
            const seen = await closeFailing(gate, n1);
            assertOwnError(seen);
        });

        it('reports its own error once the append resized the file', async function () {
            share.addFile('out/log.txt', 'old');
            await load('azure-file-write', { action: 'append', target: 'out/log.txt' });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('uploadRange');
            n1.receive({ payload: '+new' });
            const seen = await closeFailing(gate, n1);
            assertOwnError(seen);
        });

        it('reports its own error once the copy created its destination', async function () {
            await load('azure-file-transfer', {
                action: 'copy',
                destination: 'in/copy.txt',
                createDir: false,
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('uploadRange', 'in/copy.txt');
            n1.receive({});
            const seen = await closeFailing(gate, n1);
            assertOwnError(seen);
        });

        it('reports its own error once the move created a directory', async function () {
            await load('azure-file-transfer', { action: 'move', destination: 'moved/report.txt' });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('rename');
            n1.receive({});
            const seen = await closeFailing(gate, n1);
            assertOwnError(seen);
        });

        it('reports its own error once the recursive create made a level', async function () {
            await load('azure-directory-action', { source: 'a/b', recursive: true });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('createIfNotExists', 'a/b');
            n1.receive({});
            const seen = await closeFailing(gate, n1);
            assertOwnError(seen);
        });

        it('reports its own error once the recursive delete removed a file', async function () {
            share.addFile('dir/a.txt', 'a').addFile('dir/b.txt', 'b');
            await load('azure-directory-action', {
                action: 'delete',
                source: 'dir',
                recursive: true,
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('deleteIfExists', 'dir/b.txt');
            n1.receive({});
            const seen = await closeFailing(gate, n1);
            assertOwnError(seen);
        });

        it('reports its own error once the directory copy created its destination', async function () {
            await load('azure-directory-transfer', {
                action: 'copy',
                destination: 'copied',
                recursive: true,
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('getProperties', 'in/report.txt');
            n1.receive({});
            const seen = await closeFailing(gate, n1);
            assertOwnError(seen);
        });

        it('reports its own error when the first create of a directory copy fails', async function () {
            await load('azure-directory-transfer', {
                action: 'copy',
                destination: 'copied',
                recursive: true,
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('createIfNotExists', 'copied');
            n1.receive({});
            const seen = await closeFailing(gate, n1);
            assertOwnError(seen);
        });

        it('reports its own error when a range copy fails after the file was created', async function () {
            share.addDir('copied');
            await load('azure-directory-transfer', {
                action: 'copy',
                destination: 'copied',
                recursive: true,
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('uploadRange', 'copied/report.txt');
            n1.receive({});
            const seen = await closeFailing(gate, n1);
            assertOwnError(seen);
        });

        it('stays quiet when a read fails before anything changed', async function () {
            share.addDir('copied');
            await load('azure-directory-transfer', {
                action: 'copy',
                destination: 'copied',
                recursive: true,
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('getProperties', 'in/report.txt');
            n1.receive({});
            const seen = await closeFailing(gate, n1);
            assertQuiet(assert, seen);
        });

        it('stays quiet when the existence check of an append fails', async function () {
            share.addFile('out/log.txt', 'old');
            await load('azure-file-write', { action: 'append', target: 'out/log.txt' });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('exists');
            n1.receive({ payload: '+new' });
            const seen = await closeFailing(gate, n1);
            assertQuiet(assert, seen);
        });

        // A mutating call that fails after close may have changed storage, even as the action's
        // first change.
        const FIRST_CHANGE = [
            {
                what: "an append's resize",
                type: 'azure-file-write',
                config: { action: 'append', target: 'out/log.txt' },
                setup: () => share.addFile('out/log.txt', 'old'),
                gate: ['resize'],
            },
            {
                what: "an append's upload of a new file",
                type: 'azure-file-write',
                config: { action: 'append', target: 'out/log.txt' },
                setup: () => share.addDir('out'),
                gate: ['uploadData'],
            },
            {
                what: "a write's first directory level",
                type: 'azure-file-write',
                config: { target: 'out/new.txt', createDir: true },
                gate: ['createIfNotExists', 'out'],
            },
            {
                what: "a copy's create",
                type: 'azure-file-transfer',
                config: { action: 'copy', destination: 'in/copy.txt', createDir: false },
                gate: ['create', 'in/copy.txt'],
            },
            {
                what: "a move's rename",
                type: 'azure-file-transfer',
                config: { action: 'move', destination: 'in/moved.txt', createDir: false },
                gate: ['rename'],
            },
            {
                what: "a move's first directory level",
                type: 'azure-file-transfer',
                config: { action: 'move', destination: 'moved/report.txt' },
                gate: ['createIfNotExists', 'moved'],
            },
            {
                what: 'a non-recursive delete',
                type: 'azure-directory-action',
                config: { action: 'delete', source: 'empty', recursive: false },
                setup: () => share.addDir('empty'),
                gate: ['deleteIfExists', 'empty'],
            },
            {
                what: "a recursive create's first level",
                type: 'azure-directory-action',
                config: { source: 'a/b', recursive: true },
                gate: ['createIfNotExists', 'a'],
            },
            {
                what: "a recursive delete's first file",
                type: 'azure-directory-action',
                config: { action: 'delete', source: 'dir', recursive: true },
                setup: () => share.addFile('dir/a.txt', 'a'),
                gate: ['deleteIfExists', 'dir/a.txt'],
            },
            {
                what: "a recursive delete's own directory",
                type: 'azure-directory-action',
                config: { action: 'delete', source: 'empty', recursive: true },
                setup: () => share.addDir('empty'),
                gate: ['deleteIfExists', 'empty'],
            },
            {
                what: "a directory copy's destination parent",
                type: 'azure-directory-transfer',
                config: { action: 'copy', destination: 'p/copied', recursive: true },
                gate: ['createIfNotExists', 'p'],
            },
            {
                what: "a directory copy's file create",
                type: 'azure-directory-transfer',
                config: { action: 'copy', destination: 'copied', recursive: true },
                setup: () => share.addDir('copied'),
                gate: ['create', 'copied/report.txt'],
            },
        ];
        for (const first of FIRST_CHANGE) {
            it(`reports its own error when ${first.what} fails`, async function () {
                if (first.setup) first.setup();
                await load(first.type, first.config);
                const n1 = helper.getNode('n1');
                const gate = share.gateOnce(...first.gate);
                n1.receive({ payload: 'data' });
                const seen = await closeFailing(gate, n1);
                assertOwnError(seen);
            });
        }

        it('stays quiet for an output write after a finished recursive create', async function () {
            await load('azure-directory-action', { source: 'a/b', recursive: true });
            const n1 = helper.getNode('n1');
            const writes = holdCalls(n1, 'setTypedProperty');
            n1.receive({});
            await settle();
            assert.equal(writes.length, 1);
            await n1.close();
            const seen = observe(helper, n1);
            writes[0].reject(new Error('context store failed'));
            await settle();
            assertQuiet(assert, seen);
        });
    });

    describe('a file whose data steps began finishes them', function () {
        it('a copy that created its destination at close copies all its data, then reports nothing', async function () {
            await load('azure-file-transfer', {
                action: 'copy',
                destination: 'in/copy.txt',
                createDir: false,
            });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('create', 'in/copy.txt');
            n1.receive({});
            const seen = await closeDuring(gate, n1);
            assert.equal(share.readFile('in/copy.txt'), 'hello azure');
            assertQuiet(assert, seen);
        });

        it('an append under way at close still writes all its data, then reports nothing', async function () {
            share.addFile('out/log.txt', 'old');
            await load('azure-file-write', { action: 'append', target: 'out/log.txt' });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('resize');
            n1.receive({ payload: '+new' });
            await gate.reached;
            await settle();
            await n1.close();
            const seen = observe(helper, n1);
            gate.release();
            await settle();
            assert.equal(share.readFile('out/log.txt'), 'old+new');
            assertQuiet(assert, seen);
        });
    });

    describe('azure-directory-action output', function () {
        it('closing while the directory is created writes no output', async function () {
            await load('azure-directory-action');
            const n1 = helper.getNode('n1');
            const writes = holdCalls(n1, 'setTypedProperty');
            const gate = share.gateOnce('create');
            n1.receive({});
            await gate.reached;
            await settle();
            await n1.close();
            const seen = observe(helper, n1);
            gate.release();
            await settle();
            assert.equal(writes.length, 0);
            assertQuiet(assert, seen);
        });

        for (const outcome of ['resolves', 'rejects']) {
            it(`an output write that ${outcome} after close reports nothing`, async function () {
                await load('azure-directory-action');
                const n1 = helper.getNode('n1');
                const writes = holdCalls(n1, 'setTypedProperty');
                n1.receive({});
                await settle();
                assert.equal(writes.length, 1);
                await n1.close();
                const seen = observe(helper, n1);
                if (outcome === 'resolves') writes[0].resolve();
                else writes[0].reject(new Error('context store failed'));
                await settle();
                assertQuiet(assert, seen);
            });
        }
    });

    // file-read's download, stat and existence check, and directory-action's listing.
    const READS = [
        { type: 'azure-file-read', method: 'downloadToBuffer', config: {} },
        {
            type: 'azure-file-read',
            method: 'getProperties',
            config: { actionRead: false, actionStat: true },
        },
        {
            type: 'azure-file-read',
            method: 'exists',
            config: { actionRead: false, actionExists: true },
        },
        {
            type: 'azure-directory-action',
            method: 'listFilesAndDirectories',
            config: { action: 'list', source: 'in' },
        },
    ];

    describe('read-only calls are aborted at close', function () {
        for (const read of READS) {
            describe(`${read.type} ${read.method}`, function () {
                // Whether the abortSignal of each call was aborted, in call order.
                const aborted = () =>
                    share.signals
                        .filter((entry) => entry.method === read.method)
                        .map((entry) => entry.signal?.aborted);

                it('close aborts the call in flight and completes quietly', async function () {
                    await load(read.type, read.config);
                    const n1 = helper.getNode('n1');
                    // The gate is never released: only the abort can end the call.
                    const gate = share.gateOnce(read.method);
                    n1.receive({});
                    await gate.reached;
                    await settle();
                    const seen = observe(helper, n1);
                    await n1.close();
                    await settle();
                    assert.deepEqual(aborted(), [true]);
                    assertQuiet(assert, seen);
                });

                // Control: passes before and after the change.
                it('a call that finished before close is not aborted at close', async function () {
                    await load(read.type, read.config);
                    const n1 = helper.getNode('n1');
                    const seen = observe(helper, n1);
                    n1.receive({});
                    await settle();
                    assert.equal(seen.sends, 1);
                    assert.equal(await countAborts(() => n1.close()), 0);
                });

                it('two calls in flight are both aborted at close, even if one abort throws', async function () {
                    await load(read.type, read.config);
                    const n1 = helper.getNode('n1');
                    const warnings = [];
                    n1.on('call:warn', (call) => warnings.push(call.args[0]));
                    const gates = [share.gateOnce(read.method), share.gateOnce(read.method)];
                    n1.receive({});
                    n1.receive({});
                    await Promise.all(gates.map((gate) => gate.reached));
                    await settle();
                    const seen = observe(helper, n1);
                    const restore = failFirstAbort();
                    try {
                        await n1.close();
                    } finally {
                        restore();
                    }
                    // The first abort threw, so one call is still open; let it finish after close.
                    gates.forEach((gate) => gate.release());
                    await settle();
                    assert.deepEqual(aborted().sort(), [false, true]);
                    assert.equal(warnings.length, 1);
                    assertQuiet(assert, seen, 2);
                });
            });
        }
    });

    describe('fake share', function () {
        it('a read with an aborted signal fails with an AbortError at once and sends nothing', async function () {
            const controller = new AbortController();
            controller.abort();
            const exists = share.rootDirectoryClient
                .getDirectoryClient('in')
                .getFileClient('report.txt')
                .exists({ abortSignal: controller.signal });
            await assert.rejects(exists, { name: 'AbortError' });
            assert.deepEqual(share.calls, []);
        });

        it('a held read fails with an AbortError when its signal aborts', async function () {
            const controller = new AbortController();
            const gate = share.gateOnce('downloadToBuffer');
            const download = share.rootDirectoryClient
                .getDirectoryClient('in')
                .getFileClient('report.txt')
                .downloadToBuffer(0, undefined, { abortSignal: controller.signal });
            await gate.reached;
            controller.abort();
            await assert.rejects(download, { name: 'AbortError' });
        });
    });

    describe('azure-directory-action listing', function () {
        it('an empty first page arriving at close requests no further page', async function () {
            share.addFile('dir/a.txt', 'a');
            share.emptyFirstPage = true;
            await load('azure-directory-action', { action: 'list', source: 'dir' });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('listFilesAndDirectories', 'dir');
            n1.receive({});
            await gate.reached;
            await settle();
            gate.release();
            const closed = n1.close();
            const seen = observe(helper, n1);
            await closed;
            await settle();
            assert.equal(
                share.attempts.some((call) => call.method === 'listFilesAndDirectories:page'),
                false,
            );
            assertQuiet(assert, seen);
        });

        it('a page that arrives after a failed abort requests no further page', async function () {
            share.addFile('dir/a.txt', 'a');
            share.emptyFirstPage = true;
            await load('azure-directory-action', { action: 'list', source: 'dir' });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('listFilesAndDirectories', 'dir');
            n1.receive({});
            await gate.reached;
            await settle();
            const restore = failFirstAbort();
            try {
                await n1.close();
            } finally {
                restore();
            }
            const seen = observe(helper, n1);
            gate.release();
            await settle();
            assert.equal(
                share.attempts.some((call) => call.method === 'listFilesAndDirectories:page'),
                false,
            );
            assertQuiet(assert, seen);
        });

        it('a page that arrives at close fetches no further page', async function () {
            // One item per page: the first page, then page 2 (arriving at close), then page 3.
            share.addFile('dir/a.txt', 'a').addFile('dir/b.txt', 'b').addFile('dir/c.txt', 'c');
            share.pageSize = 1;
            await load('azure-directory-action', { action: 'list', source: 'dir' });
            const n1 = helper.getNode('n1');
            const gate = share.gateOnce('listFilesAndDirectories:page');
            n1.receive({});
            await gate.reached;
            await settle();
            gate.release();
            const closed = n1.close();
            const seen = observe(helper, n1);
            await closed;
            await settle();
            assert.equal(
                share.attempts.filter((call) => call.method === 'listFilesAndDirectories:page')
                    .length,
                1,
            );
            assertQuiet(assert, seen);
        });
    });
});
