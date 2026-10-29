const assert = require('assert/strict');
const helper = require('node-red-node-test-helper');
const fileReadNode = require('../src/file-read.js');
const catchNode = require('@node-red/nodes/core/common/25-catch.js');
const { FakeShareServiceClient, fakeConfigNode } = require('./helpers/fake-share');
const { trigger, lastStatusText } = require('./helpers/harness');

helper.init(require.resolve('node-red'));

// Characterization of the current azure-file-read behavior (Phase 2.2a).
// Tests titled "legacy:" pin quirks that a later change must alter deliberately.
describe('azure-file-read node', function () {
    let service;
    let share;

    function load(nodeConfig, extraNodes = []) {
        const flow = [
            { id: 'f1', type: 'tab' },
            { id: 'cfg', type: 'azure-file-config' },
            {
                id: 'n1',
                z: 'f1',
                type: 'azure-file-read',
                config: 'cfg',
                shareName: 'share',
                shareNameType: 'str',
                wires: [['out']],
                ...nodeConfig,
            },
            { id: 'out', z: 'f1', type: 'helper' },
            ...extraNodes.map((node) => ({ z: 'f1', ...node })),
        ];
        return helper.load([fakeConfigNode(service), fileReadNode, catchNode], flow);
    }

    beforeEach(function (done) {
        service = new FakeShareServiceClient();
        share = service.share('share');
        share.addFile('in/report.txt', 'hello azure');
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(done);
    });

    it('reads a configured file into msg.file.data and keeps unrelated keys', async function () {
        await load({ actionRead: true, source: 'in/report.txt' });

        const { msg, statuses } = await trigger(helper, 'n1', 'out', {
            payload: 'untouched',
            topic: 't',
        });

        assert.ok(Buffer.isBuffer(msg.file.data));
        assert.equal(msg.file.data.toString(), 'hello azure');
        assert.deepEqual(
            {
                filetype: msg.file.filetype,
                path: msg.file.path,
                dir: msg.file.dir,
                base: msg.file.base,
                name: msg.file.name,
                ext: msg.file.ext,
            },
            {
                filetype: 'file',
                path: 'in/report.txt',
                dir: 'in',
                base: 'report.txt',
                name: 'report',
                ext: '.txt',
            },
        );
        assert.equal(msg.payload, 'untouched');
        assert.equal(msg.topic, 't');
        assert.deepEqual(service.requestedShares, ['share']);
        assert.equal(lastStatusText({ statuses }), 'Read');
    });

    it('combines read, exists and stat in one message', async function () {
        await load({
            actionRead: true,
            actionExists: true,
            actionStat: true,
            source: 'in/report.txt',
        });

        const result = await trigger(helper, 'n1', 'out', {});

        assert.equal(result.msg.file.data.toString(), 'hello azure');
        assert.equal(result.msg.file.exists, true);
        assert.equal(result.msg.file.stats.size, 11);
        assert.ok(result.msg.file.stats.mtime instanceof Date);
        assert.ok(result.msg.file.stats.ctime instanceof Date);
        assert.equal(lastStatusText(result), 'Read, Exists, Stat');
    });

    it('normalizes whitespace, backslashes and duplicate separators in the path', async function () {
        await load({ actionRead: true, source: '  /in\\\\report.txt  ' });

        const { msg } = await trigger(helper, 'n1', 'out', {});

        assert.equal(msg.file.path, 'in/report.txt');
        assert.equal(msg.file.data.toString(), 'hello azure');
    });

    it('rejects . and .. path segments with INVALID_PATH before any storage call', async function () {
        await load({ actionRead: true, source: 'in/../secret.txt' });

        const result = await trigger(helper, 'n1', 'out', {});

        assert.equal(result.err.code, 'INVALID_PATH');
        assert.equal(lastStatusText(result), 'INVALID_PATH');
        assert.deepEqual(share.calls, []);
    });

    it('reports FILE_NOT_FOUND when reading a missing file', async function () {
        await load({ actionRead: true, source: 'in/missing.txt' });

        const result = await trigger(helper, 'n1', 'out', {});

        assert.equal(result.err.code, 'FILE_NOT_FOUND');
        assert.equal(result.err.message, 'File not found: in/missing.txt');
        assert.equal(lastStatusText(result), 'FILE_NOT_FOUND');
    });

    it('returns exists=false for a missing file without failing', async function () {
        await load({ actionExists: true, source: 'in/missing.txt' });

        const result = await trigger(helper, 'n1', 'out', {});

        assert.equal(result.msg.file.exists, false);
        assert.equal(result.msg.file.data, undefined);
        assert.equal(lastStatusText(result), 'Not Found');
    });

    it('returns stats=null for stat-only on a missing file without failing', async function () {
        await load({ actionStat: true, source: 'in/missing.txt' });

        const result = await trigger(helper, 'n1', 'out', {});

        assert.equal(result.msg.file.stats, null);
        assert.equal(lastStatusText(result), 'Stat (Not Found)');
    });

    it('reads dynamically from msg.file with a tokenized action string', async function () {
        await load({ dynamic: true });

        const result = await trigger(helper, 'n1', 'out', {
            file: { action: 'READ, stat', path: 'in/report.txt' },
        });

        assert.equal(result.msg.file.data.toString(), 'hello azure');
        assert.equal(result.msg.file.stats.size, 11);
        assert.equal(result.msg.file.action, 'READ, stat');
        assert.equal(lastStatusText(result), 'Read, Stat');
    });

    it('legacy: an unknown dynamic action succeeds with metadata only', async function () {
        await load({ dynamic: true });

        const result = await trigger(helper, 'n1', 'out', {
            file: { action: 'bread', path: 'in/report.txt' },
        });

        assert.equal(result.msg.file.data, undefined);
        assert.equal(result.msg.file.path, 'in/report.txt');
        assert.equal(lastStatusText(result), 'Did nothing to the file...');
        assert.deepEqual(share.calls, []);
    });

    it('legacy: dynamic flag objects only accept literal true', async function () {
        await load({ dynamic: true });

        const result = await trigger(helper, 'n1', 'out', {
            file: { action: { read: 'yes', exists: true }, path: 'in/report.txt' },
        });

        assert.equal(result.msg.file.data, undefined);
        assert.equal(result.msg.file.exists, true);
    });

    it('reports ACTION_MISSING and SOURCE_PATH_MISSING for incomplete dynamic requests', async function () {
        await load({ dynamic: true });

        const noAction = await trigger(helper, 'n1', 'out', { file: { path: 'in/report.txt' } });
        assert.equal(noAction.err.code, 'ACTION_MISSING');

        const noPath = await trigger(helper, 'n1', 'out', { file: { action: 'read' } });
        assert.equal(noPath.err.code, 'SOURCE_PATH_MISSING');
    });

    it('reports SHARE_NAME_MISSING and AZURE_CONFIG_MISSING', async function () {
        await load({ actionRead: true, source: 'in/report.txt', shareName: '' });
        const noShare = await trigger(helper, 'n1', 'out', {});
        assert.equal(noShare.err.code, 'SHARE_NAME_MISSING');

        helper.unload();
        await load({ actionRead: true, source: 'in/report.txt', config: 'none' });
        const noConfig = await trigger(helper, 'n1', 'out', {});
        assert.equal(noConfig.err.code, 'AZURE_CONFIG_MISSING');
        assert.equal(noConfig.err.message, 'Missing Azure configuration');
    });

    it('merges into an existing msg.file object and replaces a non-object target', async function () {
        await load({ actionExists: true, source: 'in/report.txt' });

        const merged = await trigger(helper, 'n1', 'out', { file: { custom: 1 } });
        assert.equal(merged.msg.file.custom, 1);
        assert.equal(merged.msg.file.exists, true);

        const replaced = await trigger(helper, 'n1', 'out', { file: 'text' });
        assert.equal(typeof replaced.msg.file, 'object');
        assert.equal(replaced.msg.file[0], undefined);
        assert.equal(replaced.msg.file.exists, true);
    });

    it('writes the result to a configured flow context target', async function () {
        await load({
            actionExists: true,
            source: 'in/report.txt',
            target: 'lastRead',
            targetType: 'flow',
        });

        const { msg } = await trigger(helper, 'n1', 'out', { file: { keep: true } });

        assert.deepEqual(msg.file, { keep: true });
        const stored = helper.getNode('n1').context().flow.get('lastRead');
        assert.equal(stored.exists, true);
        assert.equal(stored.path, 'in/report.txt');
    });

    it('exposes the error code to Catch nodes', async function () {
        await load({ actionRead: true, source: 'in/missing.txt' }, [
            { id: 'c1', type: 'catch', scope: null, uncaught: false, wires: [['caught']] },
            { id: 'caught', type: 'helper' },
        ]);

        const caught = new Promise((resolve) => helper.getNode('caught').on('input', resolve));
        helper.getNode('n1').receive({ _marker: 'm1' });
        const msg = await caught;

        assert.equal(msg._marker, 'm1');
        assert.equal(msg.error.code, 'FILE_NOT_FOUND');
        assert.equal(msg.error.source.id, 'n1');
    });
});
