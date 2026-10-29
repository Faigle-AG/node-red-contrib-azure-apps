const assert = require('assert/strict');
const helper = require('node-red-node-test-helper');
const fileWriteNode = require('../src/file-write.js');
const { FakeShareServiceClient, fakeConfigNode } = require('./helpers/fake-share');
const { trigger, lastStatusText } = require('./helpers/harness');

helper.init(require.resolve('node-red'));

// Characterization of the current azure-file-write behavior (Phase 2.2a).
describe('azure-file-write node', function () {
    let service;
    let share;

    function load(nodeConfig) {
        const flow = [
            { id: 'f1', type: 'tab' },
            { id: 'cfg', type: 'azure-file-config' },
            {
                id: 'n1',
                z: 'f1',
                type: 'azure-file-write',
                config: 'cfg',
                shareName: 'share',
                shareNameType: 'str',
                wires: [['out']],
                ...nodeConfig,
            },
            { id: 'out', z: 'f1', type: 'helper' },
        ];
        return helper.load([fakeConfigNode(service), fileWriteNode], flow);
    }

    beforeEach(function (done) {
        service = new FakeShareServiceClient();
        share = service.share('share');
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(done);
    });

    it('writes msg.file.data by default, creating parent directories', async function () {
        await load({ action: 'write', target: 'out/a/report.txt' });

        const result = await trigger(helper, 'n1', 'out', {
            payload: 'untouched',
            file: { data: 'hello', custom: 1 },
        });

        assert.equal(share.readFile('out/a/report.txt'), 'hello');
        assert.equal(result.msg.payload, 'untouched');
        assert.equal(result.msg.file.custom, 1);
        assert.equal(result.msg.file.path, 'out/a/report.txt');
        assert.equal(result.msg.file.base, 'report.txt');
        assert.equal(result.msg.file.filetype, 'file');
        assert.equal(lastStatusText(result), 'Wrote report.txt');
    });

    it('fails with the SDK code when the parent is missing and createDir is false', async function () {
        await load({ action: 'write', target: 'missing/report.txt', createDir: false });

        const result = await trigger(helper, 'n1', 'out', { file: { data: 'x' } });

        assert.equal(result.err.code, 'ParentNotFound');
        assert.equal(lastStatusText(result), 'ParentNotFound');
    });

    it('appends to an existing file and creates a missing one', async function () {
        share.addFile('log.txt', 'one,');
        await load({ action: 'append', target: 'log.txt' });

        const appended = await trigger(helper, 'n1', 'out', { file: { data: 'two' } });
        assert.equal(share.readFile('log.txt'), 'one,two');
        assert.equal(lastStatusText(appended), 'Appended log.txt');

        helper.unload();
        await load({ action: 'append', target: 'new.txt' });
        await trigger(helper, 'n1', 'out', { file: { data: 'first' } });
        assert.equal(share.readFile('new.txt'), 'first');
    });

    it('does not resize when appending empty data', async function () {
        share.addFile('log.txt', 'one');
        await load({ action: 'append', target: 'log.txt' });

        await trigger(helper, 'n1', 'out', { file: { data: '' } });

        assert.equal(share.readFile('log.txt'), 'one');
        assert.equal(share.calls.filter((call) => call.method === 'resize').length, 0);
    });

    it('converts objects, numbers and typed arrays to bytes', async function () {
        await load({ dynamic: true });

        const cases = [
            [{ a: 1 }, '{"a":1}'],
            [42, '42'],
            [new Uint8Array([104, 105]), 'hi'],
            ['', ''],
        ];
        for (const [data, expected] of cases) {
            await trigger(helper, 'n1', 'out', {
                file: { action: 'write', path: 'data.txt', data },
            });
            assert.equal(share.readFile('data.txt'), expected);
        }
    });

    it('legacy: static data with msg.file but no data writes an empty file', async function () {
        await load({ action: 'write', target: 'static.txt' });

        const result = await trigger(helper, 'n1', 'out', { file: {} });

        assert.ok(result.msg);
        assert.equal(share.readFile('static.txt'), '');
    });

    it('static data without msg.file fails as DATA_MISSING, keeping the TypeError and status', async function () {
        await load({ action: 'write', target: 'static.txt' });

        const result = await trigger(helper, 'n1', 'out', {}, { settleMs: 50 });

        assert.equal(result.err.code, 'DATA_MISSING');
        assert.ok(result.err instanceof TypeError);
        assert.deepEqual(result.extra, { outputs: 0, errors: 0 });
        assert.equal(lastStatusText(result), result.err.message);
        assert.deepEqual(share.mutations(), []);
    });

    it('keeps unrelated TypeErrors from msg data getters uncoded', async function () {
        await load({ action: 'write', target: 'getter.txt' });
        const own = {};
        Object.defineProperty(own, 'file', {
            enumerable: true,
            get() {
                throw new TypeError('own getter failed');
            },
        });
        const inherited = Object.create({
            get file() {
                throw new TypeError('inherited getter failed');
            },
        });

        for (const [input, message] of [
            [own, 'own getter failed'],
            [inherited, 'inherited getter failed'],
        ]) {
            const result = await trigger(helper, 'n1', 'out', input);
            assert.ok(result.err instanceof TypeError);
            assert.equal(result.err.message, message);
            assert.equal(result.err.code, undefined);
            assert.equal(lastStatusText(result), message);
        }
        assert.deepEqual(share.mutations(), []);
    });

    it('legacy: dynamic null data writes the text "null"', async function () {
        await load({ dynamic: true });
        await trigger(helper, 'n1', 'out', {
            file: { action: 'write', path: 'dynamic.txt', data: null },
        });
        assert.equal(share.readFile('dynamic.txt'), 'null');
    });

    it('trims and lowercases dynamic actions; dynamic createDir defaults to false', async function () {
        share.addDir('dir');
        await load({ dynamic: true });

        await trigger(helper, 'n1', 'out', {
            file: { action: ' WRITE ', path: 'dir/a.txt', data: 'a' },
        });
        assert.equal(share.readFile('dir/a.txt'), 'a');

        const noParent = await trigger(helper, 'n1', 'out', {
            file: { action: 'write', path: 'other/a.txt', data: 'a' },
        });
        assert.equal(noParent.err.code, 'ParentNotFound');
    });

    it('validates dynamic requests before any storage call', async function () {
        await load({ dynamic: true });

        const cases = [
            [{}, 'FILE_MISSING'],
            [{ file: { action: 'remove', path: 'a.txt', data: 'x' } }, 'INVALID_ACTION'],
            [{ file: { action: 'write', path: 'a.txt' } }, 'DATA_MISSING'],
            [{ file: { action: 'write', path: '  ', data: 'x' } }, 'TARGET_PATH_MISSING'],
            [{ file: { action: 'write', path: 'a/../b.txt', data: 'x' } }, 'INVALID_PATH'],
            [{ file: { action: 'write', path: 7, data: 'x' } }, 'INVALID_PATH'],
        ];
        for (const [input, code] of cases) {
            const result = await trigger(helper, 'n1', 'out', input);
            assert.equal(result.err && result.err.code, code, JSON.stringify(input));
            assert.equal(lastStatusText(result), code);
        }
        assert.deepEqual(share.mutations(), []);
    });

    it('reports TARGET_PATH_MISSING for an empty static target', async function () {
        await load({ action: 'write', target: '' });

        const result = await trigger(helper, 'n1', 'out', { file: { data: 'x' } });

        assert.equal(result.err.code, 'TARGET_PATH_MISSING');
    });
});
