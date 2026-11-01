// The types each typed field offers in the editor (Phase 2.9). A configured type outside these
// fails clearly before anything is evaluated or requested.
const TYPES = {
    messageId: ['msg', 'flow', 'global', 'str', 'jsonata', 'env'],
};

// The User ID is configured once, on the email configuration node, which owns its types.
const { userId: USER_ID_TYPES } = require('./email-config').TYPES;

module.exports = function (RED) {
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);

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
                const configNode = RED.nodes.getNode(String(req.query.config || '').trim());

                if (!configNode) {
                    return res.status(400).json({
                        message: 'A deployed Azure Email Config is required',
                    });
                }

                if ((configNode.userIdType || 'str') !== 'str') {
                    return res.status(400).json({
                        message:
                            'Folder loading requires a static User ID / Email in Azure Email Config',
                    });
                }

                const userId = String(configNode.userId || '').trim();
                if (!userId) {
                    return res.status(400).json({
                        message: 'User ID / Email is required in Azure Email Config',
                    });
                }

                const accessToken = await configNode.getToken(
                    'https://graph.microsoft.com/.default',
                );

                const folders = await listMailFolders(userId, accessToken);

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
        this.configNode = RED.nodes.getNode(config.config);
        this.dynamic = config.dynamic;
        this.messageId = config.messageId;
        this.messageIdType = config.messageIdType || 'msg';
        this.destinationId = config.destinationId || 'archive';
        this.destinationName = config.destinationName || 'Archive';

        var node = this;
        extendNode(node);

        // Close aborts every Graph request in flight; input still in progress then completes
        // without status, output or error.
        const pending = new Set();
        let closing = false;
        node.on('close', function () {
            closing = true;
            for (const controller of pending) {
                try {
                    controller.abort();
                } catch (err) {
                    node.warn(`Could not abort a Graph request: ${err.message}`);
                }
            }
            node.status.clear();
        });

        node.on('input', async function (msg, send, done) {
            const controller = new AbortController();
            pending.add(controller);
            const finishClosed = () => {
                if (done) done();
            };
            try {
                if (!node.configNode) throw new Error('Missing Azure Email configuration');

                // Unsupported types fail before anything is evaluated or requested. Dynamic mode
                // takes the message ID from msg.email, so its type is not checked there.
                const userIdType = node.configNode.userIdType || 'str';
                if (!USER_ID_TYPES.includes(userIdType)) {
                    const err = new Error(`User ID type '${userIdType}' is not supported`);
                    err.code = 'INVALID_CONFIGURATION';
                    throw err;
                }
                if (!node.dynamic && !TYPES.messageId.includes(node.messageIdType)) {
                    const err = new Error(
                        `Message ID type '${node.messageIdType}' is not supported`,
                    );
                    err.code = 'INVALID_CONFIGURATION';
                    throw err;
                }

                const userIdRaw = await node.getTypedProperty(
                    node.configNode.userId,
                    node.configNode.userIdType || 'str',
                    msg,
                );

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

                // The node may have closed while the user and message IDs were read.
                if (closing) return finishClosed();

                if (!msgIdRaw) throw new Error('Message ID is missing');
                if (!destIdRaw) throw new Error('Destination Folder ID is missing');

                node.status.processing('authenticating...');

                const accessToken = await node.configNode.getToken(
                    'https://graph.microsoft.com/.default',
                );
                if (closing) return finishClosed();

                node.status.processing('moving email...');

                const payload = {
                    destinationId: destIdRaw,
                };

                const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(currentUserId)}/messages/${encodeURIComponent(msgIdRaw)}/move`;

                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                    },
                    body: JSON.stringify(payload),
                    signal: controller.signal,
                });

                if (!response.ok) {
                    const errData = await response.text();
                    throw new Error(`Graph API error ${response.status}: ${errData}`);
                }

                const data = await response.json();
                if (closing) return finishClosed();

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
                if (closing) return finishClosed();
                node.status.failed(err.code || err.message || 'Azure Graph error');
                if (done) done(err);
                else node.error(err, msg);
            } finally {
                pending.delete(controller);
            }
        });
    }

    RED.nodes.registerType('azure-email-transfer', AzureEmailTransferNode);
};

module.exports.TYPES = TYPES;
