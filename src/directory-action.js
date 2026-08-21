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

    async function ensureDirectory(shareClient, directoryPath) {
        let client = shareClient.rootDirectoryClient;
        for (const segment of directoryPath.split('/')) {
            client = client.getDirectoryClient(segment);
            await client.createIfNotExists();
        }
        return client;
    }

    async function deleteDirectoryRecursive(directoryClient) {
        for await (const item of directoryClient.listFilesAndDirectories()) {
            if (item.kind === 'directory') {
                const child = directoryClient.getDirectoryClient(item.name);
                await deleteDirectoryRecursive(child);
            } else {
                await directoryClient.getFileClient(item.name).deleteIfExists();
            }
        }
        return directoryClient.deleteIfExists();
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

                if (action === 'create') {
                    if (recursive) await ensureDirectory(shareClient, directoryPath);
                    else await directoryClient.create();

                    msg.file = { ...msg.file, ...file };
                    await setOutputData(true);
                    node.status.succeeded(`Created ${file.base}`);
                } else if (action === 'delete') {
                    const response = recursive
                        ? await deleteDirectoryRecursive(directoryClient)
                        : await directoryClient.deleteIfExists();

                    msg.file = { ...msg.file, ...file, deleted: response.succeeded === true };
                    await setOutputData(true);
                    node.status.succeeded(
                        response.succeeded ? `Deleted ${file.base}` : `Not found ${file.base}`,
                    );
                } else {
                    const contents = [];
                    for await (const item of directoryClient.listFilesAndDirectories()) {
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

                    const result = { ...msg.file, ...file, contents };
                    await setOutputData(result);
                    node.status.succeeded(`Listed ${contents.length} items`);
                }

                send(msg);
                if (done) done();
            } catch (err) {
                node.status.failed(err.code || err.message || 'Configuration error');
                if (done) done(err);
                else node.error(err, msg);
            }
        });
    }

    RED.nodes.registerType('azure-directory-action', AzureDirectoryActionNode);
};
