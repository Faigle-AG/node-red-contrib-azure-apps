'use strict';

module.exports = function (RED) {
    const path = require('path');
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);

    const MAX_RANGE_SIZE = 4 * 1024 * 1024;

    function createError(message, code, cause) {
        const err = new Error(message);
        if (code) err.code = code;
        if (cause) err.cause = cause;
        return err;
    }

    function normalizeAzurePath(value, label = 'Target path') {
        if (typeof value !== 'string') {
            throw createError(`${label} must resolve to a string`, 'INVALID_PATH');
        }

        const normalized = value
            .trim()
            .replace(/\\/g, '/')
            .split('/')
            .filter((part) => part !== '')
            .join('/');

        if (!normalized) throw createError(`${label} is missing`, 'TARGET_PATH_MISSING');

        const segments = normalized.split('/');
        if (segments.some((segment) => segment === '.' || segment === '..')) {
            throw createError(`${label} cannot contain . or .. segments`, 'INVALID_PATH');
        }

        return normalized;
    }

    function splitFilePath(filename) {
        const segments = filename.split('/');
        const fileName = segments.pop();
        return {
            directoryPath: segments.join('/'),
            fileName,
        };
    }

    function getDirectoryClient(shareClient, directoryPath) {
        let client = shareClient.rootDirectoryClient;
        if (!directoryPath) return client;

        for (const segment of directoryPath.split('/')) {
            client = client.getDirectoryClient(segment);
        }
        return client;
    }

    // Creates each missing level of directoryPath. After close it stops between levels; `changed`
    // records a level it actually created.
    async function ensureDirectory(shareClient, directoryPath, progress) {
        let client = shareClient.rootDirectoryClient;
        if (!directoryPath) return client;
        const segments = directoryPath.split('/');
        for (let index = 0; index < segments.length; index += 1) {
            if (index > 0) progress.boundary();
            client = client.getDirectoryClient(segments[index]);
            const response = await progress.mutate(() => client.createIfNotExists());
            if (response.succeeded) progress.changed = true;
        }
        return client;
    }

    // A storage action's progress after close (Phase 2.8e): the action stops at the next boundary
    // between independent steps. Once storage has changed, or may have changed (`changed`: a
    // confirmed change, or a mutating call that failed with unknown effects), whatever ends the
    // action after close is reported: the stop (NODE_CLOSING) or the storage call's own error.
    // Before that, it completes quietly.
    function createProgress(label, isClosing) {
        const progress = {
            changed: false,
            boundary() {
                if (isClosing()) {
                    throw createError(
                        `${label} stopped on close before it completed; changes already made were kept`,
                        'NODE_CLOSING',
                    );
                }
            },
            // Runs one mutating SDK call. A call that fails may still have changed storage, so
            // its failure counts as a change.
            async mutate(call) {
                try {
                    return await call();
                } catch (err) {
                    progress.changed = true;
                    throw err;
                }
            },
        };
        return progress;
    }

    function normalizeWriteData(value) {
        if (value === undefined) {
            throw createError('Data to write is undefined', 'DATA_MISSING');
        }

        if (Buffer.isBuffer(value)) return value;
        if (value instanceof ArrayBuffer) return Buffer.from(value);
        if (ArrayBuffer.isView(value)) {
            return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        }
        if (typeof value === 'object' && value !== null) {
            return Buffer.from(JSON.stringify(value), 'utf8');
        }
        return Buffer.from(String(value), 'utf8');
    }

    // Once the file is resized, close does not stop its range uploads part-way (other failures
    // still can).
    async function appendBuffer(fileClient, buffer, progress) {
        const exists = await fileClient.exists();
        progress.boundary();
        if (!exists) {
            await progress.mutate(() => fileClient.uploadData(buffer));
            return;
        }

        const properties = await fileClient.getProperties();
        progress.boundary();
        const originalSize = Number(properties.contentLength || 0);
        if (buffer.length === 0) return;

        await progress.mutate(() => fileClient.resize(originalSize + buffer.length));
        progress.changed = true;

        for (let sourceOffset = 0; sourceOffset < buffer.length; sourceOffset += MAX_RANGE_SIZE) {
            const count = Math.min(MAX_RANGE_SIZE, buffer.length - sourceOffset);
            const chunk = buffer.subarray(sourceOffset, sourceOffset + count);
            await fileClient.uploadRange(chunk, originalSize + sourceOffset, count);
        }
    }

    function AzureFileWriteNode(config) {
        RED.nodes.createNode(this, config);

        this.configNode = RED.nodes.getNode(config.config);
        this.shareName = config.shareName;
        this.shareNameType = config.shareNameType || 'str';
        this.dynamic = config.dynamic === true;
        this.action = config.action || 'write';
        this.target = config.target;
        this.targetType = config.targetType || 'str';
        this.data = config.data || 'file.data';
        this.dataType = config.dataType || 'msg';
        this.createDir = config.createDir !== false;

        const node = this;
        extendNode(node);

        // True only when the msg data path provably stops at a missing (undefined/null) parent.
        // Reads own data descriptors, so no getter runs again; inherited, accessor or computed
        // parts are treated as uncertain and leave the original error uncoded.
        function hasMissingParent(msg) {
            try {
                const parts = RED.util.normalisePropertyExpression(
                    String(node.data).replace(/^msg\./, ''),
                );
                let current = msg;
                for (const part of parts.slice(0, -1)) {
                    if (typeof part !== 'string' && typeof part !== 'number') return false;
                    const descriptor = Object.getOwnPropertyDescriptor(current, part);
                    if (!descriptor) return !(part in current);
                    if (!('value' in descriptor)) return false;
                    current = descriptor.value;
                    if (current === undefined || current === null) return true;
                    if (typeof current !== 'object') return false;
                }
                return false;
            } catch {
                return false;
            }
        }

        // A msg data path through a missing parent (e.g. file.data without msg.file) throws a
        // TypeError; tag it DATA_MISSING and keep its message as the status text.
        async function getStaticData(msg) {
            try {
                return await node.getTypedProperty(node.data, node.dataType, msg);
            } catch (err) {
                if (
                    node.dataType === 'msg' &&
                    err instanceof TypeError &&
                    !err.code &&
                    hasMissingParent(msg)
                ) {
                    err.code = 'DATA_MISSING';
                    Object.defineProperty(err, 'statusText', { value: err.message });
                }
                throw err;
            }
        }

        // After close, input still in progress starts no new storage action and completes without
        // status, output or error. An action already started stops only between independent steps
        // (directory levels, the files and listing pages of a tree, or before a file's data steps);
        // once a file's data steps begin, close does not stop them part-way. Close cancels no
        // mutating call. Once the action has changed storage, it then fails with NODE_CLOSING, or
        // with the storage call's own error if one fails after close.
        let closing = false;
        node.on('close', function () {
            closing = true;
            node.status.clear();
        });

        node.on('input', async function (msg, send, done) {
            let progress;
            const finishClosed = () => {
                if (done) done();
            };
            try {
                if (!node.configNode) {
                    throw createError('Missing Azure configuration', 'AZURE_CONFIG_MISSING');
                }

                const shareName = await node.getValidatedProperty(
                    node.shareName,
                    node.shareNameType,
                    msg,
                    'Share name',
                    { required: true, trimString: true, code: 'SHARE_NAME_MISSING' },
                );

                let action;
                let targetRaw;
                let dataRaw;
                let createDir;

                if (node.dynamic) {
                    if (!msg.file || typeof msg.file !== 'object') {
                        throw createError(
                            'Dynamic action requested but msg.file is missing',
                            'FILE_MISSING',
                        );
                    }

                    action = msg.file.action;
                    targetRaw = msg.file.path;
                    dataRaw = msg.file.data;
                    createDir = msg.file.createDir === true;
                } else {
                    action = node.action;
                    targetRaw = await node.getValidatedProperty(
                        node.target,
                        node.targetType,
                        msg,
                        'Target path',
                        { required: true, trimString: true, code: 'TARGET_PATH_MISSING' },
                    );
                    dataRaw = await getStaticData(msg);
                    createDir = node.createDir;
                }

                action = String(action || '')
                    .trim()
                    .toLowerCase();
                if (action !== 'write' && action !== 'append') {
                    throw createError(
                        `Unknown action type: ${action || '<empty>'}`,
                        'INVALID_ACTION',
                    );
                }
                if (dataRaw === undefined)
                    throw createError('Data to write is undefined', 'DATA_MISSING');

                const targetPath = normalizeAzurePath(targetRaw);
                const filePath = splitFilePath(targetPath);
                const parsed = path.posix.parse(targetPath);
                const dataBuffer = normalizeWriteData(dataRaw);
                // The node may have closed while the share, path and data were read.
                if (closing) return finishClosed();

                progress = createProgress(action === 'append' ? 'Append' : 'Write', () => closing);
                const serviceClient = node.configNode.getClient();
                const shareClient = serviceClient.getShareClient(shareName);
                const directoryClient = createDir
                    ? await ensureDirectory(shareClient, filePath.directoryPath, progress)
                    : getDirectoryClient(shareClient, filePath.directoryPath);
                progress.boundary();
                const fileClient = directoryClient.getFileClient(filePath.fileName);

                node.status.processing(`${action}...`);

                if (action === 'append') await appendBuffer(fileClient, dataBuffer, progress);
                else await progress.mutate(() => fileClient.uploadData(dataBuffer));
                if (closing) return finishClosed();

                const file = {
                    filetype: 'file',
                    path: targetPath,
                    dir: parsed.dir,
                    name: parsed.name,
                    base: parsed.base,
                    ext: parsed.ext,
                };

                msg.file = { ...msg.file, ...file };
                node.status.succeeded(`${action === 'append' ? 'Appended' : 'Wrote'} ${file.base}`);

                send(msg);
                if (done) done();
            } catch (err) {
                if (closing) {
                    // An action that had changed storage reports why it is incomplete (the stop or
                    // the storage call's own error); anything else completes quietly.
                    if (progress && progress.changed) {
                        if (done) done(err);
                        else node.error(err, msg);
                        return;
                    }
                    return finishClosed();
                }
                node.status.failed(
                    err.statusText || err.code || err.message || 'Configuration error',
                );
                if (done) done(err);
                else node.error(err, msg);
            }
        });
    }

    RED.nodes.registerType('azure-file-write', AzureFileWriteNode);
};
