// The types each typed field offers in the editor (Phase 2.9). A configured type outside these
// fails clearly before anything is evaluated or requested.
const TYPES = {
    output: ['msg', 'flow', 'global'],
};

// The User ID is configured once, on the email configuration node, which owns its types.
const { userId: USER_ID_TYPES } = require('./email-config').TYPES;

module.exports = function (RED) {
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);

    async function getGraphCollection(url, token) {
        var result = [];

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

            if (data.value) result = result.concat(data.value);
            url = data['@odata.nextLink'];
        }

        return result;
    }

    async function getMailFolders(userId, token) {
        var folderDetails = [];
        const encodedUserId = encodeURIComponent(userId);

        async function getChildFolders(url, parentPath) {
            const folders = await getGraphCollection(url, token);

            for (const folder of folders) {
                const folderPath = parentPath
                    ? `${parentPath} / ${folder.displayName}`
                    : folder.displayName;

                folderDetails.push({
                    id: folder.id,
                    name: folder.displayName,
                    path: folderPath,
                });

                if (folder.childFolderCount > 0) {
                    await getChildFolders(
                        `https://graph.microsoft.com/v1.0/users/${encodedUserId}/mailFolders/${encodeURIComponent(folder.id)}/childFolders?includeHiddenFolders=true&$top=100&$select=id,displayName,childFolderCount`,
                        folderPath,
                    );
                }
            }
        }

        await getChildFolders(
            `https://graph.microsoft.com/v1.0/users/${encodedUserId}/mailFolders?includeHiddenFolders=true&$top=100&$select=id,displayName,childFolderCount`,
            '',
        );

        return folderDetails;
    }

    RED.httpAdmin.get(
        '/email-read/folders',
        RED.auth.needsPermission('email-read.read'),
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

                const folders = await getMailFolders(userId, accessToken);

                res.json(folders);
            } catch (err) {
                RED.log.error(err);
                res.status(500).json({
                    message: err.message || 'Unable to load mail folders',
                });
            }
        },
    );

    function AzureEmailReadNode(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name;
        this.configNode = RED.nodes.getNode(config.config);
        this.dynamic = config.dynamic;
        this.folderId = config.folderId || 'inbox';
        this.folderName = config.folderName || 'Inbox';
        this.limit = config.limit || 10;
        this.downloadAttachments = config.downloadAttachments;
        this.output = config.output;
        this.outputType = config.outputType;

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

                // Unsupported types fail before anything is evaluated or requested.
                const userIdType = node.configNode.userIdType || 'str';
                if (!USER_ID_TYPES.includes(userIdType)) {
                    const err = new Error(`User ID type '${userIdType}' is not supported`);
                    err.code = 'INVALID_CONFIGURATION';
                    throw err;
                }
                if (!TYPES.output.includes(node.outputType || 'msg')) {
                    throw new Error(
                        `Unsupported target property type: ${node.outputType || 'msg'}`,
                    );
                }

                const currentFolderId =
                    node.dynamic && msg.email && msg.email.folderId !== undefined
                        ? msg.email.folderId
                        : node.folderId;

                const currentFolderName =
                    node.dynamic && msg.email && msg.email.folderName !== undefined
                        ? msg.email.folderName
                        : node.folderName;

                const currentLimit =
                    node.dynamic && msg.email && msg.email.limit !== undefined
                        ? msg.email.limit
                        : node.limit;

                const currentDownloadAttachments =
                    node.dynamic && msg.email && msg.email.downloadAttachments !== undefined
                        ? msg.email.downloadAttachments
                        : node.downloadAttachments;

                const currentUserId = await node.getTypedProperty(
                    node.configNode.userId,
                    node.configNode.userIdType || 'str',
                    msg,
                );
                if (closing) return finishClosed();

                const normalizedUserId = String(currentUserId || '').trim();
                if (!normalizedUserId) {
                    const err = new Error('User ID / Email resolved to an empty value');
                    err.code = 'INVALID_USER_ID';
                    throw err;
                }

                const normalizedFolderId = String(currentFolderId || '').trim();
                if (!normalizedFolderId) {
                    const err = new Error('Mail Folder resolved to an empty value');
                    err.code = 'INVALID_FOLDER_ID';
                    throw err;
                }

                node.status.processing('authenticating...');

                const accessToken = await node.configNode.getToken(
                    'https://graph.microsoft.com/.default',
                );
                if (closing) return finishClosed();

                node.status.processing('fetching emails...');

                let url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(normalizedUserId)}/mailFolders/${encodeURIComponent(normalizedFolderId)}/messages?$top=${currentLimit}`;

                if (currentDownloadAttachments) url += '&$expand=attachments';

                const response = await fetch(url, {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        Accept: 'application/json',
                    },
                    signal: controller.signal,
                });

                if (!response.ok) {
                    const errData = await response.text();
                    throw new Error(`Graph API error ${response.status}: ${errData}`);
                }

                const data = await response.json();
                if (closing) return finishClosed();

                var emailDetails = {
                    action: 'read',
                    folderId: normalizedFolderId,
                    folderName: currentFolderName,
                    count: data.value ? data.value.length : 0,
                    list: data.value ? data.value : [],
                };

                await node.setTypedProperty(node.output, node.outputType, msg, emailDetails);
                if (closing) return finishClosed();

                send(msg);
                if (done) done();

                node.status.succeeded('finished processing', {
                    next: () => node.status.waiting('waiting for input'),
                });
            } catch (err) {
                if (closing) return finishClosed();
                node.error(err);
                node.status.failed(err.code || err.message || 'Azure Graph error');
                if (done) done(err);
                else node.error(err, msg);
            } finally {
                pending.delete(controller);
            }
        });
    }

    RED.nodes.registerType('azure-email-read', AzureEmailReadNode);
};

module.exports.TYPES = TYPES;
