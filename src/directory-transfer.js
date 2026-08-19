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

    function getDirectoryClient(shareClient, directoryPath) {
        let client = shareClient.rootDirectoryClient;
        if (!directoryPath) return client;
        for (const segment of directoryPath.split('/')) client = client.getDirectoryClient(segment);
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

    async function copyFile(sourceFileClient, destinationFileClient) {
        const properties = await sourceFileClient.getProperties();
        const size = Number(properties.contentLength || 0);
        const createOptions = {};
        const headers = fileHttpHeadersFromProperties(properties);

        if (Object.keys(headers).length > 0) createOptions.fileHttpHeaders = headers;
        if (properties.metadata) createOptions.metadata = properties.metadata;

        await destinationFileClient.create(size, createOptions);
        for (let offset = 0; offset < size; offset += MAX_RANGE_SIZE) {
            const count = Math.min(MAX_RANGE_SIZE, size - offset);
            const buffer = await sourceFileClient.downloadToBuffer(offset, count);
            await destinationFileClient.uploadRange(buffer, offset, count);
        }
    }

    async function copyDirectoryRecursive(sourceDirectory, destinationDirectory, counters) {
        await destinationDirectory.createIfNotExists();
        counters.directories += 1;

        for await (const item of sourceDirectory.listFilesAndDirectories()) {
            if (item.kind === 'directory') {
                await copyDirectoryRecursive(
                    sourceDirectory.getDirectoryClient(item.name),
                    destinationDirectory.getDirectoryClient(item.name),
                    counters,
                );
            } else {
                await copyFile(
                    sourceDirectory.getFileClient(item.name),
                    destinationDirectory.getFileClient(item.name),
                );
                counters.files += 1;
            }
        }
    }

    function AzureDirectoryTransferNode(config) {
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
        this.recursive = config.recursive !== false;

        const node = this;
        extendNode(node);

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
                let sourceRaw;
                let destinationRaw;
                let recursive;

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
                    recursive = msg.file.recursive === true;
                } else {
                    action = node.action;
                    sourceRaw = await node.getValidatedProperty(
                        node.source,
                        node.sourceType,
                        msg,
                        'Source path',
                        { required: true, trimString: true, code: 'SOURCE_PATH_MISSING' },
                    );
                    destinationRaw = await node.getValidatedProperty(
                        node.destination,
                        node.destinationType,
                        msg,
                        'Destination path',
                        { required: true, trimString: true, code: 'DESTINATION_PATH_MISSING' },
                    );
                    recursive = node.recursive;
                }

                action = String(action || '')
                    .trim()
                    .toLowerCase();
                if (!['copy', 'move'].includes(action)) {
                    throw createError(
                        `Unknown action type: ${action || '<empty>'}`,
                        'INVALID_ACTION',
                    );
                }

                const sourcePath = normalizeAzurePath(sourceRaw, 'Source path');
                const destinationPath = normalizeAzurePath(destinationRaw, 'Destination path');

                if (sourcePath === destinationPath) {
                    node.status.info('Source and Destination are identical');
                    send(msg);
                    if (done) done();
                    return;
                }
                if (destinationPath.startsWith(sourcePath + '/')) {
                    throw createError(
                        'Destination cannot be inside the source directory',
                        'INVALID_DESTINATION',
                    );
                }

                const serviceClient = node.configNode.getClient();
                const shareClient = serviceClient.getShareClient(shareName);
                const sourceDirectory = getDirectoryClient(shareClient, sourcePath);
                const destinationDirectory = getDirectoryClient(shareClient, destinationPath);

                node.status.processing(`${action}...`);

                let counters;
                if (action === 'copy') {
                    if (!recursive) {
                        throw createError(
                            'Directory copy requires Recursive to be enabled',
                            'RECURSIVE_REQUIRED',
                        );
                    }

                    const destinationParent = path.posix.dirname(destinationPath);
                    if (destinationParent && destinationParent !== '.') {
                        await ensureDirectory(shareClient, destinationParent);
                    }

                    counters = { files: 0, directories: 0 };
                    await copyDirectoryRecursive(sourceDirectory, destinationDirectory, counters);
                } else {
                    if (recursive) {
                        const destinationParent = path.posix.dirname(destinationPath);
                        if (destinationParent && destinationParent !== '.') {
                            await ensureDirectory(shareClient, destinationParent);
                        }
                    }
                    await sourceDirectory.rename(destinationPath, {
                        replaceIfExists: true,
                        ignoreReadOnly: true,
                    });
                }

                const parsed = path.posix.parse(destinationPath);
                const file = {
                    filetype: 'directory',
                    action,
                    source: sourcePath,
                    destination: destinationPath,
                    path: destinationPath,
                    dir: parsed.dir,
                    name: parsed.name,
                    base: parsed.base,
                    ext: parsed.ext,
                };
                if (counters) file.copied = counters;

                msg.file = { ...msg.file, ...file };
                node.status.succeeded(
                    action === 'copy'
                        ? `Copied ${counters.files} files`
                        : `Moved ${path.posix.basename(sourcePath)}`,
                );

                send(msg);
                if (done) done();
            } catch (err) {
                node.status.failed(err.code || err.message || 'Configuration error');
                if (done) done(err);
                else node.error(err, msg);
            }
        });
    }

    RED.nodes.registerType('azure-directory-transfer', AzureDirectoryTransferNode);
};
