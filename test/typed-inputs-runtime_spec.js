'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const { AsyncLocalStorage } = require('async_hooks');
const helper = require('node-red-node-test-helper');
const { util } = require('@node-red/util');
const { FakeShareServiceClient } = require('./helpers/fake-share');

helper.init(require.resolve('node-red'));

// Phase 2.9: the Azure nodes accept exactly the types their editors offer. T3 evaluates every
// offered type on the paths that are not the plain utils helpers (the Search Query options and
// filter, the service URL, the User ID, the ignore pattern and the watcher's startup reads) and on
// one field per plain path; T4 rejects any other type of an active field before anything is
// evaluated or requested, and leaves inactive fields unchecked; T5 pins legacy defaults; T6 pins
// the payloads of the new literals (P3, P4, P5, P7).

// Every external capability of these nodes is a facade owned by the test: `fetch` is bound into
// each module as a lexical variable, and `openai` and `@azure/storage-file-share` are what the
// modules' own require returns. The facades stay bound for good, mutate no global, and serve only
// the test that owns the call (an AsyncLocalStorage owner each test enters) while it is active.
// Any other call, before a test, after its nodes are unloaded or from a stale continuation of an
// earlier test, is refused and recorded; it never reaches a real service or another test.
const owner = new AsyncLocalStorage();
const strays = [];
function ownerOf(call) {
    const current = owner.getStore();
    if (current && current.active) return current;
    strays.push(call);
    throw new Error(`${call} called outside an active test`);
}

async function fenceFetch(url, init = {}) {
    const current = ownerOf('fetch');
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    current.requests.push({ url: String(url), method: init.method || 'GET', body });
    return new Response(JSON.stringify({ value: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

const openaiFacade = {
    OpenAI: class {
        constructor(options) {
            ownerOf('OpenAI').sdk.push({ client: options.baseURL });
            this.responses = {
                create: async (body) => {
                    ownerOf('responses.create').sdk.push({ body });
                    return { id: 'resp-29', model: body.model, output_text: 'answer' };
                },
            };
        }
    },
};

const shareSdkFacade = {
    ShareServiceClient: class {
        constructor(url) {
            const current = ownerOf('ShareServiceClient');
            current.sdk.push({ url });
            return current.service;
        }

        static fromConnectionString(connectionString) {
            const current = ownerOf('ShareServiceClient.fromConnectionString');
            current.sdk.push({ connectionString });
            return current.service;
        }
    },
    StorageSharedKeyCredential: class {
        constructor() {
            ownerOf('StorageSharedKeyCredential');
        }
    },
};

// Loads a product module with `fetch` bound to the fence and the SDK facades in place of the SDKs.
const SRC = path.join(__dirname, '../src');
function loadModule(file) {
    const filename = path.join(SRC, file);
    const load = Module.createRequire(filename);
    const facades = { openai: openaiFacade, '@azure/storage-file-share': shareSdkFacade };
    const module = { exports: {} };
    const body = vm.compileFunction(
        fs.readFileSync(filename, 'utf8'),
        ['exports', 'require', 'module', '__filename', '__dirname', 'fetch'],
        { filename },
    );
    body(
        module.exports,
        (id) => (id in facades ? facades[id] : load(id)),
        module,
        filename,
        SRC,
        fenceFetch,
    );
    return module.exports;
}
const NODES = Object.fromEntries(
    fs
        .readdirSync(SRC)
        .filter((file) => file.endsWith('.js'))
        .map((file) => [file.replace(/\.js$/, ''), loadModule(file)]),
);

// Test-owned configuration nodes: authentication returns constants, and the share configuration
// hands out the test's in-memory share service, counted and owner-checked.
function fakeAuthConfig(RED) {
    function FakeAuthConfig(config) {
        RED.nodes.createNode(this, config);
        this.authType = config.authType || 'apiKey';
        this.getApiKey = () => 'test-key';
        this.getToken = async () => 'test-token';
        this.getCredential = () => ({ fake: true });
        this.getSasToken = () => 'sv=29';
        this.getConnectionString = () => 'DefaultEndpointsProtocol=https;AccountName=a';
    }
    RED.nodes.registerType('azure-auth-config', FakeAuthConfig);
}
function fakeFileConfig(RED) {
    function FakeFileConfig(config) {
        RED.nodes.createNode(this, config);
        this.getClient = () => {
            const current = ownerOf('getClient');
            current.getClient += 1;
            return current.service;
        };
    }
    RED.nodes.registerType('azure-file-config', FakeFileConfig);
}

// The active test's fixture, and Node-RED's evaluations of typed properties during it.
let fixture = null;
let evaluations = null;
function startFixture() {
    // Turnover retires the previous owner: from now on its late calls are refused.
    if (fixture) fixture.active = false;
    fixture = {
        active: true,
        requests: [],
        sdk: [],
        getClient: 0,
        service: new FakeShareServiceClient(),
    };
    owner.enterWith(fixture);
    return fixture;
}

const SHARE = 'share29';
const ENDPOINT = 'https://search29.example.test';
const AUTH = { id: 'auth', type: 'azure-auth-config', authType: 'apiKey' };
const EMAIL_CONFIG = { id: 'mail', type: 'azure-email-config', auth: 'auth', userId: 'user29' };

// Per node: its module, the configuration nodes it needs, and a valid static configuration.
const SETUPS = {
    'azure-ai-search-index': {
        modules: ['ai-search-index'],
        configs: [AUTH],
        base: {
            config: 'auth',
            endpoint: ENDPOINT,
            indexName: 'idx',
            operation: 'get',
            timeoutMs: 30000,
        },
    },
    'azure-ai-search-query': {
        modules: ['ai-search-query'],
        configs: [AUTH],
        base: { config: 'auth', endpoint: ENDPOINT, indexName: 'idx', timeoutMs: 30000 },
    },
    'azure-ai-search-sync': {
        modules: ['ai-search-sync'],
        configs: [AUTH],
        base: { config: 'auth', endpoint: ENDPOINT, indexName: 'idx', documents: 'docs' },
    },
    'azure-document-intelligence': {
        modules: ['document-intelligence'],
        configs: [AUTH],
        base: { config: 'auth', endpoint: ENDPOINT, modelId: 'prebuilt-read', output: 'analysis' },
    },
    'azure-foundry-llm': {
        modules: ['foundry-llm'],
        configs: [AUTH],
        base: { config: 'auth', endpoint: ENDPOINT, model: 'model29' },
    },
    'azure-email-read': {
        modules: ['email-config', 'email-read'],
        configs: [AUTH, EMAIL_CONFIG],
        base: { config: 'mail', output: 'emails' },
    },
    'azure-email-transfer': {
        modules: ['email-config', 'email-transfer'],
        configs: [AUTH, EMAIL_CONFIG],
        base: { config: 'mail', messageId: 'm29', messageIdType: 'str', action: 'move' },
    },
    'azure-email-write': {
        modules: ['email-config', 'email-write'],
        configs: [AUTH, EMAIL_CONFIG],
        base: {
            config: 'mail',
            to: 'a@example.test',
            toType: 'str',
            subject: 'Hi',
            subjectType: 'str',
            body: 'Body',
            bodyType: 'str',
            attachments: '',
        },
    },
    'azure-file-read': {
        modules: ['file-read'],
        configs: [{ id: 'share', type: 'azure-file-config' }],
        base: { config: 'share', shareName: SHARE, source: 'a.txt', actionRead: true },
    },
    'azure-file-write': {
        modules: ['file-write'],
        configs: [{ id: 'share', type: 'azure-file-config' }],
        base: {
            config: 'share',
            shareName: SHARE,
            target: 'out.txt',
            data: 'text',
            dataType: 'str',
        },
    },
    'azure-file-transfer': {
        modules: ['file-transfer'],
        configs: [{ id: 'share', type: 'azure-file-config' }],
        base: {
            config: 'share',
            shareName: SHARE,
            source: 'a.txt',
            destination: 'b.txt',
            action: 'copy',
        },
    },
    'azure-directory-action': {
        modules: ['directory-action'],
        configs: [{ id: 'share', type: 'azure-file-config' }],
        base: { config: 'share', shareName: SHARE, source: 'dir', action: 'list' },
    },
    'azure-directory-transfer': {
        modules: ['directory-transfer'],
        configs: [{ id: 'share', type: 'azure-file-config' }],
        base: {
            config: 'share',
            shareName: SHARE,
            source: 'dir',
            destination: 'dir2',
            action: 'copy',
        },
    },
};

// Loads one node (n1, wired to `out`) with its configuration nodes. `realFileConfig` loads the
// real azure-file-config (with the SDK facade) in place of the test's share configuration.
async function load(nodeType, node = {}, { configs, realFileConfig = false } = {}) {
    const setup = SETUPS[nodeType];
    const current = startFixture();
    current.service.share(SHARE).addFile('a.txt', 'a');
    current.service.share(SHARE).addDir('dir');
    const modules = [
        fakeAuthConfig,
        realFileConfig ? NODES['file-config'] : fakeFileConfig,
        ...setup.modules.map((name) => NODES[name]),
    ];
    await helper.load(modules, [
        { id: 'f1', type: 'tab' },
        ...(configs || setup.configs),
        { id: 'n1', z: 'f1', type: nodeType, ...setup.base, ...node, wires: [['out']] },
        { id: 'out', z: 'f1', type: 'helper' },
    ]);
    const n1 = helper.getNode('n1');
    for (const scope of ['flow', 'global']) n1.context()[scope].set('p', node.$context);
    evaluations.length = 0;
    return n1;
}

function run(node, msg = {}) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ timeout: true }), 2000);
        helper.getNode('out').once('input', (out) => {
            clearTimeout(timer);
            resolve({ msg: out });
        });
        node.once('call:error', (call) => {
            clearTimeout(timer);
            resolve({ err: call.args[0] });
        });
        node.receive(msg);
    });
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

// Nothing outside the test's own facades was started.
function assertNothingStarted() {
    assert.deepEqual(fixture.requests, [], 'requests');
    assert.deepEqual(fixture.sdk, [], 'SDK calls');
    assert.equal(fixture.getClient, 0, 'share clients');
    assert.deepEqual(evaluations, [], 'evaluations');
}

// A configured value of each offered type that resolves to `value`, given msg.p, flow and global p
// (set through `$context`) and the environment variable TYPED_29_VALUE.
function representative(type, value, literal = value) {
    process.env.TYPED_29_VALUE = String(value);
    return (
        {
            msg: [{ $context: undefined }, 'p', { p: value }],
            flow: [{ $context: value }, 'p', {}],
            global: [{ $context: value }, 'p', {}],
            jsonata: [{ $context: undefined }, 'p', { p: value }],
            env: [{ $context: undefined }, 'TYPED_29_VALUE', {}],
        }[type] || [{ $context: undefined }, literal, {}]
    );
}

describe('typed inputs (Phase 2.9): Azure runtimes', function () {
    this.timeout(10000);
    let realEvaluate;

    before(function () {
        realEvaluate = util.evaluateNodeProperty;
        util.evaluateNodeProperty = function (value, type, ...rest) {
            if (evaluations) evaluations.push(type);
            return realEvaluate.call(this, value, type, ...rest);
        };
    });

    after(function () {
        util.evaluateNodeProperty = realEvaluate;
        assert.deepEqual(strays, []);
    });

    beforeEach(function (done) {
        evaluations = [];
        helper.startServer(done);
    });

    afterEach(function (done) {
        delete process.env.TYPED_29_VALUE;
        helper.unload().then(() =>
            helper.stopServer(() => {
                // Only now, after unload: any later call of these nodes is refused.
                if (fixture) fixture.active = false;
                fixture = null;
                evaluations = null;
                done();
            }),
        );
    });

    describe('the facades', function () {
        const CALLS = {
            fetch: () => fenceFetch('https://late.example.test'),
            'responses.create': () =>
                new openaiFacade.OpenAI({ baseURL: 'x' }).responses.create({ model: 'm' }),
            ShareServiceClient: () => new shareSdkFacade.ShareServiceClient('https://late'),
        };

        for (const [name, call] of Object.entries(CALLS)) {
            it(`${name}: refused outside any test`, async function () {
                await owner.run(undefined, () =>
                    assert.rejects(async () => call(), /called outside an active test/),
                );
                assert.ok(strays.length >= 1);
                strays.splice(0);
            });

            it(`${name}: a late call of a finished test is refused, not served by the next`, async function () {
                const earlier = startFixture();
                let late;
                owner.run(earlier, () => {
                    setTimeout(async () => {
                        try {
                            await call();
                        } catch (err) {
                            late = err;
                        }
                    }, 20);
                });
                earlier.active = false;
                const current = startFixture();
                await settle(60);
                assert.match(late.message, /called outside an active test/);
                assert.deepEqual([current.requests, current.sdk], [[], []]);
                assert.deepEqual([earlier.requests, earlier.sdk], [[], []]);
                assert.ok(strays.length >= 1);
                strays.splice(0);
            });
        }

        it('a reload within one test retires the previous owner (the real turnover path)', async function () {
            await load('azure-ai-search-query');
            const first = fixture;
            let scheduledUnder;
            let late;
            setTimeout(() => {
                scheduledUnder = owner.getStore();
                fenceFetch('https://late.example.test').catch((error) => (late = error));
            }, 40);
            await helper.unload();
            await load('azure-ai-search-query');
            const second = fixture;
            await settle(100);
            // The late call ran under the first owner, which the reload retired.
            assert.equal(scheduledUnder, first);
            assert.equal(first.active, false);
            assert.match(late.message, /called outside an active test/);
            assert.deepEqual([first.requests, second.requests], [[], []]);
            assert.deepEqual(strays.splice(0), ['fetch']);
        });

        it('a captured responses.create of a retired owner is refused', async function () {
            const first = startFixture();
            // Constructed while the first owner is active; called later by its own continuation.
            const create = new openaiFacade.OpenAI({ baseURL: 'x' }).responses.create;
            let late;
            owner.run(first, () =>
                setTimeout(() => create({ model: 'm' }).catch((error) => (late = error)), 40),
            );
            const second = startFixture();
            await settle(100);
            assert.equal(first.active, false);
            assert.match(late.message, /called outside an active test/);
            assert.deepEqual([first.sdk.filter((c) => c.body), second.sdk], [[], []]);
            assert.deepEqual(strays.splice(0), ['responses.create']);
        });

        it('the share configuration refuses a client outside an active test', async function () {
            await load('azure-file-read');
            const config = helper.getNode('share');
            fixture.active = false;
            assert.throws(() => config.getClient(), /getClient called outside an active test/);
            assert.deepEqual(strays.splice(0), ['getClient']);
        });
    });

    describe('T3 every offered type works', function () {
        const VALUE = ['msg', 'flow', 'global', 'str', 'jsonata', 'env'];

        // The Search Query options (QO) and filter (QF): each offered type reaches the request.
        const QUERY = {
            searchFields: ['str', 'title', (b) => b.searchFields, 'title'],
            select: ['str', 'id', (b) => b.select, 'id'],
            filter: ['str', 'x eq 1', (b) => b.filter, 'x eq 1'],
            semanticConfiguration: ['str', 'sem', (b) => b.semanticConfiguration, 'sem'],
            querySyntax: ['str', 'full', (b) => b.queryType, 'full'],
            searchMode: ['str', 'all', (b) => b.searchMode, 'all'],
            top: ['num', 5, (b) => b.top, 5],
            skip: ['num', 3, (b) => b.skip, 3],
            count: ['bool', true, (b) => b.count, true],
        };
        for (const [field, [literalType, value, read, expected]] of Object.entries(QUERY)) {
            for (const type of [...VALUE.filter((t) => t !== 'str'), literalType]) {
                it(`ai-search-query ${field} of type ${type}`, async function () {
                    const [context, configured, msg] = representative(type, value);
                    const n1 = await load('azure-ai-search-query', {
                        ...context,
                        [field]: configured,
                        [`${field}Type`]: type,
                    });
                    const result = await run(n1, msg);
                    assert.ok(result.msg, result.err && result.err.message);
                    assert.deepEqual(read(fixture.requests[0].body), expected);
                    if (!['str', 'num', 'bool'].includes(type) || field === 'filter') {
                        assert.ok(evaluations.includes(type), `evaluations: ${evaluations}`);
                    }
                });
            }
        }

        for (const [field, literalType, value, check] of [
            [
                'outputMode',
                'str',
                'response',
                (r) => assert.deepEqual(r.msg.payload, { value: [] }),
            ],
            ['timeoutMs', 'num', 5000, (r) => assert.ok(r.msg)],
            ['enableLogging', 'bool', true, (r) => assert.ok(r.msg)],
        ]) {
            for (const type of [...VALUE.filter((t) => t !== 'str'), literalType]) {
                it(`ai-search-query ${field} of type ${type}`, async function () {
                    const [context, configured, msg] = representative(type, value);
                    const n1 = await load('azure-ai-search-query', {
                        ...context,
                        [field]: configured,
                        [`${field}Type`]: type,
                    });
                    check(await run(n1, msg));
                });
            }
        }

        // A plain value path (UG) on one field: every offered type becomes the search text.
        for (const type of VALUE) {
            it(`ai-search-query query (UG) of type ${type}`, async function () {
                const [context, configured, msg] = representative(type, 'hello');
                const n1 = await load('azure-ai-search-query', {
                    ...context,
                    query: configured,
                    queryType: type,
                });
                await run(n1, msg);
                assert.equal(fixture.requests[0].body.search, 'hello');
            });
        }

        // A validated path (UV) and an output path (US), on file-read.
        for (const type of VALUE) {
            it(`file-read shareName (UV) of type ${type}`, async function () {
                const [context, configured, msg] = representative(type, SHARE);
                const n1 = await load('azure-file-read', {
                    ...context,
                    shareName: configured,
                    shareNameType: type,
                });
                const result = await run(n1, msg);
                assert.equal(String(result.msg.file.data), 'a');
            });
        }
        for (const type of ['msg', 'flow', 'global']) {
            it(`file-read target (US) of type ${type}`, async function () {
                const n1 = await load('azure-file-read', { target: 'out', targetType: type });
                const result = await run(n1, {});
                const written = type === 'msg' ? result.msg.out : n1.context()[type].get('out');
                assert.equal(String(written.data), 'a');
            });
        }

        // The service URL (NS): synchronous, on the real share configuration.
        for (const type of ['str', 'env']) {
            it(`file-config serviceUrl of type ${type}`, async function () {
                process.env.TYPED_29_URL = 'https://acct.file.core.windows.net';
                const n1 = await load(
                    'azure-file-read',
                    {},
                    {
                        realFileConfig: true,
                        configs: [
                            { ...AUTH, authType: 'sas' },
                            {
                                id: 'share',
                                type: 'azure-file-config',
                                auth: 'auth',
                                serviceUrl:
                                    type === 'env'
                                        ? 'TYPED_29_URL'
                                        : 'https://acct.file.core.windows.net',
                                serviceUrlType: type,
                            },
                        ],
                    },
                );
                const result = await run(n1, {});
                delete process.env.TYPED_29_URL;
                assert.equal(String(result.msg.file.data), 'a');
                assert.match(
                    fixture.sdk[0].url,
                    /^https:\/\/acct\.file\.core\.windows\.net\/?\?sv=29$/,
                );
            });
        }

        // The User ID (EU), configured on the email configuration and read by the email nodes.
        for (const type of ['str', 'env']) {
            it(`email-config userId of type ${type}, read by email-read`, async function () {
                process.env.TYPED_29_VALUE = 'user29';
                const n1 = await load(
                    'azure-email-read',
                    {},
                    {
                        configs: [
                            AUTH,
                            {
                                ...EMAIL_CONFIG,
                                userId: type === 'env' ? 'TYPED_29_VALUE' : 'user29',
                                userIdType: type,
                            },
                        ],
                    },
                );
                const result = await run(n1, {});
                assert.ok(result.msg, result.err && result.err.message);
                assert.match(fixture.requests[0].url, /\/users\/user29\//);
            });
        }

        // The watcher's startup reads (share name and folder) and its ignore pattern (RE).
        for (const type of ['flow', 'global', 'str', 'jsonata', 'env']) {
            for (const field of ['shareName', 'source']) {
                it(`directory-watch ${field} of type ${type}`, async function () {
                    const value = field === 'shareName' ? SHARE : 'dir';
                    const [context, configured] = representative(type, value);
                    const n1 = await loadWatch({
                        ...context,
                        [field]: type === 'jsonata' ? `"${value}"` : configured,
                        [`${field}Type`]: type,
                    });
                    await settle(80);
                    assert.equal(
                        field === 'shareName' ? n1.resolvedShareName : n1.resolvedSource,
                        value,
                    );
                });
            }
        }
        it('directory-watch ignoredFiles of type re starts the watcher', async function () {
            const n1 = await loadWatch({ ignoredFiles: '\\.tmp$', ignoredFilesType: 're' });
            await settle(80);
            assert.ok(n1.ignoreRegex instanceof RegExp);
            assert.equal(fixture.getClient, 1);
        });
    });

    // Loads the Azure directory watcher, which starts at construction.
    async function loadWatch(node) {
        const current = startFixture();
        current.service.share(SHARE).addDir('dir');
        const before = [
            { id: 'f1', type: 'tab' },
            { id: 'share', type: 'azure-file-config' },
            { id: 'out', z: 'f1', type: 'helper' },
        ];
        // The watcher reads its share and folder at construction: flow and global get their value
        // first, from a flow without it, and the watcher is deployed after.
        await helper.load([fakeFileConfig, NODES['directory-watch']], before);
        for (const scope of ['flow', 'global']) {
            helper.getNode('out').context()[scope].set('p', node.$context);
        }
        await helper.setFlows(
            [
                ...before,
                {
                    id: 'n1',
                    z: 'f1',
                    type: 'azure-directory-watch',
                    config: 'share',
                    shareName: SHARE,
                    source: '',
                    pollInterval: 60,
                    ...node,
                    wires: [['out']],
                },
            ],
            'full',
        );
        return helper.getNode('n1');
    }

    describe('T2 the email nodes check the User ID against its offer', function () {
        const CANDIDATES = ['str', 'num', 'bool', 'json', 'bin', 're', 'date', 'jsonata', 'env'];
        for (const nodeType of ['azure-email-read', 'azure-email-transfer', 'azure-email-write']) {
            it(`${nodeType} accepts exactly str and env`, async function () {
                const accepted = [];
                for (const type of [
                    ...CANDIDATES,
                    'msg',
                    'flow',
                    'global',
                    'node',
                    'cred',
                    'foo',
                ]) {
                    await helper.unload();
                    const n1 = await load(
                        nodeType,
                        {},
                        {
                            configs: [AUTH, { ...EMAIL_CONFIG, userIdType: type }],
                        },
                    );
                    const result = await run(n1, {});
                    const message = `User ID type '${type}' is not supported`;
                    if (!(result.err && result.err.message === message)) accepted.push(type);
                }
                assert.deepEqual(accepted.sort(), ['env', 'str']);
            });
        }
    });

    describe('T4 any other type of an active field fails before anything starts', function () {
        // Per node: each active field, its label, and whether it is an output target.
        const FIELDS = {
            'azure-ai-search-index': [
                ['endpoint', 'Endpoint'],
                ['indexName', 'Index name'],
                ['output', null],
            ],
            'azure-ai-search-query': [
                ['endpoint', 'Endpoint'],
                ['indexName', 'Index name'],
                ['query', 'Query'],
                ['additionalParameters', 'Additional parameters'],
                ['searchFields', 'Search fields'],
                ['select', 'Select'],
                ['filter', 'Filter'],
                ['semanticConfiguration', 'Semantic configuration'],
                ['querySyntax', 'Query type'],
                ['searchMode', 'Search mode'],
                ['outputMode', 'Value'],
                ['top', 'Top'],
                ['skip', 'Skip'],
                ['timeoutMs', 'Timeout'],
                ['count', 'Total count'],
                ['enableLogging', 'Logging'],
                ['output', null],
            ],
            'azure-ai-search-sync': [
                ['endpoint', 'Endpoint'],
                ['indexName', 'Index name'],
                ['documents', 'Documents'],
                ['output', null],
            ],
            'azure-document-intelligence': [
                ['endpoint', 'Endpoint'],
                ['modelId', 'Model'],
                ['documentData', 'Document data'],
                ['output', null],
            ],
            'azure-foundry-llm': [
                ['endpoint', 'Endpoint'],
                ['model', 'Model'],
                ['input', 'Input'],
                ['output', null],
            ],
            'azure-email-read': [['output', null]],
            'azure-email-transfer': [['messageId', 'Message ID']],
            'azure-email-write': [
                ['to', 'To'],
                ['subject', 'Subject'],
                ['body', 'Body'],
            ],
            'azure-file-read': [
                ['shareName', 'Share name'],
                ['source', 'Source'],
                ['target', null],
            ],
            'azure-file-write': [
                ['shareName', 'Share name'],
                ['target', 'Target'],
                ['data', 'Data'],
            ],
            'azure-file-transfer': [
                ['shareName', 'Share name'],
                ['source', 'Source'],
                ['destination', 'Destination'],
            ],
            'azure-directory-action': [
                ['shareName', 'Share name'],
                ['source', 'Source'],
                ['property', null],
            ],
            'azure-directory-transfer': [
                ['shareName', 'Share name'],
                ['source', 'Source'],
                ['destination', 'Destination'],
            ],
        };

        for (const [nodeType, fields] of Object.entries(FIELDS)) {
            for (const [field, label] of fields) {
                for (const type of label ? ['foo'] : ['str', 'foo']) {
                    it(`${nodeType} ${field} of type ${type}`, async function () {
                        const n1 = await load(nodeType, { [`${field}Type`]: type });
                        const result = await run(n1, { payload: 'x' });
                        if (label) {
                            assert.equal(result.err.code, 'INVALID_CONFIGURATION');
                            assert.equal(
                                result.err.message,
                                `${label} type '${type}' is not supported`,
                            );
                        } else {
                            // Foundry's existing catch gives every uncoded error its name as code.
                            const code = nodeType === 'azure-foundry-llm' ? 'Error' : undefined;
                            assert.equal(result.err.code, code);
                            assert.equal(
                                result.err.message,
                                `Unsupported target property type: ${type}`,
                            );
                        }
                        assertNothingStarted();
                    });
                }
            }
        }

        it('azure-ai-search-index definition of type foo when it creates or updates', async function () {
            const n1 = await load('azure-ai-search-index', {
                operation: 'createOrUpdate',
                definitionType: 'foo',
            });
            const result = await run(n1, {});
            assert.equal(result.err.message, "Index definition type 'foo' is not supported");
            assertNothingStarted();
        });

        it('azure-foundry-llm instructions of type foo when set', async function () {
            const n1 = await load('azure-foundry-llm', {
                instructions: 'Be brief',
                instructionsType: 'foo',
            });
            const result = await run(n1, { payload: 'hi' });
            assert.equal(result.err.message, "Instructions type 'foo' is not supported");
            assertNothingStarted();
        });

        it('azure-email-write attachments of type foo when set', async function () {
            const n1 = await load('azure-email-write', {
                attachments: 'a',
                attachmentsType: 'foo',
            });
            const result = await run(n1, {});
            assert.equal(result.err.message, "Attachments type 'foo' is not supported");
            assertNothingStarted();
        });

        for (const nodeType of ['azure-email-read', 'azure-email-transfer', 'azure-email-write']) {
            it(`${nodeType}: an email configuration's userId of type foo`, async function () {
                const n1 = await load(
                    nodeType,
                    {},
                    {
                        configs: [AUTH, { ...EMAIL_CONFIG, userIdType: 'foo' }],
                    },
                );
                const result = await run(n1, {});
                assert.equal(result.err.code, 'INVALID_CONFIGURATION');
                assert.equal(result.err.message, "User ID type 'foo' is not supported");
                assertNothingStarted();
            });
        }

        it('file-config serviceUrl of type foo', async function () {
            const n1 = await load(
                'azure-file-read',
                {},
                {
                    realFileConfig: true,
                    configs: [
                        { ...AUTH, authType: 'sas' },
                        {
                            id: 'share',
                            type: 'azure-file-config',
                            auth: 'auth',
                            serviceUrl: 'x',
                            serviceUrlType: 'foo',
                        },
                    ],
                },
            );
            const result = await run(n1, {});
            assert.equal(result.err.code, 'INVALID_CONFIGURATION');
            assert.equal(result.err.message, "Service URL type 'foo' is not supported");
            assert.deepEqual(fixture.sdk, []);
        });

        for (const [field, value, message] of [
            ['shareName', SHARE, "Share name type 'foo' is not supported"],
            ['source', 'dir', "Source type 'foo' is not supported"],
            ['target', 'file', 'Unsupported target property type: foo'],
            ['ignoredFiles', '\\.tmp$', "Ignored files type 'foo' is not supported"],
        ]) {
            it(`azure-directory-watch ${field} of type foo: no watcher starts`, async function () {
                const n1 = await loadWatch({ [field]: value, [`${field}Type`]: 'foo' });
                const errors = [];
                n1.on('call:error', (call) => errors.push(call.args[0]));
                await settle(80);
                assert.deepEqual(
                    errors.map((e) => e.message),
                    [message],
                );
                assert.equal(fixture.getClient, 0);
                assert.deepEqual(evaluations, []);
                assert.equal(n1.resolvedShareName, undefined);
            });
        }
    });

    describe('T4 inactive fields are not checked', function () {
        // Each of these still reaches its external boundary.
        const reached = (result) =>
            assert.ok(
                fixture.requests.length + fixture.sdk.length + fixture.getClient > 0,
                `reached the boundary (${result.err && result.err.message})`,
            );

        for (const [title, nodeType, node, msg] of [
            [
                'index definition for a get',
                'azure-ai-search-index',
                { operation: 'get', definitionType: 'foo' },
            ],
            [
                'blank foundry instructions',
                'azure-foundry-llm',
                { instructions: '', instructionsType: 'foo' },
                { payload: 'hi' },
            ],
            [
                'blank email attachments',
                'azure-email-write',
                { attachments: '', attachmentsType: 'foo' },
            ],
            [
                'dynamic email statics',
                'azure-email-write',
                {
                    dynamic: true,
                    toType: 'foo',
                    subjectType: 'foo',
                    bodyType: 'foo',
                    attachmentsType: 'foo',
                },
                { email: { to: 'a@example.test', subject: 's', body: 'b' } },
            ],
            [
                'dynamic email message ID',
                'azure-email-transfer',
                { dynamic: true, messageIdType: 'foo' },
                { email: { messageId: 'm', action: 'move', destinationId: 'archive' } },
            ],
            [
                'dynamic document statics',
                'azure-document-intelligence',
                { dynamic: true, modelIdType: 'foo', documentDataType: 'foo' },
                { document: { modelId: 'prebuilt-read', data: 'https://example.test/a.pdf' } },
            ],
            [
                'dynamic file-read source',
                'azure-file-read',
                { dynamic: true, sourceType: 'foo' },
                { file: { action: 'read', path: 'a.txt' } },
            ],
            [
                'dynamic file-write statics',
                'azure-file-write',
                { dynamic: true, targetType: 'foo', dataType: 'foo' },
                { file: { action: 'write', path: 'd.txt', data: 'x' } },
            ],
            [
                'dynamic file-transfer paths',
                'azure-file-transfer',
                { dynamic: true, sourceType: 'foo', destinationType: 'foo' },
                { file: { action: 'copy', source: 'a.txt', destination: 'c.txt' } },
            ],
            [
                'a DELETE never reads the destination',
                'azure-file-transfer',
                { action: 'DELETE', destinationType: 'foo' },
            ],
            [
                'dynamic directory-action source',
                'azure-directory-action',
                { dynamic: true, sourceType: 'foo' },
                { file: { action: 'list', path: 'dir' } },
            ],
            [
                'a blank source of a list (the share root)',
                'azure-directory-action',
                { source: '', sourceType: 'foo' },
            ],
            [
                'dynamic directory-transfer paths',
                'azure-directory-transfer',
                { dynamic: true, sourceType: 'foo', destinationType: 'foo' },
                { file: { action: 'copy', source: 'dir', destination: 'dir3' } },
            ],
        ]) {
            it(title, async function () {
                const n1 = await load(nodeType, node);
                const result = await run(n1, msg || {});
                assert.ok(
                    !result.err || !/type '.*' is not supported/.test(result.err.message),
                    result.err && result.err.message,
                );
                reached(result);
            });
        }

        it("' delete ' (untrimmed) still reads, so checks, the destination", async function () {
            const n1 = await load('azure-file-transfer', {
                action: ' delete ',
                destinationType: 'foo',
            });
            const result = await run(n1, {});
            assert.equal(result.err.message, "Destination type 'foo' is not supported");
            assertNothingStarted();
        });

        it('a blank source of a create is required, so checked', async function () {
            const n1 = await load('azure-directory-action', {
                action: 'create',
                source: '',
                sourceType: 'foo',
            });
            const result = await run(n1, {});
            assert.equal(result.err.message, "Source type 'foo' is not supported");
            assertNothingStarted();
        });

        it('a blank source of a create with an offered type keeps DIRECTORY_PATH_MISSING', async function () {
            const n1 = await load('azure-directory-action', { action: 'create', source: '' });
            const result = await run(n1, {});
            assert.equal(result.err.code, 'DIRECTORY_PATH_MISSING');
        });

        it('a connection string carries its endpoint, so the serviceUrl type is not checked', async function () {
            const n1 = await load(
                'azure-file-read',
                {},
                {
                    realFileConfig: true,
                    configs: [
                        { ...AUTH, authType: 'connectionString' },
                        {
                            id: 'share',
                            type: 'azure-file-config',
                            auth: 'auth',
                            serviceUrl: '',
                            serviceUrlType: 'foo',
                        },
                    ],
                },
            );
            const result = await run(n1, {});
            assert.equal(String(result.msg.file.data), 'a');
            assert.ok(fixture.sdk[0].connectionString);
        });

        for (const [title, node] of [
            ['a blank watch folder (the share root)', { source: '', sourceType: 'foo' }],
            ['a blank ignore pattern', { ignoredFiles: '', ignoredFilesType: 'str' }],
        ]) {
            it(`azure-directory-watch: ${title}`, async function () {
                await loadWatch(node);
                await settle(80);
                assert.equal(fixture.getClient, 1);
            });
        }
    });

    describe('T5 legacy defaults', function () {
        for (const [title, outputType] of [
            ['absent', undefined],
            ['blank', ''],
        ]) {
            it(`foundry outputType ${title} writes msg.payload`, async function () {
                const n1 = await load('azure-foundry-llm', { outputType });
                const result = await run(n1, { payload: 'hi' });
                assert.equal(result.msg.payload, 'answer');
            });
        }

        it("foundry outputType ' msg ' (untrimmed) fails before the SDK call", async function () {
            const n1 = await load('azure-foundry-llm', { outputType: ' msg ' });
            const result = await run(n1, { payload: 'hi' });
            assert.equal(result.err.message, 'Unsupported target property type:  msg ');
            assertNothingStarted();
        });

        it('email-read without an output type writes msg.<output>', async function () {
            const n1 = await load('azure-email-read', { output: 'emails', outputType: undefined });
            const result = await run(n1, {});
            assert.equal(result.msg.emails.action, 'read');
        });

        it("directory-action without a property writes Azure's msg.file.content", async function () {
            const n1 = await load('azure-directory-action', {
                property: undefined,
                propertyType: undefined,
            });
            const result = await run(n1, {});
            assert.equal(result.msg.file.content.path, 'dir');
        });

        it('search query without top and skip leaves both out', async function () {
            const n1 = await load('azure-ai-search-query', { top: '', skip: '' });
            await run(n1, { payload: 'x' });
            assert.equal('top' in fixture.requests[0].body, false);
            assert.equal('skip' in fixture.requests[0].body, false);
        });
    });

    describe('T6 the new literals', function () {
        it('P3: file-write data of type bin writes its bytes', async function () {
            const n1 = await load('azure-file-write', { data: '[104,105]', dataType: 'bin' });
            const result = await run(n1, {});
            assert.ok(result.msg, result.err && result.err.message);
            assert.equal(String(fixture.service.share(SHARE).readFile('out.txt')), 'hi');
        });

        it('P4: email-write attachments of type json are sent', async function () {
            const n1 = await load('azure-email-write', {
                attachments: '[{"name":"a.txt","content":"aGk="}]',
                attachmentsType: 'json',
            });
            const result = await run(n1, {});
            assert.ok(result.msg, result.err && result.err.message);
            assert.equal(fixture.requests[0].body.message.attachments[0].name, 'a.txt');
        });

        it('D5: an attachments evaluation error is still swallowed', async function () {
            const n1 = await load('azure-email-write', {
                attachments: '$$$(',
                attachmentsType: 'jsonata',
            });
            const result = await run(n1, {});
            assert.ok(result.msg, result.err && result.err.message);
            assert.equal(fixture.requests[0].body.message.attachments, undefined);
        });

        it('P5: email-write to of type json sends the recipients', async function () {
            const n1 = await load('azure-email-write', {
                to: '[{"address":"a@example.test","name":"A"}]',
                toType: 'json',
            });
            await run(n1, {});
            assert.deepEqual(fixture.requests[0].body.message.toRecipients, [
                { emailAddress: { address: 'a@example.test', name: 'A' } },
            ]);
        });

        it('P7: foundry input of type json reaches the Responses call', async function () {
            const input = [{ role: 'user', content: 'hi' }];
            const n1 = await load('azure-foundry-llm', {
                input: JSON.stringify(input),
                inputType: 'json',
            });
            const result = await run(n1, {});
            assert.ok(result.msg, result.err && result.err.message);
            assert.deepEqual(fixture.sdk.find((c) => c.body).body.input, input);
        });
    });
});
