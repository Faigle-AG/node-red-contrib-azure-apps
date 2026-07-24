module.exports = function (RED) {
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);
    const { DefaultAzureCredential } = require('@azure/identity');

    function wait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function AzureDocumentIntelligenceNode(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name;
        this.endpoint = config.endpoint;
        this.dynamic = config.dynamic;
        this.modelId = config.modelId;
        this.modelIdType = config.modelIdType || 'str';
        this.documentData = config.documentData;
        this.documentDataType = config.documentDataType || 'msg';
        this.inputType = config.inputType || 'auto';
        this.outputContentFormat = config.outputContentFormat || 'text';
        this.output = config.output;
        this.outputType = config.outputType || 'msg';

        var node = this;
        extendNode(node);

        node.on('input', async function (msg, send, done) {
            try {
                let modelRaw = node.dynamic
                    ? msg.document && msg.document.modelId
                    : await node.getTypedProperty(node.modelId, node.modelIdType, msg);
                if (typeof modelRaw === 'string') modelRaw = modelRaw.trim();
                const docRaw = node.dynamic
                    ? msg.document && msg.document.data
                    : await node.getTypedProperty(node.documentData, node.documentDataType, msg);
                const currentInputType = node.dynamic
                    ? (msg.document && msg.document.inputType) || node.inputType
                    : node.inputType;
                const currentOutputFormat = node.dynamic
                    ? (msg.document && msg.document.outputContentFormat) || node.outputContentFormat
                    : node.outputContentFormat;

                if (!this.endpoint) throw new Error('Endpoint URL is missing');
                if (!modelRaw) throw new Error('Model ID is missing');
                if (!docRaw) throw new Error('Document Data is missing');

                node.status.processing('authenticating...');

                const credential = new DefaultAzureCredential();
                const tokenResponse = await credential.getToken(
                    'https://cognitiveservices.azure.com/.default',
                );

                node.status.processing('submitting document...');

                let body, contentType;
                if (
                    currentInputType === 'url' ||
                    (currentInputType === 'auto' &&
                        typeof docRaw === 'string' &&
                        docRaw.startsWith('http'))
                ) {
                    body = JSON.stringify({ urlSource: docRaw });
                    contentType = 'application/json';
                } else if (
                    currentInputType === 'base64' ||
                    (currentInputType === 'auto' && typeof docRaw === 'string')
                ) {
                    const cleanBase64 = docRaw.replace(/^data:.*?;base64,/, '');
                    body = Buffer.from(cleanBase64, 'base64');
                    contentType = 'application/octet-stream';
                } else if (
                    currentInputType === 'buffer' ||
                    (currentInputType === 'auto' && Buffer.isBuffer(docRaw))
                ) {
                    body = docRaw;
                    contentType = 'application/octet-stream';
                } else {
                    throw new Error('Invalid or unrecognized document input format');
                }

                const baseUrl = this.endpoint.replace(/\/$/, '');

                // Build Analyze URL targeting 2024-11-30 API version
                let analyzeUrl = `${baseUrl}/formrecognizer/documentModels/${encodeURIComponent(modelRaw)}:analyze?api-version=2024-11-30`;

                if (currentOutputFormat && currentOutputFormat !== 'text') {
                    analyzeUrl += `&outputContentFormat=${encodeURIComponent(currentOutputFormat)}`;
                }

                const initialResponse = await fetch(analyzeUrl, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${tokenResponse.token}`,
                        'Content-Type': contentType,
                    },
                    body: body,
                });

                if (!initialResponse.ok) {
                    const errData = await initialResponse.text();
                    throw new Error(`Analyze API error ${initialResponse.status}: ${errData}`);
                }

                const operationLocation = initialResponse.headers.get('Operation-Location');
                if (!operationLocation) {
                    throw new Error('Did not receive Operation-Location header from Azure');
                }

                node.status.processing('analyzing...');

                let resultData = null;
                let isCompleted = false;

                while (!isCompleted) {
                    await wait(2000);

                    const pollResponse = await fetch(operationLocation, {
                        method: 'GET',
                        headers: {
                            Authorization: `Bearer ${tokenResponse.token}`,
                        },
                    });

                    if (!pollResponse.ok) {
                        const errData = await pollResponse.text();
                        throw new Error(`Polling API error ${pollResponse.status}: ${errData}`);
                    }

                    resultData = await pollResponse.json();

                    if (resultData.status === 'succeeded') isCompleted = true;
                    else if (resultData.status === 'failed')
                        throw new Error(
                            `Document analysis failed: ${JSON.stringify(resultData.error)}`,
                        );
                }

                var docDetails = {
                    action: 'analyze',
                    status: 'succeeded',
                    modelId: modelRaw,
                    analysis: resultData,
                };

                await node.setTypedProperty(node.output, node.outputType, msg, docDetails);

                node.status.succeeded('analysis complete');
                send(msg);

                if (done) done();
            } catch (err) {
                node.status.failed(err.code || err.message || 'Azure API error');
                if (done) done(err);
                else node.error(err, msg);
            }
        });
    }

    RED.nodes.registerType('document-intelligence', AzureDocumentIntelligenceNode);
};
