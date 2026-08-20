'use strict';

module.exports = function (RED) {
    const { DefaultAzureCredential } = require('@azure/identity');

    function createError(message, code, cause) {
        const err = new Error(message);
        if (code) err.code = code;
        if (cause) err.cause = cause;
        return err;
    }

    function AzureConfigNode(config) {
        RED.nodes.createNode(this, config);

        this.name = config.name;
        this.authType = config.authType || 'entra';
        this.accountName = config.accountName;

        const node = this;
        let credential = null;

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

        node.getAccountName = function () {
            if (node.authType !== 'accountKey') {
                throw createError(
                    `Storage account key authentication is required, but Azure Config uses '${node.authType}'`,
                    'ACCOUNT_KEY_AUTH_REQUIRED',
                );
            }
            return String(node.accountName || '').trim();
        };

        node.getAccountKey = function () {
            if (node.authType !== 'accountKey') {
                throw createError(
                    `Storage account key authentication is required, but Azure Config uses '${node.authType}'`,
                    'ACCOUNT_KEY_AUTH_REQUIRED',
                );
            }

            const accountKey = node.credentials && node.credentials.accountKey;
            if (!accountKey)
                throw createError('Storage account key is missing', 'ACCOUNT_KEY_MISSING');
            return accountKey;
        };

        node.getConnectionString = function () {
            if (node.authType !== 'connectionString') {
                throw createError(
                    `Storage connection string authentication is required, but Azure Config uses '${node.authType}'`,
                    'CONNECTION_STRING_AUTH_REQUIRED',
                );
            }

            const connectionString = node.credentials && node.credentials.connectionString;
            if (!connectionString) {
                throw createError(
                    'Storage connection string is missing',
                    'CONNECTION_STRING_MISSING',
                );
            }
            return connectionString;
        };

        node.getSasToken = function () {
            if (node.authType !== 'sas') {
                throw createError(
                    `Storage SAS authentication is required, but Azure Config uses '${node.authType}'`,
                    'SAS_AUTH_REQUIRED',
                );
            }

            const sasToken = node.credentials && node.credentials.sasToken;
            if (!sasToken) throw createError('SAS token is missing', 'SAS_TOKEN_MISSING');
            return sasToken;
        };

        node.on('close', function () {
            credential = null;
        });
    }

    RED.nodes.registerType('azure-auth-config', AzureConfigNode, {
        credentials: {
            apiKey: { type: 'password' },
            accountKey: { type: 'password' },
            connectionString: { type: 'password' },
            sasToken: { type: 'password' },
        },
    });
};
