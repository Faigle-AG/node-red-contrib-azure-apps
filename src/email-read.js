module.exports = function (RED) {
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);
    const { DefaultAzureCredential } = require('@azure/identity');

    function AzureEmailReadNode(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name;
        this.dynamic = config.dynamic;
        this.userId = config.userId;
        this.userIdType = config.userIdType || 'str';
        this.limit = config.limit || 10;
        this.downloadAttachments = config.downloadAttachments;
        this.output = config.output;
        this.outputType = config.outputType;

        var node = this;
        extendNode(node);

        node.on('input', async function (msg, send, done) {
            try {
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

                node.status.processing('authenticating...');

                const credential = new DefaultAzureCredential();
                const tokenResponse = await credential.getToken(
                    'https://graph.microsoft.com/.default',
                );

                node.status.processing('fetching emails...');

                let url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(normalizedUserId)}/mailFolders/inbox/messages?$top=${currentLimit}`;

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
