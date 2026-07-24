'use strict';

module.exports = function (RED) {
    const OpenAIModule = require('openai');
    const { DefaultAzureCredential, getBearerTokenProvider } = require('@azure/identity');
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);

    const OpenAI = OpenAIModule.OpenAI || OpenAIModule.default || OpenAIModule;
    const FOUNDRY_SCOPE = 'https://ai.azure.com/.default';

    function normalizeBaseUrl(value) {
        if (typeof value !== 'string' || !value.trim()) {
            throw new Error('Foundry endpoint is missing');
        }

        let endpoint;
        try {
            endpoint = new URL(value.trim());
        } catch {
            throw new Error('Foundry endpoint must be a valid HTTPS URL');
        }

        if (endpoint.protocol !== 'https:') {
            throw new Error('Foundry endpoint must use HTTPS');
        }

        endpoint.search = '';
        endpoint.hash = '';
        endpoint.pathname = endpoint.pathname.replace(/\/+$/, '');

        if (endpoint.pathname.endsWith('/openai/v1/responses')) {
            endpoint.pathname = endpoint.pathname.slice(0, -'/responses'.length);
        } else if (!endpoint.pathname.endsWith('/openai/v1')) {
            endpoint.pathname += '/openai/v1';
        }

        endpoint.pathname += '/';
        return endpoint.toString();
    }

    function normalizeInput(value) {
        if (value === undefined || value === null) {
            throw new Error('LLM input is missing');
        }

        if (Buffer.isBuffer(value)) return value.toString('utf8');
        if (typeof value === 'string' || Array.isArray(value)) return value;
        if (typeof value === 'object') return JSON.stringify(value);

        return String(value);
    }

    function readOutputText(response) {
        if (response && typeof response.output_text === 'string') {
            return response.output_text;
        }

        const parts = [];
        const outputItems = response && Array.isArray(response.output) ? response.output : [];

        for (const item of outputItems) {
            const contentItems = item && Array.isArray(item.content) ? item.content : [];
            for (const content of contentItems) {
                if (content && typeof content.text === 'string') parts.push(content.text);
            }
        }

        return parts.join('\n');
    }

    function toFiniteNumber(value, name, options) {
        if (value === undefined || value === null || value === '') return undefined;

        const number = Number(value);
        if (!Number.isFinite(number)) throw new Error(`${name} must be a finite number`);
        if (options && options.integer && !Number.isInteger(number)) {
            throw new Error(`${name} must be an integer`);
        }
        if (options && options.min !== undefined && number < options.min) {
            throw new Error(`${name} must be at least ${options.min}`);
        }
        if (options && options.max !== undefined && number > options.max) {
            throw new Error(`${name} must be at most ${options.max}`);
        }

        return number;
    }

    function normalizeSdkError(err) {
        const statusCode = err && (err.status || err.statusCode);
        const requestId = err && (err.request_id || err.requestId || err._request_id);
        const code = err && (err.code || err.type || err.name);
        let message = err && err.message ? err.message : 'Azure Foundry request failed';

        if (statusCode === 401 && !message.includes(FOUNDRY_SCOPE)) {
            message +=
                ` Authentication must use audience ${FOUNDRY_SCOPE.replace('/.default', '')}; ` +
                'verify the endpoint, identity, role assignment, and token validity.';
        }

        const wrapped = new Error(message);
        wrapped.name = (err && err.name) || 'AzureFoundryError';
        wrapped.statusCode = statusCode;
        wrapped.code = code;
        wrapped.requestId = requestId;
        wrapped.cause = err;

        if (err && err.error) wrapped.details = err.error;
        else if (err && err.body) wrapped.details = err.body;

        return wrapped;
    }

    function AzureFoundryLlmNode(config) {
        RED.nodes.createNode(this, config);

        this.name = config.name;
        this.authType = config.authType || 'entra';
        this.endpoint = config.endpoint;
        this.endpointType = config.endpointType || 'str';
        this.model = config.model;
        this.modelType = config.modelType || 'str';
        this.instructions = config.instructions;
        this.instructionsType = config.instructionsType || 'str';
        this.input = config.input || 'payload';
        this.inputType = config.inputType || 'msg';
        this.output =
            typeof config.output === 'string' && config.output.trim()
                ? config.output.trim()
                : 'payload';
        this.outputType =
            typeof config.outputType === 'string' && config.outputType.trim()
                ? config.outputType
                : 'msg';
        this.outputMode = config.outputMode || 'text';
        this.maxOutputTokens = config.maxOutputTokens;
        this.temperature = config.temperature;
        this.maxRetries = config.maxRetries === '' ? 4 : config.maxRetries;
        this.timeoutMs = config.timeoutMs === '' ? 120000 : config.timeoutMs;
        this.includeRawResponse = config.includeRawResponse === true;
        this.enableLogging = config.enableLogging === true;

        const node = this;
        extendNode(node);

        const credential = node.authType === 'entra' ? new DefaultAzureCredential() : null;
        const tokenProvider = credential ? getBearerTokenProvider(credential, FOUNDRY_SCOPE) : null;

        node.on('input', async function (msg, send, done) {
            try {
                node.status.processing('calling Azure Foundry');

                const endpointValue = await node.getTypedProperty(
                    node.endpoint,
                    node.endpointType,
                    msg,
                );
                const modelValue = await node.getTypedProperty(node.model, node.modelType, msg);
                const inputValue = await node.getTypedProperty(node.input, node.inputType, msg);
                const instructionsValue = node.instructions
                    ? await node.getTypedProperty(node.instructions, node.instructionsType, msg)
                    : undefined;

                const baseURL = normalizeBaseUrl(endpointValue);
                const model = String(modelValue || '').trim();
                if (!model) throw new Error('Model deployment name is missing');

                const input = normalizeInput(inputValue);
                const maxOutputTokens = toFiniteNumber(node.maxOutputTokens, 'Max output tokens', {
                    integer: true,
                    min: 1,
                });
                const temperature = toFiniteNumber(node.temperature, 'Temperature', {
                    min: 0,
                    max: 2,
                });
                const maxRetries = toFiniteNumber(node.maxRetries, 'Max retries', {
                    integer: true,
                    min: 0,
                    max: 10,
                });
                const timeout = toFiniteNumber(node.timeoutMs, 'Timeout', {
                    integer: true,
                    min: 1000,
                });

                const requestBody = {
                    model,
                    input,
                };

                if (instructionsValue !== undefined && instructionsValue !== null) {
                    const instructions = String(instructionsValue).trim();
                    if (instructions) requestBody.instructions = instructions;
                }
                if (maxOutputTokens !== undefined) {
                    requestBody.max_output_tokens = maxOutputTokens;
                }
                if (temperature !== undefined) requestBody.temperature = temperature;

                let apiKey;
                if (node.authType === 'apiKey') {
                    apiKey = node.credentials && node.credentials.apiKey;
                    if (!apiKey) throw new Error('Azure Foundry API key is missing');
                } else {
                    apiKey = await tokenProvider();
                    if (!apiKey) {
                        throw new Error('DefaultAzureCredential did not return an access token');
                    }
                }

                const client = new OpenAI({
                    baseURL,
                    apiKey,
                    maxRetries,
                    timeout,
                });

                if (node.enableLogging) {
                    const inputSize =
                        typeof input === 'string' ? input.length : JSON.stringify(input).length;
                    node.log(
                        `Calling Azure Foundry model '${model}' with ${inputSize} input characters ` +
                            `(maxRetries=${maxRetries}, timeoutMs=${timeout})`,
                    );
                }

                const response = await client.responses.create(requestBody);
                const outputText = readOutputText(response);

                if (node.outputMode === 'text' && !outputText) {
                    throw new Error('Azure Foundry returned no text output');
                }

                const outputValue = node.outputMode === 'response' ? response : outputText;

                if (!node.output || typeof node.output !== 'string') {
                    const outputError = new Error('Output target property is missing');
                    outputError.code = 'OUTPUT_TARGET_MISSING';
                    throw outputError;
                }

                await node.setTypedProperty(node.output, node.outputType, msg, outputValue);

                msg.foundry = {
                    id: response.id,
                    requestId: response._request_id,
                    model: response.model || model,
                    status: response.status,
                    usage: response.usage,
                    outputText,
                    maxRetries,
                    timeoutMs: timeout,
                };

                if (node.includeRawResponse) msg.foundry.response = response;

                send(msg);
                if (done) done();

                node.status.succeeded('response received', {
                    next: () => node.status.waiting('waiting for input'),
                });
            } catch (err) {
                const normalized = normalizeSdkError(err);
                const statusText = normalized.statusCode
                    ? `HTTP ${normalized.statusCode}`
                    : normalized.code || normalized.message || 'Azure Foundry error';

                node.status.failed(statusText);

                if (node.enableLogging && normalized.requestId) {
                    node.warn(`Azure Foundry request ID: ${normalized.requestId}`);
                }

                if (done) done(normalized);
                else node.error(normalized, msg);
            }
        });
    }

    RED.nodes.registerType('foundry-llm', AzureFoundryLlmNode, {
        credentials: {
            apiKey: { type: 'password' },
        },
    });
};
