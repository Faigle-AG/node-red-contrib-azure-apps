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
        if (typeof value === 'string') value = value.trim();
        if (value === undefined || value === null || value === '') return undefined;

        const number = Number(value);
        if (
            (typeof value !== 'string' && typeof value !== 'number') ||
            !Number.isSafeInteger(number) ||
            number < min
        ) {
            throw new Error(`${label} must be an integer greater than or equal to ${min}`);
        }

        return number;
    }

    async function resolveQueryOption(node, property, msg, label) {
        const type = node[`${property}Type`];
        const configured = node[property];
        // Keep literal blanks intact; evaluating an empty 'num' can turn it into 0.
        if (type === 'str' || type === 'num' || type === 'bool') return configured;
        if (typeof configured !== 'string' || !configured.trim()) {
            throw new Error(`${label}: dynamic source is missing`);
        }
        const value = await node.getTypedProperty(configured, type, msg);
        if (value === undefined) {
            throw new Error(`${label}: dynamic source resolved to undefined`);
        }
        return value;
    }

    function toOptionalString(value, label) {
        if (value === undefined || value === null) return undefined;
        if (typeof value !== 'string') throw new Error(`${label} must resolve to a string`);
        return value.trim() || undefined;
    }

    function toChoice(value, label, choices) {
        const choice = toOptionalString(value, label);
        if (!choices.includes(choice)) {
            throw new Error(`${label} must be one of: ${choices.join(', ')}`);
        }
        return choice;
    }

    function toBoolean(value, label) {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') {
            const text = value.trim().toLowerCase();
            if (text === 'true') return true;
            if (text === 'false') return false;
        }
        throw new Error(`${label} must resolve to true or false`);
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
        this.searchMode = config.searchMode === undefined ? 'any' : config.searchMode;
        this.searchModeType = config.searchModeType || 'str';
        this.querySyntax = config.querySyntax === undefined ? 'simple' : config.querySyntax;
        this.querySyntaxType = config.querySyntaxType || 'str';
        this.searchFields = config.searchFields;
        this.searchFieldsType = config.searchFieldsType || 'str';
        this.select = config.select;
        this.selectType = config.selectType || 'str';
        this.filter = config.filter || '';
        this.filterType = config.filterType || 'str';
        this.top = config.top;
        this.topType = config.topType || 'num';
        this.skip = config.skip;
        this.skipType = config.skipType || 'num';
        this.count = config.count === undefined ? false : config.count;
        this.countType = config.countType || 'bool';
        this.semanticConfiguration = config.semanticConfiguration;
        this.semanticConfigurationType = config.semanticConfigurationType || 'str';
        this.additionalParameters = config.additionalParameters || '{}';
        this.additionalParametersType = config.additionalParametersType || 'json';
        this.output =
            typeof config.output === 'string' && config.output.trim()
                ? config.output.trim()
                : 'payload';
        this.outputType = config.outputType || 'msg';
        this.outputMode = config.outputMode === undefined ? 'documents' : config.outputMode;
        this.outputModeType = config.outputModeType || 'str';
        this.timeoutMs =
            config.timeoutMs === '' || config.timeoutMs === undefined ? 30000 : config.timeoutMs;
        this.timeoutMsType = config.timeoutMsType || 'num';
        this.enableLogging = config.enableLogging === undefined ? false : config.enableLogging;
        this.enableLoggingType = config.enableLoggingType || 'bool';

        const node = this;
        extendNode(node);

        node.on('input', async function (msg, send, done) {
            const controller = new AbortController();
            let timeout;
            let enableLogging = false;

            try {
                if (!node.configNode) throw new Error('Missing Azure configuration');

                // Resolve into local variables, never shared node state, for concurrent messages.
                const valueOf = (property, label) => resolveQueryOption(node, property, msg, label);
                enableLogging = toBoolean(await valueOf('enableLogging', 'Logging'), 'Logging');
                const outputMode = toChoice(
                    await valueOf('outputMode', 'Output value'),
                    'Output value',
                    ['documents', 'response'],
                );

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

                requestBody.queryType = toChoice(
                    await valueOf('querySyntax', 'Query Type'),
                    'Query Type',
                    ['simple', 'full', 'semantic'],
                );
                requestBody.searchMode = toChoice(
                    await valueOf('searchMode', 'Search Mode'),
                    'Search Mode',
                    ['any', 'all'],
                );
                const searchFields = toOptionalString(
                    await valueOf('searchFields', 'Search Fields'),
                    'Search Fields',
                );
                const select = toOptionalString(await valueOf('select', 'Select'), 'Select');
                if (searchFields) requestBody.searchFields = searchFields;
                if (select) requestBody.select = select;
                const filterValue =
                    node.filterType === 'str'
                        ? node.filter
                        : await node.getTypedProperty(node.filter, node.filterType, msg);
                if (
                    filterValue !== undefined &&
                    filterValue !== null &&
                    typeof filterValue !== 'string'
                ) {
                    const err = new Error('Filter must resolve to an OData filter string');
                    err.code = 'FILTER_INVALID';
                    throw err;
                }
                const filter = (filterValue || '').trim();
                if (filter) {
                    requestBody.filter = filter;
                } else if (node.filterType !== 'str') {
                    // Do not silently turn a missing dynamic filter into an unfiltered search.
                    const err = new Error(
                        'Dynamic filter is missing or empty; use an empty string Filter to disable filtering',
                    );
                    err.code = 'FILTER_MISSING';
                    throw err;
                }

                const top = toOptionalInteger(await valueOf('top', 'Top'), 'Top', 1);
                const skip = toOptionalInteger(await valueOf('skip', 'Skip'), 'Skip', 0);
                const timeoutMs = toOptionalInteger(
                    await valueOf('timeoutMs', 'Timeout'),
                    'Timeout',
                    1000,
                );
                if (timeoutMs === undefined) throw new Error('Timeout is required');
                const count = toBoolean(await valueOf('count', 'Total Count'), 'Total Count');
                const semanticConfiguration = toOptionalString(
                    await valueOf('semanticConfiguration', 'Semantic Config'),
                    'Semantic Config',
                );

                if (top !== undefined) requestBody.top = top;
                if (skip !== undefined) requestBody.skip = skip;
                if (count) requestBody.count = true;
                if (semanticConfiguration)
                    requestBody.semanticConfiguration = semanticConfiguration;

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

                if (enableLogging) {
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
                const outputValue = outputMode === 'response' ? responseBody : documents;

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

                if (enableLogging && normalized.requestId) {
                    node.warn(`Azure AI Search request ID: ${normalized.requestId}`);
                }

                if (done) done(normalized);
                else node.error(normalized, msg);
            }
        });
    }

    RED.nodes.registerType('azure-ai-search-query', AzureAiSearchNode);
};
