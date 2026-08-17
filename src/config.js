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
        let serviceClient = null;

        node.getClient = function () {
            if (serviceClient) return serviceClient;

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
                return serviceClient;
            }

            const serviceUrl = normalizeServiceUrl(node.serviceUrl);

            switch (node.authType) {
                case 'entra':
                    clientOptions.fileRequestIntent = 'backup';
                    serviceClient = new ShareServiceClient(
                        serviceUrl,
                        new DefaultAzureCredential(),
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

                    serviceClient = new ShareServiceClient(
                        serviceUrl,
                        new StorageSharedKeyCredential(accountName, accountKey),
                        clientOptions,
                    );
                    break;
                }

                case 'sas': {
                    const sasToken = node.credentials && node.credentials.sasToken;
                    serviceClient = new ShareServiceClient(
                        appendSasToken(serviceUrl, sasToken),
                        undefined,
                        clientOptions,
                    );
                    break;
                }

                default:
                    throw createError(
                        `Unsupported authentication type: ${node.authType}`,
                        'INVALID_AUTH_TYPE',
                    );
            }

            return serviceClient;
        };

        node.on('close', function () {
            serviceClient = null;
        });
    }

    RED.nodes.registerType('azure-config', AzureConfigNode, {
        credentials: {
            accountKey: { type: 'password' },
            connectionString: { type: 'password' },
            sasToken: { type: 'password' },
        },
    });
};
