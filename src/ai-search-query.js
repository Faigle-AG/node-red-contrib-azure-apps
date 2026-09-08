'use strict';

module.exports = function (RED) {
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);

    const SEARCH_SCOPE = 'https://search.azure.com/.default';
    const API_VERSION = '2026-04-01';

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

    function normalizeObject(value, label) {
        if (value === undefined || value === null || value === '') return {};

        if (typeof value === 'string') {
            try {
                value = JSON.parse(value);
            } catch {
                throw new Error(`${label} must resolve to a JSON object`);
            }
        }

        if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value)) {
            throw new Error(`${label} must resolve to a JSON object`);
        }

        return { ...value };
    }

    function toOptionalInteger(value, label, min) {
        if (value === undefined || value === null || value === '') return undefined;

        const number = Number(value);
        if (!Number.isInteger(number) || number < min) {
            throw new Error(`${label} must be an integer greater than or equal to ${min}`);
        }

        return number;
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
            `Azure AI Search request failed with HTTP ${response.status}`;

        const err = new Error(message);
        err.name = 'AzureAiSearchError';
        err.statusCode = response.status;
        err.code = serviceError && serviceError.code;
        err.details = body;
        err.requestId = response.headers.get('x-ms-request-id');
        return err;
    }

    function AzureAiSearchNode(config) {
        RED.nodes.createNode(this, config);

        this.name = config.name;
        this.configNode = RED.nodes.getNode(config.config);
        this.endpoint = config.endpoint;
        this.endpointType = config.endpointType || 'str';
        this.indexName = config.indexName;
        this.indexNameType = config.indexNameType || 'str';
        this.query = config.query || 'payload';
        this.queryType = config.queryType || 'msg';
        this.searchMode = config.searchMode || 'any';
        this.querySyntax = config.querySyntax || 'simple';
        this.searchFields = config.searchFields || '';
        this.select = config.select || '';
        this.filter = config.filter || '';
        this.top = config.top;
        this.skip = config.skip;
        this.count = config.count === true;
        this.semanticConfiguration = config.semanticConfiguration || '';
        this.additionalParameters = config.additionalParameters || '{}';
        this.additionalParametersType = config.additionalParametersType || 'json';
        this.output =
            typeof config.output === 'string' && config.output.trim()
                ? config.output.trim()
                : 'payload';
        this.outputType = config.outputType || 'msg';
        this.outputMode = config.outputMode || 'documents';
        this.timeoutMs = config.timeoutMs === '' ? 30000 : config.timeoutMs;
        this.enableLogging = config.enableLogging === true;

        const node = this;
        extendNode(node);

        node.on('input', async function (msg, send, done) {
            const controller = new AbortController();
            let timeout;

            try {
                if (!node.configNode) throw new Error('Missing Azure configuration');

                node.status.processing('searching...');

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
                const queryValue = await node.getTypedProperty(node.query, node.queryType, msg);
                const additionalValue = await node.getTypedProperty(
                    node.additionalParameters,
                    node.additionalParametersType,
                    msg,
                );

                const endpoint = normalizeEndpoint(endpointValue);
                const indexName = String(indexNameValue).trim();
                const additionalParameters = normalizeObject(
                    additionalValue,
                    'Additional parameters',
                );

                const requestBody = {};

                if (queryValue !== undefined && queryValue !== null && queryValue !== '') {
                    requestBody.search = Buffer.isBuffer(queryValue)
                        ? queryValue.toString('utf8')
                        : String(queryValue);
                }

                if (node.querySyntax) requestBody.queryType = node.querySyntax;
                if (node.searchMode) requestBody.searchMode = node.searchMode;
                if (node.searchFields && node.searchFields.trim()) {
                    requestBody.searchFields = node.searchFields.trim();
                }
                if (node.select && node.select.trim()) requestBody.select = node.select.trim();
                if (node.filter && node.filter.trim()) requestBody.filter = node.filter.trim();

                const top = toOptionalInteger(node.top, 'Top', 1);
                const skip = toOptionalInteger(node.skip, 'Skip', 0);
                const timeoutMs = toOptionalInteger(node.timeoutMs, 'Timeout', 1000);

                if (top !== undefined) requestBody.top = top;
                if (skip !== undefined) requestBody.skip = skip;
                if (node.count) requestBody.count = true;
                if (node.semanticConfiguration && node.semanticConfiguration.trim()) {
                    requestBody.semanticConfiguration = node.semanticConfiguration.trim();
                }

                Object.assign(requestBody, additionalParameters);

                if (
                    requestBody.search === undefined &&
                    !Array.isArray(requestBody.vectorQueries) &&
                    requestBody.vector === undefined
                ) {
                    requestBody.search = '*';
                }

                const targetUrl = new URL(
                    `/indexes/${encodeURIComponent(indexName)}/docs/search`,
                    endpoint,
                );
                targetUrl.searchParams.set('api-version', API_VERSION);

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

                if (timeoutMs !== undefined) {
                    timeout = setTimeout(() => controller.abort(), timeoutMs);
                }

                if (node.enableLogging) {
                    node.log(
                        `Searching Azure AI Search index '${indexName}' with api-version=${API_VERSION}`,
                    );
                }

                const response = await fetch(targetUrl.toString(), {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(requestBody),
                    signal: controller.signal,
                });

                if (timeout) {
                    clearTimeout(timeout);
                    timeout = null;
                }

                const responseBody = await readResponseBody(response);
                if (!response.ok) throw createHttpError(response, responseBody);

                const documents = Array.isArray(responseBody.value) ? responseBody.value : [];
                const outputValue = node.outputMode === 'response' ? responseBody : documents;

                await node.setTypedProperty(node.output, node.outputType, msg, outputValue);

                msg.azureSearch = {
                    requestId: response.headers.get('x-ms-request-id'),
                    indexName,
                    apiVersion: API_VERSION,
                    count: responseBody['@odata.count'],
                    coverage: responseBody['@search.coverage'],
                    answers: responseBody['@search.answers'],
                    documentsReturned: documents.length,
                };

                send(msg);
                if (done) done();

                node.status.succeeded(`${documents.length} result(s)`, {
                    next: () => node.status.waiting('waiting for input'),
                });
            } catch (err) {
                if (timeout) clearTimeout(timeout);

                let normalized = err;
                if (err && err.name === 'AbortError') {
                    normalized = new Error('Azure AI Search request timed out');
                    normalized.code = 'REQUEST_TIMEOUT';
                }

                const statusText = normalized.statusCode
                    ? `HTTP ${normalized.statusCode}`
                    : normalized.code || normalized.message || 'Azure AI Search error';

                node.status.failed(statusText);

                if (node.enableLogging && normalized.requestId) {
                    node.warn(`Azure AI Search request ID: ${normalized.requestId}`);
                }

                if (done) done(normalized);
                else node.error(normalized, msg);
            }
        });
    }

    RED.nodes.registerType('azure-ai-search-query', AzureAiSearchNode);
};
