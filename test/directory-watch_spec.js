const assert = require('assert/strict');
const helper = require('node-red-node-test-helper');
const directoryWatchNode = require('../src/directory-watch.js');
const { FakeShareServiceClient, fakeConfigNode, restError } = require('./helpers/fake-share');
const { collect, delay } = require('./helpers/harness');

helper.init(require.resolve('node-red'));

const POLL_MS = 250;

// Characterization of the current azure-directory-watch behavior (Phase 2.2a).
describe('azure-directory-watch node', function () {
    this.timeout(5000);

    let service;
    let share;

    function load(nodeConfig) {
        const flow = [
            { id: 'f1', type: 'tab' },
            { id: 'cfg', type: 'azure-file-config' },
            {
                id: 'n1',
                z: 'f1',
                type: 'azure-directory-watch',
                config: 'cfg',
                shareName: 'share',
                shareNameType: 'str',
                source: 'watch',
                pollInterval: POLL_MS,
                awaitWriteFinish: false,
                wires: [['out']],
                ...nodeConfig,
            },
            { id: 'out', z: 'f1', type: 'helper' },
        ];
        return helper.load([fakeConfigNode(service), directoryWatchNode], flow);
    }

    function errorLogs(nodeId) {
        return helper
            .log()
            .args.map((args) => args[0])
            .filter((entry) => entry.id === nodeId && entry.level === helper.log().ERROR);
    }

    // Counts sends, statuses and errors a node reports from now on.
    function track(node) {
        const counts = { sends: 0, statuses: 0, errors: 0 };
        node.on('call:send', () => (counts.sends += 1));
        node.on('call:status', () => (counts.statuses += 1));
        node.on('call:error', () => (counts.errors += 1));
        return { snapshot: () => ({ ...counts }) };
    }

    // Lets already-scheduled spy notifications (process.nextTick) arrive.
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    function listCalls() {
        return share.calls.filter((call) => call.method === 'listFilesAndDirectories').length;
    }

    beforeEach(function (done) {
        service = new FakeShareServiceClient();
        share = service.share('share');
        share.addFile('watch/a.txt', 'a');
        share.addDir('watch/dir');
        share.addFile('watch/dir/nested.txt', 'n');
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(done);
    });

    it('emits add for existing files on the initial scan, skipping directories by default', async function () {
        await load({});

        const messages = await collect(helper, 'out', 150);

        assert.equal(messages.length, 1);
        const file = messages[0].file;
        assert.equal(file.action, 'add');
        assert.equal(file.filetype, 'file');
        assert.equal(file.source, 'watch');
        assert.equal(file.path, 'watch/a.txt');
        assert.equal(file.base, 'a.txt');
        assert.equal(file.stats.contentLength, 1);
    });

    it('emits directories and nested files when enabled by filterDirs and depth', async function () {
        await load({ filterDirs: true, depth: 1 });

        const messages = await collect(helper, 'out', 150);

        assert.deepEqual(messages.map((msg) => [msg.file.filetype, msg.file.path]).sort(), [
            ['directory', 'watch/dir'],
            ['file', 'watch/a.txt'],
            ['file', 'watch/dir/nested.txt'],
        ]);
    });

    it('emits add, change and delete between polls after ignoreInitial', async function () {
        await load({ ignoreInitial: true, watchChange: true, watchDelete: true });
        assert.deepEqual(await collect(helper, 'out', 150), []);

        share.addFile('watch/b.txt', 'b');
        const added = await collect(helper, 'out', POLL_MS + 150);
        assert.deepEqual(
            added.map((msg) => [msg.file.action, msg.file.path]),
            [['add', 'watch/b.txt']],
        );

        share.addFile('watch/b.txt', 'bb');
        const changed = await collect(helper, 'out', POLL_MS + 150);
        assert.deepEqual(
            changed.map((msg) => [msg.file.action, msg.file.path]),
            [['change', 'watch/b.txt']],
        );

        share.files.delete('watch/b.txt');
        const deleted = await collect(helper, 'out', POLL_MS + 150);
        assert.equal(deleted.length, 1);
        assert.equal(deleted[0].file.action, 'delete');
        assert.equal(deleted[0].file.stats, null);
    });

    it('ignores names matching ignoredFiles', async function () {
        share.addFile('watch/skip.tmp', 't');
        await load({ ignoredFiles: '\\.tmp$' });

        const messages = await collect(helper, 'out', 150);

        assert.deepEqual(
            messages.map((msg) => msg.file.path),
            ['watch/a.txt'],
        );
    });

    it('stops polling after close', async function () {
        await load({});
        await delay(100);
        helper.unload();
        const callsAtClose = share.calls.length;

        await delay(POLL_MS * 2);

        assert.equal(share.calls.length, callsAtClose);
    });

    it('reports startup configuration errors through node.error with a code', async function () {
        await load({ shareName: '' });
        await delay(50);

        const errors = errorLogs('n1');
        assert.equal(errors.length, 1);
        assert.equal(errors[0].msg.code, 'SHARE_NAME_MISSING');
    });

    it('reports an invalid ignoredFiles regex once at startup and does not poll', async function () {
        await load({ ignoredFiles: '(' });
        await delay(POLL_MS * 2);

        assert.ok(helper.getNode('n1'));
        const errors = errorLogs('n1');
        assert.equal(errors.length, 1);
        assert.ok(errors[0].msg instanceof SyntaxError);
        assert.deepEqual(share.calls, []);
    });

    it('does not send, set status or poll again after close while a scan is in flight', async function () {
        await load({});
        await delay(100);
        const gate = share.gateOnce('listFilesAndDirectories', 'watch');
        share.addFile('watch/new.txt', 'n');
        await gate.reached;
        const counts = track(helper.getNode('n1'));

        await helper.unload();
        await settle();
        const atClose = counts.snapshot();
        const listsAtClose = listCalls();
        gate.release();
        await delay(POLL_MS * 2);

        assert.deepEqual(counts.snapshot(), atClose);
        assert.equal(listCalls(), listsAtClose);
    });

    it('does not send after close while the output write is in flight', async function () {
        await load({ ignoreInitial: true });
        const node = helper.getNode('n1');
        const writeOutput = node.setTypedProperty;
        let release;
        let writeStarted = false;
        const gate = new Promise((resolve) => (release = resolve));
        node.setTypedProperty = async (...args) => {
            writeStarted = true;
            await gate;
            return writeOutput.apply(node, args);
        };
        share.addFile('watch/new.txt', 'n');
        for (let i = 0; i < 100 && !writeStarted; i++) await delay(10);
        assert.equal(writeStarted, true);
        const counts = track(node);

        await helper.unload();
        await settle();
        const atClose = counts.snapshot();
        release();
        await delay(100);

        assert.deepEqual(counts.snapshot(), atClose);
    });

    it('starts no new SDK requests after close when a gated listing resumes', async function () {
        await load({});
        await delay(100);
        const gate = share.gateOnce('listFilesAndDirectories', 'watch');
        share.addFile('watch/n1.txt', '1');
        share.addFile('watch/n2.txt', '2');
        share.addFile('watch/n3.txt', '3');
        await gate.reached;

        await helper.unload();
        await settle();
        const callsAtClose = share.calls.length;
        gate.release();
        await delay(POLL_MS * 2);

        assert.deepEqual(share.calls.slice(callsAtClose), []);
    });

    it('starts no new output writes after close when one write was in flight', async function () {
        await load({ ignoreInitial: true });
        const node = helper.getNode('n1');
        const writeOutput = node.setTypedProperty;
        let release;
        let writes = 0;
        const gate = new Promise((resolve) => (release = resolve));
        node.setTypedProperty = async (...args) => {
            writes += 1;
            if (writes === 1) await gate;
            return writeOutput.apply(node, args);
        };
        share.addFile('watch/n1.txt', '1');
        share.addFile('watch/n2.txt', '2');
        share.addFile('watch/n3.txt', '3');
        for (let i = 0; i < 100 && writes === 0; i++) await delay(10);
        const counts = track(node);

        await helper.unload();
        await settle();
        const atClose = counts.snapshot();
        release();
        await delay(100);

        assert.equal(writes, 1, 'only the write already in flight at close');
        assert.deepEqual(counts.snapshot(), atClose);
    });

    it('fetches no further listing page after close when an item lookup fails with 404', async function () {
        share.pageSize = 1;
        const gate = share.gateOnce('getProperties', 'watch/a.txt');
        await load({});
        await gate.reached;

        await helper.unload();
        await settle();
        const callsAtClose = share.calls.length;
        gate.release(restError(404, 'ResourceNotFound'));
        await delay(POLL_MS * 2);

        assert.deepEqual(share.calls.slice(callsAtClose), []);
    });

    it('fetches no further listing page after close when a recursive scan returns', async function () {
        share.pageSize = 1;
        share.addFile('watch/z.txt', 'z');
        const gate = share.gateOnce('listFilesAndDirectories', 'watch/dir');
        await load({ depth: 1 });
        await gate.reached;

        await helper.unload();
        await settle();
        const callsAtClose = share.calls.length;
        gate.release();
        await delay(POLL_MS * 2);

        assert.deepEqual(share.calls.slice(callsAtClose), []);
    });

    it('stays silent after close when the initial scan is still running', async function () {
        const gate = share.gateOnce('listFilesAndDirectories', 'watch');
        await load({});
        await gate.reached;
        const counts = track(helper.getNode('n1'));

        await helper.unload();
        await settle();
        const atClose = counts.snapshot();
        gate.release();
        await delay(POLL_MS * 2);

        assert.deepEqual(counts.snapshot(), atClose);
        assert.equal(listCalls(), 1);
    });

    it('does not report an error after close when an in-flight scan fails', async function () {
        const gate = share.gateOnce('listFilesAndDirectories', 'watch');
        await load({});
        await gate.reached;
        const counts = track(helper.getNode('n1'));

        await helper.unload();
        await settle();
        const atClose = counts.snapshot();
        gate.release(restError(500, 'InternalError'));
        await delay(POLL_MS * 2);

        assert.deepEqual(counts.snapshot(), atClose);
        assert.equal(listCalls(), 1);
    });

    it('treats an advancing SMB last-write time (fileLastWriteOn) as an unfinished write', async function () {
        await load({ ignoreInitial: true, awaitWriteFinish: true, stabilityThreshold: '600' });
        await delay(100);
        const fixed = { etag: 'fixed', lastModified: new Date(0), contentLength: 10 };
        share.addFile('watch/upload.bin', '0123456789');
        share.setFileProperties('watch/upload.bin', { ...fixed, fileLastWriteOn: new Date() });

        const events = [];
        helper.getNode('out').on('input', (msg) => events.push(msg.file.path));
        for (let i = 0; i < 6; i++) {
            await delay(200);
            share.setFileProperties('watch/upload.bin', { fileLastWriteOn: new Date() });
        }
        assert.deepEqual(events, [], 'no add while the last-write time keeps moving');

        await delay(600 + POLL_MS * 3);
        assert.deepEqual(events, ['watch/upload.bin']);
    });

    it('legacy: clamps pollInterval to 250ms and treats stabilityThreshold 0 as 2000ms', async function () {
        await load({ pollInterval: '100', stabilityThreshold: '0', awaitWriteFinish: true });

        const node = helper.getNode('n1');
        assert.equal(node.pollInterval, 250);
        assert.equal(node.stabilityThreshold, 2000);
    });
});
