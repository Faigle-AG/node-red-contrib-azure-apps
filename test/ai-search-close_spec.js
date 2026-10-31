const assert = require('assert/strict');
const helper = require('node-red-node-test-helper');
const indexNode = require('../src/ai-search-index.js');
const queryNode = require('../src/ai-search-query.js');
const syncNode = require('../src/ai-search-sync.js');
const {
    settle,
    fakeFetch,
    response,
    deferred,
    holdCalls,
    holdFirst,
    observe,
    assertQuiet,
    fakeAuthConfig,
    tokenControl,
    failFirstAbort,
    countAborts,
    lateStatuses,
} = require('./helpers/close');

helper.init(require.resolve('node-red'));

// The Azure AI Search nodes against a fake fetch and a fake auth config (Phase 2.8d). Close
// aborts the request through the node's own controller and is not reported as its timeout.
const COMMON = {
    endpoint: 'https://search.example.test',
    endpointType: 'str',
    indexName: 'idx',
    indexNameType: 'str',
    output: 'payload',
    outputType: 'msg',
};
const NODES = {
    'azure-ai-search-index': {
        module: indexNode,
        config: { operation: 'get', timeoutMs: '30000' },
        msg: () => ({}),
        reply: () => response({ name: 'idx' }),
    },
    'azure-ai-search-query': {
        module: queryNode,
        config: { query: 'payload', queryType: 'msg', timeoutMs: '30000', timeoutMsType: 'num' },
        msg: () => ({ payload: 'hotel' }),
        reply: () => response({ value: [] }),
    },
    'azure-ai-search-sync': {
        module: syncNode,
        config: { documents: 'payload', documentsType: 'msg', batchSize: '1', timeoutMs: '30000' },
        msg: () => ({ payload: [{ id: '1' }, { id: '2' }] }),
        reply: () => response({ value: [{ key: '1', status: true }] }),
    },
};

describe('Azure AI Search nodes: close during in-flight work (2.8d)', function () {
    this.timeout(10000);
    let fetches;
    let tokens;

    beforeEach(function (done) {
        fetches = fakeFetch();
        helper.startServer(done);
    });

    afterEach(function (done) {
        // The fake ends after unload, so close-time work still meets it, never the network.
        helper.unload().then(() => {
            fetches.restore();
            helper.stopServer(done);
        });
    });

    function load(type, nodeConfig = {}, authType = 'apiKey') {
        tokens = tokenControl();
        return helper.load(
            [fakeAuthConfig(tokens), NODES[type].module],
            [
                { id: 'auth', type: 'azure-auth-config', authType },
                {
                    id: 'n1',
                    type,
                    config: 'auth',
                    ...COMMON,
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
            it('closing while its values are read sends no request and completes quietly', async function () {
                await load(type);
                const n1 = helper.getNode('n1');
                const reads = holdFirst(n1, 'getValidatedProperty');
                n1.receive(spec.msg());
                await settle();
                assert.equal(reads.length, 1);
                await n1.close();
                const seen = observe(helper, n1);
                await reads[0].release();
                await settle();
                assert.equal(fetches.requests.length, 0);
                assertQuiet(assert, seen);
            });

            it('closing while its values are read requests no Entra token', async function () {
                await load(type, {}, 'entra');
                const n1 = helper.getNode('n1');
                const reads = holdFirst(n1, 'getValidatedProperty');
                n1.receive(spec.msg());
                await settle();
                assert.equal(reads.length, 1);
                await n1.close();
                const seen = observe(helper, n1);
                await reads[0].release();
                await settle();
                assert.equal(tokens.calls, 0);
                assert.equal(fetches.requests.length, 0);
                assertQuiet(assert, seen);
            });

            it('closing in the same tick as the input sets no later status and sends nothing', async function () {
                await load(type);
                const n1 = helper.getNode('n1');
                const statuses = lateStatuses(n1);
                n1.receive(spec.msg());
                const closed = n1.close();
                statuses.mark();
                const seen = observe(helper, n1);
                await closed;
                await settle();
                assert.deepEqual(statuses.late, []);
                assert.equal(fetches.requests.length, 0);
                assert.deepEqual(seen.completions, [undefined]);
                assert.equal(seen.sends, 0);
                assert.deepEqual(seen.errors, []);
            });

            it('a value read rejected after close completes quietly', async function () {
                await load(type);
                const n1 = helper.getNode('n1');
                const reads = holdFirst(n1, 'getValidatedProperty');
                n1.receive(spec.msg());
                await settle();
                await n1.close();
                const seen = observe(helper, n1);
                reads[0].reject(new Error('context store failed'));
                await settle();
                assertQuiet(assert, seen);
            });

            it('closing while the Entra token is requested sends no request', async function () {
                await load(type, {}, 'entra');
                tokens.hold = true;
                const n1 = helper.getNode('n1');
                n1.receive(spec.msg());
                await settle();
                assert.equal(tokens.held.length, 1);
                await n1.close();
                const seen = observe(helper, n1);
                tokens.held[0].resolve('fake-token');
                await settle();
                assert.equal(fetches.requests.length, 0);
                assertQuiet(assert, seen);
            });

            it('close aborts the request in flight and is not reported as a timeout', async function () {
                await load(type);
                const n1 = helper.getNode('n1');
                n1.receive(spec.msg());
                await settle();
                assert.equal(fetches.requests.length, 1);
                const seen = observe(helper, n1);
                await n1.close();
                await settle();
                assert.equal(fetches.requests[0].options.signal?.aborted, true);
                assertQuiet(assert, seen);
            });

            it('a response that settles at close is not reported', async function () {
                await load(type);
                const n1 = helper.getNode('n1');
                n1.receive(spec.msg());
                await settle();
                fetches.requests[0].reply.resolve(spec.reply());
                const closed = n1.close();
                const seen = observe(helper, n1);
                await closed;
                await settle();
                assert.equal(fetches.requests.length, 1);
                assertQuiet(assert, seen);
            });

            it('a response body still being read at close is not reported', async function () {
                await load(type);
                const n1 = helper.getNode('n1');
                const writes = holdCalls(n1, 'setTypedProperty');
                n1.receive(spec.msg());
                await settle();
                const body = deferred();
                fetches.requests[0].reply.resolve(response(null, { text: () => body.promise }));
                await settle();
                await n1.close();
                const seen = observe(helper, n1);
                body.resolve(JSON.stringify({ value: [{ key: '1', status: true }] }));
                await settle();
                assert.equal(fetches.requests.length, 1);
                assert.equal(writes.length, 0);
                assertQuiet(assert, seen);
            });

            for (const outcome of ['resolves', 'rejects']) {
                it(`an output write that ${outcome} after close reports nothing`, async function () {
                    await load(type, type === 'azure-ai-search-sync' ? { batchSize: '500' } : {});
                    const n1 = helper.getNode('n1');
                    const writes = holdCalls(n1, 'setTypedProperty');
                    n1.receive(spec.msg());
                    await settle();
                    fetches.requests[0].reply.resolve(spec.reply());
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

            it('two requests in flight are both aborted at close, even if one abort throws', async function () {
                await load(type);
                const n1 = helper.getNode('n1');
                const warnings = [];
                n1.on('call:warn', (call) => warnings.push(call.args[0]));
                n1.receive(spec.msg());
                n1.receive(spec.msg());
                await settle();
                assert.equal(fetches.requests.length, 2);
                const seen = observe(helper, n1);
                const restore = failFirstAbort();
                try {
                    await n1.close();
                } finally {
                    restore();
                }
                // The first abort threw, so its request is still open; answer it after close.
                fetches.requests[0].reply.resolve(spec.reply());
                await settle();
                assert.equal(fetches.requests[1].options.signal?.aborted, true);
                assert.equal(fetches.requests.length, 2);
                assert.equal(warnings.length, 1);
                assertQuiet(assert, seen, 2);
            });

            // Controls: these pass before and after the change.

            it('a request that completes before close sends its result', async function () {
                await load(type, type === 'azure-ai-search-sync' ? { batchSize: '500' } : {});
                const n1 = helper.getNode('n1');
                const seen = observe(helper, n1);
                n1.receive(spec.msg());
                await settle();
                fetches.requests[0].reply.resolve(spec.reply());
                await settle();
                assert.equal(seen.sends, 1);
                assert.deepEqual(seen.completions, [undefined]);
            });

            // sync sends one request per batch (two here), each answered as it starts.
            it('requests that finished before close are not aborted at close', async function () {
                await load(type);
                const n1 = helper.getNode('n1');
                const seen = observe(helper, n1);
                n1.receive(spec.msg());
                await settle();
                for (let i = 0; i < fetches.requests.length; i += 1) {
                    fetches.requests[i].reply.resolve(spec.reply());
                    await settle();
                }
                assert.equal(seen.sends, 1);
                assert.equal(fetches.requests.length, type === 'azure-ai-search-sync' ? 2 : 1);
                assert.equal(await countAborts(() => n1.close()), 0);
            });

            it('a request timeout while open keeps its REQUEST_TIMEOUT error and status', async function () {
                await load(type, { timeoutMs: '1000' });
                const n1 = helper.getNode('n1');
                const seen = observe(helper, n1);
                n1.receive(spec.msg());
                await new Promise((resolve) => setTimeout(resolve, 1300));
                assert.equal(seen.completions.length, 1);
                assert.equal(seen.completions[0].code, 'REQUEST_TIMEOUT');
                assert.equal(seen.statuses.at(-1).fill, 'red');
                assert.equal(seen.sends, 0);
            });
        });
    }

    describe('azure-ai-search-sync batches', function () {
        it('closing while a batch response is read sends no further batch', async function () {
            await load('azure-ai-search-sync');
            const n1 = helper.getNode('n1');
            n1.receive(NODES['azure-ai-search-sync'].msg());
            await settle();
            const body = deferred();
            fetches.requests[0].reply.resolve(response(null, { text: () => body.promise }));
            await settle();
            await n1.close();
            const seen = observe(helper, n1);
            body.resolve(JSON.stringify({ value: [{ key: '1', status: true }] }));
            await settle();
            assert.equal(fetches.requests.length, 1);
            assertQuiet(assert, seen);
        });
    });
});
