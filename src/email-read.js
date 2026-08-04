module.exports = function (RED) {
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);
    const { DefaultAzureCredential } = require('@azure/identity');

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

                const folders = await getMailFolders(userId, tokenResponse.token);

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
        this.dynamic = config.dynamic;
        this.userId = config.userId;
        this.userIdType = config.userIdType || 'str';
        this.folderId = config.folderId || 'inbox';
        this.folderName = config.folderName || 'Inbox';
        this.limit = config.limit || 10;
        this.downloadAttachments = config.downloadAttachments;
        this.output = config.output;
        this.outputType = config.outputType;

        var node = this;
        extendNode(node);

        node.on('input', async function (msg, send, done) {
            try {
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
                    node.userId,
                    node.userIdType,
                    msg,
                );

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

                const credential = new DefaultAzureCredential();
                const tokenResponse = await credential.getToken(
                    'https://graph.microsoft.com/.default',
                );

                node.status.processing('fetching emails...');

                let url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(normalizedUserId)}/mailFolders/${encodeURIComponent(normalizedFolderId)}/messages?$top=${currentLimit}`;

                if (currentDownloadAttachments) url += '&$expand=attachments';

                const response = await fetch(url, {
                    headers: {
                        Authorization: `Bearer ${tokenResponse.token}`,
                        Accept: 'application/json',
                    },
                });

                if (!response.ok) {
                    const errData = await response.text();
                    throw new Error(`Graph API error ${response.status}: ${errData}`);
                }

                const data = await response.json();

                var emailDetails = {
                    action: 'read',
                    folderId: normalizedFolderId,
                    folderName: currentFolderName,
                    count: data.value ? data.value.length : 0,
                    list: data.value ? data.value : [],
                };

                await node.setTypedProperty(node.output, node.outputType, msg, emailDetails);

                send(msg);
                if (done) done();

                node.status.succeeded('finished processing', {
                    next: () => node.status.waiting('waiting for input'),
                });
            } catch (err) {
                node.error(err);
                node.status.failed(err.code || err.message || 'Azure Graph error');
                if (done) done(err);
                else node.error(err, msg);
            }
        });
    }

    RED.nodes.registerType('email-read', AzureEmailReadNode);
};
