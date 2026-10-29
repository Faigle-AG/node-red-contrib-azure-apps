const assert = require('assert/strict');
const helper = require('node-red-node-test-helper');
const fileTransferNode = require('../src/file-transfer.js');
const { FakeShareServiceClient, fakeConfigNode, restError } = require('./helpers/fake-share');
const { trigger, lastStatusText } = require('./helpers/harness');

helper.init(require.resolve('node-red'));

// Characterization of the current azure-file-transfer behavior (Phase 2.2a).
describe('azure-file-transfer node', function () {
    let service;
    let share;

    function load(nodeConfig) {
        const flow = [
            { id: 'f1', type: 'tab' },
            { id: 'cfg', type: 'azure-file-config' },
            {
                id: 'n1',
                z: 'f1',
                type: 'azure-file-transfer',
                config: 'cfg',
                shareName: 'share',
                shareNameType: 'str',
                wires: [['out']],
                ...nodeConfig,
            },
            { id: 'out', z: 'f1', type: 'helper' },
        ];
        return helper.load([fakeConfigNode(service), fileTransferNode], flow);
    }

    beforeEach(function (done) {
        service = new FakeShareServiceClient();
        share = service.share('share');
        share.addFile('in/report.txt', 'payload-bytes', { contentType: 'text/plain' });
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(done);
    });

    it('copies a file with its content type and keeps the source', async function () {
        await load({ action: 'copy', source: 'in/report.txt', destination: 'archive/report.txt' });

        const result = await trigger(helper, 'n1', 'out', { payload: 'untouched' });

        assert.equal(share.readFile('archive/report.txt'), 'payload-bytes');
        assert.equal(share.files.get('archive/report.txt').contentType, 'text/plain');
        assert.equal(share.readFile('in/report.txt'), 'payload-bytes');
        assert.equal(result.msg.payload, 'untouched');
        assert.equal(result.msg.file.action, 'copy');
        assert.equal(result.msg.file.source, 'in/report.txt');
        assert.equal(result.msg.file.destination, 'archive/report.txt');
        assert.equal(result.msg.file.path, 'archive/report.txt');
        assert.equal(lastStatusText(result), 'Copied report.txt');
    });

    it('moves a file by rename', async function () {
        await load({ action: 'move', source: 'in/report.txt', destination: 'done/report.txt' });

        const result = await trigger(helper, 'n1', 'out', {});

        assert.equal(share.readFile('done/report.txt'), 'payload-bytes');
        assert.equal(share.files.has('in/report.txt'), false);
        assert.equal(lastStatusText(result), 'Moved report.txt');
    });

    it('deletes a file and reports deleted=true without touching msg.payload', async function () {
        await load({ action: 'delete', source: 'in/report.txt' });

        const result = await trigger(helper, 'n1', 'out', { payload: 'untouched' });

        assert.equal(share.files.has('in/report.txt'), false);
        assert.equal(result.msg.file.deleted, true);
        assert.equal(result.msg.file.destination, null);
        assert.equal(result.msg.file.path, 'in/report.txt');
        assert.equal(result.msg.payload, 'untouched');
        assert.equal(lastStatusText(result), 'Deleted report.txt');
    });

    it('succeeds with deleted=false when deleting a missing file', async function () {
        await load({ action: 'delete', source: 'in/missing.txt' });

        const result = await trigger(helper, 'n1', 'out', {});

        assert.equal(result.msg.file.deleted, false);
        assert.equal(lastStatusText(result), 'Not found missing.txt');
    });

    it('returns metadata without storage I/O when source equals destination', async function () {
        await load({ action: 'copy', source: 'in/report.txt', destination: '/in//report.txt' });

        const result = await trigger(helper, 'n1', 'out', {});

        assert.equal(result.msg.file.path, 'in/report.txt');
        assert.equal(result.msg.file.action, 'copy');
        assert.deepEqual(share.calls, []);
        assert.equal(lastStatusText(result), 'Source and Destination are identical');
    });

    it('fails with the SDK code when copying a missing source and creates nothing', async function () {
        await load({ action: 'copy', source: 'in/missing.txt', destination: 'x/missing.txt' });

        const result = await trigger(helper, 'n1', 'out', {});

        assert.equal(result.err.code, 'ResourceNotFound');
        assert.equal(lastStatusText(result), 'ResourceNotFound');
        assert.equal(share.files.has('x/missing.txt'), false);
    });

    it('legacy: a failed range upload leaves a partial destination (no rollback)', async function () {
        share.failOnce('uploadRange', 'archive/report.txt', restError(500, 'InternalError'));
        await load({ action: 'copy', source: 'in/report.txt', destination: 'archive/report.txt' });

        const result = await trigger(helper, 'n1', 'out', {});

        assert.equal(result.err.code, 'InternalError');
        assert.equal(share.files.has('archive/report.txt'), true);
        assert.equal(share.readFile('in/report.txt'), 'payload-bytes');
    });

    it('creates destination directories only when createDir applies', async function () {
        await load({ dynamic: true });

        const noCreate = await trigger(helper, 'n1', 'out', {
            file: { action: 'copy', source: 'in/report.txt', destination: 'new/report.txt' },
        });
        assert.equal(noCreate.err.code, 'ParentNotFound');

        const withCreate = await trigger(helper, 'n1', 'out', {
            file: {
                action: 'copy',
                source: 'in/report.txt',
                destination: 'new/report.txt',
                createDir: true,
            },
        });
        assert.ok(withCreate.msg);
        assert.equal(share.readFile('new/report.txt'), 'payload-bytes');
    });

    it('validates requests before any storage mutation', async function () {
        await load({ dynamic: true });

        const cases = [
            [{}, 'FILE_MISSING'],
            [{ file: { action: 'rename', source: 'a', destination: 'b' } }, 'INVALID_ACTION'],
            [{ file: { action: 'copy', destination: 'b' } }, 'INVALID_PATH'],
            [{ file: { action: 'copy', source: 'a', destination: ' ' } }, 'PATH_MISSING'],
            [{ file: { action: 'move', source: '../a', destination: 'b' } }, 'INVALID_PATH'],
        ];
        for (const [input, code] of cases) {
            const result = await trigger(helper, 'n1', 'out', input);
            assert.equal(result.err && result.err.code, code, JSON.stringify(input));
        }
        assert.deepEqual(share.mutations(), []);
    });

    it('requires a static destination for copy/move but not for delete', async function () {
        await load({ action: 'copy', source: 'in/report.txt', destination: '' });
        const copy = await trigger(helper, 'n1', 'out', {});
        assert.equal(copy.err.code, 'DESTINATION_PATH_MISSING');

        helper.unload();
        await load({ action: 'delete', source: 'in/report.txt', destination: '' });
        const del = await trigger(helper, 'n1', 'out', {});
        assert.equal(del.msg.file.deleted, true);
    });
});
