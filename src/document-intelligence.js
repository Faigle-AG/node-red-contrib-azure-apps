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
        this.pages = config.pages;
        this.locale = config.locale;
        this.stringIndexType = config.stringIndexType || 'utf16CodeUnit';
        this.features = config.features;
        this.queryFields = config.queryFields;
        this.outputOptions = config.outputOptions;
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
                const currentPages = node.dynamic
                    ? (msg.document && msg.document.pages) || node.pages
                    : node.pages;
                const currentLocale = node.dynamic
                    ? (msg.document && msg.document.locale) || node.locale
                    : node.locale;
                const currentStringIndexType = node.dynamic
                    ? (msg.document && msg.document.stringIndexType) || node.stringIndexType
                    : node.stringIndexType;
                const currentFeatures = node.dynamic
                    ? (msg.document && msg.document.features) || node.features
                    : node.features;
                const currentQueryFields = node.dynamic
                    ? (msg.document && msg.document.queryFields) || node.queryFields
                    : node.queryFields;
                const currentOutputOptions = node.dynamic
                    ? (msg.document && (msg.document.outputOptions || msg.document.output)) ||
                      node.outputOptions
                    : node.outputOptions;

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

                const baseUrl = String(node.endpoint || '')
                    .trim()
                    .replace(/\/+$/, '')
                    .replace(/\/(formrecognizer|documentintelligence)$/i, '');

                const targetUrl = new URL(
                    `${baseUrl}/documentintelligence/documentModels/${encodeURIComponent(modelRaw)}:analyze`,
                );

                targetUrl.searchParams.set('api-version', '2024-11-30');

                if (currentOutputFormat && currentOutputFormat !== 'text') {
                    targetUrl.searchParams.set('outputContentFormat', currentOutputFormat.trim());
                }
                if (
                    currentPages &&
                    typeof currentPages === 'string' &&
                    currentPages.trim() !== ''
                ) {
                    targetUrl.searchParams.set('pages', currentPages.trim());
                }
                if (
                    currentLocale &&
                    typeof currentLocale === 'string' &&
                    currentLocale.trim() !== ''
                ) {
                    targetUrl.searchParams.set('locale', currentLocale.trim());
                }
                if (
                    currentStringIndexType &&
                    typeof currentStringIndexType === 'string' &&
                    currentStringIndexType.trim() !== ''
                ) {
                    targetUrl.searchParams.set('stringIndexType', currentStringIndexType.trim());
                }
                if (currentFeatures) {
                    const featStr = Array.isArray(currentFeatures)
                        ? currentFeatures.join(',')
                        : String(currentFeatures);
                    if (featStr.trim() !== '')
                        targetUrl.searchParams.set('features', featStr.trim());
                }
                if (currentQueryFields) {
                    const qfStr = Array.isArray(currentQueryFields)
                        ? currentQueryFields.join(',')
                        : String(currentQueryFields);
                    if (qfStr.trim() !== '')
                        targetUrl.searchParams.set('queryFields', qfStr.trim());
                }
                if (currentOutputOptions) {
                    const outStr = Array.isArray(currentOutputOptions)
                        ? currentOutputOptions.join(',')
                        : String(currentOutputOptions);
                    if (outStr.trim() !== '') targetUrl.searchParams.set('output', outStr.trim());
                }

                const initialResponse = await fetch(targetUrl.toString(), {
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
