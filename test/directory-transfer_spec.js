const assert = require('assert/strict');
const helper = require('node-red-node-test-helper');
const directoryTransferNode = require('../src/directory-transfer.js');
const { FakeShareServiceClient, fakeConfigNode } = require('./helpers/fake-share');
const { trigger, lastStatusText } = require('./helpers/harness');

helper.init(require.resolve('node-red'));

// Characterization of the current azure-directory-transfer behavior (Phase 2.2a).
describe('azure-directory-transfer node', function () {
    let service;
    let share;

    function load(nodeConfig) {
        const flow = [
            { id: 'f1', type: 'tab' },
            { id: 'cfg', type: 'azure-file-config' },
            {
                id: 'n1',
                z: 'f1',
                type: 'azure-directory-transfer',
                config: 'cfg',
                shareName: 'share',
                shareNameType: 'str',
                wires: [['out']],
                ...nodeConfig,
            },
            { id: 'out', z: 'f1', type: 'helper' },
        ];
        return helper.load([fakeConfigNode(service), directoryTransferNode], flow);
    }

    beforeEach(function (done) {
        service = new FakeShareServiceClient();
        share = service.share('share');
        share.addFile('src/a.txt', 'a');
        share.addFile('src/sub/b.txt', 'b');
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(done);
    });

    it('copies a tree recursively and reports counters', async function () {
        await load({ action: 'copy', source: 'src', destination: 'backup/src' });

        const result = await trigger(helper, 'n1', 'out', { payload: 'untouched' });

        assert.equal(share.readFile('backup/src/a.txt'), 'a');
        assert.equal(share.readFile('backup/src/sub/b.txt'), 'b');
        assert.equal(share.readFile('src/a.txt'), 'a');
        assert.deepEqual(result.msg.file.copied, { files: 2, directories: 2 });
        assert.equal(result.msg.file.filetype, 'directory');
        assert.equal(result.msg.file.path, 'backup/src');
        assert.equal(result.msg.payload, 'untouched');
        assert.equal(lastStatusText(result), 'Copied 2 files');
    });

    it('requires recursive for copy', async function () {
        await load({ action: 'copy', source: 'src', destination: 'dst', recursive: false });

        const result = await trigger(helper, 'n1', 'out', {});

        assert.equal(result.err.code, 'RECURSIVE_REQUIRED');
        assert.deepEqual(share.mutations(), []);
    });

    it('moves a directory by rename', async function () {
        await load({ action: 'move', source: 'src', destination: 'moved/src' });

        const result = await trigger(helper, 'n1', 'out', {});

        assert.equal(share.readFile('moved/src/sub/b.txt'), 'b');
        assert.equal(share.dirs.has('src'), false);
        assert.equal(lastStatusText(result), 'Moved src');
    });

    it('legacy: forwards the message unchanged when source equals destination', async function () {
        await load({ action: 'copy', source: 'src', destination: '/src/' });

        const result = await trigger(helper, 'n1', 'out', { file: { keep: 1 } });

        assert.deepEqual(result.msg.file, { keep: 1 });
        assert.deepEqual(share.calls, []);
        assert.equal(lastStatusText(result), 'Source and Destination are identical');
    });

    it('rejects a destination inside the source', async function () {
        await load({ action: 'copy', source: 'src', destination: 'src/inner' });

        const result = await trigger(helper, 'n1', 'out', {});

        assert.equal(result.err.code, 'INVALID_DESTINATION');
        assert.deepEqual(share.mutations(), []);
    });

    it('validates dynamic requests before any storage mutation', async function () {
        await load({ dynamic: true });

        const cases = [
            [{}, 'FILE_MISSING'],
            [{ file: { action: 'delete', source: 'src', destination: 'x' } }, 'INVALID_ACTION'],
            [{ file: { action: 'move', source: 'src' } }, 'INVALID_PATH'],
            [{ file: { action: 'move', source: '..', destination: 'x' } }, 'INVALID_PATH'],
        ];
        for (const [input, code] of cases) {
            const result = await trigger(helper, 'n1', 'out', input);
            assert.equal(result.err && result.err.code, code, JSON.stringify(input));
        }
        assert.deepEqual(share.mutations(), []);
    });

    it('defaults dynamic recursive to false, so dynamic copy needs it explicitly', async function () {
        await load({ dynamic: true });

        const result = await trigger(helper, 'n1', 'out', {
            file: { action: 'copy', source: 'src', destination: 'dst' },
        });

        assert.equal(result.err.code, 'RECURSIVE_REQUIRED');
    });
});
