'use strict';

module.exports = function (RED) {
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);

    const SEARCH_SCOPE = 'https://search.azure.com/.default';
    const API_VERSION = '2026-04-01';
    const MAX_BATCH_DOCUMENTS = 1000;
    const MAX_BATCH_BYTES = 16 * 1024 * 1024;
    const VALID_ACTIONS = new Set(['upload', 'merge', 'mergeOrUpload', 'delete']);

    function normalizeEndpoint(value) {
        if (typeof value !== 'string' || !value.trim()) {
            throw new Error('Azure AI Search endpoint is missing');
        }

        let endpoint;
        try {
            endpoint = new URL(value.trim());
        } catch {
            throw new Error('Azure AI Search endpoint must be a valid HTTPS URL');
        }

        if (endpoint.protocol !== 'https:') {
            throw new Error('Azure AI Search endpoint must use HTTPS');
        }

        endpoint.search = '';
        endpoint.hash = '';
        endpoint.pathname = '/';
        return endpoint.toString().replace(/\/+$/, '');
    }

    function toInteger(value, label, min, max) {
        const number = Number(value);
        if (!Number.isInteger(number) || number < min || (max !== undefined && number > max)) {
            const range = max === undefined ? `at least ${min}` : `between ${min} and ${max}`;
            throw new Error(`${label} must be an integer ${range}`);
        }
        return number;
    }

    function parseJsonValue(value, label) {
        if (Buffer.isBuffer(value)) value = value.toString('utf8');

        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) throw new Error(`${label} is empty`);
            try {
                return JSON.parse(trimmed);
            } catch (err) {
                const wrapped = new Error(`${label} must contain valid JSON`);
                wrapped.cause = err;
                throw wrapped;
            }
        }

        return value;
    }

    function normalizeDocuments(value) {
        value = parseJsonValue(value, 'Documents');

        let documents;
        if (Array.isArray(value)) {
            documents = value;
        } else if (value && typeof value === 'object' && Array.isArray(value.value)) {
            documents = value.value;
        } else if (value && typeof value === 'object') {
            documents = [value];
        } else {
            throw new Error(
                'Documents must resolve to an object, an array, or an object with a value array',
            );
        }

        if (documents.length === 0) throw new Error('Documents array is empty');

        return documents.map((document, index) => {
            if (
                !document ||
                typeof document !== 'object' ||
                Array.isArray(document) ||
                Buffer.isBuffer(document)
            ) {
                throw new Error(`Document ${index + 1} must be a JSON object`);
            }
            return { ...document };
        });
    }

    function applyActions(documents, actionMode) {
        return documents.map((document, index) => {
            const copy = { ...document };

            if (actionMode === 'document') {
                const documentAction = copy['@search.action'];
                if (!VALID_ACTIONS.has(documentAction)) {
                    throw new Error(
                        `Document ${index + 1} must contain a valid @search.action when Action is set to 'From document'`,
                    );
                }
            } else {
                if (!VALID_ACTIONS.has(actionMode)) {
                    throw new Error(`Unsupported indexing action '${actionMode}'`);
                }
                copy['@search.action'] = actionMode;
            }

            return copy;
        });
    }

    function buildBatches(documents, batchSize) {
        const batches = [];
        let current = [];

        function payloadSize(items) {
            return Buffer.byteLength(JSON.stringify({ value: items }), 'utf8');
        }

        for (const document of documents) {
            const singleSize = payloadSize([document]);
            if (singleSize > MAX_BATCH_BYTES) {
                throw new Error(
                    'A single document exceeds the Azure AI Search 16 MB indexing payload limit',
                );
            }

            const candidate = [...current, document];
            if (
                current.length > 0 &&
                (candidate.length > batchSize || payloadSize(candidate) > MAX_BATCH_BYTES)
            ) {
                batches.push(current);
                current = [document];
            } else {
                current = candidate;
            }
        }

        if (current.length > 0) batches.push(current);
        return batches;
    }

    async function readResponseBody(response) {
        const text = await response.text();
        if (!text) return {};

        try {
            return JSON.parse(text);
        } catch {
            return { message: text };
        }
    }

    function createHttpError(response, body) {
        const serviceError = body && body.error;
        const message =
            (serviceError && (serviceError.message || serviceError.code)) ||
            (body && body.message) ||
            `Azure AI Search indexing request failed with HTTP ${response.status}`;

        const err = new Error(message);
        err.name = 'AzureAiSearchSyncError';
        err.statusCode = response.status;
        err.code = serviceError && serviceError.code;
        err.details = body;
        err.requestId = response.headers.get('x-ms-request-id');
        return err;
    }

    function createDocumentError(summary) {
        const err = new Error(
            `Azure AI Search rejected ${summary.failed} of ${summary.total} document actions`,
        );
        err.name = 'AzureAiSearchDocumentError';
        err.code = 'DOCUMENT_INDEXING_FAILED';
        err.details = summary;
        return err;
    }

    function createTargetUrl(endpoint, indexName) {
        const encodedIndexName = encodeURIComponent(indexName);
        return `${endpoint}/indexes('${encodedIndexName}')/docs/search.index?api-version=${API_VERSION}`;
    }

    function AzureAiSearchSyncNode(config) {
        RED.nodes.createNode(this, config);

        this.name = config.name;
        this.configNode = RED.nodes.getNode(config.config);
        this.endpoint = config.endpoint;
        this.endpointType = config.endpointType || 'str';
        this.indexName = config.indexName;
        this.indexNameType = config.indexNameType || 'str';
        this.documents = config.documents || 'payload';
        this.documentsType = config.documentsType || 'msg';
        this.action = config.action || 'mergeOrUpload';
        this.batchSize = config.batchSize === '' ? 500 : config.batchSize;
        this.timeoutMs = config.timeoutMs === '' ? 30000 : config.timeoutMs;
        this.failOnDocumentError = config.failOnDocumentError !== false;
        this.output =
            typeof config.output === 'string' && config.output.trim()
                ? config.output.trim()
                : 'payload';
        this.outputType = config.outputType || 'msg';
        this.outputMode = config.outputMode || 'summary';
        this.enableLogging = config.enableLogging === true;

        const node = this;
        extendNode(node);

        node.on('input', async function (msg, send, done) {
            try {
                if (!node.configNode) throw new Error('Missing Azure configuration');

                node.status.processing('preparing documents...');

                const endpointValue = await node.getValidatedProperty(
                    node.endpoint,
                    node.endpointType,
                    msg,
                    'Endpoint',
                    { required: true, trimString: true, code: 'ENDPOINT_MISSING' },
                );
                const indexNameValue = await node.getValidatedProperty(
                    node.indexName,
                    node.indexNameType,
                    msg,
                    'Index name',
                    { required: true, trimString: true, code: 'INDEX_NAME_MISSING' },
                );
                const documentsValue = await node.getTypedProperty(
                    node.documents,
                    node.documentsType,
                    msg,
                );

                const endpoint = normalizeEndpoint(endpointValue);
                const indexName = String(indexNameValue).trim();
                const batchSize = toInteger(node.batchSize, 'Batch size', 1, MAX_BATCH_DOCUMENTS);
                const timeoutMs = toInteger(node.timeoutMs, 'Timeout', 1000);
                const documents = applyActions(normalizeDocuments(documentsValue), node.action);
                const batches = buildBatches(documents, batchSize);

                const headers = {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                };

                if (node.configNode.authType === 'apiKey') {
                    headers['api-key'] = node.configNode.getApiKey();
                } else if (node.configNode.authType === 'entra') {
                    const token = await node.configNode.getToken(SEARCH_SCOPE);
                    headers.Authorization = `Bearer ${token}`;
                } else {
                    throw new Error(
                        `Azure AI Search requires Entra ID or API key authentication, but Azure Config uses '${node.configNode.authType}'`,
                    );
                }

                const targetUrl = createTargetUrl(endpoint, indexName);
                const results = [];
                const responses = [];

                for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
                    const batch = batches[batchIndex];
                    node.status.processing(
                        `indexing batch ${batchIndex + 1}/${batches.length} (${batch.length})...`,
                    );

                    if (node.enableLogging) {
                        node.log(
                            `Indexing ${batch.length} document(s) into Azure AI Search index '${indexName}' ` +
                                `(batch ${batchIndex + 1}/${batches.length}, api-version=${API_VERSION})`,
                        );
                    }

                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), timeoutMs);
                    let response;

                    try {
                        response = await fetch(targetUrl, {
                            method: 'POST',
                            headers,
                            body: JSON.stringify({ value: batch }),
                            signal: controller.signal,
                        });
                    } finally {
                        clearTimeout(timeout);
                    }

                    const responseBody = await readResponseBody(response);
                    if (!response.ok) throw createHttpError(response, responseBody);

                    const batchResults = Array.isArray(responseBody.value)
                        ? responseBody.value
                        : [];
                    results.push(...batchResults);
                    responses.push({
                        batch: batchIndex + 1,
                        httpStatus: response.status,
                        requestId: response.headers.get('x-ms-request-id'),
                        response: responseBody,
                    });
                }

                const failedResults = results.filter((result) => result && result.status !== true);
                const succeededResults = results.filter(
                    (result) => result && result.status === true,
                );
                const summary = {
                    action: node.action,
                    indexName,
                    apiVersion: API_VERSION,
                    total: documents.length,
                    succeeded: succeededResults.length,
                    failed: failedResults.length,
                    batches: batches.length,
                    results,
                };

                msg.azureSearchSync = summary;

                let outputValue;
                if (node.outputMode === 'results') outputValue = results;
                else if (node.outputMode === 'responses') outputValue = responses;
                else outputValue = summary;

                await node.setTypedProperty(node.output, node.outputType, msg, outputValue);

                if (failedResults.length > 0 && node.failOnDocumentError) {
                    throw createDocumentError(summary);
                }

                send(msg);
                if (done) done();

                if (failedResults.length > 0) {
                    node.status.warning(`${failedResults.length} document(s) failed`);
                } else {
                    node.status.succeeded(`${succeededResults.length} document(s) indexed`, {
                        next: () => node.status.waiting('waiting for input'),
                    });
                }
            } catch (err) {
                const message =
                    err && err.name === 'AbortError'
                        ? 'Azure AI Search indexing request timed out'
                        : err.code || err.message || 'Azure AI Search indexing error';

                node.status.failed(message);

                let herror = err;
                if (err && err.name === 'AbortError') {
                    const timeoutError = new Error('Azure AI Search indexing request timed out');
                    timeoutError.name = 'AzureAiSearchTimeoutError';
                    timeoutError.code = 'REQUEST_TIMEOUT';
                    timeoutError.cause = err;
                    herror = timeoutError;
                }

                if (done) done(herror);
                else node.error(herror, msg);
            }
        });
    }

    RED.nodes.registerType('azure-ai-search-sync', AzureAiSearchSyncNode);
};
