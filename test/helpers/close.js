'use strict';

const assert = require('assert/strict');
const { AsyncLocalStorage } = require('async_hooks');

// Shared fixtures for the close tests (Phase 2.8): calls the test holds and releases, a fake
// fetch that honours abort signals like the real one, and an observer for what a node reports
// after close. Nothing leaves the process.

function deferred() {
    let resolve, reject;
    const promise = new Promise((a, b) => {
        resolve = a;
        reject = b;
    });
    return { promise, resolve, reject };
}

// Lets awaited continuations and the helper's nextTick call events run.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function abortError() {
    const err = new Error('This operation was aborted');
    err.name = 'AbortError';
    return err;
}

// The fetch fence. Global fetch is replaced once, for the whole run, and never restored: each
// request goes to the fake of the test whose work started it (tracked through the async context).
// Work that outlives its test, such as a timer left by code that ignores close, can then neither
// reach the network nor land in a later test's fake; it is refused and recorded in
// `strayRequests`, and the run fails at the end if there were any.
const fetchOwner = new AsyncLocalStorage();
const strayRequests = [];
let fenceInstalled = false;

function installFetchFence() {
    if (fenceInstalled) return;
    fenceInstalled = true;
    globalThis.fetch = (url, options) => {
        const fixture = fetchOwner.getStore();
        if (!fixture || !fixture.active) {
            strayRequests.push(String(url));
            return Promise.reject(new Error(`fetch outside an active test fixture: ${url}`));
        }
        return fixture.fetch(url, options);
    };
    if (typeof after === 'function') {
        after('no request outlived its test', function () {
            assert.deepEqual(strayRequests, []);
        });
    }
}

// A fake fetch for the current test, behind the fence. Each request waits until the test answers
// it; an aborted signal rejects it with an AbortError, as fetch does. restore() ends the fixture:
// later requests from this test's work are refused.
function fakeFetch() {
    installFetchFence();
    const requests = [];
    const fixture = {
        active: true,
        fetch(url, options = {}) {
            const reply = deferred();
            requests.push({ url: String(url), options, reply });
            const { signal } = options;
            if (signal) {
                if (signal.aborted) return Promise.reject(abortError());
                signal.addEventListener('abort', () => reply.reject(abortError()), { once: true });
            }
            return reply.promise;
        },
    };
    fetchOwner.enterWith(fixture);
    return { requests, restore: () => (fixture.active = false) };
}

// A fetch Response stand-in; `json`/`text` may be given as held promises.
function response(body, { ok = true, status = 200, json, text, headers = {} } = {}) {
    return {
        ok,
        status,
        headers: { get: (name) => headers[name.toLowerCase()] ?? null },
        json: json || (async () => body),
        text: text || (async () => JSON.stringify(body)),
    };
}

// Replaces a node method (getTypedProperty, setTypedProperty, ...) with calls the test releases.
function holdCalls(target, method) {
    const held = [];
    target[method] = (...args) => {
        const call = deferred();
        held.push({ args, ...call });
        return call.promise;
    };
    return held;
}

// Holds only the first call of a node method; later calls go to the original. Release the held
// call with its real result through `release()`.
function holdFirst(target, method) {
    const original = target[method].bind(target);
    const held = [];
    target[method] = (...args) => {
        if (held.length) return original(...args);
        const call = deferred();
        held.push({ args, ...call, release: async () => call.resolve(await original(...args)) });
        return call.promise;
    };
    return held;
}

// Releases held calls in order, including calls the released ones go on to make.
async function releaseAll(held, value) {
    for (let i = 0; i < held.length; i += 1) {
        held[i].resolve(typeof value === 'function' ? value(held[i].args, i) : value);
        await settle();
    }
}

// Records what a node reports from the moment of the call: completions (done/_complete), sends
// (messages reaching the wired helper node `out`), statuses, errors and warnings. The empty status
// that close itself sets (status.clear) is not counted.
function observe(helper, node) {
    const seen = { completions: [], sends: 0, statuses: [], errors: [], warnings: [] };
    const complete = node._complete;
    node._complete = function (msg, err) {
        seen.completions.push(err);
        return complete.call(this, msg, err);
    };
    helper.getNode('out').on('input', () => (seen.sends += 1));
    node.on('call:status', (call) => {
        const status = call.args[0];
        if (status && Object.keys(status).length) seen.statuses.push(status);
    });
    node.on('call:error', (call) => seen.errors.push(call.args[0]));
    node.on('call:warn', (call) => seen.warnings.push(call.args[0]));
    return seen;
}

// Records the node's status calls made after mark(), as they happen. The test helper reports
// status calls a tick late, so a status set just before close would otherwise look like one set
// after it.
function lateStatuses(node) {
    const late = [];
    let marked = false;
    for (const name of ['processing', 'succeeded', 'failed', 'info', 'waiting', 'warning']) {
        const original = node.status[name];
        node.status[name] = (...args) => {
            if (marked) late.push({ [name]: args[0] });
            return original(...args);
        };
    }
    return { late, mark: () => (marked = true) };
}

// A node that closed with work in flight reports nothing more and completes once per input.
function assertQuiet(assert, seen, completions = 1) {
    assert.deepEqual(seen.completions, new Array(completions).fill(undefined));
    assert.equal(seen.sends, 0);
    assert.deepEqual(seen.statuses, []);
    assert.deepEqual(seen.errors, []);
}

// A fake azure-auth-config whose token requests the test can hold.
function fakeAuthConfig(tokens) {
    return function (RED) {
        function FakeAzureAuthConfigNode(config) {
            RED.nodes.createNode(this, config);
            this.authType = config.authType || 'apiKey';
            this.getApiKey = () => 'test-api-key';
            this.getToken = () => {
                tokens.calls += 1;
                return tokens.hold ? tokens.next() : Promise.resolve('fake-token');
            };
        }
        RED.nodes.registerType('azure-auth-config', FakeAzureAuthConfigNode);
    };
}

// Token requests are counted and answered at once unless `hold` is set, in which case each waits
// in `held`.
function tokenControl() {
    const tokens = { hold: false, held: [], calls: 0 };
    tokens.next = () => {
        const call = deferred();
        tokens.held.push(call);
        return call.promise;
    };
    return tokens;
}

// Makes the first AbortController.abort() call throw, to check that close still aborts the rest.
function failFirstAbort() {
    const original = AbortController.prototype.abort;
    let failed = false;
    AbortController.prototype.abort = function (...args) {
        if (!failed) {
            failed = true;
            throw new Error('abort failed');
        }
        return original.apply(this, args);
    };
    return () => (AbortController.prototype.abort = original);
}

// Counts AbortController.abort() calls made while `action` runs, such as a close that should
// leave finished requests alone.
async function countAborts(action) {
    const original = AbortController.prototype.abort;
    let count = 0;
    AbortController.prototype.abort = function (...args) {
        count += 1;
        return original.apply(this, args);
    };
    try {
        await action();
    } finally {
        AbortController.prototype.abort = original;
    }
    return count;
}

module.exports = {
    deferred,
    settle,
    abortError,
    fakeFetch,
    response,
    holdCalls,
    holdFirst,
    releaseAll,
    observe,
    assertQuiet,
    fakeAuthConfig,
    tokenControl,
    failFirstAbort,
    countAborts,
    strayRequests,
    lateStatuses,
};
