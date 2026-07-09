module.exports = function (RED) {
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);
    const { DefaultAzureCredential } = require('@azure/identity');

    function AzureReadEmailNode(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name;
        this.userId = config.userId;
        this.limit = config.limit || 10;
        this.output = config.output;
        this.outputType = config.outputType;

        var node = this;

        extendNode(node);

        node.on('input', async function (msg, send, done) {
            try {
                node.status.processing('authenticating...');

                const credential = new DefaultAzureCredential();
                const tokenResponse = await credential.getToken('https://graph.microsoft.com/.default');

                node.status.processing('fetching emails...');

                const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(node.userId)}/mailFolders/inbox/messages?$top=${node.limit}`;

                const response = await fetch(url, {
                    headers: {
                        'Authorization': `Bearer ${tokenResponse.token}`,
                        'Accept': 'application/json'
                    }
                });

                if (!response.ok) {
                    const errData = await response.text();
                    throw new Error(`Graph API error ${response.status}: ${errData}`);
                }

                const data = await response.json();

                await node.setTypedProperty(node.output, node.outputType, msg, data.value);

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

    RED.nodes.registerType('azure-read-email', AzureReadEmailNode);
};