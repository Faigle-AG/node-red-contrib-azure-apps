const assert = require('assert/strict');
const helper = require('node-red-node-test-helper');
const emailConfigNode = require('../src/email-config.js');
const emailReadNode = require('../src/email-read.js');
const emailTransferNode = require('../src/email-transfer.js');
const emailWriteNode = require('../src/email-write.js');
const {
    settle,
    fakeFetch,
    response,
    deferred,
    holdCalls,
    releaseAll,
    observe,
    assertQuiet,
    fakeAuthConfig,
    tokenControl,
    failFirstAbort,
    countAborts,
} = require('./helpers/close');

helper.init(require.resolve('node-red'));

// The Graph email nodes against a fake fetch and a fake auth config (Phase 2.8a). Typed values
// resolve to their configured string, except attachments, which resolve to none.
const NODES = {
    'azure-email-read': {
        module: emailReadNode,
        config: { folderId: 'inbox', limit: 1, output: 'email', outputType: 'msg' },
        reply: () => response({ value: [{ id: 'm1' }] }),
    },
    'azure-email-transfer': {
        module: emailTransferNode,
        config: {
            messageId: 'm1',
            messageIdType: 'str',
            destinationId: 'archive',
            destinationName: 'Archive',
        },
        reply: () => response({ id: 'm1-moved' }),
    },
    'azure-email-write': {
        module: emailWriteNode,
        config: {
            to: 'to@example.invalid',
            toType: 'str',
            subject: 'Subject',
            subjectType: 'str',
            body: 'Body',
            bodyType: 'str',
            attachments: '',
            attachmentsType: 'str',
        },
        reply: () => response(null, { status: 202 }),
    },
};
const readValue = ([value]) => value || [];

describe('Graph email nodes: close during in-flight work (2.8a)', function () {
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

    function load(type) {
        tokens = tokenControl();
        return helper.load(
            [fakeAuthConfig(tokens), emailConfigNode, NODES[type].module],
            [
                { id: 'auth', type: 'azure-auth-config' },
                {
                    id: 'cfg',
                    type: 'azure-email-config',
                    auth: 'auth',
                    userId: 'user@example.invalid',
                    userIdType: 'str',
                },
                { id: 'n1', type, config: 'cfg', ...NODES[type].config, wires: [['out']] },
                { id: 'out', type: 'helper' },
            ],
        );
    }

    for (const type of Object.keys(NODES)) {
        describe(type, function () {
            it('closing while its values are read sends no request and completes quietly', async function () {
                await load(type);
                const n1 = helper.getNode('n1');
                const reads = holdCalls(n1, 'getTypedProperty');
                n1.receive({});
                await settle();
                await n1.close();
                const seen = observe(helper, n1);
                await releaseAll(reads, readValue);
                assert.equal(tokens.calls, 0);
                assert.equal(fetches.requests.length, 0);
                assertQuiet(assert, seen);
            });

            it('a value read rejected after close completes quietly', async function () {
                await load(type);
                const n1 = helper.getNode('n1');
                const reads = holdCalls(n1, 'getTypedProperty');
                n1.receive({});
                await settle();
                await n1.close();
                const seen = observe(helper, n1);
                reads[0].reject(new Error('context store failed'));
                await settle();
                assertQuiet(assert, seen);
            });

            it('closing while the token is requested sends no request', async function () {
                await load(type);
                tokens.hold = true;
                const n1 = helper.getNode('n1');
                n1.receive({});
                await settle();
                assert.equal(tokens.held.length, 1);
                await n1.close();
                const seen = observe(helper, n1);
                tokens.held[0].resolve('fake-token');
                await settle();
                assert.equal(fetches.requests.length, 0);
                assertQuiet(assert, seen);
            });

            it('close aborts the request in flight and completes quietly', async function () {
                await load(type);
                const n1 = helper.getNode('n1');
                n1.receive({});
                await settle();
                assert.equal(fetches.requests.length, 1);
                // The abort settles the request during close, so observe from before it.
                const seen = observe(helper, n1);
                await n1.close();
                await settle();
                assert.equal(fetches.requests[0].options.signal?.aborted, true);
                assertQuiet(assert, seen);
            });

            it('a response that settles at close is not reported', async function () {
                await load(type);
                const n1 = helper.getNode('n1');
                n1.receive({});
                await settle();
                fetches.requests[0].reply.resolve(NODES[type].reply());
                const closed = n1.close();
                const seen = observe(helper, n1);
                await closed;
                await settle();
                assertQuiet(assert, seen);
            });

            it('an error response whose body is read after close is not reported', async function () {
                await load(type);
                const n1 = helper.getNode('n1');
                n1.receive({});
                await settle();
                const body = deferred();
                fetches.requests[0].reply.resolve(
                    response(null, { ok: false, status: 500, text: () => body.promise }),
                );
                await settle();
                await n1.close();
                const seen = observe(helper, n1);
                body.resolve('server error');
                await settle();
                assertQuiet(assert, seen);
            });

            it('two requests in flight are both aborted at close, even if one abort throws', async function () {
                await load(type);
                const n1 = helper.getNode('n1');
                const warnings = [];
                n1.on('call:warn', (call) => warnings.push(call.args[0]));
                n1.receive({});
                n1.receive({});
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
                fetches.requests[0].reply.resolve(NODES[type].reply());
                await settle();
                assert.equal(fetches.requests[0].options.signal?.aborted, false);
                assert.equal(fetches.requests[1].options.signal?.aborted, true);
                assert.equal(warnings.length, 1);
                assertQuiet(assert, seen, 2);
            });

            // Controls: these pass before and after the change.

            it('a request that finished before close is not aborted at close', async function () {
                await load(type);
                const n1 = helper.getNode('n1');
                const seen = observe(helper, n1);
                n1.receive({});
                await settle();
                fetches.requests[0].reply.resolve(NODES[type].reply());
                await settle();
                assert.equal(seen.sends, 1);
                assert.equal(await countAborts(() => n1.close()), 0);
            });

            it('a request that completes before close sends its result', async function () {
                await load(type);
                const n1 = helper.getNode('n1');
                const seen = observe(helper, n1);
                n1.receive({});
                await settle();
                fetches.requests[0].reply.resolve(NODES[type].reply());
                await settle();
                assert.equal(seen.sends, 1);
                assert.deepEqual(seen.completions, [undefined]);
            });

            it('an HTTP error while open fails with the Graph error text', async function () {
                await load(type);
                const n1 = helper.getNode('n1');
                const seen = observe(helper, n1);
                n1.receive({});
                await settle();
                fetches.requests[0].reply.resolve(
                    response(null, { ok: false, status: 500, text: async () => 'server error' }),
                );
                await settle();
                assert.equal(seen.completions.length, 1);
                assert.equal(seen.completions[0].message, 'Graph API error 500: server error');
                assert.equal(seen.statuses.at(-1).fill, 'red');
                assert.equal(seen.sends, 0);
            });
        });
    }

    describe('azure-email-read output write', function () {
        for (const outcome of ['resolves', 'rejects']) {
            it(`an output write that ${outcome} after close reports nothing`, async function () {
                await load('azure-email-read');
                const n1 = helper.getNode('n1');
                const writes = holdCalls(n1, 'setTypedProperty');
                n1.receive({});
                await settle();
                fetches.requests[0].reply.resolve(NODES['azure-email-read'].reply());
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

        it('a JSON body still being read at close is not reported', async function () {
            await load('azure-email-read');
            const n1 = helper.getNode('n1');
            const writes = holdCalls(n1, 'setTypedProperty');
            n1.receive({});
            await settle();
            const body = deferred();
            fetches.requests[0].reply.resolve(response(null, { json: () => body.promise }));
            await settle();
            await n1.close();
            const seen = observe(helper, n1);
            body.resolve({ value: [{ id: 'm1' }] });
            await settle();
            assert.equal(writes.length, 0);
            assertQuiet(assert, seen);
        });
    });
});
