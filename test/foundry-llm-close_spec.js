const assert = require('assert/strict');
const helper = require('node-red-node-test-helper');
const { OpenAI } = require('openai');
const foundryNode = require('../src/foundry-llm.js');
const {
    settle,
    fakeFetch,
    holdCalls,
    releaseAll,
    observe,
    assertQuiet,
    fakeAuthConfig,
    tokenControl,
    failFirstAbort,
    countAborts,
    lateStatuses,
} = require('./helpers/close');

helper.init(require.resolve('node-red'));

// azure-foundry-llm against a fake fetch that the real OpenAI SDK calls (Phase 2.8c).
const reply = () =>
    new Response(
        JSON.stringify({
            id: 'resp_1',
            object: 'response',
            model: 'gpt-test',
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'pong' }] }],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
    );
const readValue = ([value]) => value;

// Records every SDK responses.create call (each start, with its options) and passes it on.
function spyCreate() {
    const original = OpenAI.Responses.prototype.create;
    const calls = [];
    OpenAI.Responses.prototype.create = function (body, options) {
        calls.push({ body, options });
        return original.call(this, body, options);
    };
    return { calls, restore: () => (OpenAI.Responses.prototype.create = original) };
}

describe('azure-foundry-llm: close during in-flight work (2.8c)', function () {
    this.timeout(10000);
    let fetches;
    let tokens;
    let creates;

    beforeEach(function (done) {
        fetches = fakeFetch();
        creates = spyCreate();
        helper.startServer(done);
    });

    afterEach(function (done) {
        // The fake ends after unload, so close-time work still meets it, never the network.
        helper.unload().then(() => {
            fetches.restore();
            creates.restore();
            helper.stopServer(done);
        });
    });

    function load(nodeConfig = {}, authType = 'apiKey') {
        tokens = tokenControl();
        return helper.load(
            [fakeAuthConfig(tokens), foundryNode],
            [
                { id: 'auth', type: 'azure-auth-config', authType },
                {
                    id: 'n1',
                    type: 'azure-foundry-llm',
                    config: 'auth',
                    endpoint: 'https://foundry.example.test/openai/v1',
                    endpointType: 'str',
                    model: 'gpt-test',
                    modelType: 'str',
                    input: 'payload',
                    inputType: 'msg',
                    output: 'payload',
                    outputType: 'msg',
                    outputMode: 'text',
                    maxRetries: '0',
                    timeoutMs: '',
                    wires: [['out']],
                    ...nodeConfig,
                },
                { id: 'out', type: 'helper' },
            ],
        );
    }

    it('closing while its values are read sends no request and completes quietly', async function () {
        await load();
        const n1 = helper.getNode('n1');
        const reads = holdCalls(n1, 'getTypedProperty');
        n1.receive({ payload: 'ping' });
        await settle();
        await n1.close();
        const seen = observe(helper, n1);
        await releaseAll(reads, readValue);
        assert.equal(fetches.requests.length, 0);
        assertQuiet(assert, seen);
    });

    it('closing while its values are read requests no Entra token', async function () {
        await load({}, 'entra');
        const n1 = helper.getNode('n1');
        const reads = holdCalls(n1, 'getTypedProperty');
        n1.receive({ payload: 'ping' });
        await settle();
        await n1.close();
        const seen = observe(helper, n1);
        await releaseAll(reads, readValue);
        assert.equal(tokens.calls, 0);
        assert.equal(fetches.requests.length, 0);
        assertQuiet(assert, seen);
    });

    it('closing in the same tick as the input sets no later status and starts no SDK call', async function () {
        await load();
        const n1 = helper.getNode('n1');
        const statuses = lateStatuses(n1);
        n1.receive({ payload: 'ping' });
        const closed = n1.close();
        statuses.mark();
        const seen = observe(helper, n1);
        await closed;
        await settle();
        assert.deepEqual(statuses.late, []);
        assert.equal(creates.calls.length, 0);
        assert.deepEqual(seen.completions, [undefined]);
        assert.equal(seen.sends, 0);
        assert.deepEqual(seen.errors, []);
    });

    it('a value read rejected after close completes quietly', async function () {
        await load();
        const n1 = helper.getNode('n1');
        const reads = holdCalls(n1, 'getTypedProperty');
        n1.receive({ payload: 'ping' });
        await settle();
        await n1.close();
        const seen = observe(helper, n1);
        reads[0].reject(new Error('context store failed'));
        await settle();
        assertQuiet(assert, seen);
    });

    it('closing while the Entra token is requested starts no SDK call', async function () {
        await load({}, 'entra');
        tokens.hold = true;
        const n1 = helper.getNode('n1');
        n1.receive({ payload: 'ping' });
        await settle();
        assert.equal(tokens.held.length, 1);
        await n1.close();
        const seen = observe(helper, n1);
        tokens.held[0].resolve('fake-token');
        await settle();
        assert.equal(creates.calls.length, 0);
        assert.equal(fetches.requests.length, 0);
        assertQuiet(assert, seen);
    });

    it('close aborts the request in flight and completes quietly', async function () {
        await load();
        const n1 = helper.getNode('n1');
        n1.receive({ payload: 'ping' });
        await settle();
        assert.equal(fetches.requests.length, 1);
        const seen = observe(helper, n1);
        await n1.close();
        await settle();
        assert.equal(fetches.requests[0].options.signal?.aborted, true);
        assertQuiet(assert, seen);
    });

    it('a response that settles at close starts no output write', async function () {
        await load();
        const n1 = helper.getNode('n1');
        const writes = holdCalls(n1, 'setTypedProperty');
        n1.receive({ payload: 'ping' });
        await settle();
        fetches.requests[0].reply.resolve(reply());
        const closed = n1.close();
        const seen = observe(helper, n1);
        await closed;
        await settle();
        assert.equal(writes.length, 0);
        assertQuiet(assert, seen);
    });

    for (const outcome of ['resolves', 'rejects']) {
        it(`an output write that ${outcome} after close reports nothing`, async function () {
            await load();
            const n1 = helper.getNode('n1');
            const writes = holdCalls(n1, 'setTypedProperty');
            n1.receive({ payload: 'ping' });
            await settle();
            fetches.requests[0].reply.resolve(reply());
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
        await load();
        const n1 = helper.getNode('n1');
        const writes = holdCalls(n1, 'setTypedProperty');
        const warnings = [];
        n1.on('call:warn', (call) => warnings.push(call.args[0]));
        n1.receive({ payload: 'a' });
        n1.receive({ payload: 'b' });
        await settle();
        assert.equal(fetches.requests.length, 2);
        const seen = observe(helper, n1);
        const restore = failFirstAbort();
        try {
            await n1.close();
        } finally {
            restore();
        }
        // The first abort threw, so its request is still open; answer it after close. Its
        // response must not reach the output write.
        fetches.requests[0].reply.resolve(reply());
        await settle();
        assert.equal(fetches.requests[1].options.signal?.aborted, true);
        assert.equal(warnings.length, 1);
        assert.equal(writes.length, 0);
        assertQuiet(assert, seen, 2);
    });

    // Controls: these pass before and after the change.

    it('a request that finished before close is not aborted at close', async function () {
        await load();
        const n1 = helper.getNode('n1');
        const seen = observe(helper, n1);
        n1.receive({ payload: 'ping' });
        await settle();
        fetches.requests[0].reply.resolve(reply());
        await settle();
        assert.equal(seen.sends, 1);
        assert.equal(await countAborts(() => n1.close()), 0);
    });

    it('a response that arrives before close is sent', async function () {
        await load();
        const n1 = helper.getNode('n1');
        const seen = observe(helper, n1);
        n1.receive({ payload: 'ping' });
        await settle();
        fetches.requests[0].reply.resolve(reply());
        await settle();
        assert.equal(seen.sends, 1);
        assert.deepEqual(seen.completions, [undefined]);
    });

    it('an SDK timeout while open keeps its error and status', async function () {
        await load({ timeoutMs: '1000' });
        const n1 = helper.getNode('n1');
        const seen = observe(helper, n1);
        n1.receive({ payload: 'ping' });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        assert.equal(seen.completions.length, 1);
        // Today's identity: the SDK timeout error is the cause of a normalized Error.
        const err = seen.completions[0];
        assert.equal(err.name, 'Error');
        assert.equal(err.code, 'Error');
        assert.equal(err.message, 'Request timed out.');
        assert.equal(err.cause.constructor.name, 'APIConnectionTimeoutError');
        assert.deepEqual(seen.statuses.at(-1), { fill: 'red', shape: 'dot', text: 'Error' });
        assert.equal(seen.sends, 0);
    });
});
