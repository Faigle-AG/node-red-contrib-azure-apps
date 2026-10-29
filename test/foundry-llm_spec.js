const assert = require('assert/strict');
const helper = require('node-red-node-test-helper');
const foundryNode = require('../src/foundry-llm.js');
const { trigger, lastStatusText } = require('./helpers/harness');

helper.init(require.resolve('node-red'));

const ENDPOINT = 'https://foundry.example.test';
const API_KEY = 'test-api-key';
const TOKEN = 'test-entra-token';

// Characterization of azure-foundry-llm (Phase 2.3). The real OpenAI SDK builds the request;
// globalThis.fetch is replaced, so nothing leaves the process and no credentials are used.
describe('azure-foundry-llm node', function () {
    let originalFetch;
    let requests;
    let reply;
    let tokenScopes;

    function fakeAuthConfig(RED) {
        function FakeAzureAuthConfigNode(config) {
            RED.nodes.createNode(this, config);
            this.authType = config.authType;
            this.getApiKey = () => API_KEY;
            this.getToken = async (scope) => {
                tokenScopes.push(scope);
                return TOKEN;
            };
        }
        RED.nodes.registerType('azure-auth-config', FakeAzureAuthConfigNode);
    }

    function load(nodeConfig, authType = 'apiKey') {
        const flow = [
            { id: 'f1', type: 'tab' },
            { id: 'cfg', type: 'azure-auth-config', authType },
            {
                id: 'n1',
                z: 'f1',
                type: 'azure-foundry-llm',
                config: 'cfg',
                endpoint: ENDPOINT,
                endpointType: 'str',
                model: 'gpt-test',
                modelType: 'str',
                input: 'payload',
                inputType: 'msg',
                output: 'payload',
                outputType: 'msg',
                outputMode: 'text',
                maxRetries: '0',
                timeoutMs: '',
                wires: [['out']],
                ...nodeConfig,
            },
            { id: 'out', z: 'f1', type: 'helper' },
        ];
        return helper.load([fakeAuthConfig, foundryNode], flow);
    }

    function responseBody(overrides = {}) {
        return {
            id: 'resp_1',
            object: 'response',
            model: 'gpt-test',
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'pong' }] }],
            usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
            ...overrides,
        };
    }

    before(function () {
        originalFetch = globalThis.fetch;
        globalThis.fetch = async (url, init = {}) => {
            requests.push({
                url: String(url),
                method: init.method,
                headers: new Headers(init.headers),
                body: init.body ? JSON.parse(init.body) : undefined,
            });
            const { status, body } = reply();
            return new Response(JSON.stringify(body), {
                status,
                headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' },
            });
        };
    });

    after(function () {
        globalThis.fetch = originalFetch;
    });

    beforeEach(function (done) {
        requests = [];
        tokenScopes = [];
        reply = () => ({ status: 200, body: responseBody() });
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(done);
    });

    it('posts a Responses API request with the API key and writes the text output', async function () {
        await load({ endpoint: `${ENDPOINT}/openai/v1`, instructions: ' Be brief. ' });

        const result = await trigger(
            helper,
            'n1',
            'out',
            { payload: 'hello', topic: 't' },
            { settleMs: 50 },
        );

        assert.equal(requests.length, 1);
        assert.equal(requests[0].method, 'POST');
        assert.equal(requests[0].url, `${ENDPOINT}/openai/v1/responses`);
        assert.equal(requests[0].headers.get('authorization'), `Bearer ${API_KEY}`);
        assert.deepEqual(requests[0].body, {
            model: 'gpt-test',
            input: 'hello',
            instructions: 'Be brief.',
        });
        assert.equal(result.msg.payload, 'pong');
        assert.equal(result.msg.topic, 't');
        assert.equal(result.msg.foundry.id, 'resp_1');
        assert.equal(result.msg.foundry.model, 'gpt-test');
        assert.equal(result.msg.foundry.outputText, 'pong');
        assert.deepEqual(result.msg.foundry.usage, {
            input_tokens: 3,
            output_tokens: 1,
            total_tokens: 4,
        });
        assert.equal(result.msg.foundry.response, undefined);
        assert.equal(lastStatusText(result), 'response received');
        assert.deepEqual(result.extra, { outputs: 0, errors: 0 });
    });

    it('legacy: a bare-host endpoint yields a double slash before /openai/v1', async function () {
        await load({ endpoint: ENDPOINT });

        await trigger(helper, 'n1', 'out', { payload: 'x' });

        assert.equal(requests[0].url, `${ENDPOINT}//openai/v1/responses`);
    });

    it('accepts endpoints that already end in /openai/v1 or /openai/v1/responses', async function () {
        for (const endpoint of [`${ENDPOINT}/openai/v1/`, `${ENDPOINT}/openai/v1/responses`]) {
            helper.unload();
            await load({ endpoint });
            await trigger(helper, 'n1', 'out', { payload: 'x' });
        }

        assert.deepEqual(
            requests.map((request) => request.url),
            [`${ENDPOINT}/openai/v1/responses`, `${ENDPOINT}/openai/v1/responses`],
        );
    });

    it('uses an Entra token for the ai.azure.com audience', async function () {
        await load({}, 'entra');

        await trigger(helper, 'n1', 'out', { payload: 'x' });

        assert.deepEqual(tokenScopes, ['https://ai.azure.com/.default']);
        assert.equal(requests[0].headers.get('authorization'), `Bearer ${TOKEN}`);
    });

    it('writes the full response in response mode and can include it in msg.foundry', async function () {
        await load({ outputMode: 'response', includeRawResponse: true });

        const result = await trigger(helper, 'n1', 'out', { payload: 'x' });

        assert.equal(result.msg.payload.id, 'resp_1');
        assert.equal(result.msg.foundry.response.id, 'resp_1');
    });

    it('legacy: JSON-stringifies object input and decodes Buffer input', async function () {
        await load({});

        await trigger(helper, 'n1', 'out', { payload: { a: 1 } });
        await trigger(helper, 'n1', 'out', { payload: Buffer.from('bytes') });

        assert.equal(requests[0].body.input, '{"a":1}');
        assert.equal(requests[1].body.input, 'bytes');
    });

    it('reports HTTP status failures without sending, adding the audience hint on 401', async function () {
        reply = () => ({ status: 401, body: { error: { message: 'Unauthorized' } } });
        await load({});

        const result = await trigger(helper, 'n1', 'out', { payload: 'x' }, { settleMs: 50 });

        assert.equal(result.err.statusCode, 401);
        assert.match(result.err.message, /audience https:\/\/ai\.azure\.com/);
        assert.equal(result.err.message.includes(API_KEY), false);
        assert.equal(lastStatusText(result), 'HTTP 401');
        assert.deepEqual(result.extra, { outputs: 0, errors: 0 });
    });

    it('fails when text mode receives no text output', async function () {
        reply = () => ({ status: 200, body: responseBody({ output: [] }) });
        await load({});

        const result = await trigger(helper, 'n1', 'out', { payload: 'x' });

        assert.equal(result.err.message, 'Azure Foundry returned no text output');
    });

    it('legacy: validation errors are coded with the error name "Error"', async function () {
        const cases = [
            [{ config: 'missing' }, 'Missing Azure configuration'],
            [{ endpoint: 'http://foundry.example.test' }, 'Foundry endpoint must use HTTPS'],
            [{ model: '' }, 'Model deployment name is missing'],
            [{ temperature: '3' }, 'Temperature must be at most 2'],
        ];
        for (const [config, message] of cases) {
            helper.unload();
            await load(config);
            const result = await trigger(helper, 'n1', 'out', { payload: 'x' });
            assert.equal(result.err.message, message);
            assert.equal(result.err.code, 'Error');
            assert.equal(lastStatusText(result), 'Error');
        }
        assert.equal(requests.length, 0);
    });

    it('rejects configurations whose auth type cannot call Foundry', async function () {
        await load({}, 'sas');

        const result = await trigger(helper, 'n1', 'out', { payload: 'x' });

        assert.match(result.err.message, /requires Entra ID or API key authentication/);
        assert.equal(requests.length, 0);
    });
});
