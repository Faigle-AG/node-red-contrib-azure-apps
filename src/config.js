'use strict';

module.exports = function (RED) {
    const { ShareServiceClient, StorageSharedKeyCredential } = require('@azure/storage-file-share');
    const { DefaultAzureCredential } = require('@azure/identity');

    function createError(message, code, cause) {
        const err = new Error(message);
        if (code) err.code = code;
        if (cause) err.cause = cause;
        return err;
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

        for (const [key, value] of params.entries()) {
            url.searchParams.set(key, value);
        }

        return url.toString();
    }

    function AzureConfigNode(config) {
        RED.nodes.createNode(this, config);

        this.name = config.name;
        this.authType = config.authType || 'entra';
        this.serviceUrl = config.serviceUrl;
        this.accountName = config.accountName;

        const node = this;

        let credential = null;
        let fileServiceClient = null;

        node.getCredential = function () {
            if (node.authType !== 'entra') {
                throw createError(
                    `Microsoft Entra ID authentication is required, but Azure Config uses '${node.authType}'`,
                    'ENTRA_AUTH_REQUIRED',
                );
            }

            if (!credential) credential = new DefaultAzureCredential();
            return credential;
        };

        node.getToken = async function (scope) {
            if (!scope) throw createError('Azure token scope is missing', 'TOKEN_SCOPE_MISSING');

            const tokenResponse = await node.getCredential().getToken(scope);
            if (!tokenResponse || !tokenResponse.token) {
                throw createError(
                    'Azure authentication did not return an access token',
                    'TOKEN_MISSING',
                );
            }

            return tokenResponse.token;
        };

        node.getApiKey = function () {
            if (node.authType !== 'apiKey') {
                throw createError(
                    `API key authentication is required, but Azure Config uses '${node.authType}'`,
                    'API_KEY_AUTH_REQUIRED',
                );
            }

            const apiKey = node.credentials && node.credentials.apiKey;
            if (!apiKey) throw createError('Azure API key is missing', 'API_KEY_MISSING');
            return apiKey;
        };

        node.getClient = function () {
            if (fileServiceClient) return fileServiceClient;

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

                fileServiceClient = ShareServiceClient.fromConnectionString(
                    connectionString,
                    clientOptions,
                );
                return fileServiceClient;
            }

            const serviceUrl = normalizeServiceUrl(node.serviceUrl);

            switch (node.authType) {
                case 'entra':
                    clientOptions.fileRequestIntent = 'backup';
                    fileServiceClient = new ShareServiceClient(
                        serviceUrl,
                        node.getCredential(),
                        clientOptions,
                    );
                    break;

                case 'accountKey': {
                    const accountName = String(
                        node.accountName || accountNameFromUrl(serviceUrl),
                    ).trim();
                    const accountKey = node.credentials && node.credentials.accountKey;

                    if (!accountName) {
                        throw createError(
                            'Storage account name is missing',
                            'ACCOUNT_NAME_MISSING',
                        );
                    }

                    if (!accountKey) {
                        throw createError('Storage account key is missing', 'ACCOUNT_KEY_MISSING');
                    }

                    fileServiceClient = new ShareServiceClient(
                        serviceUrl,
                        new StorageSharedKeyCredential(accountName, accountKey),
                        clientOptions,
                    );
                    break;
                }

                case 'sas': {
                    const sasToken = node.credentials && node.credentials.sasToken;
                    fileServiceClient = new ShareServiceClient(
                        appendSasToken(serviceUrl, sasToken),
                        undefined,
                        clientOptions,
                    );
                    break;
                }

                case 'apiKey':
                    throw createError(
                        'API key authentication cannot be used with Azure Files',
                        'INVALID_FILE_AUTH_TYPE',
                    );

                default:
                    throw createError(
                        `Unsupported authentication type: ${node.authType}`,
                        'INVALID_AUTH_TYPE',
                    );
            }

            return fileServiceClient;
        };

        node.on('close', function () {
            credential = null;
            fileServiceClient = null;
        });
    }

    RED.nodes.registerType('azure-config', AzureConfigNode, {
        credentials: {
            apiKey: { type: 'password' },
            accountKey: { type: 'password' },
            connectionString: { type: 'password' },
            sasToken: { type: 'password' },
        },
    });
};
