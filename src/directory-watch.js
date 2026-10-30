'use strict';

module.exports = function (RED) {
    const path = require('path');
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);

    function createError(message, code, cause) {
        const err = new Error(message);
        if (code) err.code = code;
        if (cause) err.cause = cause;
        return err;
    }

    function normalizeAzurePath(value, label) {
        if (value === undefined || value === null) value = '';
        if (typeof value !== 'string') {
            throw createError(`${label} must resolve to a string`, 'INVALID_PATH');
        }

        const normalized = value
            .trim()
            .replace(/\\/g, '/')
            .split('/')
            .filter((part) => part !== '')
            .join('/');

        if (normalized.split('/').some((segment) => segment === '.' || segment === '..')) {
            throw createError(`${label} cannot contain . or .. segments`, 'INVALID_PATH');
        }

        return normalized;
    }

    function getDirectoryClient(shareClient, directoryPath) {
        let client = shareClient.rootDirectoryClient;
        if (!directoryPath) return client;
        for (const segment of directoryPath.split('/')) client = client.getDirectoryClient(segment);
        return client;
    }

    // Upper bound for the poll backoff during an outage; never shorter than the poll interval.
    const MAX_BACKOFF_MS = 60000;
    // Longest delay setTimeout accepts; it fires longer ones after 1 ms, so long waits run in segments.
    const MAX_TIMER_MS = 2147483647;

    function isNotFound(err) {
        return Boolean(err && (err.statusCode === 404 || err.code === 'ResourceNotFound'));
    }

    function propertyValue(value) {
        if (value instanceof Date) return value.toISOString();
        if (value === undefined || value === null) return '';
        return String(value);
    }

    function createSignature(properties) {
        return [
            propertyValue(properties && properties.etag),
            propertyValue(properties && properties.lastModified),
            propertyValue(properties && properties.contentLength),
            propertyValue(properties && properties.fileLastWriteOn),
        ].join('|');
    }

    function createFileData(source, itemPath, fileType, stats) {
        const parsed = path.posix.parse(itemPath);
        return {
            filetype: fileType,
            source,
            path: itemPath,
            dir: parsed.dir,
            name: parsed.name,
            base: parsed.base,
            ext: parsed.ext,
            stats: stats || null,
        };
    }

    function AzureDirectoryWatchNode(config) {
        RED.nodes.createNode(this, config);

        this.configNode = RED.nodes.getNode(config.config);
        this.shareName = config.shareName;
        this.shareNameType = config.shareNameType || 'str';
        this.source = config.source || '';
        this.sourceType = config.sourceType || 'str';
        this.target = config.target || 'file';
        this.targetType = config.targetType || 'msg';
        this.depth = Math.max(0, parseInt(config.depth, 10) || 0);
        this.pollInterval = Math.max(250, parseInt(config.pollInterval, 10) || 5000);
        this.watchAdd = config.watchAdd !== false;
        this.watchChange = config.watchChange === true;
        this.watchDelete = config.watchDelete === true;
        this.filterFiles = config.filterFiles !== false;
        this.filterDirs = config.filterDirs === true;
        this.awaitWriteFinish = config.awaitWriteFinish !== false;
        this.stabilityThreshold = Math.max(0, parseInt(config.stabilityThreshold, 10) || 2000);
        this.ignoreInitial = config.ignoreInitial === true;
        this.ignoredFiles = config.ignoredFiles || false;

        const node = this;
        extendNode(node);

        let stopped = false;
        let timer = null;
        let previousSnapshot = null;
        // Files waiting for awaitWriteFinish, by path. Each record is released only by its own
        // deadline re-check (a fresh getProperties), never directly by a poll.
        const pendingFiles = new Map();
        let generations = 0;
        // Issue order of every properties request (scan item or re-check). A record applies an
        // observation only if it was issued after the last one it applied.
        let issued = 0;
        let failures = 0; // consecutive failed polls
        let outageReported = false;
        let notBefore = 0; // during an outage, no request starts before this time
        // Entry each file was last released with, by path. Until a complete poll holds it or sees
        // the file with a newer request, it is that file's baseline, even if the poll that found
        // the file failed after the release.
        const released = new Map();
        // Tail of the output queue: typed writes and sends run one at a time, in the order the
        // events were decided, so a slow asynchronous target cannot reorder them.
        let outputs = Promise.resolve();

        function shouldEmit(fileType, eventType) {
            if (fileType === 'file' && !node.filterFiles) return false;
            if (fileType === 'directory' && !node.filterDirs) return false;
            if (eventType === 'add') return node.watchAdd;
            if (eventType === 'change') return node.watchChange && fileType === 'file';
            if (eventType === 'delete') return node.watchDelete;
            return false;
        }

        // Queues the event's output; the caller gets that event's own result or error.
        function sendEvent(entry, eventType) {
            const result = outputs.then(() => writeEvent(entry, eventType));
            outputs = result.catch(() => {});
            return result;
        }

        async function writeEvent(entry, eventType) {
            // Checked when the write starts, not when it was queued.
            if (stopped || !shouldEmit(entry.filetype, eventType)) return;

            const msg = {};
            const file = {
                action: eventType,
                ...createFileData(node.resolvedSource, entry.path, entry.filetype, entry.stats),
            };

            await node.setTypedProperty(node.target, node.targetType, msg, file);
            if (stopped) return;
            node.status.succeeded(`${eventType} ${entry.filetype} ${entry.base}`, {
                next: () => node.status.waiting('Listening...'),
            });
            node.send(msg);
        }

        function backoffDelay() {
            if (failures <= 1) return node.pollInterval;
            const doubled = node.pollInterval * 2 ** (failures - 1);
            return Math.max(node.pollInterval, Math.min(doubled, MAX_BACKOFF_MS));
        }

        // Reports the first failure of an outage; later ones only refresh the status.
        function reportFailure(err) {
            node.status.failed(err.code || err.message || 'Watch error');
            if (outageReported) return;
            outageReported = true;
            node.error(err);
        }

        function schedulePoll(delay) {
            if (stopped) return;
            if (timer) clearTimeout(timer);
            const now = Date.now();
            const due = Math.max(now + delay, notBefore);
            timer = setTimeout(() => {
                timer = null;
                void poll();
            }, due - now);
            timer.dueAt = due;
        }

        // A failed re-check also holds back the next poll and every other due re-check.
        function holdRequests(until) {
            notBefore = Math.max(notBefore, until);
            if (timer && timer.dueAt < notBefore) schedulePoll(0);
        }

        function cancelRecord(record) {
            if (record.timer) clearTimeout(record.timer);
            record.timer = null;
        }

        function dropRecord(record) {
            cancelRecord(record);
            if (pendingFiles.get(record.path) === record) pendingFiles.delete(record.path);
        }

        function armRecord(record, at = record.observedAt + node.stabilityThreshold) {
            cancelRecord(record);
            if (stopped) return;
            const wait = Math.max(0, Math.max(at, notBefore) - Date.now());
            const capped = wait > MAX_TIMER_MS;
            record.timer = setTimeout(
                () => {
                    record.timer = null;
                    if (capped) armRecord(record, at);
                    else void recheckRecord(record);
                },
                capped ? MAX_TIMER_MS : wait,
            );
        }

        // Applies a newer observation of a pending file: restarts its stability wait when the
        // signature changed or the file had gone missing, otherwise keeps the running deadline.
        function observeRecord(record, entry) {
            if (entry.seq <= record.lastSeq) return;
            record.lastSeq = entry.seq;
            if (record.missing || entry.signature !== record.signature) {
                record.generation = ++generations;
                record.signature = entry.signature;
                record.observedAt = entry.observedAt;
                record.entry = entry;
                record.missing = false;
                armRecord(record);
                return;
            }
            record.entry = entry;
        }

        function queueStableFile(entry, eventType) {
            if (stopped) return;
            const existing = pendingFiles.get(entry.path);
            if (!existing) {
                const record = {
                    path: entry.path,
                    eventType,
                    generation: ++generations,
                    signature: entry.signature,
                    observedAt: entry.observedAt,
                    lastSeq: entry.seq,
                    entry,
                    timer: null,
                    inFlight: false,
                    again: false,
                    missing: false,
                };
                pendingFiles.set(entry.path, record);
                armRecord(record);
                return;
            }
            if (existing.eventType !== 'add') existing.eventType = eventType;
            observeRecord(existing, entry);
        }

        async function emitOrQueue(entry, eventType) {
            if (stopped || !shouldEmit(entry.filetype, eventType)) return;

            if (entry.filetype === 'file' && node.awaitWriteFinish && eventType !== 'delete') {
                queueStableFile(entry, eventType);
                return;
            }

            await sendEvent(entry, eventType);
        }

        function getFileClient(filePath) {
            const directory = path.posix.dirname(filePath);
            return getDirectoryClient(
                node.shareClient,
                directory === '.' ? '' : directory,
            ).getFileClient(path.posix.basename(filePath));
        }

        // A current record that is neither missing nor being checked always keeps a timer.
        function ensureScheduled(record, again) {
            if (pendingFiles.get(record.path) !== record || record.missing || record.inFlight)
                return;
            if (again || !record.timer) armRecord(record);
        }

        // Deadline check: a fresh getProperties decides whether the file has stayed unchanged.
        async function recheckRecord(record) {
            if (stopped || pendingFiles.get(record.path) !== record) return;
            if (record.inFlight) {
                record.again = true;
                return;
            }
            if (Date.now() < notBefore) {
                armRecord(record, notBefore);
                return;
            }

            const generation = record.generation;
            const seq = ++issued;
            record.inFlight = true;
            let properties;
            try {
                properties = await getFileClient(record.path).getProperties();
            } catch (err) {
                record.inFlight = false;
                if (stopped) return;
                const current = pendingFiles.get(record.path) === record;
                const fresh = current && record.generation === generation && seq > record.lastSeq;
                const again = current && record.again;
                if (current) record.again = false;
                if (isNotFound(err)) {
                    if (fresh) {
                        // Gone for now; the next (newer) poll either re-arms it or reports the delete.
                        record.missing = true;
                        record.lastSeq = seq;
                    } else {
                        ensureScheduled(record, again);
                    }
                    return;
                }
                holdRequests(Date.now() + backoffDelay());
                reportFailure(err);
                if (fresh) armRecord(record);
                else ensureScheduled(record, again);
                return;
            }
            record.inFlight = false;
            if (stopped || pendingFiles.get(record.path) !== record) return;

            const again = record.again;
            record.again = false;
            const signature = createSignature(properties);
            const entry = { ...record.entry, stats: properties, signature };
            // Same generation and signature: nothing changed since the record was armed, even if a
            // newer observation of that same signature landed meanwhile.
            const stable = record.generation === generation && signature === record.signature;
            if (!stable) {
                if (record.generation === generation && seq > record.lastSeq) {
                    observeRecord(record, { ...entry, observedAt: Date.now(), seq });
                } else {
                    ensureScheduled(record, again);
                }
                return;
            }

            dropRecord(record);
            // An older response must not roll back metadata from a newer same-signature observation.
            const latest = seq > record.lastSeq ? entry : record.entry;
            const releasedSeq = Math.max(seq, record.lastSeq);
            released.set(record.path, { seq: releasedSeq, entry: { ...latest, seq: releasedSeq } });
            try {
                await sendEvent(latest, record.eventType);
            } catch (err) {
                if (stopped) return;
                reportFailure(err);
            }
        }

        // Newest observation already applied to a path's pending record or release.
        function knownSeq(itemPath) {
            const record = pendingFiles.get(itemPath);
            const release = released.get(itemPath);
            return Math.max(record ? record.lastSeq : 0, release ? release.seq : 0);
        }

        // Brings every pending record up to date with a completed poll. A missing or non-file
        // entry only drops the record if it was observed after the record's newest observation.
        function refreshPending(currentSnapshot) {
            for (const record of [...pendingFiles.values()]) {
                const current = currentSnapshot.get(record.path);
                if (!current || current.filetype !== 'file') {
                    const seen = current ? current.seq : currentSnapshot.startSeq;
                    if (seen > record.lastSeq) dropRecord(record);
                    continue;
                }
                observeRecord(record, current);
            }
        }

        async function scanDirectory(directoryClient, directoryPath, level, snapshot, ignoreRegex) {
            for await (const item of directoryClient.listFilesAndDirectories()) {
                if (stopped) return;
                if (ignoreRegex && ignoreRegex.test(item.name)) continue;

                const itemPath = directoryPath ? `${directoryPath}/${item.name}` : item.name;

                try {
                    if (item.kind === 'directory') {
                        const childClient = directoryClient.getDirectoryClient(item.name);
                        const seq = ++issued;
                        const properties = await childClient.getProperties();
                        if (stopped) return;
                        const file = createFileData(
                            node.resolvedSource,
                            itemPath,
                            'directory',
                            properties,
                        );
                        snapshot.set(itemPath, {
                            ...file,
                            signature: createSignature(properties),
                            observedAt: Date.now(),
                            seq,
                        });

                        if (level < node.depth) {
                            await scanDirectory(
                                childClient,
                                itemPath,
                                level + 1,
                                snapshot,
                                ignoreRegex,
                            );
                        }
                    } else {
                        const fileClient = directoryClient.getFileClient(item.name);
                        const seq = ++issued;
                        const properties = await fileClient.getProperties();
                        if (stopped) return;
                        const file = createFileData(
                            node.resolvedSource,
                            itemPath,
                            'file',
                            properties,
                        );
                        snapshot.set(itemPath, {
                            ...file,
                            signature: createSignature(properties),
                            observedAt: Date.now(),
                            seq,
                        });
                    }
                } catch (err) {
                    if (err.statusCode !== 404 && err.code !== 'ResourceNotFound') {
                        throw err;
                    }
                }
                // Before the iterator fetches the next item or page.
                if (stopped) return;
            }
        }

        async function createSnapshot() {
            const snapshot = new Map();
            snapshot.startSeq = ++issued;
            const rootDirectory = getDirectoryClient(node.shareClient, node.resolvedSource);
            await scanDirectory(rootDirectory, node.resolvedSource, 0, snapshot, node.ignoreRegex);
            return snapshot;
        }

        // What a poll compares a path with: the committed entry, or a newer released one.
        function baselineFor(itemPath) {
            const previous = previousSnapshot ? previousSnapshot.get(itemPath) : undefined;
            const release = released.get(itemPath);
            return release && (!previous || release.seq > previous.seq) ? release.entry : previous;
        }

        async function processSnapshot(currentSnapshot) {
            // With ignoreInitial, the first complete poll only sets the baseline.
            const silent = previousSnapshot === null && node.ignoreInitial;
            const next = new Map();
            next.startSeq = currentSnapshot.startSeq;

            for (const [itemPath, entry] of currentSnapshot) {
                const baseline = baselineFor(itemPath);
                // An observation older than one a re-check or release already applied is stale:
                // it raises no events and never becomes the baseline.
                if (entry.seq <= knownSeq(itemPath)) {
                    if (baseline) next.set(itemPath, baseline);
                    continue;
                }
                next.set(itemPath, entry);
                if (silent) continue;

                if (!baseline) {
                    await emitOrQueue(entry, 'add');
                } else if (entry.filetype !== baseline.filetype) {
                    if (pendingFiles.has(itemPath)) dropRecord(pendingFiles.get(itemPath));
                    await emitOrQueue({ ...baseline, stats: null }, 'delete');
                    await emitOrQueue(entry, 'add');
                } else if (entry.filetype === 'file' && entry.signature !== baseline.signature) {
                    await emitOrQueue(entry, 'change');
                }
            }

            // Known paths this listing lacks. A release can land while a delete output is awaited,
            // so the keys are read again until every one of them has been handled.
            const handled = new Set(currentSnapshot.keys());
            const unhandled = () =>
                [...(previousSnapshot ? previousSnapshot.keys() : []), ...released.keys()].filter(
                    (itemPath) => !handled.has(itemPath),
                );
            for (let batch = unhandled(); batch.length; batch = unhandled()) {
                for (const itemPath of batch) {
                    if (handled.has(itemPath)) continue; // listed both committed and released
                    handled.add(itemPath);
                    const baseline = baselineFor(itemPath);
                    // An absence only counts if the listing started after the newest observation.
                    if (knownSeq(itemPath) > currentSnapshot.startSeq) {
                        next.set(itemPath, baseline);
                        continue;
                    }

                    if (pendingFiles.has(itemPath)) dropRecord(pendingFiles.get(itemPath));
                    await emitOrQueue({ ...baseline, stats: null }, 'delete');
                }
            }

            previousSnapshot = next;
            // A release is done once the new baseline holds it or a newer observation replaced it.
            for (const [itemPath, release] of released) {
                const base = next.get(itemPath);
                if (base ? base.seq >= release.seq : currentSnapshot.startSeq > release.seq) {
                    released.delete(itemPath);
                }
            }
            refreshPending(currentSnapshot);
        }

        async function poll() {
            if (stopped) return;

            try {
                const snapshot = await createSnapshot();
                if (stopped) return;
                await processSnapshot(snapshot);
                if (stopped) return;
                // Recovery only once the whole poll, including its output writes, succeeded.
                failures = 0;
                notBefore = 0;
                outageReported = false;
                node.status.waiting('Listening...');
            } catch (err) {
                if (stopped) return;
                failures += 1;
                notBefore = Math.max(notBefore, Date.now() + backoffDelay());
                reportFailure(err);
            } finally {
                schedulePoll(failures ? backoffDelay() : node.pollInterval);
            }
        }

        async function startListening() {
            try {
                if (!node.configNode) {
                    throw createError('Missing Azure configuration', 'AZURE_CONFIG_MISSING');
                }

                node.resolvedShareName = await node.getValidatedProperty(
                    node.shareName,
                    node.shareNameType,
                    {},
                    'Share name',
                    { required: true, trimString: true, code: 'SHARE_NAME_MISSING' },
                );
                if (stopped) return;

                const sourceRaw = await node.getTypedProperty(node.source, node.sourceType, {});
                if (stopped) return;
                node.resolvedSource = normalizeAzurePath(sourceRaw, 'Source path');

                // Compiled once: an invalid pattern stops the watcher instead of failing every poll.
                node.ignoreRegex = node.ignoredFiles ? new RegExp(node.ignoredFiles) : null;

                const serviceClient = node.configNode.getClient();
                node.shareClient = serviceClient.getShareClient(node.resolvedShareName);

                node.status.processing('Starting...');
                await poll();
            } catch (err) {
                if (stopped) return;
                node.status.failed(err.code || err.message || 'Configuration error');
                node.error(err);
            }
        }

        node.on('close', () => {
            stopped = true;
            if (timer) clearTimeout(timer);
            for (const record of pendingFiles.values()) cancelRecord(record);
            pendingFiles.clear();
            released.clear();
        });

        void startListening();
    }

    RED.nodes.registerType('azure-directory-watch', AzureDirectoryWatchNode);
};
