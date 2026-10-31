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

    // A listing page's items as the SDK's own item listing gives them: files, then directories.
    function pageItems(page) {
        return [
            ...page.segment.fileItems.map((item) => ({ kind: 'file', ...item })),
            ...page.segment.directoryItems.map((item) => ({ kind: 'directory', ...item })),
        ];
    }

    // Lists a directory for a multi-step action page by page. After close it stops before the next
    // item and before requesting another page; a page without a continuation token ends the
    // listing.
    async function* listForAction(directoryClient, progress) {
        const pages = directoryClient.listFilesAndDirectories().byPage();
        for (;;) {
            const { value: page } = await pages.next();
            for (const item of pageItems(page)) {
                progress.boundary();
                yield item;
            }
            if (!page.continuationToken) return;
            progress.boundary();
        }
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

    async function copyDirectoryRecursive(
        sourceDirectory,
        destinationDirectory,
        counters,
        progress,
    ) {
        const response = await progress.mutate(() => destinationDirectory.createIfNotExists());
        if (response.succeeded) progress.changed = true;
        counters.directories += 1;
        progress.boundary();

        for await (const item of listForAction(sourceDirectory, progress)) {
            if (item.kind === 'directory') {
                await copyDirectoryRecursive(
                    sourceDirectory.getDirectoryClient(item.name),
                    destinationDirectory.getDirectoryClient(item.name),
                    counters,
                    progress,
                );
            } else {
                await copyFile(
                    sourceDirectory.getFileClient(item.name),
                    destinationDirectory.getFileClient(item.name),
                    progress,
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

        // After close, input still in progress starts no new storage action and completes without
        // status, output or error. An action already started stops only between independent steps
        // (directory levels, the files and listing pages of a tree, or before a file's data steps);
        // once a file's data steps begin, close does not stop them part-way. Close cancels no
        // call. Once the action has changed storage, it then fails with NODE_CLOSING, or with the
        // storage call's own error if one fails after close.
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

                // The node may have closed while the share and paths were read.
                if (closing) return finishClosed();
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
                progress = createProgress(
                    action === 'copy' ? 'Directory copy' : 'Directory move',
                    () => closing,
                );

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
                        await ensureDirectory(shareClient, destinationParent, progress);
                        progress.boundary();
                    }

                    counters = { files: 0, directories: 0 };
                    await copyDirectoryRecursive(
                        sourceDirectory,
                        destinationDirectory,
                        counters,
                        progress,
                    );
                } else {
                    if (recursive) {
                        const destinationParent = path.posix.dirname(destinationPath);
                        if (destinationParent && destinationParent !== '.') {
                            await ensureDirectory(shareClient, destinationParent, progress);
                            progress.boundary();
                        }
                    }
                    await progress.mutate(() =>
                        sourceDirectory.rename(destinationPath, {
                            replaceIfExists: true,
                            ignoreReadOnly: true,
                        }),
                    );
                }

                if (closing) return finishClosed();
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

    RED.nodes.registerType('azure-directory-transfer', AzureDirectoryTransferNode);
};
