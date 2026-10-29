const assert = require('assert/strict');
const helper = require('node-red-node-test-helper');
const directoryWatchNode = require('../src/directory-watch.js');
const { FakeShareServiceClient, fakeConfigNode } = require('./helpers/fake-share');
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

    it('legacy: an invalid ignoredFiles regex is reported on every poll, not at construction', async function () {
        await load({ ignoredFiles: '(' });
        await delay(POLL_MS + 150);

        assert.ok(helper.getNode('n1'));
        const errors = errorLogs('n1');
        assert.ok(errors.length >= 2, `expected repeated errors, got ${errors.length}`);
        assert.ok(errors.every((entry) => entry.msg instanceof SyntaxError));
    });

    it('legacy: clamps pollInterval to 250ms and treats stabilityThreshold 0 as 2000ms', async function () {
        await load({ pollInterval: '100', stabilityThreshold: '0', awaitWriteFinish: true });

        const node = helper.getNode('n1');
        assert.equal(node.pollInterval, 250);
        assert.equal(node.stabilityThreshold, 2000);
    });
});
