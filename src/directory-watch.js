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
            propertyValue(properties && properties.fileLastWriteTime),
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
        const pendingFiles = new Map();

        function shouldEmit(fileType, eventType) {
            if (fileType === 'file' && !node.filterFiles) return false;
            if (fileType === 'directory' && !node.filterDirs) return false;
            if (eventType === 'add') return node.watchAdd;
            if (eventType === 'change') return node.watchChange && fileType === 'file';
            if (eventType === 'delete') return node.watchDelete;
            return false;
        }

        async function sendEvent(entry, eventType) {
            if (!shouldEmit(entry.filetype, eventType)) return;

            const msg = {};
            const file = {
                action: eventType,
                ...createFileData(node.resolvedSource, entry.path, entry.filetype, entry.stats),
            };

            await node.setTypedProperty(node.target, node.targetType, msg, file);
            node.status.succeeded(`${eventType} ${entry.filetype} ${entry.base}`, {
                next: () => node.status.waiting('Listening...'),
            });
            node.send(msg);
        }

        function queueStableFile(entry, eventType, now) {
            const existing = pendingFiles.get(entry.path);
            const effectiveEvent = existing && existing.eventType === 'add' ? 'add' : eventType;

            if (!existing || existing.signature !== entry.signature) {
                pendingFiles.set(entry.path, {
                    eventType: effectiveEvent,
                    signature: entry.signature,
                    stableSince: now,
                    entry,
                });
                return;
            }

            existing.entry = entry;
            existing.eventType = effectiveEvent;
        }

        async function emitOrQueue(entry, eventType, now) {
            if (!shouldEmit(entry.filetype, eventType)) return;

            if (entry.filetype === 'file' && node.awaitWriteFinish && eventType !== 'delete') {
                queueStableFile(entry, eventType, now);
                return;
            }

            await sendEvent(entry, eventType);
        }

        async function flushStableFiles(currentSnapshot, now) {
            if (!node.awaitWriteFinish) return;

            for (const [itemPath, pending] of pendingFiles) {
                const current = currentSnapshot.get(itemPath);
                if (!current || current.filetype !== 'file') {
                    pendingFiles.delete(itemPath);
                    continue;
                }

                if (current.signature !== pending.signature) {
                    pending.signature = current.signature;
                    pending.stableSince = now;
                    pending.entry = current;
                    continue;
                }

                pending.entry = current;
                if (now - pending.stableSince >= node.stabilityThreshold) {
                    pendingFiles.delete(itemPath);
                    await sendEvent(pending.entry, pending.eventType);
                }
            }
        }

        async function scanDirectory(directoryClient, directoryPath, level, snapshot, ignoreRegex) {
            for await (const item of directoryClient.listFilesAndDirectories()) {
                if (ignoreRegex && ignoreRegex.test(item.name)) continue;

                const itemPath = directoryPath ? `${directoryPath}/${item.name}` : item.name;

                if (item.kind === 'directory') {
                    const childClient = directoryClient.getDirectoryClient(item.name);
                    const properties = await childClient.getProperties();
                    const file = createFileData(
                        node.resolvedSource,
                        itemPath,
                        'directory',
                        properties,
                    );
                    snapshot.set(itemPath, {
                        ...file,
                        signature: createSignature(properties),
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
                    const properties = await fileClient.getProperties();
                    const file = createFileData(node.resolvedSource, itemPath, 'file', properties);
                    snapshot.set(itemPath, {
                        ...file,
                        signature: createSignature(properties),
                    });
                }
            }
        }

        async function createSnapshot() {
            const snapshot = new Map();
            const ignoreRegex = node.ignoredFiles ? new RegExp(node.ignoredFiles) : null;
            const rootDirectory = getDirectoryClient(node.shareClient, node.resolvedSource);
            await scanDirectory(rootDirectory, node.resolvedSource, 0, snapshot, ignoreRegex);
            return snapshot;
        }

        async function processSnapshot(currentSnapshot) {
            const now = Date.now();

            if (previousSnapshot === null) {
                if (!node.ignoreInitial) {
                    for (const entry of currentSnapshot.values()) {
                        await emitOrQueue(entry, 'add', now);
                    }
                }

                previousSnapshot = currentSnapshot;
                await flushStableFiles(currentSnapshot, now);
                return;
            }

            for (const [itemPath, entry] of currentSnapshot) {
                const previous = previousSnapshot.get(itemPath);

                if (!previous) {
                    await emitOrQueue(entry, 'add', now);
                    continue;
                }

                if (entry.filetype !== previous.filetype) {
                    pendingFiles.delete(itemPath);
                    await emitOrQueue({ ...previous, stats: null }, 'delete', now);
                    await emitOrQueue(entry, 'add', now);
                    continue;
                }

                if (entry.filetype === 'file' && entry.signature !== previous.signature) {
                    await emitOrQueue(entry, 'change', now);
                }
            }

            for (const [itemPath, previous] of previousSnapshot) {
                if (currentSnapshot.has(itemPath)) continue;

                pendingFiles.delete(itemPath);
                await emitOrQueue(
                    {
                        ...previous,
                        stats: null,
                    },
                    'delete',
                    now,
                );
            }

            previousSnapshot = currentSnapshot;
            await flushStableFiles(currentSnapshot, now);
        }

        async function poll() {
            if (stopped) return;

            try {
                const snapshot = await createSnapshot();
                await processSnapshot(snapshot);
                node.status.waiting('Listening...');
            } catch (err) {
                node.status.failed(err.code || err.message || 'Watch error');
                node.error(err);
            } finally {
                if (!stopped) timer = setTimeout(() => void poll(), node.pollInterval);
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

                const sourceRaw = await node.getTypedProperty(node.source, node.sourceType, {});
                node.resolvedSource = normalizeAzurePath(sourceRaw, 'Source path');

                const serviceClient = node.configNode.getClient();
                node.shareClient = serviceClient.getShareClient(node.resolvedShareName);

                node.status.processing('Starting...');
                await poll();
            } catch (err) {
                node.status.failed(err.code || err.message || 'Configuration error');
                node.error(err);
            }
        }

        node.on('close', () => {
            stopped = true;
            if (timer) clearTimeout(timer);
            pendingFiles.clear();
        });

        void startListening();
    }

    RED.nodes.registerType('azure-directory-watch', AzureDirectoryWatchNode);
};
