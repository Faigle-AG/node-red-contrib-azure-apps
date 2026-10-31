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

    function normalizeAzurePath(value, options = {}) {
        if (value === undefined || value === null) value = '';
        if (typeof value !== 'string') {
            throw createError(
                `${options.label || 'Directory path'} must resolve to a string`,
                'INVALID_PATH',
            );
        }

        const normalized = value
            .trim()
            .replace(/\\/g, '/')
            .split('/')
            .filter((part) => part !== '')
            .join('/');

        if (!normalized && options.required) {
            throw createError(
                `${options.label || 'Directory path'} is missing`,
                'DIRECTORY_PATH_MISSING',
            );
        }
        if (
            normalized &&
            normalized.split('/').some((segment) => segment === '.' || segment === '..')
        ) {
            throw createError('Directory path cannot contain . or .. segments', 'INVALID_PATH');
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

    async function deleteDirectoryRecursive(directoryClient, progress) {
        for await (const item of listForAction(directoryClient, progress)) {
            if (item.kind === 'directory') {
                const child = directoryClient.getDirectoryClient(item.name);
                await deleteDirectoryRecursive(child, progress);
            } else {
                const response = await progress.mutate(() =>
                    directoryClient.getFileClient(item.name).deleteIfExists(),
                );
                if (response.succeeded) progress.changed = true;
            }
        }
        // The directory itself is deleted as a separate step.
        progress.boundary();
        const response = await progress.mutate(() => directoryClient.deleteIfExists());
        if (response.succeeded) progress.changed = true;
        return response;
    }

    function directoryMetadata(directoryPath) {
        if (!directoryPath) {
            return { filetype: 'directory', path: '', dir: '', name: '', base: '', ext: '' };
        }
        const parsed = path.posix.parse(directoryPath);
        return {
            filetype: 'directory',
            path: directoryPath,
            dir: parsed.dir,
            name: parsed.name,
            base: parsed.base,
            ext: parsed.ext,
        };
    }

    function AzureDirectoryActionNode(config) {
        RED.nodes.createNode(this, config);

        this.configNode = RED.nodes.getNode(config.config);
        this.shareName = config.shareName;
        this.shareNameType = config.shareNameType || 'str';
        this.dynamic = config.dynamic === true;
        this.action = config.action || 'list';
        this.source = config.source;
        this.sourceType = config.sourceType || 'str';
        this.property = config.property || 'file.content';
        this.propertyType = config.propertyType || 'msg';
        this.recursive = config.recursive !== false;

        const node = this;
        extendNode(node);

        // After close, input still in progress starts no new storage action and completes without
        // status, output or error, and close aborts the list action's page request in flight. A
        // recursive create or delete already started stops only between directory levels, items
        // or pages; close cancels no mutating call. Once the action has changed storage, it then
        // fails with NODE_CLOSING, or with the storage call's own error if one fails after close.
        const pending = new Set();
        let closing = false;
        node.on('close', function () {
            closing = true;
            for (const controller of pending) {
                try {
                    controller.abort();
                } catch (err) {
                    node.warn(`Could not abort an Azure Files listing: ${err.message}`);
                }
            }
            node.status.clear();
        });

        node.on('input', async function (msg, send, done) {
            const controller = new AbortController();
            pending.add(controller);
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
                let recursive;

                if (node.dynamic) {
                    if (!msg.file || typeof msg.file !== 'object') {
                        throw createError(
                            'Dynamic action requested but msg.file is missing',
                            'FILE_MISSING',
                        );
                    }
                    action = msg.file.action;
                    sourceRaw = msg.file.path;
                    recursive = msg.file.recursive === true;
                } else {
                    action = node.action;
                    sourceRaw = await node.getTypedProperty(node.source, node.sourceType, msg);
                    recursive = node.recursive;
                }

                action = String(action || '')
                    .trim()
                    .toLowerCase();
                if (!['create', 'delete', 'list'].includes(action)) {
                    throw createError(`Unknown action: ${action || '<empty>'}`, 'INVALID_ACTION');
                }

                // The node may have closed while the share and path were read.
                if (closing) return finishClosed();
                const directoryPath = normalizeAzurePath(sourceRaw, {
                    required: action !== 'list',
                    label: 'Directory path',
                });

                const serviceClient = node.configNode.getClient();
                const shareClient = serviceClient.getShareClient(shareName);
                const directoryClient = getDirectoryClient(shareClient, directoryPath);
                const file = directoryMetadata(directoryPath);

                const setOutputData = async (data) => {
                    await node.setTypedProperty(node.property, node.propertyType, msg, data);
                };

                node.status.processing(`${action}...`);
                progress = createProgress(
                    action === 'create' ? 'Recursive create' : 'Recursive delete',
                    () => closing,
                );

                let outputData;
                let statusText;
                if (action === 'create') {
                    if (recursive) await ensureDirectory(shareClient, directoryPath, progress);
                    else await progress.mutate(() => directoryClient.create());
                    msg.file = { ...msg.file, ...file };
                    outputData = true;
                    statusText = `Created ${file.base}`;
                } else if (action === 'delete') {
                    const response = recursive
                        ? await deleteDirectoryRecursive(directoryClient, progress)
                        : await progress.mutate(() => directoryClient.deleteIfExists());
                    msg.file = { ...msg.file, ...file, deleted: response.succeeded === true };
                    outputData = true;
                    statusText = response.succeeded
                        ? `Deleted ${file.base}`
                        : `Not found ${file.base}`;
                } else {
                    const contents = [];
                    // Page by page, so that close stops before another page is requested; close
                    // also aborts the page request in flight.
                    const pages = directoryClient
                        .listFilesAndDirectories({ abortSignal: controller.signal })
                        .byPage();
                    for (;;) {
                        const { value: page } = await pages.next();
                        for (const item of pageItems(page)) {
                            const itemPath = directoryPath
                                ? `${directoryPath}/${item.name}`
                                : item.name;
                            const parsedItem = path.posix.parse(itemPath);
                            contents.push({
                                filetype: item.kind,
                                path: itemPath,
                                dir: parsedItem.dir,
                                name: parsedItem.name,
                                base: parsedItem.base,
                                ext: parsedItem.ext,
                            });
                        }
                        if (!page.continuationToken) break;
                        if (closing) return finishClosed();
                    }
                    outputData = { ...msg.file, ...file, contents };
                    statusText = `Listed ${contents.length} items`;
                }
                // The storage action is complete; an output failure after close stays quiet.
                progress = null;
                if (closing) return finishClosed();
                await setOutputData(outputData);
                if (closing) return finishClosed();
                node.status.succeeded(statusText);
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
            } finally {
                pending.delete(controller);
            }
        });
    }

    RED.nodes.registerType('azure-directory-action', AzureDirectoryActionNode);
};
