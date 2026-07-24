module.exports = function (RED) {
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);
    const { DefaultAzureCredential } = require('@azure/identity');

    function AzureEmailWriteNode(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name;
        this.userId = config.userId;
        this.userIdType = config.userIdType || 'str';
        this.dynamic = config.dynamic;
        this.to = config.to;
        this.toType = config.toType || 'msg';
        this.subject = config.subject;
        this.subjectType = config.subjectType || 'msg';
        this.body = config.body;
        this.bodyType = config.bodyType || 'msg';
        this.attachments = config.attachments;
        this.attachmentsType = config.attachmentsType || 'msg';

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

                const toRaw = node.dynamic
                    ? (msg.email && msg.email.to) || ''
                    : (await node.getTypedProperty(node.to, node.toType, msg)) || '';
                const subjectRaw = node.dynamic
                    ? (msg.email && msg.email.subject) || ''
                    : (await node.getTypedProperty(node.subject, node.subjectType, msg)) || '';
                const bodyRaw = node.dynamic
                    ? (msg.email && msg.email.body) || ''
                    : (await node.getTypedProperty(node.body, node.bodyType, msg)) || '';
                let attachmentsRaw = [];
                try {
                    attachmentsRaw = node.dynamic
                        ? (msg.email && msg.email.attachments) || []
                        : (await node.getTypedProperty(
                              node.attachments,
                              node.attachmentsType,
                              msg,
                          )) || [];
                } catch {
                    attachmentsRaw = [];
                }

                if (!toRaw) throw new Error('Recipient (To) is missing');
                if (!subjectRaw) throw new Error('Subject is missing');
                if (!bodyRaw) throw new Error('Body is missing');

                node.status.processing('authenticating...');

                const credential = new DefaultAzureCredential();
                const tokenResponse = await credential.getToken(
                    'https://graph.microsoft.com/.default',
                );

                node.status.processing('sending email...');

                let toRecipients = [];
                if (typeof toRaw === 'string') {
                    toRecipients = toRaw.split(',').map((email) => ({
                        emailAddress: { address: email.trim() },
                    }));
                } else if (Array.isArray(toRaw)) {
                    toRecipients = toRaw.map((item) => ({
                        emailAddress: {
                            address: item.address || item.emailAddress?.address,
                            ...(item.name && { name: item.name }),
                            ...(item.emailAddress?.name && { name: item.emailAddress.name }),
                        },
                    }));
                } else if (typeof toRaw === 'object' && toRaw !== null) {
                    toRecipients = [
                        {
                            emailAddress: {
                                address: toRaw.address || toRaw.emailAddress?.address,
                                ...(toRaw.name && { name: toRaw.name }),
                                ...(toRaw.emailAddress?.name && { name: toRaw.emailAddress.name }),
                            },
                        },
                    ];
                } else {
                    throw new Error('Invalid format for Recipient (To)');
                }

                let graphAttachments = [];
                if (attachmentsRaw && Array.isArray(attachmentsRaw)) {
                    graphAttachments = attachmentsRaw.map((att) => {
                        let contentBytes;
                        if (Buffer.isBuffer(att.content)) {
                            contentBytes = att.content.toString('base64');
                        } else if (typeof att.content === 'string') {
                            contentBytes = att.content;
                        } else {
                            throw new Error('Attachment content must be a Buffer or Base64 string');
                        }

                        return {
                            '@odata.type': '#microsoft.graph.fileAttachment',
                            name: att.name || 'attachment',
                            contentType: att.contentType || 'application/octet-stream',
                            contentBytes: contentBytes,
                        };
                    });
                }

                const payload = {
                    message: {
                        subject: subjectRaw,
                        body: {
                            contentType: 'HTML',
                            content: bodyRaw,
                        },
                        toRecipients: toRecipients,
                        ...(graphAttachments.length > 0 && {
                            hasAttachments: true,
                            attachments: graphAttachments,
                        }),
                    },
                    saveToSentItems: 'true',
                };

                const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(currentUserId)}/sendMail`;

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
                    attachmentsCount: graphAttachments.length,
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
