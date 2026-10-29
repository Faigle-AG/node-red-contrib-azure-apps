const assert = require('assert/strict');
const helper = require('node-red-node-test-helper');
const directoryActionNode = require('../src/directory-action.js');
const { FakeShareServiceClient, fakeConfigNode } = require('./helpers/fake-share');
const { trigger, lastStatusText } = require('./helpers/harness');

helper.init(require.resolve('node-red'));

// Characterization of the current azure-directory-action behavior (Phase 2.2a).
describe('azure-directory-action node', function () {
    let service;
    let share;

    function load(nodeConfig) {
        const flow = [
            { id: 'f1', type: 'tab' },
            { id: 'cfg', type: 'azure-file-config' },
            {
                id: 'n1',
                z: 'f1',
                type: 'azure-directory-action',
                config: 'cfg',
                shareName: 'share',
                shareNameType: 'str',
                wires: [['out']],
                ...nodeConfig,
            },
            { id: 'out', z: 'f1', type: 'helper' },
        ];
        return helper.load([fakeConfigNode(service), directoryActionNode], flow);
    }

    beforeEach(function (done) {
        service = new FakeShareServiceClient();
        share = service.share('share');
        share.addFile('docs/a.txt', 'a');
        share.addDir('docs/sub');
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(done);
    });

    it('lists into msg.file.content by default with metadata objects', async function () {
        await load({ action: 'list', source: 'docs' });

        const result = await trigger(helper, 'n1', 'out', { file: { keep: 1 } });

        const content = result.msg.file.content;
        assert.equal(content.filetype, 'directory');
        assert.equal(content.path, 'docs');
        assert.equal(content.keep, 1);
        assert.deepEqual(
            content.contents.map((item) => [item.filetype, item.path, item.base]),
            [
                ['file', 'docs/a.txt', 'a.txt'],
                ['directory', 'docs/sub', 'sub'],
            ],
        );
        assert.equal(result.msg.file.path, undefined, 'list does not assign msg.file metadata');
        assert.equal(lastStatusText(result), 'Listed 2 items');
    });

    it('lists the share root when the path is empty', async function () {
        await load({ action: 'list', source: '' });

        const result = await trigger(helper, 'n1', 'out', {});

        assert.equal(result.msg.file.content.path, '');
        assert.deepEqual(
            result.msg.file.content.contents.map((item) => item.path),
            ['docs'],
        );
    });

    it('writes the list to an explicitly configured msg.payload', async function () {
        await load({ action: 'list', source: 'docs', property: 'payload' });

        const result = await trigger(helper, 'n1', 'out', {});

        assert.equal(result.msg.payload.contents.length, 2);
        assert.equal(result.msg.file, undefined);
    });

    it('fails with the SDK code when listing a missing directory', async function () {
        await load({ action: 'list', source: 'nope' });

        const result = await trigger(helper, 'n1', 'out', {});

        assert.equal(result.err.code, 'ResourceNotFound');
        assert.equal(lastStatusText(result), 'ResourceNotFound');
    });

    it('creates nested directories recursively by default and sets the result to true', async function () {
        await load({ action: 'create', source: 'new/a/b' });

        const result = await trigger(helper, 'n1', 'out', {});

        assert.ok(share.dirs.has('new/a/b'));
        assert.equal(result.msg.file.path, 'new/a/b');
        assert.equal(result.msg.file.content, true);
        assert.equal(lastStatusText(result), 'Created b');
    });

    it('fails a non-recursive nested create with the SDK code', async function () {
        await load({ action: 'create', source: 'new/a', recursive: false });

        const result = await trigger(helper, 'n1', 'out', {});

        assert.equal(result.err.code, 'ParentNotFound');
    });

    it('deletes a tree recursively and reports deleted=true', async function () {
        await load({ action: 'delete', source: 'docs' });

        const result = await trigger(helper, 'n1', 'out', {});

        assert.equal(share.dirs.has('docs'), false);
        assert.equal(share.files.has('docs/a.txt'), false);
        assert.equal(result.msg.file.deleted, true);
        assert.equal(result.msg.file.content, true);
        assert.equal(lastStatusText(result), 'Deleted docs');
    });

    it('succeeds with deleted=false when deleting a missing directory non-recursively', async function () {
        await load({ action: 'delete', source: 'nope', recursive: false });

        const result = await trigger(helper, 'n1', 'out', {});

        assert.equal(result.msg.file.deleted, false);
        assert.equal(result.msg.file.content, true);
        assert.equal(lastStatusText(result), 'Not found nope');
    });

    it('legacy: a recursive delete of a missing directory fails while listing', async function () {
        await load({ action: 'delete', source: 'nope' });

        const result = await trigger(helper, 'n1', 'out', {});

        assert.equal(result.err.code, 'ResourceNotFound');
    });

    it('propagates the SDK error for a non-recursive delete of a non-empty directory', async function () {
        await load({ action: 'delete', source: 'docs', recursive: false });

        const result = await trigger(helper, 'n1', 'out', {});

        assert.equal(result.err.code, 'DirectoryNotEmpty');
        assert.ok(share.dirs.has('docs'));
    });

    it('defaults dynamic recursive to false', async function () {
        await load({ dynamic: true });

        const result = await trigger(helper, 'n1', 'out', {
            file: { action: 'create', path: 'x/y' },
        });

        assert.equal(result.err.code, 'ParentNotFound');
    });

    it('validates requests before any storage mutation', async function () {
        await load({ dynamic: true });

        const cases = [
            [{}, 'FILE_MISSING'],
            [{ file: { action: 'rename', path: 'docs' } }, 'INVALID_ACTION'],
            [{ file: { action: 'create', path: '' } }, 'DIRECTORY_PATH_MISSING'],
            [{ file: { action: 'delete', path: 'docs/../..' } }, 'INVALID_PATH'],
        ];
        for (const [input, code] of cases) {
            const result = await trigger(helper, 'n1', 'out', input);
            assert.equal(result.err && result.err.code, code, JSON.stringify(input));
        }
        assert.deepEqual(share.mutations(), []);
    });
});
