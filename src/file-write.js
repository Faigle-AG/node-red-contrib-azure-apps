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

    async function ensureDirectory(shareClient, directoryPath) {
        let client = shareClient.rootDirectoryClient;
        if (!directoryPath) return client;

        for (const segment of directoryPath.split('/')) {
            client = client.getDirectoryClient(segment);
            await client.createIfNotExists();
        }
        return client;
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

    async function appendBuffer(fileClient, buffer) {
        const exists = await fileClient.exists();
        if (!exists) {
            await fileClient.uploadData(buffer);
            return;
        }

        const properties = await fileClient.getProperties();
        const originalSize = Number(properties.contentLength || 0);
        if (buffer.length === 0) return;

        await fileClient.resize(originalSize + buffer.length);

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

        node.on('input', async function (msg, send, done) {
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

                const serviceClient = node.configNode.getClient();
                const shareClient = serviceClient.getShareClient(shareName);
                const directoryClient = createDir
                    ? await ensureDirectory(shareClient, filePath.directoryPath)
                    : getDirectoryClient(shareClient, filePath.directoryPath);
                const fileClient = directoryClient.getFileClient(filePath.fileName);

                node.status.processing(`${action}...`);

                if (action === 'append') await appendBuffer(fileClient, dataBuffer);
                else await fileClient.uploadData(dataBuffer);

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
