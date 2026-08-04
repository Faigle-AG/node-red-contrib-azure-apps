'use strict';

module.exports = function (RED) {
    const { ShareServiceClient, StorageSharedKeyCredential } = require('@azure/storage-file-share');
    const { DefaultAzureCredential } = require('@azure/identity');
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);

    const FILE_OPERATIONS = new Set([
        'list',
        'read',
        'write',
        'delete',
        'stat',
        'exists',
        'mkdir',
        'rmdir',
    ]);

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
                err.code === 'ShareNotFound' ||
                err.code === 'ParentNotFound'),
        );
    }

    function normalizeOperation(value) {
        const operation = String(value || '')
            .trim()
            .toLowerCase();

        if (!FILE_OPERATIONS.has(operation)) {
            throw createError(
                `Unsupported file-share operation: ${operation || '<empty>'}`,
                'INVALID_OPERATION',
            );
        }

        return operation;
    }

    function normalizePath(value, options = {}) {
        const raw = value === undefined || value === null ? '' : String(value);
        const normalized = raw
            .replace(/\\/g, '/')
            .split('/')
            .filter((part) => part !== '')
            .join('/');

        if (!normalized && options.required) {
            throw createError(`${options.label || 'Path'} is required`, 'INVALID_PATH');
        }

        const segments = normalized ? normalized.split('/') : [];
        if (segments.some((segment) => segment === '.' || segment === '..')) {
            throw createError('Path cannot contain . or .. segments', 'INVALID_PATH');
        }

        return normalized;
    }

    function splitFilePath(path) {
        const normalized = normalizePath(path, { required: true, label: 'File path' });
        const segments = normalized.split('/');
        const fileName = segments.pop();

        if (!fileName) throw createError('File name is missing', 'INVALID_FILE_PATH');

        return {
            directoryPath: segments.join('/'),
            fileName,
            path: normalized,
        };
    }

    function normalizeServiceUrl(value) {
        const input = String(value || '').trim();
        if (!input) throw createError('File service URL is missing', 'SERVICE_URL_MISSING');

        if (/^[a-z0-9]{3,24}$/.test(input)) {
            return `https://${input}.file.core.windows.net`;
        }

        let url;
        try {
            url = new URL(input);
        } catch (err) {
            throw createError(
                'File service URL must be a valid HTTPS URL or storage account name',
                'INVALID_SERVICE_URL',
                err,
            );
        }

        if (url.protocol !== 'https:') {
            throw createError('File service URL must use HTTPS', 'INVALID_SERVICE_URL');
        }

        url.hash = '';
        url.pathname = url.pathname.replace(/\/+$/, '');
        return url.toString().replace(/\/$/, '');
    }

    function accountNameFromUrl(serviceUrl) {
        try {
            const hostname = new URL(serviceUrl).hostname;
            return hostname.split('.')[0] || '';
        } catch {
            return '';
        }
    }

    function appendSasToken(serviceUrl, sasToken) {
        const token = String(sasToken || '')
            .trim()
            .replace(/^\?/, '');
        if (!token) throw createError('SAS token is missing', 'SAS_TOKEN_MISSING');

        const url = new URL(serviceUrl);
        const params = new URLSearchParams(token);
        for (const [key, value] of params.entries()) url.searchParams.set(key, value);
        return url.toString();
    }

    function normalizeBoolean(value, fallback) {
        if (value === undefined || value === null || value === '') return fallback;
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;

        const normalized = String(value).trim().toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
        if (['false', '0', 'no', 'off'].includes(normalized)) return false;
        return fallback;
    }

    function normalizePositiveInteger(value, fallback, name) {
        if (value === undefined || value === null || value === '') return fallback;
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1) {
            throw createError(`${name} must be a positive integer`, 'INVALID_NUMBER');
        }
        return number;
    }

    function normalizeWriteData(value, format) {
        const mode = String(format || 'auto').toLowerCase();

        if (value === undefined || value === null) {
            throw createError('Write data is missing', 'DATA_MISSING');
        }

        if (mode === 'base64') {
            if (typeof value !== 'string') {
                throw createError('Base64 write data must be a string', 'INVALID_DATA');
            }
            return Buffer.from(value.replace(/^data:.*?;base64,/, ''), 'base64');
        }

        if (mode === 'json') {
            return Buffer.from(JSON.stringify(value), 'utf8');
        }

        if (mode === 'text' || mode === 'utf8') {
            return Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
        }

        if (mode === 'buffer') {
            if (Buffer.isBuffer(value)) return value;
            if (value instanceof ArrayBuffer) return Buffer.from(value);
            if (ArrayBuffer.isView(value)) {
                return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
            }
            throw createError(
                'Buffer write mode requires a Buffer, ArrayBuffer, or typed array',
                'INVALID_DATA',
            );
        }

        if (mode !== 'auto') {
            throw createError(`Unsupported write format: ${mode}`, 'INVALID_DATA_FORMAT');
        }

        if (Buffer.isBuffer(value)) return value;
        if (value instanceof ArrayBuffer) return Buffer.from(value);
        if (ArrayBuffer.isView(value)) {
            return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        }
        if (typeof value === 'string') return Buffer.from(value, 'utf8');
        if (typeof value === 'object') return Buffer.from(JSON.stringify(value), 'utf8');
        return Buffer.from(String(value), 'utf8');
    }

    function formatReadData(buffer, format) {
        const mode = String(format || 'buffer').toLowerCase();

        switch (mode) {
            case 'buffer':
                return buffer;
            case 'text':
            case 'utf8':
                return buffer.toString('utf8');
            case 'base64':
                return buffer.toString('base64');
            case 'json':
                try {
                    return JSON.parse(buffer.toString('utf8'));
                } catch (err) {
                    throw createError(
                        'The downloaded file does not contain valid JSON',
                        'INVALID_JSON',
                        err,
                    );
                }
            default:
                throw createError(`Unsupported read format: ${mode}`, 'INVALID_READ_FORMAT');
        }
    }

    function cleanProperties(properties) {
        if (!properties) return {};

        return {
            etag: properties.etag,
            lastModified: properties.lastModified,
            contentLength: properties.contentLength,
            contentType: properties.contentType || properties.fileContentType,
            contentEncoding: properties.contentEncoding || properties.fileContentEncoding,
            contentLanguage: properties.contentLanguage || properties.fileContentLanguage,
            cacheControl: properties.cacheControl || properties.fileCacheControl,
            contentDisposition: properties.contentDisposition || properties.fileContentDisposition,
            metadata: properties.metadata,
            fileAttributes: properties.fileAttributes,
            fileCreatedOn: properties.fileCreatedOn,
            fileLastWriteOn: properties.fileLastWriteOn,
            fileChangeOn: properties.fileChangeOn,
            fileId: properties.fileId,
            fileParentId: properties.fileParentId,
            isServerEncrypted: properties.isServerEncrypted,
        };
    }

    function cleanListItem(item, parentPath) {
        const itemPath = parentPath ? `${parentPath}/${item.name}` : item.name;
        return {
            kind: item.kind,
            name: item.name,
            path: itemPath,
            ...cleanProperties(item.properties),
        };
    }

    function getDirectoryClient(shareClient, directoryPath) {
        const normalized = normalizePath(directoryPath);
        let client = shareClient.rootDirectoryClient;

        if (!normalized) return client;

        for (const segment of normalized.split('/')) {
            client = client.getDirectoryClient(segment);
        }

        return client;
    }

    async function ensureDirectory(shareClient, directoryPath) {
        const normalized = normalizePath(directoryPath);
        let client = shareClient.rootDirectoryClient;

        if (!normalized) return client;

        for (const segment of normalized.split('/')) {
            client = client.getDirectoryClient(segment);
            await client.createIfNotExists();
        }

        return client;
    }

    async function listDirectory(directoryClient, parentPath, recursive, maxItems, results) {
        for await (const item of directoryClient.listFilesAndDirectories()) {
            results.push(cleanListItem(item, parentPath));
            if (results.length >= maxItems) return;

            if (recursive && item.kind === 'directory') {
                const childPath = parentPath ? `${parentPath}/${item.name}` : item.name;
                await listDirectory(
                    directoryClient.getDirectoryClient(item.name),
                    childPath,
                    true,
                    maxItems,
                    results,
                );
                if (results.length >= maxItems) return;
            }
        }
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

    async function resolveTyped(node, value, type, msg, label, options = {}) {
        const resolved = await node.getTypedProperty(value, type, msg);
        const normalized =
            options.trimString && typeof resolved === 'string' ? resolved.trim() : resolved;

        if (
            options.required &&
            (normalized === undefined || normalized === null || normalized === '')
        ) {
            throw createError(
                `${label} resolved to an empty value`,
                options.code || 'VALUE_MISSING',
            );
        }

        return normalized;
    }

    function normalizeSdkError(err) {
        if (!err) return createError('Azure Files request failed', 'AZURE_FILES_ERROR');
        if (err.cause && err.code && err.message) return err;

        const wrapped = createError(
            err.message || 'Azure Files request failed',
            err.code || 'AZURE_FILES_ERROR',
            err,
        );
        wrapped.name = err.name || 'AzureFilesError';
        wrapped.statusCode = err.statusCode || err.status;
        wrapped.requestId = err.requestId || err.request_id;
        wrapped.details = err.details || err.response;
        return wrapped;
    }

    function AzureFileShareNode(config) {
        RED.nodes.createNode(this, config);

        this.name = config.name;
        this.dynamic = config.dynamic === true;
        this.authType = config.authType || 'entra';
        this.serviceUrl = config.serviceUrl;
        this.serviceUrlType = config.serviceUrlType || 'str';
        this.accountName = config.accountName;
        this.accountNameType = config.accountNameType || 'str';
        this.operation = config.operation || 'list';
        this.shareName = config.shareName;
        this.shareNameType = config.shareNameType || 'str';
        this.path = config.path;
        this.pathType = config.pathType || 'str';
        this.data = config.data;
        this.dataType = config.dataType || 'msg';
        this.writeFormat = config.writeFormat || 'auto';
        this.readFormat = config.readFormat || 'buffer';
        this.contentType = config.contentType;
        this.contentTypeType = config.contentTypeType || 'str';
        this.createParents = config.createParents !== false;
        this.overwrite = config.overwrite !== false;
        this.recursive = config.recursive === true;
        this.maxItems = config.maxItems || 1000;
        this.output = config.output || 'fileShare';
        this.outputType = config.outputType || 'msg';
        this.enableLogging = config.enableLogging === true;

        const node = this;
        extendNode(node);

        node.on('input', async function (msg, send, done) {
            try {
                const dynamicConfig =
                    node.dynamic && msg.fileShare && typeof msg.fileShare === 'object'
                        ? msg.fileShare
                        : {};

                const operation = normalizeOperation(
                    node.dynamic && dynamicConfig.operation !== undefined
                        ? dynamicConfig.operation
                        : node.operation,
                );

                const shareNameRaw =
                    node.dynamic && dynamicConfig.shareName !== undefined
                        ? dynamicConfig.shareName
                        : await resolveTyped(
                              node,
                              node.shareName,
                              node.shareNameType,
                              msg,
                              'Share name',
                              { required: true, trimString: true, code: 'SHARE_NAME_MISSING' },
                          );

                const shareName = String(shareNameRaw || '').trim();
                if (!shareName) throw createError('Share name is missing', 'SHARE_NAME_MISSING');

                const pathRaw =
                    node.dynamic && dynamicConfig.path !== undefined
                        ? dynamicConfig.path
                        : await resolveTyped(node, node.path, node.pathType, msg, 'Path');
                const path = normalizePath(pathRaw);

                const readFormat = String(
                    node.dynamic && dynamicConfig.readFormat !== undefined
                        ? dynamicConfig.readFormat
                        : node.readFormat,
                ).toLowerCase();
                const writeFormat = String(
                    node.dynamic && dynamicConfig.writeFormat !== undefined
                        ? dynamicConfig.writeFormat
                        : node.writeFormat,
                ).toLowerCase();
                const createParents = normalizeBoolean(
                    node.dynamic && dynamicConfig.createParents !== undefined
                        ? dynamicConfig.createParents
                        : node.createParents,
                    true,
                );
                const overwrite = normalizeBoolean(
                    node.dynamic && dynamicConfig.overwrite !== undefined
                        ? dynamicConfig.overwrite
                        : node.overwrite,
                    true,
                );
                const recursive = normalizeBoolean(
                    node.dynamic && dynamicConfig.recursive !== undefined
                        ? dynamicConfig.recursive
                        : node.recursive,
                    false,
                );
                const maxItems = normalizePositiveInteger(
                    node.dynamic && dynamicConfig.maxItems !== undefined
                        ? dynamicConfig.maxItems
                        : node.maxItems,
                    1000,
                    'Max items',
                );

                node.status.processing('authenticating...');

                let serviceClient;
                let serviceUrl;
                let accountName;

                const clientOptions = {
                    allowTrailingDot: true,
                    allowSourceTrailingDot: true,
                };

                if (node.authType === 'connectionString') {
                    const connectionString = node.credentials && node.credentials.connectionString;
                    if (!connectionString) {
                        throw createError(
                            'Storage connection string is missing',
                            'CONNECTION_STRING_MISSING',
                        );
                    }
                    serviceClient = ShareServiceClient.fromConnectionString(
                        connectionString,
                        clientOptions,
                    );
                    accountName = serviceClient.accountName;
                } else {
                    const serviceUrlValue = await resolveTyped(
                        node,
                        node.serviceUrl,
                        node.serviceUrlType,
                        msg,
                        'File service URL',
                        { required: true, trimString: true, code: 'SERVICE_URL_MISSING' },
                    );
                    serviceUrl = normalizeServiceUrl(serviceUrlValue);

                    if (node.authType === 'entra') {
                        clientOptions.fileRequestIntent = 'backup';
                        serviceClient = new ShareServiceClient(
                            serviceUrl,
                            new DefaultAzureCredential(),
                            clientOptions,
                        );
                    } else if (node.authType === 'accountKey') {
                        const configuredAccountName = await resolveTyped(
                            node,
                            node.accountName,
                            node.accountNameType,
                            msg,
                            'Storage account name',
                            { trimString: true },
                        );
                        accountName = String(
                            configuredAccountName || accountNameFromUrl(serviceUrl),
                        ).trim();
                        const accountKey = node.credentials && node.credentials.accountKey;

                        if (!accountName) {
                            throw createError(
                                'Storage account name is missing',
                                'ACCOUNT_NAME_MISSING',
                            );
                        }
                        if (!accountKey) {
                            throw createError(
                                'Storage account key is missing',
                                'ACCOUNT_KEY_MISSING',
                            );
                        }

                        serviceClient = new ShareServiceClient(
                            serviceUrl,
                            new StorageSharedKeyCredential(accountName, accountKey),
                            clientOptions,
                        );
                    } else if (node.authType === 'sas') {
                        const sasToken = node.credentials && node.credentials.sasToken;
                        serviceClient = new ShareServiceClient(
                            appendSasToken(serviceUrl, sasToken),
                            undefined,
                            clientOptions,
                        );
                    } else {
                        throw createError(
                            `Unsupported authentication type: ${node.authType}`,
                            'INVALID_AUTH_TYPE',
                        );
                    }

                    accountName =
                        accountName || serviceClient.accountName || accountNameFromUrl(serviceUrl);
                }

                const shareClient = serviceClient.getShareClient(shareName);

                if (node.enableLogging) {
                    node.log(
                        `Azure Files operation '${operation}' on ${accountName || '<account>'}/${shareName}/${path}`,
                    );
                }

                node.status.processing(`${operation}...`);

                let result = {
                    action: operation,
                    status: 'succeeded',
                    accountName,
                    shareName,
                    path,
                };

                if (operation === 'list') {
                    const directoryClient = getDirectoryClient(shareClient, path);
                    const list = [];
                    await listDirectory(directoryClient, path, recursive, maxItems, list);
                    result = {
                        ...result,
                        kind: 'directory',
                        recursive,
                        truncated: list.length >= maxItems,
                        count: list.length,
                        list,
                    };
                } else if (operation === 'read') {
                    const filePath = splitFilePath(path);
                    const directoryClient = getDirectoryClient(shareClient, filePath.directoryPath);
                    const fileClient = directoryClient.getFileClient(filePath.fileName);
                    const buffer = await fileClient.downloadToBuffer(0);
                    const properties = await fileClient.getProperties();
                    result = {
                        ...result,
                        kind: 'file',
                        size: buffer.length,
                        format: readFormat,
                        data: formatReadData(buffer, readFormat),
                        properties: cleanProperties(properties),
                    };
                } else if (operation === 'write') {
                    const filePath = splitFilePath(path);
                    const directoryClient = createParents
                        ? await ensureDirectory(shareClient, filePath.directoryPath)
                        : getDirectoryClient(shareClient, filePath.directoryPath);
                    const fileClient = directoryClient.getFileClient(filePath.fileName);

                    if (!overwrite && (await fileClient.exists())) {
                        throw createError(`File already exists: ${filePath.path}`, 'FILE_EXISTS');
                    }

                    const dataValue =
                        node.dynamic && dynamicConfig.data !== undefined
                            ? dynamicConfig.data
                            : await resolveTyped(
                                  node,
                                  node.data,
                                  node.dataType,
                                  msg,
                                  'Write data',
                                  {
                                      required: true,
                                      code: 'DATA_MISSING',
                                  },
                              );
                    const buffer = normalizeWriteData(dataValue, writeFormat);
                    const contentTypeRaw =
                        node.dynamic && dynamicConfig.contentType !== undefined
                            ? dynamicConfig.contentType
                            : await resolveTyped(
                                  node,
                                  node.contentType,
                                  node.contentTypeType,
                                  msg,
                                  'Content type',
                                  { trimString: true },
                              );
                    const contentType = String(contentTypeRaw || '').trim();
                    const uploadOptions = {};
                    if (contentType) {
                        uploadOptions.fileHttpHeaders = { fileContentType: contentType };
                    }

                    await fileClient.uploadData(buffer, uploadOptions);
                    const properties = await fileClient.getProperties();
                    result = {
                        ...result,
                        kind: 'file',
                        size: buffer.length,
                        format: writeFormat,
                        overwritten: overwrite,
                        properties: cleanProperties(properties),
                    };
                } else if (operation === 'delete') {
                    const filePath = splitFilePath(path);
                    const fileClient = getDirectoryClient(
                        shareClient,
                        filePath.directoryPath,
                    ).getFileClient(filePath.fileName);
                    const response = await fileClient.deleteIfExists();
                    result = {
                        ...result,
                        kind: 'file',
                        deleted: response.succeeded === true,
                    };
                } else if (operation === 'mkdir') {
                    const directoryPath = normalizePath(path, {
                        required: true,
                        label: 'Directory path',
                    });
                    let response;
                    if (createParents) {
                        await ensureDirectory(shareClient, directoryPath);
                        response = { succeeded: true };
                    } else {
                        response = await getDirectoryClient(
                            shareClient,
                            directoryPath,
                        ).createIfNotExists();
                    }
                    result = {
                        ...result,
                        kind: 'directory',
                        created: response.succeeded === true,
                    };
                } else if (operation === 'rmdir') {
                    const directoryPath = normalizePath(path, {
                        required: true,
                        label: 'Directory path',
                    });
                    const directoryClient = getDirectoryClient(shareClient, directoryPath);
                    const response = recursive
                        ? await deleteDirectoryRecursive(directoryClient)
                        : await directoryClient.deleteIfExists();
                    result = {
                        ...result,
                        kind: 'directory',
                        recursive,
                        deleted: response.succeeded === true,
                    };
                } else if (operation === 'stat' || operation === 'exists') {
                    if (!path) {
                        const properties = await shareClient.rootDirectoryClient.getProperties();
                        result = {
                            ...result,
                            exists: true,
                            kind: 'directory',
                            properties:
                                operation === 'stat' ? cleanProperties(properties) : undefined,
                        };
                    } else {
                        const filePath = splitFilePath(path);
                        const parent = getDirectoryClient(shareClient, filePath.directoryPath);
                        let exists = false;
                        let kind;
                        let properties;

                        try {
                            properties = await parent
                                .getFileClient(filePath.fileName)
                                .getProperties();
                            exists = true;
                            kind = 'file';
                        } catch (err) {
                            if (!isNotFound(err)) throw err;
                            try {
                                properties = await parent
                                    .getDirectoryClient(filePath.fileName)
                                    .getProperties();
                                exists = true;
                                kind = 'directory';
                            } catch (directoryErr) {
                                if (!isNotFound(directoryErr)) throw directoryErr;
                            }
                        }

                        result = {
                            ...result,
                            exists,
                            kind,
                            properties:
                                operation === 'stat' && exists
                                    ? cleanProperties(properties)
                                    : undefined,
                        };
                    }
                }

                await node.setTypedProperty(node.output, node.outputType, msg, result);

                send(msg);
                if (done) done();

                node.status.succeeded(`${operation} complete`, {
                    next: () => node.status.waiting('waiting for input'),
                });
            } catch (err) {
                const normalized = normalizeSdkError(err);
                const statusText = normalized.statusCode
                    ? `HTTP ${normalized.statusCode}`
                    : normalized.code || normalized.message || 'Azure Files error';

                node.status.failed(statusText);
                if (node.enableLogging && normalized.requestId) {
                    node.warn(`Azure Files request ID: ${normalized.requestId}`);
                }

                if (done) done(normalized);
                else node.error(normalized, msg);
            }
        });
    }

    RED.nodes.registerType('file-share', AzureFileShareNode, {
        credentials: {
            accountKey: { type: 'password' },
            connectionString: { type: 'password' },
            sasToken: { type: 'password' },
        },
    });
};
