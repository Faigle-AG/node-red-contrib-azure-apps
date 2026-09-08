'use strict';

module.exports = function (RED) {
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);

    const SEARCH_SCOPE = 'https://search.azure.com/.default';
    const API_VERSION = '2026-04-01';
    const VALID_OPERATIONS = new Set(['createOrUpdate', 'get', 'delete']);

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

    function normalizeDefinition(value, indexName) {
        if (Buffer.isBuffer(value)) value = value.toString('utf8');

        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) throw new Error('Index definition is empty');

            try {
                value = JSON.parse(trimmed);
            } catch (err) {
                const wrapped = new Error('Index definition must contain valid JSON');
                wrapped.cause = err;
                throw wrapped;
            }
        }

        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Index definition must resolve to a JSON object');
        }

        const definition = { ...value };

        if (definition.name && String(definition.name).trim() !== indexName) {
            throw new Error(
                `Index definition name '${definition.name}' does not match configured index '${indexName}'`,
            );
        }

        definition.name = indexName;

        if (!Array.isArray(definition.fields) || definition.fields.length === 0) {
            throw new Error('Index definition must contain a non-empty fields array');
        }

        const keyFields = definition.fields.filter((field) => field && field.key === true);
        if (keyFields.length !== 1) {
            throw new Error('Index definition must contain exactly one field with key: true');
        }

        return definition;
    }

    function toTimeout(value) {
        const number = Number(value);
        if (!Number.isInteger(number) || number < 1000) {
            throw new Error('Timeout must be an integer of at least 1000 ms');
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
            `Azure AI Search index request failed with HTTP ${response.status}`;

        const err = new Error(message);
        err.name = 'AzureAiSearchIndexError';
        err.statusCode = response.status;
        err.code = serviceError && serviceError.code;
        err.details = body;
        err.requestId = response.headers.get('x-ms-request-id');
        return err;
    }

    function createTargetUrl(endpoint, indexName, operation, allowIndexDowntime) {
        const encodedIndexName = encodeURIComponent(indexName);
        const target = new URL(
            `${endpoint}/indexes('${encodedIndexName}')?api-version=${API_VERSION}`,
        );

        if (operation === 'createOrUpdate' && allowIndexDowntime) {
            target.searchParams.set('allowIndexDowntime', 'true');
        }

        return target.toString();
    }

    async function createHeaders(configNode, includeBody) {
        const headers = { Accept: 'application/json' };
        if (includeBody) {
            headers['Content-Type'] = 'application/json';
            headers.Prefer = 'return=representation';
        }

        if (configNode.authType === 'apiKey') {
            headers['api-key'] = configNode.getApiKey();
        } else if (configNode.authType === 'entra') {
            const token = await configNode.getToken(SEARCH_SCOPE);
            headers.Authorization = `Bearer ${token}`;
        } else {
            throw new Error(
                `Azure AI Search requires Entra ID or API key authentication, but Azure Config uses '${configNode.authType}'`,
            );
        }

        return headers;
    }

    function AzureAiSearchIndexNode(config) {
        RED.nodes.createNode(this, config);

        this.name = config.name;
        this.configNode = RED.nodes.getNode(config.config);
        this.endpoint = config.endpoint;
        this.endpointType = config.endpointType || 'str';
        this.indexName = config.indexName;
        this.indexNameType = config.indexNameType || 'str';
        this.operation = config.operation || 'createOrUpdate';
        this.definition = config.definition || 'payload';
        this.definitionType = config.definitionType || 'msg';
        this.allowIndexDowntime = config.allowIndexDowntime === true;
        this.timeoutMs = config.timeoutMs === '' ? 30000 : config.timeoutMs;
        this.output =
            typeof config.output === 'string' && config.output.trim()
                ? config.output.trim()
                : 'payload';
        this.outputType = config.outputType || 'msg';
        this.enableLogging = config.enableLogging === true;

        const node = this;
        extendNode(node);

        node.on('input', async function (msg, send, done) {
            const controller = new AbortController();
            let timeout;

            try {
                if (!node.configNode) throw new Error('Missing Azure configuration');
                if (!VALID_OPERATIONS.has(node.operation)) {
                    throw new Error(`Unsupported index operation '${node.operation}'`);
                }

                node.status.processing(`${node.operation} index...`);

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

                const endpoint = normalizeEndpoint(endpointValue);
                const indexName = String(indexNameValue).trim();
                const timeoutMs = toTimeout(node.timeoutMs);
                let requestBody;

                if (node.operation === 'createOrUpdate') {
                    const definitionValue = await node.getTypedProperty(
                        node.definition,
                        node.definitionType,
                        msg,
                    );
                    requestBody = normalizeDefinition(definitionValue, indexName);
                }

                const method =
                    node.operation === 'createOrUpdate'
                        ? 'PUT'
                        : node.operation === 'delete'
                          ? 'DELETE'
                          : 'GET';
                const headers = await createHeaders(
                    node.configNode,
                    node.operation === 'createOrUpdate',
                );
                const targetUrl = createTargetUrl(
                    endpoint,
                    indexName,
                    node.operation,
                    node.allowIndexDowntime,
                );

                if (node.enableLogging) {
                    node.log(
                        `${method} Azure AI Search index '${indexName}' ` +
                            `(operation=${node.operation}, api-version=${API_VERSION})`,
                    );
                }

                timeout = setTimeout(() => controller.abort(), timeoutMs);

                const requestOptions = {
                    method,
                    headers,
                    signal: controller.signal,
                };
                if (requestBody) requestOptions.body = JSON.stringify(requestBody);

                const response = await fetch(targetUrl, requestOptions);
                clearTimeout(timeout);
                timeout = null;

                const responseBody = await readResponseBody(response);
                if (!response.ok) throw createHttpError(response, responseBody);

                const metadata = {
                    operation: node.operation,
                    indexName,
                    apiVersion: API_VERSION,
                    httpStatus: response.status,
                    requestId: response.headers.get('x-ms-request-id'),
                    etag: response.headers.get('etag') || responseBody['@odata.etag'],
                    created:
                        node.operation === 'createOrUpdate' ? response.status === 201 : undefined,
                    deleted: node.operation === 'delete' ? true : undefined,
                };

                msg.azureSearchIndex = metadata;

                const outputValue =
                    node.operation === 'delete'
                        ? metadata
                        : Object.keys(responseBody).length > 0
                          ? responseBody
                          : metadata;

                await node.setTypedProperty(node.output, node.outputType, msg, outputValue);

                send(msg);
                if (done) done();

                const successText =
                    node.operation === 'delete'
                        ? 'index deleted'
                        : node.operation === 'get'
                          ? 'index loaded'
                          : response.status === 201
                            ? 'index created'
                            : 'index updated';

                node.status.succeeded(successText, {
                    next: () => node.status.waiting('waiting for input'),
                });
            } catch (err) {
                if (timeout) clearTimeout(timeout);

                let normalized = err;
                if (err && err.name === 'AbortError') {
                    normalized = new Error('Azure AI Search index request timed out');
                    normalized.name = 'AzureAiSearchIndexTimeoutError';
                    normalized.code = 'REQUEST_TIMEOUT';
                    normalized.cause = err;
                }

                const statusText = normalized.statusCode
                    ? `HTTP ${normalized.statusCode}`
                    : normalized.code || normalized.message || 'Azure AI Search index error';

                node.status.failed(statusText);

                if (node.enableLogging && normalized.requestId) {
                    node.warn(`Azure AI Search request ID: ${normalized.requestId}`);
                }

                if (done) done(normalized);
                else node.error(normalized, msg);
            }
        });
    }

    RED.nodes.registerType('azure-ai-search-index', AzureAiSearchIndexNode);
};
