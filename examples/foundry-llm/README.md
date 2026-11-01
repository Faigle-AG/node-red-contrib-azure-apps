# Azure Foundry LLM examples

Examples for the `azure-foundry-llm` node with the shared `azure-auth-config`.

## Before running

Each example imports as its own **disabled** tab. Its configuration node is on the same tab.

1. Before you start Node-RED, set:
    - `NODE_RED_EXAMPLE_AZURE_FOUNDRY_ENDPOINT`: your Microsoft Foundry project endpoint (for example `https://<resource>.services.ai.azure.com/api/projects/<project>`);
    - `NODE_RED_EXAMPLE_AZURE_FOUNDRY_MODEL`: the name of your model deployment.

    If a variable is unset, the node reports what is missing and sends no request.

2. Set up authentication (see below).
3. Enable the tab, deploy, then click the example's button. Each click invokes the model once through the SDK; the SDK may retry (these examples allow up to 4 retries), and service usage may incur charges.

## Authentication

Examples 01–03 use **Microsoft Entra ID** through **EDIT ME: example Foundry identity**. It uses whatever identity the Node-RED process can obtain: environment variables, managed identity, or an Azure CLI login. Run Node-RED under a **dedicated test identity** that has access to that project only.

Example 04 uses **API key** authentication. After importing it:

1. Open **EDIT ME: example Foundry API key**.
2. Enter the API key in the credential field.
3. Deploy the flow.

No example contains a key or secret.

## Examples

- **01 Static prompt**: sends `msg.payload` with fixed instructions, and writes the answer text to `msg.payload`.
- **02 Message input and custom output**: sends `msg.question` (temperature 0.2, at most 400 output tokens) and writes the answer text to `msg.answer`.
- **03 Message configuration**: the Inject node fills `msg.foundryEndpoint` and `msg.foundryModel` from the same two variables, plus `msg.systemPrompt` and the question. The node reads all of them from the message.
- **04 API key and full response**: uses API-key authentication and output mode `response`. The complete response object is written to `msg.result`, and with **Include Raw Response** on it is also kept in `msg.foundry.response`.

The node also writes request metadata to `msg.foundry`.

**The Debug nodes of 03 and 04 show the complete message.** In 04 that includes the raw model response and its metadata. Use synthetic prompts, and do not share the editor or its Debug output if your prompts are sensitive.

## Effects and cleanup

The flows provision no Azure resource. The node sends no `store` option, so whether the service keeps requests or responses follows the service's own settings. These flows do not delete service-retained data; manage retention and any cleanup through the service.

## Not verified

- A real Foundry project, deployment or model output, SDK retries and charges: the tests fake the SDK client and the identity.
- Behaviour in the Node-RED editor.
