module.exports = function (RED) {
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);
    const { DefaultAzureCredential } = require('@azure/identity');

    function AzureEmailTransferNode(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name;
        this.userId = config.userId;
        this.dynamic = config.dynamic;
        this.messageId = config.messageId;
        this.messageIdType = config.messageIdType || 'msg';
        this.destinationId = config.destinationId;
        this.destinationIdType = config.destinationIdType || 'msg';

        var node = this;
        extendNode(node);

        node.on('input', async function (msg, send, done) {
            try {
                const msgIdRaw = node.dynamic
                    ? msg.email && msg.email.messageId
                    : await node.getTypedProperty(node.messageId, node.messageIdType, msg);
                const destIdRaw = node.dynamic
                    ? msg.email && msg.email.destinationId
                    : await node.getTypedProperty(node.destinationId, node.destinationIdType, msg);

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

                const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(node.userId)}/messages/${encodeURIComponent(msgIdRaw)}/move`;

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
