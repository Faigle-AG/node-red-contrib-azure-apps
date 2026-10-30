const assert = require('assert/strict');
const helper = require('node-red-node-test-helper');
const directoryWatchNode = require('../src/directory-watch.js');
const { FakeShareServiceClient, fakeConfigNode, restError } = require('./helpers/fake-share');
const { collect, delay } = require('./helpers/harness');

helper.init(require.resolve('node-red'));

const POLL_MS = 250;

// Characterization of the current azure-directory-watch behavior (Phase 2.2a).
describe('azure-directory-watch node', function () {
    this.timeout(5000);

    let service;
    let share;

    function load(nodeConfig) {
        const flow = [
            { id: 'f1', type: 'tab' },
            { id: 'cfg', type: 'azure-file-config' },
            {
                id: 'n1',
                z: 'f1',
                type: 'azure-directory-watch',
                config: 'cfg',
                shareName: 'share',
                shareNameType: 'str',
                source: 'watch',
                pollInterval: POLL_MS,
                awaitWriteFinish: false,
                wires: [['out']],
                ...nodeConfig,
            },
            { id: 'out', z: 'f1', type: 'helper' },
        ];
        return helper.load([fakeConfigNode(service), directoryWatchNode], flow);
    }

    function errorLogs(nodeId) {
        return helper
            .log()
            .args.map((args) => args[0])
            .filter((entry) => entry.id === nodeId && entry.level === helper.log().ERROR);
    }

    // Counts sends, statuses and errors a node reports from now on.
    function track(node) {
        const counts = { sends: 0, statuses: 0, errors: 0 };
        node.on('call:send', () => (counts.sends += 1));
        node.on('call:status', () => (counts.statuses += 1));
        node.on('call:error', () => (counts.errors += 1));
        return { snapshot: () => ({ ...counts }) };
    }

    // Lets already-scheduled spy notifications (process.nextTick) arrive.
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    function listCalls() {
        return share.calls.filter((call) => call.method === 'listFilesAndDirectories').length;
    }

    // Resolves with the first event for `filePath` and the time it arrived.
    function nextEvent(filePath) {
        const out = helper.getNode('out');
        return new Promise((resolve) => {
            out.on('input', function onInput(msg) {
                if (msg.file.path !== filePath) return;
                out.removeListener('input', onInput);
                resolve({ at: Date.now(), msg });
            });
        });
    }

    function eventsFor(filePath) {
        const events = [];
        helper.getNode('out').on('input', (msg) => {
            if (msg.file.path === filePath) events.push(msg);
        });
        return events;
    }

    function propertyCalls(filePath) {
        return share.calls.filter(
            (call) => call.method === 'getProperties' && call.path === filePath,
        );
    }

    // Resolves with the time of the first properties request for `filePath`.
    async function firstObservation(filePath) {
        for (let i = 0; i < 300 && propertyCalls(filePath).length === 0; i++) await delay(5);
        assert.ok(propertyCalls(filePath).length > 0, `${filePath} was never observed`);
        return propertyCalls(filePath)[0].at;
    }

    // Runs this module's own timers after 1 ms and records the delays it asked for, so long
    // backoff sequences can be checked without waiting for them. Test-only.
    function compressWatchTimers() {
        const original = global.setTimeout;
        const requested = [];
        global.setTimeout = function (callback, ms, ...args) {
            const caller = new Error().stack.split('\n')[2] || '';
            if (!caller.includes('directory-watch.js')) return original(callback, ms, ...args);
            requested.push(ms);
            return original(callback, 1, ...args);
        };
        return { requested, restore: () => (global.setTimeout = original) };
    }

    // Records the timers this module asks for (without changing them). Test-only.
    function recordWatchTimers() {
        const original = global.setTimeout;
        const requested = [];
        global.setTimeout = function (callback, ms, ...args) {
            const caller = new Error().stack.split('\n')[2] || '';
            if (caller.includes('directory-watch.js')) requested.push({ ms, at: Date.now() });
            return original(callback, ms, ...args);
        };
        return { requested, restore: () => (global.setTimeout = original) };
    }

    // Holds this module's timers of at least `minMs` instead of running them; fire() runs one
    // with the clock moved forward by the delays fired so far. Test-only.
    function holdLongWatchTimers(minMs) {
        const original = global.setTimeout;
        const held = [];
        let elapsed = 0;
        global.setTimeout = function (callback, ms, ...args) {
            const caller = new Error().stack.split('\n')[2] || '';
            if (!caller.includes('directory-watch.js') || ms < minMs) {
                return original(callback, ms, ...args);
            }
            const handle = original(() => {}, 0);
            held.push({ ms, callback });
            return handle;
        };
        function fire(timer) {
            const now = Date.now;
            elapsed += timer.ms;
            Date.now = () => now() + elapsed;
            try {
                timer.callback();
            } finally {
                Date.now = now;
            }
        }
        return { held, fire, restore: () => (global.setTimeout = original) };
    }

    beforeEach(function (done) {
        service = new FakeShareServiceClient();
        share = service.share('share');
        share.addFile('watch/a.txt', 'a');
        share.addDir('watch/dir');
        share.addFile('watch/dir/nested.txt', 'n');
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(done);
    });

    it('emits add for existing files on the initial scan, skipping directories by default', async function () {
        await load({});

        const messages = await collect(helper, 'out', 150);

        assert.equal(messages.length, 1);
        const file = messages[0].file;
        assert.equal(file.action, 'add');
        assert.equal(file.filetype, 'file');
        assert.equal(file.source, 'watch');
        assert.equal(file.path, 'watch/a.txt');
        assert.equal(file.base, 'a.txt');
        assert.equal(file.stats.contentLength, 1);
    });

    it('emits directories and nested files when enabled by filterDirs and depth', async function () {
        await load({ filterDirs: true, depth: 1 });

        const messages = await collect(helper, 'out', 150);

        assert.deepEqual(messages.map((msg) => [msg.file.filetype, msg.file.path]).sort(), [
            ['directory', 'watch/dir'],
            ['file', 'watch/a.txt'],
            ['file', 'watch/dir/nested.txt'],
        ]);
    });

    it('emits add, change and delete between polls after ignoreInitial', async function () {
        await load({ ignoreInitial: true, watchChange: true, watchDelete: true });
        assert.deepEqual(await collect(helper, 'out', 150), []);

        share.addFile('watch/b.txt', 'b');
        const added = await collect(helper, 'out', POLL_MS + 150);
        assert.deepEqual(
            added.map((msg) => [msg.file.action, msg.file.path]),
            [['add', 'watch/b.txt']],
        );

        share.addFile('watch/b.txt', 'bb');
        const changed = await collect(helper, 'out', POLL_MS + 150);
        assert.deepEqual(
            changed.map((msg) => [msg.file.action, msg.file.path]),
            [['change', 'watch/b.txt']],
        );

        share.files.delete('watch/b.txt');
        const deleted = await collect(helper, 'out', POLL_MS + 150);
        assert.equal(deleted.length, 1);
        assert.equal(deleted[0].file.action, 'delete');
        assert.equal(deleted[0].file.stats, null);
    });

    it('ignores names matching ignoredFiles', async function () {
        share.addFile('watch/skip.tmp', 't');
        await load({ ignoredFiles: '\\.tmp$' });

        const messages = await collect(helper, 'out', 150);

        assert.deepEqual(
            messages.map((msg) => msg.file.path),
            ['watch/a.txt'],
        );
    });

    it('stops polling after close', async function () {
        await load({});
        await delay(100);
        helper.unload();
        const callsAtClose = share.calls.length;

        await delay(POLL_MS * 2);

        assert.equal(share.calls.length, callsAtClose);
    });

    it('reports startup configuration errors through node.error with a code', async function () {
        await load({ shareName: '' });
        await delay(50);

        const errors = errorLogs('n1');
        assert.equal(errors.length, 1);
        assert.equal(errors[0].msg.code, 'SHARE_NAME_MISSING');
    });

    it('reports an invalid ignoredFiles regex once at startup and does not poll', async function () {
        await load({ ignoredFiles: '(' });
        await delay(POLL_MS * 2);

        assert.ok(helper.getNode('n1'));
        const errors = errorLogs('n1');
        assert.equal(errors.length, 1);
        assert.ok(errors[0].msg instanceof SyntaxError);
        assert.deepEqual(share.calls, []);
    });

    it('does not send, set status or poll again after close while a scan is in flight', async function () {
        await load({});
        await delay(100);
        const gate = share.gateOnce('listFilesAndDirectories', 'watch');
        share.addFile('watch/new.txt', 'n');
        await gate.reached;
        const counts = track(helper.getNode('n1'));

        await helper.unload();
        await settle();
        const atClose = counts.snapshot();
        const listsAtClose = listCalls();
        gate.release();
        await delay(POLL_MS * 2);

        assert.deepEqual(counts.snapshot(), atClose);
        assert.equal(listCalls(), listsAtClose);
    });

    it('does not send after close while the output write is in flight', async function () {
        await load({ ignoreInitial: true });
        const node = helper.getNode('n1');
        const writeOutput = node.setTypedProperty;
        let release;
        let writeStarted = false;
        const gate = new Promise((resolve) => (release = resolve));
        node.setTypedProperty = async (...args) => {
            writeStarted = true;
            await gate;
            return writeOutput.apply(node, args);
        };
        share.addFile('watch/new.txt', 'n');
        for (let i = 0; i < 100 && !writeStarted; i++) await delay(10);
        assert.equal(writeStarted, true);
        const counts = track(node);

        await helper.unload();
        await settle();
        const atClose = counts.snapshot();
        release();
        await delay(100);

        assert.deepEqual(counts.snapshot(), atClose);
    });

    it('starts no new SDK requests after close when a gated listing resumes', async function () {
        await load({});
        await delay(100);
        const gate = share.gateOnce('listFilesAndDirectories', 'watch');
        share.addFile('watch/n1.txt', '1');
        share.addFile('watch/n2.txt', '2');
        share.addFile('watch/n3.txt', '3');
        await gate.reached;

        await helper.unload();
        await settle();
        const callsAtClose = share.calls.length;
        gate.release();
        await delay(POLL_MS * 2);

        assert.deepEqual(share.calls.slice(callsAtClose), []);
    });

    it('starts no new output writes after close when one write was in flight', async function () {
        await load({ ignoreInitial: true });
        const node = helper.getNode('n1');
        const writeOutput = node.setTypedProperty;
        let release;
        let writes = 0;
        const gate = new Promise((resolve) => (release = resolve));
        node.setTypedProperty = async (...args) => {
            writes += 1;
            if (writes === 1) await gate;
            return writeOutput.apply(node, args);
        };
        share.addFile('watch/n1.txt', '1');
        share.addFile('watch/n2.txt', '2');
        share.addFile('watch/n3.txt', '3');
        for (let i = 0; i < 100 && writes === 0; i++) await delay(10);
        const counts = track(node);

        await helper.unload();
        await settle();
        const atClose = counts.snapshot();
        release();
        await delay(100);

        assert.equal(writes, 1, 'only the write already in flight at close');
        assert.deepEqual(counts.snapshot(), atClose);
    });

    it('fetches no further listing page after close when an item lookup fails with 404', async function () {
        share.pageSize = 1;
        const gate = share.gateOnce('getProperties', 'watch/a.txt');
        await load({});
        await gate.reached;

        await helper.unload();
        await settle();
        const callsAtClose = share.calls.length;
        gate.release(restError(404, 'ResourceNotFound'));
        await delay(POLL_MS * 2);

        assert.deepEqual(share.calls.slice(callsAtClose), []);
    });

    it('fetches no further listing page after close when a recursive scan returns', async function () {
        share.pageSize = 1;
        share.addFile('watch/z.txt', 'z');
        const gate = share.gateOnce('listFilesAndDirectories', 'watch/dir');
        await load({ depth: 1 });
        await gate.reached;

        await helper.unload();
        await settle();
        const callsAtClose = share.calls.length;
        gate.release();
        await delay(POLL_MS * 2);

        assert.deepEqual(share.calls.slice(callsAtClose), []);
    });

    it('stays silent after close when the initial scan is still running', async function () {
        const gate = share.gateOnce('listFilesAndDirectories', 'watch');
        await load({});
        await gate.reached;
        const counts = track(helper.getNode('n1'));

        await helper.unload();
        await settle();
        const atClose = counts.snapshot();
        gate.release();
        await delay(POLL_MS * 2);

        assert.deepEqual(counts.snapshot(), atClose);
        assert.equal(listCalls(), 1);
    });

    it('does not report an error after close when an in-flight scan fails', async function () {
        const gate = share.gateOnce('listFilesAndDirectories', 'watch');
        await load({});
        await gate.reached;
        const counts = track(helper.getNode('n1'));

        await helper.unload();
        await settle();
        const atClose = counts.snapshot();
        gate.release(restError(500, 'InternalError'));
        await delay(POLL_MS * 2);

        assert.deepEqual(counts.snapshot(), atClose);
        assert.equal(listCalls(), 1);
    });

    it('treats an advancing SMB last-write time (fileLastWriteOn) as an unfinished write', async function () {
        await load({ ignoreInitial: true, awaitWriteFinish: true, stabilityThreshold: '600' });
        await delay(100);
        const fixed = { etag: 'fixed', lastModified: new Date(0), contentLength: 10 };
        share.addFile('watch/upload.bin', '0123456789');
        share.setFileProperties('watch/upload.bin', { ...fixed, fileLastWriteOn: new Date() });

        const events = [];
        helper.getNode('out').on('input', (msg) => events.push(msg.file.path));
        for (let i = 0; i < 6; i++) {
            await delay(200);
            share.setFileProperties('watch/upload.bin', { fileLastWriteOn: new Date() });
        }
        assert.deepEqual(events, [], 'no add while the last-write time keeps moving');

        await delay(600 + POLL_MS * 3);
        assert.deepEqual(events, ['watch/upload.bin']);
    });

    describe('stability re-check (awaitWriteFinish)', function () {
        const AWAIT = { awaitWriteFinish: true };

        it('releases a stable file about one threshold after it was seen, before the next poll', async function () {
            const t0 = Date.now();
            await load({ ...AWAIT, pollInterval: '1000', stabilityThreshold: '300' });
            const { at } = await nextEvent('watch/a.txt');

            assert.ok(at - t0 >= 300 && at - t0 < 900, `released ${at - t0} ms after start`);
        });

        it("counts the threshold from the file's own observation even when the scan is slow", async function () {
            share.addFile('watch/z.txt', 'z');
            const gate = share.gateOnce('getProperties', 'watch/z.txt');
            const t0 = Date.now();
            await load({ ...AWAIT, pollInterval: '2000', stabilityThreshold: '600' });
            const added = nextEvent('watch/a.txt');
            await gate.reached;
            await delay(1200);
            gate.release();
            const { at } = await added;

            assert.ok(at - t0 >= 600 && at - t0 < 2200, `released ${at - t0} ms after start`);
        });

        it('waits at least the threshold when it is about twice the poll interval', async function () {
            await load({ ...AWAIT, ignoreInitial: true, stabilityThreshold: '500' });
            await delay(100);
            const added = nextEvent('watch/new.txt');
            const t0 = Date.now();
            share.addFile('watch/new.txt', 'n');
            const { at } = await added;

            assert.ok(at - t0 >= 500 && at - t0 < 1150, `released ${at - t0} ms after creation`);
        });

        it('defers a due re-check while polls are failing, and reports the outage once', async function () {
            await load({ ...AWAIT, ignoreInitial: true, stabilityThreshold: '300' });
            await delay(100);
            const events = eventsFor('watch/new.txt');
            share.addFile('watch/new.txt', 'n');
            await firstObservation('watch/new.txt');
            share.failOnce('listFilesAndDirectories', 'watch', restError(503, 'ServerBusy'));
            share.failOnce('listFilesAndDirectories', 'watch', restError(503, 'ServerBusy'));
            await delay(2000);

            const windows = share.faultHits.map((hit, index) => ({
                from: hit.at,
                to: hit.at + POLL_MS * 2 ** index,
            }));
            assert.equal(windows.length, 2);
            const recheckDuringBackoff = propertyCalls('watch/new.txt').filter((call) =>
                windows.some((w) => call.at > w.from && call.at < w.to - 20),
            );
            assert.deepEqual(recheckDuringBackoff, []);
            assert.equal(events.length, 1);
            assert.equal(errorLogs('n1').length, 1);
        });

        it('ignores a stale in-flight re-check after the file was deleted and re-created', async function () {
            this.timeout(8000);
            const same = { etag: 'same', lastModified: new Date(0) };
            await load({
                ...AWAIT,
                ignoreInitial: true,
                pollInterval: '1000',
                stabilityThreshold: '200',
            });
            await delay(100);
            const events = eventsFor('watch/x.txt');
            share.addFile('watch/x.txt', 'x');
            share.setFileProperties('watch/x.txt', same);
            await firstObservation('watch/x.txt');
            const gate = share.gateOnce('getProperties', 'watch/x.txt');
            await gate.reached;

            share.files.delete('watch/x.txt');
            const scansBefore = listCalls();
            for (let i = 0; i < 400 && listCalls() === scansBefore; i++) await delay(5);
            await delay(100);
            share.addFile('watch/x.txt', 'x');
            share.setFileProperties('watch/x.txt', same);
            const seenBefore = propertyCalls('watch/x.txt').length;
            for (let i = 0; i < 400 && propertyCalls('watch/x.txt').length === seenBefore; i++) {
                await delay(5);
            }
            const recreatedSeenAt = propertyCalls('watch/x.txt')[seenBefore].at;
            const added = nextEvent('watch/x.txt');
            gate.release();
            const { at } = await added;
            await delay(400);

            assert.equal(events.length, 1);
            assert.ok(
                at - recreatedSeenAt >= 190,
                `the stale result released the new file early (${at - recreatedSeenAt} ms)`,
            );
        });

        it('keeps a pending add when a re-check briefly finds the file missing', async function () {
            this.timeout(6000);
            await load({
                ...AWAIT,
                ignoreInitial: true,
                pollInterval: '1000',
                stabilityThreshold: '200',
            });
            await delay(100);
            const events = eventsFor('watch/y.txt');
            share.addFile('watch/y.txt', 'first');
            await firstObservation('watch/y.txt');
            share.files.delete('watch/y.txt');
            await delay(400);
            share.addFile('watch/y.txt', 'second!');
            await delay(1600);

            assert.equal(events.length, 1);
            assert.equal(events[0].file.action, 'add');
            assert.equal(events[0].file.stats.contentLength, 7);
        });

        it('does not roll a pending file back to an older scan result that completes later', async function () {
            this.timeout(6000);
            await load({
                ...AWAIT,
                ignoreInitial: true,
                pollInterval: '500',
                stabilityThreshold: '600',
            });
            await delay(100);
            const events = eventsFor('watch/p.txt');
            share.addFile('watch/p.txt', 'one');
            share.addFile('watch/q.txt', 'q');
            const t1 = await firstObservation('watch/p.txt');
            const gate = share.gateOnce('getProperties', 'watch/q.txt');
            await gate.reached;
            await delay(Math.max(0, t1 + 550 - Date.now()));
            share.addFile('watch/p.txt', 'three');
            await delay(Math.max(0, t1 + 900 - Date.now()));
            gate.release();
            await delay(Math.max(0, t1 + 1550 - Date.now()));

            assert.equal(events.length, 1, 'released once, without a rollback delay');
            assert.equal(events[0].file.stats.contentLength, 5);
        });

        it('runs one re-check per file at a time and applies only the latest result', async function () {
            this.timeout(6000);
            await load({
                ...AWAIT,
                ignoreInitial: true,
                pollInterval: '1000',
                stabilityThreshold: '200',
            });
            await delay(100);
            const events = eventsFor('watch/r.txt');
            share.addFile('watch/r.txt', 'one');
            await firstObservation('watch/r.txt');
            const gate = share.gateOnce('getProperties', 'watch/r.txt');
            await gate.reached;
            const issuedAt = Date.now();
            share.addFile('watch/r.txt', 'three');
            await delay(1300);
            const whileInFlight = propertyCalls('watch/r.txt').filter((call) => call.at > issuedAt);
            gate.release();
            await delay(600);

            assert.equal(whileInFlight.length, 1, 'only the poll scan, no second re-check');
            assert.equal(events.length, 1);
            assert.equal(events[0].file.stats.contentLength, 5);
        });
    });

    describe('stability re-check, r2 corrections', function () {
        const AWAIT = { awaitWriteFinish: true };

        it('reports an output failure when a re-checked file is released', async function () {
            this.timeout(6000);
            const unhandled = [];
            const onUnhandled = (reason) => unhandled.push(reason);
            process.on('unhandledRejection', onUnhandled);
            try {
                await load({
                    ...AWAIT,
                    ignoreInitial: true,
                    pollInterval: '1000',
                    stabilityThreshold: '200',
                });
                helper.getNode('n1').setTypedProperty = async () => {
                    throw new Error('context store unavailable');
                };
                await delay(100);
                share.addFile('watch/o.txt', 'o');
                await delay(1600);

                assert.deepEqual(unhandled, []);
                assert.ok(
                    errorLogs('n1').some(
                        (entry) => entry.msg && entry.msg.message === 'context store unavailable',
                    ),
                );
            } finally {
                process.removeListener('unhandledRejection', onUnhandled);
            }
        });

        it('defers other due re-checks and the next poll after a re-check fails', async function () {
            this.timeout(6000);
            await load({
                ...AWAIT,
                ignoreInitial: true,
                pollInterval: '1000',
                stabilityThreshold: '300',
            });
            await delay(100);
            share.addFile('watch/a2.txt', 'a');
            share.addFile('watch/b2.txt', 'b');
            const gate = share.gateOnce('getProperties', 'watch/b2.txt');
            await gate.reached;
            share.failOnce('getProperties', 'watch/a2.txt', restError(500, 'InternalError'));
            await delay(100);
            gate.release();
            await delay(1600);

            assert.equal(share.faultHits.length, 1);
            const failedAt = share.faultHits[0].at;
            const early = share.calls.filter(
                (call) =>
                    call.at > failedAt &&
                    call.at < failedAt + 1000 - 30 &&
                    (call.method === 'listFilesAndDirectories' ||
                        (call.method === 'getProperties' && call.path === 'watch/b2.txt')),
            );
            assert.deepEqual(early, [], 'nothing issued before the shared not-before time');
            assert.equal(errorLogs('n1').length, 1);
        });

        it('creates no stability timers after close when a directory send resumes', async function () {
            share.addFile('watch/z2.txt', 'z');
            await load({ ...AWAIT, filterDirs: true });
            const node = helper.getNode('n1');
            const writeOutput = node.setTypedProperty;
            let release;
            let gated = false;
            const gate = new Promise((resolve) => (release = resolve));
            node.setTypedProperty = async (...args) => {
                if (!gated && args[3] && args[3].filetype === 'directory') {
                    gated = true;
                    await gate;
                }
                return writeOutput.apply(node, args);
            };
            for (let i = 0; i < 200 && !gated; i++) await delay(5);
            assert.equal(gated, true);
            const timers = recordWatchTimers();
            try {
                await helper.unload();
                await settle();
                const closedAt = Date.now();
                release();
                await delay(100);
                assert.deepEqual(
                    timers.requested.filter((t) => t.at >= closedAt),
                    [],
                );
            } finally {
                timers.restore();
            }
        });

        it('ignores a stale 404 from an older re-check of a newer generation', async function () {
            this.timeout(6000);
            await load({
                ...AWAIT,
                ignoreInitial: true,
                pollInterval: '1000',
                stabilityThreshold: '200',
            });
            await delay(100);
            const events = eventsFor('watch/r3.txt');
            share.addFile('watch/r3.txt', 'one');
            const t1 = await firstObservation('watch/r3.txt');
            const gate = share.gateOnce('getProperties', 'watch/r3.txt');
            await gate.reached;
            share.addFile('watch/r3.txt', 'three');
            await delay(Math.max(0, t1 + 1300 - Date.now()));
            gate.release(restError(404, 'ResourceNotFound'));
            await delay(Math.max(0, t1 + 1700 - Date.now()));

            assert.equal(events.length, 1, 'released without waiting for another poll');
            assert.equal(events[0].file.stats.contentLength, 5);
        });

        it('treats a poll whose output write keeps failing as one continuing outage', async function () {
            const timers = compressWatchTimers();
            try {
                await load({ ignoreInitial: true });
                await delay(20);
                helper.getNode('n1').setTypedProperty = async () => {
                    throw new Error('context store unavailable');
                };
                const before = timers.requested.length;
                share.addFile('watch/out.txt', 'o');
                await delay(150);

                assert.deepEqual(
                    timers.requested.slice(before, before + 4),
                    [250, 500, 1000, 2000],
                );
                assert.equal(errorLogs('n1').length, 1);
            } finally {
                timers.restore();
            }
        });

        it('does not strand a newer generation when an older re-check fails with a server error', async function () {
            this.timeout(6000);
            await load({
                ...AWAIT,
                ignoreInitial: true,
                pollInterval: '1000',
                stabilityThreshold: '200',
            });
            await delay(100);
            const events = eventsFor('watch/r4.txt');
            share.addFile('watch/r4.txt', 'one');
            const t1 = await firstObservation('watch/r4.txt');
            const gate = share.gateOnce('getProperties', 'watch/r4.txt');
            await gate.reached;
            share.addFile('watch/r4.txt', 'three');
            await delay(Math.max(0, t1 + 1300 - Date.now()));
            gate.release(restError(500, 'InternalError'));
            await delay(Math.max(0, t1 + 2900 - Date.now()));

            assert.equal(events.length, 1, 'the newer generation is still released');
            assert.equal(events[0].file.stats.contentLength, 5);
            assert.equal(errorLogs('n1').length, 1);
        });

        it('does not report a Change for the state an Add was just released with', async function () {
            this.timeout(6000);
            await load({
                ...AWAIT,
                ignoreInitial: true,
                watchChange: true,
                pollInterval: '1000',
                stabilityThreshold: '200',
            });
            await delay(100);
            const events = eventsFor('watch/f.txt');
            share.addFile('watch/f.txt', 'one');
            const t1 = await firstObservation('watch/f.txt');
            await delay(Math.max(0, t1 + 100 - Date.now()));
            share.addFile('watch/f.txt', 'three');
            await delay(Math.max(0, t1 + 1700 - Date.now()));

            assert.deepEqual(
                events.map((msg) => msg.file.action),
                ['add'],
            );
        });
    });

    describe('stability re-check, unchanged newer observations', function () {
        const AWAIT = { awaitWriteFinish: true };

        async function inFlightAcrossUnchangedPoll(fileName, outcome) {
            await load({
                ...AWAIT,
                ignoreInitial: true,
                pollInterval: '1000',
                stabilityThreshold: '200',
            });
            await delay(100);
            const filePath = `watch/${fileName}`;
            const events = eventsFor(filePath);
            share.addFile(filePath, 'same');
            const t1 = await firstObservation(filePath);
            const gate = share.gateOnce('getProperties', filePath);
            await gate.reached;
            const scans = listCalls();
            for (let i = 0; i < 400 && listCalls() === scans; i++) await delay(5);
            await delay(Math.max(0, t1 + 1100 - Date.now()));
            gate.release(outcome);
            return { events, t1 };
        }

        it('still releases when a newer unchanged poll lands while the re-check is in flight', async function () {
            this.timeout(6000);
            const { events, t1 } = await inFlightAcrossUnchangedPoll('s1.txt');
            await delay(Math.max(0, t1 + 1600 - Date.now()));

            assert.equal(events.length, 1);
        });

        it('re-schedules after an older failed re-check when a newer unchanged poll landed', async function () {
            this.timeout(8000);
            const { events, t1 } = await inFlightAcrossUnchangedPoll(
                's2.txt',
                restError(500, 'InternalError'),
            );
            await delay(Math.max(0, t1 + 3200 - Date.now()));

            assert.equal(events.length, 1);
            assert.equal(errorLogs('n1').length, 1);
        });

        it('releases with the newest metadata when an older unchanged re-check completes last', async function () {
            this.timeout(6000);
            await load({
                ...AWAIT,
                ignoreInitial: true,
                pollInterval: '1000',
                stabilityThreshold: '200',
            });
            await delay(100);
            const filePath = 'watch/s4.txt';
            const events = eventsFor(filePath);
            share.addFile(filePath, 'same', { contentType: 'text/old' });
            const t1 = await firstObservation(filePath);
            const gate = share.gateOnce('getProperties', filePath);
            await gate.reached;
            // Not part of the signature: the newer poll sees the same version with new metadata.
            share.setFileProperties(filePath, { contentType: 'text/new' });
            await delay(Math.max(0, t1 + 1100 - Date.now()));
            gate.release('as-issued');
            await delay(Math.max(0, t1 + 1600 - Date.now()));

            assert.equal(events.length, 1);
            assert.equal(events[0].file.stats.contentType, 'text/new');
        });

        it('re-schedules after an older 404 when a newer poll saw the file', async function () {
            this.timeout(6000);
            const { events, t1 } = await inFlightAcrossUnchangedPoll(
                's3.txt',
                restError(404, 'ResourceNotFound'),
            );
            await delay(Math.max(0, t1 + 1600 - Date.now()));

            assert.equal(events.length, 1);
        });
    });

    describe('stability re-check, old snapshots', function () {
        const AWAIT = { awaitWriteFinish: true };

        it('does not turn an old scan that completes after a release into a Change', async function () {
            this.timeout(8000);
            share.addFile('watch/zz.txt', 'z');
            await load({ ...AWAIT, watchChange: true, stabilityThreshold: '600' });
            const events = eventsFor('watch/a.txt');
            await firstObservation('watch/zz.txt');
            const gate = share.gateOnce('getProperties', 'watch/zz.txt');
            await gate.reached;
            share.addFile('watch/a.txt', 'Bversion');
            await nextEvent('watch/a.txt');
            gate.release();
            await delay(1300);

            assert.deepEqual(
                events.map((msg) => msg.file.action),
                ['add'],
            );
            assert.equal(events[0].file.stats.contentLength, 8);
        });

        it('does not report a delete from an old listing when a newer re-check saw the file', async function () {
            this.timeout(8000);
            await load({
                ...AWAIT,
                ignoreInitial: true,
                watchDelete: true,
                pollInterval: '500',
                stabilityThreshold: '1200',
            });
            await delay(100);
            const events = eventsFor('watch/d.txt');
            share.addFile('watch/d.txt', 'one');
            const t1 = await firstObservation('watch/d.txt');
            const listGate = share.gateOnce('listFilesAndDirectories', 'watch');
            await listGate.reached;
            share.files.delete('watch/d.txt');
            const scanGate = share.gateOnce('getProperties', 'watch/a.txt');
            listGate.release();
            await scanGate.reached;
            share.addFile('watch/d.txt', 'two');
            await delay(Math.max(0, t1 + 1300 - Date.now()));
            scanGate.release();
            await delay(Math.max(0, t1 + 3200 - Date.now()));

            assert.deepEqual(
                events.map((msg) => msg.file.action),
                ['add'],
            );
        });

        it('keeps the released version as the baseline when an old listing missed the file', async function () {
            this.timeout(8000);
            await load({
                ...AWAIT,
                ignoreInitial: true,
                watchChange: true,
                watchDelete: true,
                pollInterval: '500',
                stabilityThreshold: '800',
            });
            await delay(100);
            const events = eventsFor('watch/d.txt');
            share.addFile('watch/d.txt', 'one');
            const t1 = await firstObservation('watch/d.txt');
            const listGate = share.gateOnce('listFilesAndDirectories', 'watch');
            await listGate.reached;
            share.files.delete('watch/d.txt');
            const scanGate = share.gateOnce('getProperties', 'watch/a.txt');
            listGate.release();
            await scanGate.reached;
            share.addFile('watch/d.txt', 'second');
            // The re-checks see the new version at t1+800 and release it at about t1+1600,
            // while the listing that missed the file is still scanning.
            await delay(Math.max(0, t1 + 1800 - Date.now()));
            const listsBefore = listCalls();
            scanGate.release();
            // Long enough for a wrong Change from that poll to pass its own stability wait.
            await delay(Math.max(0, t1 + 3700 - Date.now()));

            assert.ok(listCalls() > listsBefore, 'a newer poll saw the released file');
            assert.deepEqual(
                events.map((msg) => msg.file.action),
                ['add'],
            );
            assert.equal(events[0].file.stats.contentLength, 6);
        });
    });

    describe('stability re-check, failed polls after a release', function () {
        const AWAIT = { awaitWriteFinish: true };

        // Holds the first directory output for `ms`, then fails it (or lets it through); files
        // queued before it keep their own deadline.
        function holdFirstDirectoryOutput(ms, { fail = true } = {}) {
            const node = helper.getNode('n1');
            const writeOutput = node.setTypedProperty;
            const state = { failed: false };
            node.setTypedProperty = async (...args) => {
                if (!state.failed && args[3] && args[3].filetype === 'directory') {
                    state.failed = true;
                    await delay(ms);
                    if (fail) throw new Error('context store unavailable');
                }
                return writeOutput.apply(node, args);
            };
            return state;
        }

        // First poll queues a.txt and fails on its directory output. The retry sees a.txt as a
        // directory, but that reply is held until t1 + `replyAt`; a.txt is a file again by then.
        async function oldDirectoryReply(replyAt) {
            await load({
                ...AWAIT,
                filterDirs: true,
                watchDelete: true,
                pollInterval: '250',
                stabilityThreshold: '600',
            });
            holdFirstDirectoryOutput(100);
            const events = eventsFor('watch/a.txt');
            const t1 = await firstObservation('watch/a.txt');
            for (let i = 0; i < 200 && errorLogs('n1').length === 0; i++) await delay(5);
            share.files.delete('watch/a.txt');
            share.addDir('watch/a.txt');
            const gate = share.gateOnce('getProperties', 'watch/a.txt');
            await gate.reached;
            share.dirs.delete('watch/a.txt');
            share.addFile('watch/a.txt', 'version-B');
            await delay(Math.max(0, t1 + replyAt - Date.now()));
            const before = events.map((msg) => [msg.file.action, msg.file.filetype]);
            gate.release('as-issued');
            return { events, t1, before };
        }

        it('does not add a file again when the first poll fails after the file was released', async function () {
            this.timeout(6000);
            await load({
                ...AWAIT,
                filterDirs: true,
                pollInterval: '1000',
                stabilityThreshold: '300',
            });
            const output = holdFirstDirectoryOutput(600);
            const events = eventsFor('watch/a.txt');
            const dirEvents = eventsFor('watch/dir');
            await delay(2600);

            assert.equal(output.failed, true);
            assert.equal(errorLogs('n1').length, 1);
            assert.deepEqual(
                events.map((msg) => msg.file.action),
                ['add'],
            );
            assert.deepEqual(
                dirEvents.map((msg) => msg.file.action),
                ['add'],
            );
        });

        it('does not add a new file again when a later poll fails after the file was released', async function () {
            this.timeout(6000);
            await load({
                ...AWAIT,
                ignoreInitial: true,
                filterDirs: true,
                pollInterval: '1000',
                stabilityThreshold: '300',
            });
            await delay(100);
            const output = holdFirstDirectoryOutput(600);
            const events = eventsFor('watch/b.txt');
            share.addFile('watch/b.txt', 'b');
            share.addDir('watch/c');
            const t1 = await firstObservation('watch/b.txt');
            await delay(Math.max(0, t1 + 2400 - Date.now()));

            assert.equal(output.failed, true);
            assert.deepEqual(
                events.map((msg) => msg.file.action),
                ['add'],
            );
        });

        it('reports a Change, not a second Add, when a released file changed before the retry', async function () {
            this.timeout(6000);
            await load({
                ...AWAIT,
                ignoreInitial: true,
                watchChange: true,
                filterDirs: true,
                pollInterval: '1000',
                stabilityThreshold: '300',
            });
            await delay(100);
            holdFirstDirectoryOutput(600);
            const events = eventsFor('watch/b.txt');
            share.addFile('watch/b.txt', 'b');
            share.addDir('watch/c');
            const t1 = await firstObservation('watch/b.txt');
            await nextEvent('watch/b.txt');
            share.addFile('watch/b.txt', 'b2');
            await delay(Math.max(0, t1 + 2400 - Date.now()));

            assert.deepEqual(
                events.map((msg) => msg.file.action),
                ['add', 'change'],
            );
            assert.equal(events[1].file.stats.contentLength, 2);
        });

        it('keeps the released file, not an older directory reply, as the baseline', async function () {
            this.timeout(6000);
            const { events, t1, before } = await oldDirectoryReply(1300);
            assert.deepEqual(before, [['add', 'file']], 'fixture: released before the old reply');
            await delay(Math.max(0, t1 + 2600 - Date.now()));

            assert.deepEqual(
                events.map((msg) => [msg.file.action, msg.file.filetype]),
                [['add', 'file']],
            );
        });

        it('reports a later delete with the released type, not an older directory reply', async function () {
            this.timeout(6000);
            const { events, t1, before } = await oldDirectoryReply(1300);
            assert.deepEqual(before, [['add', 'file']], 'fixture: released before the old reply');
            await delay(Math.max(0, t1 + 1500 - Date.now()));
            share.files.delete('watch/a.txt');
            await delay(Math.max(0, t1 + 2300 - Date.now()));

            assert.deepEqual(
                events.map((msg) => [msg.file.action, msg.file.filetype]),
                [
                    ['add', 'file'],
                    ['delete', 'file'],
                ],
            );
        });

        it('reports no directory delete when an older directory reply lands before the release', async function () {
            this.timeout(6000);
            // The re-check at t1+600 has seen the file; it is released at t1+1200.
            const { events, t1, before } = await oldDirectoryReply(900);
            assert.deepEqual(before, [], 'fixture: not released yet when the old reply arrives');
            await delay(Math.max(0, t1 + 2600 - Date.now()));

            assert.deepEqual(
                events.map((msg) => [msg.file.action, msg.file.filetype]),
                [['add', 'file']],
            );
        });

        it('reports the delete of a file released before its failed first poll was retried', async function () {
            this.timeout(6000);
            await load({
                ...AWAIT,
                filterDirs: true,
                watchDelete: true,
                pollInterval: '1000',
                stabilityThreshold: '300',
            });
            holdFirstDirectoryOutput(600);
            const events = eventsFor('watch/a.txt');
            await nextEvent('watch/a.txt');
            share.files.delete('watch/a.txt');
            await delay(1800);

            assert.deepEqual(
                events.map((msg) => msg.file.action),
                ['add', 'delete'],
            );
        });

        it('reports the delete of a new file released before its failed poll was retried', async function () {
            this.timeout(6000);
            await load({
                ...AWAIT,
                ignoreInitial: true,
                filterDirs: true,
                watchDelete: true,
                pollInterval: '1000',
                stabilityThreshold: '300',
            });
            await delay(100);
            holdFirstDirectoryOutput(600);
            const events = eventsFor('watch/b.txt');
            share.addFile('watch/b.txt', 'b');
            share.addDir('watch/c');
            const t1 = await firstObservation('watch/b.txt');
            await nextEvent('watch/b.txt');
            share.files.delete('watch/b.txt');
            await delay(Math.max(0, t1 + 2400 - Date.now()));

            assert.deepEqual(
                events.map((msg) => msg.file.action),
                ['add', 'delete'],
            );
        });

        it('keeps a release that lands while its poll is still writing outputs', async function () {
            this.timeout(6000);
            await load({
                ...AWAIT,
                ignoreInitial: true,
                watchChange: true,
                filterDirs: true,
                pollInterval: '1000',
                stabilityThreshold: '300',
            });
            await delay(100);
            holdFirstDirectoryOutput(1200, { fail: false });
            const events = eventsFor('watch/x.txt');
            share.addFile('watch/x.txt', 'one');
            share.addDir('watch/y');
            const t1 = await firstObservation('watch/x.txt');
            await delay(50);
            // Changed after that poll saw it; its re-checks release this version mid-poll.
            share.addFile('watch/x.txt', 'two');
            await delay(Math.max(0, t1 + 2900 - Date.now()));

            assert.deepEqual(
                events.map((msg) => msg.file.action),
                ['add'],
            );
            assert.equal(events[0].file.stats.contentLength, 3);
        });

        it("follows a release that lands during a delete output with that file's delete", async function () {
            this.timeout(6000);
            await load({
                ...AWAIT,
                ignoreInitial: true,
                watchDelete: true,
                pollInterval: '1000',
                stabilityThreshold: '600',
            });
            const node = helper.getNode('n1');
            const writeOutput = node.setTypedProperty;
            let deletes = 0;
            let secondDeleteStarted;
            const secondDelete = new Promise((resolve) => (secondDeleteStarted = resolve));
            let finishDelete;
            const deleteHeld = new Promise((resolve) => (finishDelete = resolve));
            node.setTypedProperty = async (...args) => {
                if (args[3].action === 'delete' && args[3].path === 'watch/a.txt') {
                    deletes += 1;
                    if (deletes === 1) {
                        // b's re-check is issued meanwhile, before this poll fails: a failed
                        // poll would hold it until the retry itself starts.
                        await delay(700);
                        throw new Error('context store unavailable');
                    }
                    secondDeleteStarted();
                    await deleteHeld;
                }
                return writeOutput.apply(node, args);
            };
            await delay(100);
            const events = eventsFor('watch/b.txt');
            share.files.delete('watch/a.txt');
            share.addFile('watch/b.txt', 'b');
            await firstObservation('watch/b.txt');
            const gate = share.gateOnce('getProperties', 'watch/b.txt');
            await gate.reached; // b's re-check
            const listsAtCheck = listCalls();
            share.files.delete('watch/b.txt');
            await secondDelete; // the retry saw b missing and is writing a.txt's delete
            assert.equal(errorLogs('n1').length, 1, 'fixture: the poll that found b failed');
            assert.equal(listCalls(), listsAtCheck + 1, 'fixture: the re-check preceded the retry');
            gate.release('as-issued');
            await delay(100);
            finishDelete();
            await delay(300);

            assert.deepEqual(
                events.map((msg) => msg.file.action),
                ['add', 'delete'],
            );
        });

        it('reports one delete for a file released while its poll was writing outputs', async function () {
            this.timeout(6000);
            await load({
                ...AWAIT,
                ignoreInitial: true,
                watchDelete: true,
                filterDirs: true,
                pollInterval: '1000',
                stabilityThreshold: '300',
            });
            await delay(100);
            holdFirstDirectoryOutput(1200, { fail: false });
            const events = eventsFor('watch/x.txt');
            share.addFile('watch/x.txt', 'one');
            share.addDir('watch/y');
            const t1 = await firstObservation('watch/x.txt');
            await delay(50);
            share.addFile('watch/x.txt', 'two');
            // Released at about t1+600, before that poll commits at about t1+1200.
            await delay(Math.max(0, t1 + 1300 - Date.now()));
            share.files.delete('watch/x.txt');
            await delay(Math.max(0, t1 + 2600 - Date.now()));

            assert.deepEqual(
                events.map((msg) => msg.file.action),
                ['add', 'delete'],
            );
        });

        it('ignores an older retry observation of a file released meanwhile', async function () {
            this.timeout(6000);
            await load({
                ...AWAIT,
                filterDirs: true,
                watchChange: true,
                pollInterval: '250',
                stabilityThreshold: '600',
            });
            const output = holdFirstDirectoryOutput(100);
            const events = eventsFor('watch/a.txt');
            const t1 = await firstObservation('watch/a.txt');
            for (let i = 0; i < 200 && errorLogs('n1').length === 0; i++) await delay(5);
            const gate = share.gateOnce('getProperties', 'watch/a.txt');
            await gate.reached; // the retry's request, issued before the change below
            share.setFileProperties('watch/a.txt', { etag: 'version-2' });
            await delay(Math.max(0, t1 + 1300 - Date.now()));
            gate.release('as-issued');
            await delay(Math.max(0, t1 + 3000 - Date.now()));

            assert.equal(output.failed, true);
            assert.deepEqual(
                events.map((msg) => msg.file.action),
                ['add'],
            );
            assert.equal(events[0].file.stats.etag, 'version-2');
        });
    });

    describe('output order', function () {
        const AWAIT = { awaitWriteFinish: true };

        // Holds the Add's output write until t1+1500 (then fails it when `error` is given), while
        // a Change to the same file is decided at about t1+1050. Records each write's times.
        async function slowFirstWrite(error) {
            await load({
                ...AWAIT,
                watchChange: true,
                pollInterval: '250',
                stabilityThreshold: '300',
            });
            const node = helper.getNode('n1');
            const writeOutput = node.setTypedProperty;
            const writes = [];
            node.setTypedProperty = async (...args) => {
                const write = { action: args[3].action, started: Date.now() };
                writes.push(write);
                try {
                    if (writes.length === 1) {
                        await delay(Math.max(0, t1 + 1500 - Date.now()));
                        if (error) throw error;
                    }
                    return await writeOutput.apply(node, args);
                } finally {
                    write.finished = Date.now();
                }
            };
            const events = eventsFor('watch/a.txt');
            const t1 = await firstObservation('watch/a.txt');
            await delay(Math.max(0, t1 + 600 - Date.now()));
            share.addFile('watch/a.txt', 'aa');
            return { events, writes, t1 };
        }

        it('writes and sends a later event only after an earlier slow output write', async function () {
            this.timeout(6000);
            const { events, writes, t1 } = await slowFirstWrite();
            await delay(Math.max(0, t1 + 2200 - Date.now()));

            assert.deepEqual(
                events.map((msg) => msg.file.action),
                ['add', 'change'],
            );
            assert.deepEqual(
                writes.map((write) => write.action),
                ['add', 'change'],
            );
            assert.ok(writes[1].started >= writes[0].finished, 'the Change waited for the Add');
        });

        it('starts no queued output write after close', async function () {
            this.timeout(6000);
            const { events, writes, t1 } = await slowFirstWrite();
            await delay(Math.max(0, t1 + 1250 - Date.now()));
            await helper.unload();
            await delay(Math.max(0, t1 + 1800 - Date.now()));

            assert.deepEqual(
                writes.map((write) => write.action),
                ['add'],
            );
            assert.deepEqual(events, []);
        });

        it('reports a failed output write and delivers the next event after it', async function () {
            this.timeout(6000);
            const { events, writes, t1 } = await slowFirstWrite(
                new Error('context store unavailable'),
            );
            await delay(Math.max(0, t1 + 2200 - Date.now()));

            assert.deepEqual(
                events.map((msg) => msg.file.action),
                ['change'],
            );
            assert.ok(writes[1].started >= writes[0].finished, 'the Change waited for the failure');
            const reported = errorLogs('n1').filter(
                (entry) => entry.msg && entry.msg.message === 'context store unavailable',
            );
            assert.equal(reported.length, 1);
        });
    });

    describe('stability re-check, long thresholds', function () {
        const AWAIT = { awaitWriteFinish: true };
        const MAX_TIMER = 2147483647;
        const LONG = 3000000000;

        it('does not release at once when the threshold exceeds the timer range', async function () {
            const timers = recordWatchTimers();
            try {
                await load({ ...AWAIT, stabilityThreshold: String(LONG) });
                assert.deepEqual(await collect(helper, 'out', 300), []);
                assert.ok(timers.requested.length > 0);
                for (const { ms } of timers.requested) assert.ok(ms <= MAX_TIMER, `delay ${ms}`);
            } finally {
                timers.restore();
            }
        });

        it('waits out the whole threshold in timer-range segments', async function () {
            const timers = holdLongWatchTimers(1e6);
            try {
                await load({ ...AWAIT, stabilityThreshold: String(LONG) });
                const events = eventsFor('watch/a.txt');
                for (let i = 0; i < 100 && timers.held.length === 0; i++) await delay(5);
                assert.deepEqual(
                    timers.held.map((timer) => timer.ms),
                    [MAX_TIMER],
                );

                timers.fire(timers.held[0]);
                await delay(50);
                assert.equal(events.length, 0, 'not released after the first segment');
                assert.equal(timers.held.length, 2);
                const rest = timers.held[1].ms;
                assert.ok(
                    rest <= LONG - MAX_TIMER && rest > LONG - MAX_TIMER - 1000,
                    `rest ${rest}`,
                );

                timers.fire(timers.held[1]);
                await delay(50);
                assert.equal(events.length, 1);
                assert.equal(timers.held.length, 2);
            } finally {
                timers.restore();
            }
        });
    });

    describe('poll failure backoff', function () {
        it('reports the first failed poll once and doubles the delay until a poll succeeds', async function () {
            const timers = compressWatchTimers();
            try {
                for (let i = 0; i < 4; i++) {
                    share.failOnce(
                        'listFilesAndDirectories',
                        'watch',
                        restError(503, 'ServerBusy'),
                    );
                }
                await load({ ignoreInitial: true });
                await delay(100);
                assert.deepEqual(timers.requested.slice(0, 5), [250, 500, 1000, 2000, 250]);
                assert.equal(errorLogs('n1').length, 1);

                share.failOnce('listFilesAndDirectories', 'watch', restError(503, 'ServerBusy'));
                await delay(100);
                assert.equal(errorLogs('n1').length, 2, 'a new outage is reported again');
            } finally {
                timers.restore();
            }
        });

        it('caps the backoff at 60 s', async function () {
            const timers = compressWatchTimers();
            try {
                for (let i = 0; i < 10; i++) {
                    share.failOnce(
                        'listFilesAndDirectories',
                        'watch',
                        restError(503, 'ServerBusy'),
                    );
                }
                await load({ ignoreInitial: true });
                await delay(150);
                assert.deepEqual(
                    timers.requested.slice(0, 11),
                    [250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 250],
                );
            } finally {
                timers.restore();
            }
        });

        it('never retries faster than a poll interval above the cap', async function () {
            const timers = compressWatchTimers();
            try {
                for (let i = 0; i < 3; i++) {
                    share.failOnce(
                        'listFilesAndDirectories',
                        'watch',
                        restError(503, 'ServerBusy'),
                    );
                }
                await load({ ignoreInitial: true, pollInterval: '70000' });
                await delay(100);
                assert.deepEqual(timers.requested.slice(0, 4), [70000, 70000, 70000, 70000]);
            } finally {
                timers.restore();
            }
        });
    });

    it('legacy: clamps pollInterval to 250ms and treats stabilityThreshold 0 as 2000ms', async function () {
        await load({ pollInterval: '100', stabilityThreshold: '0', awaitWriteFinish: true });

        const node = helper.getNode('n1');
        assert.equal(node.pollInterval, 250);
        assert.equal(node.stabilityThreshold, 2000);
    });
});
