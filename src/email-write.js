module.exports = function (RED) {
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);
    const { DefaultAzureCredential } = require('@azure/identity');

    function AzureEmailWriteNode(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name;
        this.userId = config.userId;
        this.dynamic = config.dynamic;
        this.to = config.to;
        this.toType = config.toType || 'msg';
        this.subject = config.subject;
        this.subjectType = config.subjectType || 'msg';
        this.body = config.body;
        this.bodyType = config.bodyType || 'msg';

        var node = this;
        extendNode(node);

        node.on('input', async function (msg, send, done) {
            try {
                const toRaw = node.dynamic
                    ? msg.email && msg.email.to
                    : await node.getTypedProperty(node.to, node.toType, msg);
                const subjectRaw = node.dynamic
                    ? msg.email && msg.email.subject
                    : await node.getTypedProperty(node.subject, node.subjectType, msg);
                const bodyRaw = node.dynamic
                    ? msg.email && msg.email.body
                    : await node.getTypedProperty(node.body, node.bodyType, msg);

                if (!toRaw) throw new Error('Recipient (To) is missing');
                if (!subjectRaw) throw new Error('Subject is missing');
                if (bodyRaw === undefined) throw new Error('Body is missing');

                node.status.processing('authenticating...');

                const credential = new DefaultAzureCredential();
                const tokenResponse = await credential.getToken(
                    'https://graph.microsoft.com/.default',
                );

                node.status.processing('sending email...');

                const toRecipients = toRaw.split(',').map((email) => ({
                    emailAddress: { address: email.trim() },
                }));

                const payload = {
                    message: {
                        subject: subjectRaw,
                        body: {
                            contentType: 'HTML',
                            content: bodyRaw,
                        },
                        toRecipients: toRecipients,
                    },
                    saveToSentItems: 'true',
                };

                const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(node.userId)}/sendMail`;

                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${tokenResponse.token}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(payload),
                });

                if (!response.ok) {
                    const errData = await response.text();
                    throw new Error(`Graph API error ${response.status}: ${errData}`);
                }

                var emailDetails = {
                    action: 'write',
                    status: 'sent',
                    to: toRaw,
                    subject: subjectRaw,
                };

                msg.email = { ...msg.email, ...emailDetails };
                node.status.succeeded('email sent');
                send(msg);

                if (done) done();
            } catch (err) {
                node.status.failed(err.code || err.message || 'Azure Graph error');
                if (done) done(err);
                else node.error(err, msg);
            }
        });
    }

    RED.nodes.registerType('email-write', AzureEmailWriteNode);
};
