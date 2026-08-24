'use strict';

module.exports = function (RED) {
    const { ShareServiceClient, StorageSharedKeyCredential } = require('@azure/storage-file-share');

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
        for (const [key, value] of params.entries()) url.searchParams.set(key, value);
        return url.toString();
    }

    function AzureFilesConfigNode(config) {
        RED.nodes.createNode(this, config);

        this.name = config.name;
        this.authNode = RED.nodes.getNode(config.auth);
        this.serviceUrl = config.serviceUrl;
        this.serviceUrlType = config.serviceUrlType || 'str';

        const node = this;
        let fileServiceClient = null;

        node.getClient = function () {
            if (fileServiceClient) return fileServiceClient;
            if (!node.authNode) {
                throw createError(
                    'Missing Azure authentication configuration',
                    'AZURE_CONFIG_MISSING',
                );
            }

            const clientOptions = {
                allowTrailingDot: true,
                allowSourceTrailingDot: true,
            };

            if (node.authNode.authType === 'connectionString') {
                fileServiceClient = ShareServiceClient.fromConnectionString(
                    node.authNode.getConnectionString(),
                    clientOptions,
                );
                return fileServiceClient;
            }

            const serviceUrlRaw = RED.util.evaluateNodeProperty(
                node.serviceUrl,
                node.serviceUrlType,
                node,
                {},
            );
            const serviceUrl = normalizeServiceUrl(serviceUrlRaw);

            switch (node.authNode.authType) {
                case 'entra':
                    clientOptions.fileRequestIntent = 'backup';
                    fileServiceClient = new ShareServiceClient(
                        serviceUrl,
                        node.authNode.getCredential(),
                        clientOptions,
                    );
                    break;

                case 'accountKey': {
                    const accountName =
                        node.authNode.getAccountName() || accountNameFromUrl(serviceUrl);
                    if (!accountName) {
                        throw createError(
                            'Storage account name is missing',
                            'ACCOUNT_NAME_MISSING',
                        );
                    }

                    fileServiceClient = new ShareServiceClient(
                        serviceUrl,
                        new StorageSharedKeyCredential(accountName, node.authNode.getAccountKey()),
                        clientOptions,
                    );
                    break;
                }

                case 'sas':
                    fileServiceClient = new ShareServiceClient(
                        appendSasToken(serviceUrl, node.authNode.getSasToken()),
                        undefined,
                        clientOptions,
                    );
                    break;

                case 'apiKey':
                    throw createError(
                        'API key authentication cannot be used with Azure Files',
                        'INVALID_FILE_AUTH_TYPE',
                    );

                default:
                    throw createError(
                        `Unsupported authentication type: ${node.authNode.authType}`,
                        'INVALID_AUTH_TYPE',
                    );
            }

            return fileServiceClient;
        };

        node.on('close', function () {
            fileServiceClient = null;
        });
    }

    RED.nodes.registerType('azure-file-config', AzureFilesConfigNode);
};
