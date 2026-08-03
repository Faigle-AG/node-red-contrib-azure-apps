module.exports = function (RED) {
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);
    const { DefaultAzureCredential } = require('@azure/identity');

    async function listMailFolders(userId, token) {
        const folders = [];
        const encodedUserId = encodeURIComponent(userId);

        async function loadFolders(url, parentPath) {
            while (url) {
                const response = await fetch(url, {
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: 'application/json',
                    },
                });

                if (!response.ok) {
                    const errData = await response.text();
                    throw new Error(`Graph API error ${response.status}: ${errData}`);
                }

                const data = await response.json();

                for (const folder of data.value || []) {
                    const path = parentPath
                        ? `${parentPath} › ${folder.displayName}`
                        : folder.displayName;

                    folders.push({
                        id: folder.id,
                        path,
                    });

                    if (folder.childFolderCount > 0) {
                        await loadFolders(
                            `https://graph.microsoft.com/v1.0/users/${encodedUserId}/mailFolders/${encodeURIComponent(folder.id)}/childFolders?includeHiddenFolders=true&$select=id,displayName,childFolderCount`,
                            path,
                        );
                    }
                }

                url = data['@odata.nextLink'];
            }
        }

        await loadFolders(
            `https://graph.microsoft.com/v1.0/users/${encodedUserId}/mailFolders?includeHiddenFolders=true&$select=id,displayName,childFolderCount`,
            '',
        );

        folders.sort(function (a, b) {
            return a.path.localeCompare(b.path);
        });

        return folders;
    }

    RED.httpAdmin.get(
        '/email-transfer/folders',
        RED.auth.needsPermission('email-transfer.read'),
        async function (req, res) {
            try {
                const userId = String(req.query.userId || '').trim();

                if (!userId) {
                    return res.status(400).json({
                        message: 'User ID / Email is required',
                    });
                }

                const credential = new DefaultAzureCredential();
                const tokenResponse = await credential.getToken(
                    'https://graph.microsoft.com/.default',
                );

                const folders = await listMailFolders(userId, tokenResponse.token);

                res.json({ folders });
            } catch (err) {
                res.status(500).json({
                    message: err.message || 'Unable to load mail folders',
                });
            }
        },
    );

    function AzureEmailTransferNode(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name;
        this.userId = config.userId;
        this.userIdType = config.userIdType || 'str';
        this.dynamic = config.dynamic;
        this.messageId = config.messageId;
        this.messageIdType = config.messageIdType || 'msg';
        this.destinationId = config.destinationId || 'archive';
        this.destinationName = config.destinationName || 'Archive';

        var node = this;
        extendNode(node);

        node.on('input', async function (msg, send, done) {
            try {
                const userIdRaw = await node.getTypedProperty(node.userId, node.userIdType, msg);

                const currentUserId = String(userIdRaw || '').trim();
                if (!currentUserId) {
                    const error = new Error('User ID / Email resolved to an empty value');
                    error.code = 'INVALID_USER_ID';
                    throw error;
                }

                const msgIdRaw = node.dynamic
                    ? msg.email && msg.email.messageId
                    : await node.getTypedProperty(node.messageId, node.messageIdType, msg);
                const destIdRaw = node.dynamic
                    ? msg.email && msg.email.destinationId
                    : node.destinationId;
                const destNameRaw = node.dynamic
                    ? msg.email && msg.email.destinationName
                    : node.destinationName;

                if (!msgIdRaw) throw new Error('Message ID is missing');
                if (!destIdRaw) throw new Error('Destination Folder ID is missing');

                node.status.processing('authenticating...');

                const credential = new DefaultAzureCredential();
                const tokenResponse = await credential.getToken(
                    'https://graph.microsoft.com/.default',
                );

                node.status.processing('moving email...');

                const payload = {
                    destinationId: destIdRaw,
                };

                const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(currentUserId)}/messages/${encodeURIComponent(msgIdRaw)}/move`;

                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${tokenResponse.token}`,
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                    },
                    body: JSON.stringify(payload),
                });

                if (!response.ok) {
                    const errData = await response.text();
                    throw new Error(`Graph API error ${response.status}: ${errData}`);
                }

                const data = await response.json();

                var emailDetails = {
                    action: 'transfer',
                    messageId: msgIdRaw,
                    destinationId: destIdRaw,
                    destinationName: destNameRaw,
                    apiResponse: data,
                };

                msg.email = { ...msg.email, ...emailDetails };
                node.status.succeeded('email moved');
                send(msg);

                if (done) done();
            } catch (err) {
                node.status.failed(err.code || err.message || 'Azure Graph error');
                if (done) done(err);
                else node.error(err, msg);
            }
        });
    }

    RED.nodes.registerType('email-transfer', AzureEmailTransferNode);
};
