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

    function isNotFound(err) {
        return Boolean(
            err &&
            (err.statusCode === 404 ||
                err.status === 404 ||
                err.code === 'ResourceNotFound' ||
                err.code === 'ParentNotFound'),
        );
    }

    function normalizeAzurePath(value) {
        if (typeof value !== 'string') {
            throw createError('Source path must resolve to a string', 'INVALID_PATH');
        }

        const normalized = value
            .trim()
            .replace(/\\/g, '/')
            .split('/')
            .filter((part) => part !== '')
            .join('/');

        if (!normalized) {
            throw createError('Source path is missing', 'SOURCE_PATH_MISSING');
        }

        const segments = normalized.split('/');
        if (segments.some((segment) => segment === '.' || segment === '..')) {
            throw createError('Source path cannot contain . or .. segments', 'INVALID_PATH');
        }

        return normalized;
    }

    function resolveActions(action) {
        let runRead = false;
        let runExists = false;
        let runStat = false;

        if (Array.isArray(action)) {
            const actions = action.map((value) => String(value).trim().toLowerCase());
            runRead = actions.includes('read');
            runExists = actions.includes('exists');
            runStat = actions.includes('stat');
        } else if (typeof action === 'string') {
            const actions = action
                .toLowerCase()
                .split(/[\s,+|]+/)
                .filter(Boolean);
            runRead = actions.includes('read');
            runExists = actions.includes('exists');
            runStat = actions.includes('stat');
        } else if (action && typeof action === 'object') {
            runRead = action.read === true;
            runExists = action.exists === true;
            runStat = action.stat === true;
        }

        return { runRead, runExists, runStat };
    }

    function getFileClient(shareClient, filename) {
        const segments = filename.split('/');
        const fileName = segments.pop();
        let directoryClient = shareClient.rootDirectoryClient;

        for (const segment of segments) {
            directoryClient = directoryClient.getDirectoryClient(segment);
        }

        return directoryClient.getFileClient(fileName);
    }

    function AzureFileReadNode(config) {
        RED.nodes.createNode(this, config);

        this.configNode = RED.nodes.getNode(config.config);
        this.shareName = config.shareName;
        this.shareNameType = config.shareNameType || 'str';
        this.dynamic = config.dynamic === true;
        this.actionRead = config.actionRead;
        this.actionExists = config.actionExists;
        this.actionStat = config.actionStat;
        this.source = config.source;
        this.sourceType = config.sourceType || 'str';
        this.target = config.target || 'file';
        this.targetType = config.targetType || 'msg';

        const node = this;
        extendNode(node);

        node.on('input', async function (msg, send, done) {
            try {
                if (!node.configNode) {
                    throw createError('Missing Azure configuration', 'AZURE_CONFIG_MISSING');
                }

                const currentShareName = await node.getValidatedProperty(
                    node.shareName,
                    node.shareNameType,
                    msg,
                    'Share name',
                    {
                        required: true,
                        trimString: true,
                        code: 'SHARE_NAME_MISSING',
                    },
                );

                let sourcePathRaw;
                let runRead;
                let runExists;
                let runStat;

                if (node.dynamic) {
                    if (!msg.file || msg.file.action === undefined) {
                        throw createError(
                            'Dynamic action requested but msg.file.action is missing',
                            'ACTION_MISSING',
                        );
                    }
                    if (!msg.file || msg.file.path === undefined) {
                        throw createError(
                            'Dynamic action requested but msg.file.path is missing',
                            'SOURCE_PATH_MISSING',
                        );
                    }

                    sourcePathRaw = msg.file.path;
                    ({ runRead, runExists, runStat } = resolveActions(msg.file.action));
                } else {
                    sourcePathRaw = await node.getValidatedProperty(
                        node.source,
                        node.sourceType,
                        msg,
                        'Source path',
                        {
                            required: true,
                            trimString: true,
                            code: 'SOURCE_PATH_MISSING',
                        },
                    );
                    runRead = node.actionRead;
                    runExists = node.actionExists;
                    runStat = node.actionStat;
                }

                const filename = normalizeAzurePath(sourcePathRaw);
                const parsed = path.posix.parse(filename);

                const file = {
                    filetype: 'file',
                    path: filename,
                    dir: parsed.dir,
                    name: parsed.name,
                    base: parsed.base,
                    ext: parsed.ext,
                };

                const serviceClient = node.configNode.getClient();
                const shareClient = serviceClient.getShareClient(currentShareName);
                const fileClient = getFileClient(shareClient, filename);

                node.status.processing('processing...');

                const acts = [];
                let fileExists;
                let properties;

                if (runStat) {
                    try {
                        properties = await fileClient.getProperties();
                        fileExists = true;
                    } catch (err) {
                        if (!isNotFound(err)) throw err;
                        fileExists = false;
                    }
                }

                if (runRead) {
                    if (fileExists === false) {
                        throw createError(`File not found: ${filename}`, 'FILE_NOT_FOUND');
                    }

                    try {
                        file.data = await fileClient.downloadToBuffer(0);
                        fileExists = true;
                        acts.push('Read');
                    } catch (err) {
                        if (isNotFound(err)) {
                            throw createError(`File not found: ${filename}`, 'FILE_NOT_FOUND', err);
                        }
                        throw err;
                    }
                }

                if (runExists) {
                    if (fileExists === undefined) {
                        fileExists = await fileClient.exists();
                    }
                    file.exists = fileExists;
                    acts.push(fileExists ? 'Exists' : 'Not Found');
                }

                if (runStat) {
                    if (fileExists) {
                        if (
                            properties.fileAttributes &&
                            properties.fileAttributes.includes('Directory')
                        )
                            file.filetype = 'directory';

                        file.stats = {
                            size: properties.contentLength,
                            mtime: properties.lastModified,
                            ctime: properties.fileCreatedOn || properties.lastModified,
                            ...properties,
                        };
                        acts.push('Stat');
                    } else {
                        file.stats = null;
                        acts.push('Stat (Not Found)');
                    }
                }

                const currentTargetValue = await node.getTypedProperty(
                    node.target,
                    node.targetType,
                    msg,
                );
                const currentTarget =
                    currentTargetValue &&
                    typeof currentTargetValue === 'object' &&
                    !Buffer.isBuffer(currentTargetValue)
                        ? currentTargetValue
                        : {};

                await node.setTypedProperty(node.target, node.targetType, msg, {
                    ...currentTarget,
                    ...file,
                });

                if (acts.length > 0) node.status.succeeded(acts.join(', '));
                else node.status.info('Did nothing to the file...');

                send(msg);
                if (done) done();
            } catch (err) {
                node.status.failed(err.code || err.message || 'Configuration error');
                if (done) done(err);
                else node.error(err, msg);
            }
        });
    }

    RED.nodes.registerType('azure-file-read', AzureFileReadNode);
};
