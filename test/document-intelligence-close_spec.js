const assert = require('assert/strict');
const helper = require('node-red-node-test-helper');
const documentIntelligenceNode = require('../src/document-intelligence.js');
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
    strayRequests,
} = require('./helpers/close');

helper.init(require.resolve('node-red'));

// azure-document-intelligence against a fake fetch and a fake auth config (Phase 2.8b). The node
// polls every 2 s, so tests that need a poll wait for it.
const POLL_MS = 2000;
const waitForPoll = () => new Promise((resolve) => setTimeout(resolve, POLL_MS + 200));
const OPERATION = 'https://fake.invalid/operations/1';
const accepted = () =>
    response(null, { status: 202, headers: { 'operation-location': OPERATION } });
const readValue = ([value]) => (value === 'payload' ? 'https://fake.invalid/doc.pdf' : value);

describe('azure-document-intelligence: close during in-flight work (2.8b)', function () {
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

    function load() {
        tokens = tokenControl();
        return helper.load(
            [fakeAuthConfig(tokens), documentIntelligenceNode],
            [
                { id: 'auth', type: 'azure-auth-config' },
                {
                    id: 'n1',
                    type: 'azure-document-intelligence',
                    config: 'auth',
                    endpoint: 'https://fake.invalid',
                    endpointType: 'str',
                    modelId: 'prebuilt-read',
                    modelIdType: 'str',
                    documentData: 'payload',
                    documentDataType: 'msg',
                    inputType: 'url',
                    output: 'document',
                    outputType: 'msg',
                    wires: [['out']],
                },
                { id: 'out', type: 'helper' },
            ],
        );
    }

    async function startAndSubmit() {
        await load();
        const n1 = helper.getNode('n1');
        n1.receive({ payload: 'https://fake.invalid/doc.pdf' });
        await settle();
        assert.equal(fetches.requests.length, 1);
        fetches.requests[0].reply.resolve(accepted());
        await settle();
        return n1;
    }

    it('closing while its values are read submits nothing and completes quietly', async function () {
        await load();
        const n1 = helper.getNode('n1');
        const reads = holdCalls(n1, 'getTypedProperty');
        n1.receive({ payload: 'https://fake.invalid/doc.pdf' });
        await settle();
        await n1.close();
        const seen = observe(helper, n1);
        await releaseAll(reads, readValue);
        assert.equal(tokens.calls, 0);
        assert.equal(fetches.requests.length, 0);
        assertQuiet(assert, seen);
    });

    it('a value read rejected after close completes quietly', async function () {
        await load();
        const n1 = helper.getNode('n1');
        const reads = holdCalls(n1, 'getTypedProperty');
        n1.receive({ payload: 'https://fake.invalid/doc.pdf' });
        await settle();
        await n1.close();
        const seen = observe(helper, n1);
        reads[0].reject(new Error('context store failed'));
        await settle();
        assertQuiet(assert, seen);
    });

    it('closing while the token is requested submits nothing', async function () {
        await load();
        tokens.hold = true;
        const n1 = helper.getNode('n1');
        n1.receive({ payload: 'https://fake.invalid/doc.pdf' });
        await settle();
        assert.equal(tokens.held.length, 1);
        await n1.close();
        const seen = observe(helper, n1);
        tokens.held[0].resolve('fake-token');
        await settle();
        assert.equal(fetches.requests.length, 0);
        assertQuiet(assert, seen);
    });

    it('close aborts the submit request in flight and completes quietly', async function () {
        await load();
        const n1 = helper.getNode('n1');
        n1.receive({ payload: 'https://fake.invalid/doc.pdf' });
        await settle();
        const seen = observe(helper, n1);
        await n1.close();
        await settle();
        assert.equal(fetches.requests[0].options.signal?.aborted, true);
        assertQuiet(assert, seen);
    });

    it('closing between polls sends no further poll and completes quietly', async function () {
        const n1 = await startAndSubmit();
        const seen = observe(helper, n1);
        await n1.close();
        // Close ends the poll wait at once rather than when it runs out.
        await settle();
        assert.deepEqual(seen.completions, [undefined]);
        await waitForPoll();
        assert.equal(fetches.requests.length, 1);
        assertQuiet(assert, seen);
    });

    it('closing during the poll wait sends no poll, even if the abort throws', async function () {
        const n1 = await startAndSubmit();
        const warnings = [];
        n1.on('call:warn', (call) => warnings.push(call.args[0]));
        const seen = observe(helper, n1);
        const restore = failFirstAbort();
        try {
            await n1.close();
        } finally {
            restore();
        }
        // The abort threw, so the wait was not cut short; let it run out.
        await waitForPoll();
        assert.equal(fetches.requests.length, 1);
        assert.equal(warnings.length, 1);
        assertQuiet(assert, seen);
    });

    it('close aborts the poll in flight and completes quietly', async function () {
        const n1 = await startAndSubmit();
        await waitForPoll();
        assert.equal(fetches.requests.length, 2);
        const seen = observe(helper, n1);
        await n1.close();
        await settle();
        assert.equal(fetches.requests[1].options.signal?.aborted, true);
        assertQuiet(assert, seen);
    });

    it('a poll result still being read at close is not reported', async function () {
        const n1 = await startAndSubmit();
        const writes = holdCalls(n1, 'setTypedProperty');
        await waitForPoll();
        const body = deferred();
        fetches.requests[1].reply.resolve(response(null, { json: () => body.promise }));
        await settle();
        await n1.close();
        const seen = observe(helper, n1);
        body.resolve({ status: 'succeeded', analyzeResult: {} });
        await settle();
        assert.equal(writes.length, 0);
        assertQuiet(assert, seen);
    });

    for (const outcome of ['resolves', 'rejects']) {
        it(`an output write that ${outcome} after close reports nothing`, async function () {
            const n1 = await startAndSubmit();
            const writes = holdCalls(n1, 'setTypedProperty');
            await waitForPoll();
            fetches.requests[1].reply.resolve(response({ status: 'succeeded', analyzeResult: {} }));
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

    it('two submits in flight are both aborted at close, even if one abort throws', async function () {
        await load();
        const n1 = helper.getNode('n1');
        const warnings = [];
        n1.on('call:warn', (call) => warnings.push(call.args[0]));
        n1.receive({ payload: 'https://fake.invalid/a.pdf' });
        n1.receive({ payload: 'https://fake.invalid/b.pdf' });
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
        fetches.requests[0].reply.resolve(accepted());
        await waitForPoll();
        assert.equal(fetches.requests[1].options.signal?.aborted, true);
        assert.equal(fetches.requests.length, 2);
        assert.equal(warnings.length, 1);
        assertQuiet(assert, seen, 2);
    });

    // Fixture check for the fetch fence: work that outlives its fixture, like a poll timer left by
    // code that ignores close, is refused rather than sent or given to a later test's fake.
    it('fetch fence: a request from work that outlived its fixture is refused', async function () {
        const old = fakeFetch();
        const later = deferred();
        setTimeout(
            () => later.resolve(fetch('https://fake.invalid/stale').catch((err) => err)),
            30,
        );
        old.restore();
        const current = fakeFetch();
        const err = await later.promise;
        assert.match(err.message, /outside an active test fixture/);
        assert.equal(old.requests.length, 0);
        assert.equal(current.requests.length, 0);
        // Remove only this check's own entry; any other stray still fails the run at the end.
        const index = strayRequests.indexOf('https://fake.invalid/stale');
        assert.notEqual(index, -1);
        strayRequests.splice(index, 1);
        current.restore();
    });

    // Controls: these pass before and after the change.

    it('an analysis that finished before close is not aborted at close', async function () {
        const n1 = await startAndSubmit();
        const seen = observe(helper, n1);
        await waitForPoll();
        fetches.requests[1].reply.resolve(response({ status: 'succeeded', analyzeResult: {} }));
        await settle();
        assert.equal(seen.sends, 1);
        assert.equal(await countAborts(() => n1.close()), 0);
    });

    it('an analysis that completes before close sends its result', async function () {
        const n1 = await startAndSubmit();
        const seen = observe(helper, n1);
        await waitForPoll();
        fetches.requests[1].reply.resolve(response({ status: 'succeeded', analyzeResult: {} }));
        await settle();
        assert.equal(seen.sends, 1);
        assert.deepEqual(seen.completions, [undefined]);
    });

    it('a submit error while open fails with the Analyze API error text', async function () {
        await load();
        const n1 = helper.getNode('n1');
        const seen = observe(helper, n1);
        n1.receive({ payload: 'https://fake.invalid/doc.pdf' });
        await settle();
        fetches.requests[0].reply.resolve(
            response(null, { ok: false, status: 500, text: async () => 'server error' }),
        );
        await settle();
        assert.equal(seen.completions.length, 1);
        assert.equal(seen.completions[0].message, 'Analyze API error 500: server error');
        assert.equal(seen.statuses.at(-1).fill, 'red');
    });
});
