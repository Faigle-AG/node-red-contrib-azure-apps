'use strict';

// The types each typed field offers in the editor (Phase 2.9). A configured type outside these
// fails clearly before anything is evaluated or changed.
const TYPES = {
    shareName: ['msg', 'flow', 'global', 'str', 'jsonata', 'env'],
    source: ['msg', 'flow', 'global', 'str', 'jsonata', 'env'],
    destination: ['msg', 'flow', 'global', 'str', 'jsonata', 'env'],
};

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

    function normalizeAzurePath(value, label) {
        if (typeof value !== 'string') {
            throw createError(`${label} must resolve to a string`, 'INVALID_PATH');
        }

        const normalized = value
            .trim()
            .replace(/\\/g, '/')
            .split('/')
            .filter((part) => part !== '')
            .join('/');

        if (!normalized) throw createError(`${label} is missing`, 'PATH_MISSING');
        if (normalized.split('/').some((segment) => segment === '.' || segment === '..')) {
            throw createError(`${label} cannot contain . or .. segments`, 'INVALID_PATH');
        }
        return normalized;
    }

    function splitFilePath(filename) {
        const segments = filename.split('/');
        return {
            directoryPath: segments.slice(0, -1).join('/'),
            fileName: segments[segments.length - 1],
        };
    }

    function getDirectoryClient(shareClient, directoryPath) {
        let client = shareClient.rootDirectoryClient;
        if (!directoryPath) return client;
        for (const segment of directoryPath.split('/')) client = client.getDirectoryClient(segment);
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

    function getFileClient(shareClient, filename) {
        const parts = splitFilePath(filename);
        return getDirectoryClient(shareClient, parts.directoryPath).getFileClient(parts.fileName);
    }

    function fileHttpHeadersFromProperties(properties) {
        const headers = {};
        const mapping = {
            fileContentType: properties.contentType || properties.fileContentType,
            fileContentEncoding: properties.contentEncoding || properties.fileContentEncoding,
            fileContentLanguage: properties.contentLanguage || properties.fileContentLanguage,
            fileCacheControl: properties.cacheControl || properties.fileCacheControl,
            fileContentDisposition:
                properties.contentDisposition || properties.fileContentDisposition,
        };

        for (const [key, value] of Object.entries(mapping)) {
            if (value !== undefined && value !== null && value !== '') headers[key] = value;
        }
        return headers;
    }

    // Once the destination file is created, close does not stop its range copies part-way (other
    // failures still can).
    async function copyFile(sourceFileClient, destinationFileClient, progress) {
        const properties = await sourceFileClient.getProperties();
        progress.boundary();
        const size = Number(properties.contentLength || 0);
        const createOptions = {};
        const headers = fileHttpHeadersFromProperties(properties);

        if (Object.keys(headers).length > 0) createOptions.fileHttpHeaders = headers;
        if (properties.metadata) createOptions.metadata = properties.metadata;

        await progress.mutate(() => destinationFileClient.create(size, createOptions));
        progress.changed = true;

        for (let offset = 0; offset < size; offset += MAX_RANGE_SIZE) {
            const count = Math.min(MAX_RANGE_SIZE, size - offset);
            const buffer = await sourceFileClient.downloadToBuffer(offset, count);
            await destinationFileClient.uploadRange(buffer, offset, count);
        }
    }

    function AzureFileTransferNode(config) {
        RED.nodes.createNode(this, config);

        this.configNode = RED.nodes.getNode(config.config);
        this.shareName = config.shareName;
        this.shareNameType = config.shareNameType || 'str';
        this.dynamic = config.dynamic === true;
        this.action = config.action || 'move';
        this.source = config.source;
        this.sourceType = config.sourceType || 'str';
        this.destination = config.destination;
        this.destinationType = config.destinationType || 'str';
        this.createDir = config.createDir !== false;

        const node = this;
        extendNode(node);

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

                // Unsupported types fail before anything is evaluated or changed. Dynamic mode
                // ignores the static paths, and a delete never reads its destination (the same test
                // as below), so those types are not checked.
                if (!TYPES.shareName.includes(node.shareNameType)) {
                    throw createError(
                        `Share name type '${node.shareNameType}' is not supported`,
                        'INVALID_CONFIGURATION',
                    );
                }
                if (!node.dynamic) {
                    for (const [field, label] of [
                        ['source', 'Source'],
                        ['destination', 'Destination'],
                    ]) {
                        const type = node[`${field}Type`];
                        if (
                            (field === 'source' ||
                                String(node.action || '').toLowerCase() !== 'delete') &&
                            !TYPES[field].includes(type)
                        ) {
                            throw createError(
                                `${label} type '${type}' is not supported`,
                                'INVALID_CONFIGURATION',
                            );
                        }
                    }
                }

                const shareName = await node.getValidatedProperty(
                    node.shareName,
                    node.shareNameType,
                    msg,
                    'Share name',
                    { required: true, trimString: true, code: 'SHARE_NAME_MISSING' },
                );

                let action;
                let sourceRaw;
                let destinationRaw;
                let createDir;

                if (node.dynamic) {
                    if (!msg.file || typeof msg.file !== 'object') {
                        throw createError(
                            'Dynamic action requested but msg.file is missing',
                            'FILE_MISSING',
                        );
                    }
                    action = msg.file.action;
                    sourceRaw = msg.file.source;
                    destinationRaw = msg.file.destination;
                    createDir = msg.file.createDir === true;
                } else {
                    action = node.action;
                    sourceRaw = await node.getValidatedProperty(
                        node.source,
                        node.sourceType,
                        msg,
                        'Source path',
                        { required: true, trimString: true, code: 'SOURCE_PATH_MISSING' },
                    );
                    if (String(action || '').toLowerCase() !== 'delete') {
                        destinationRaw = await node.getValidatedProperty(
                            node.destination,
                            node.destinationType,
                            msg,
                            'Destination path',
                            { required: true, trimString: true, code: 'DESTINATION_PATH_MISSING' },
                        );
                    }
                    createDir = node.createDir;
                }

                action = String(action || '')
                    .trim()
                    .toLowerCase();
                if (!['copy', 'move', 'delete'].includes(action)) {
                    throw createError(
                        `Unknown action type: ${action || '<empty>'}`,
                        'INVALID_ACTION',
                    );
                }

                // The node may have closed while the share and paths were read.
                if (closing) return finishClosed();
                const sourcePath = normalizeAzurePath(sourceRaw, 'Source path');
                let destinationPath = null;
                if (action !== 'delete') {
                    destinationPath = normalizeAzurePath(destinationRaw, 'Destination path');
                }

                const serviceClient = node.configNode.getClient();
                const shareClient = serviceClient.getShareClient(shareName);
                const sourceFileClient = getFileClient(shareClient, sourcePath);

                if (destinationPath && sourcePath === destinationPath) {
                    const parsed = path.posix.parse(sourcePath);
                    msg.file = {
                        ...msg.file,
                        filetype: 'file',
                        action,
                        source: sourcePath,
                        destination: destinationPath,
                        path: sourcePath,
                        dir: parsed.dir,
                        name: parsed.name,
                        base: parsed.base,
                        ext: parsed.ext,
                    };
                    node.status.info('Source and Destination are identical');
                    send(msg);
                    if (done) done();
                    return;
                }

                node.status.processing(`${action}...`);
                progress = createProgress(action === 'copy' ? 'Copy' : 'Move', () => closing);

                if (action === 'copy' || action === 'move') {
                    const destinationFilePath = splitFilePath(destinationPath);
                    if (createDir) {
                        await ensureDirectory(
                            shareClient,
                            destinationFilePath.directoryPath,
                            progress,
                        );
                        progress.boundary();
                    }

                    if (action === 'copy') {
                        const destinationFileClient = getDirectoryClient(
                            shareClient,
                            destinationFilePath.directoryPath,
                        ).getFileClient(destinationFilePath.fileName);
                        await copyFile(sourceFileClient, destinationFileClient, progress);
                    } else {
                        await progress.mutate(() =>
                            sourceFileClient.rename(destinationPath, {
                                replaceIfExists: true,
                                ignoreReadOnly: true,
                            }),
                        );
                    }
                }

                let deleted;
                if (action === 'delete') {
                    const response = await progress.mutate(() => sourceFileClient.deleteIfExists());
                    deleted = response.succeeded === true;
                }

                if (closing) return finishClosed();
                const resultingPath = destinationPath || sourcePath;
                const parsed = path.posix.parse(resultingPath);
                const file = {
                    filetype: 'file',
                    action,
                    source: sourcePath,
                    destination: destinationPath,
                    path: resultingPath,
                    dir: parsed.dir,
                    name: parsed.name,
                    base: parsed.base,
                    ext: parsed.ext,
                };
                if (action === 'delete') file.deleted = deleted;

                msg.file = { ...msg.file, ...file };

                if (action === 'copy') node.status.succeeded(`Copied ${file.base}`);
                else if (action === 'move') node.status.succeeded(`Moved ${file.base}`);
                else
                    node.status.succeeded(
                        deleted ? `Deleted ${file.base}` : `Not found ${file.base}`,
                    );

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
                node.status.failed(err.code || err.message || 'Configuration error');
                if (done) done(err);
                else node.error(err, msg);
            }
        });
    }

    RED.nodes.registerType('azure-file-transfer', AzureFileTransferNode);
};

module.exports.TYPES = TYPES;
