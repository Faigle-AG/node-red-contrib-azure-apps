# Azure Foundry LLM examples

Examples for the `foundry-llm` node using the shared `azure-config`.

## Before running

Replace these placeholders in each imported flow:

- `https://YOUR-RESOURCE.services.ai.azure.com/api/projects/YOUR-PROJECT`
- `YOUR-MODEL-DEPLOYMENT`

The node accepts the project endpoint and deployment/model name through typed inputs.

## Authentication

Examples 01–03 use **Microsoft Entra ID** through `azure-config`.

Example 04 uses **API key** authentication. After importing it:

1. Open the **EDIT: Azure API Key** config node.
2. Enter the API key in the credential field.
3. Deploy the flow.

The API key is intentionally not embedded in the exported example.

## Examples

- **01 Static prompt** — static endpoint/model/instructions, with the user prompt in `msg.payload`.
- **02 Message input and custom output** — reads `msg.question` and writes the text response to `msg.answer`.
- **03 Message configuration** — endpoint, model, and instructions are all resolved from message properties.
- **04 API key and full response** — demonstrates API-key authentication and `outputMode: response`; the complete response is written to `msg.result`.

The node also writes request metadata to `msg.foundry`. When **Include Raw Response** is enabled, the raw response is additionally available under `msg.foundry.response`.
