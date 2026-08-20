# Azure Document Intelligence examples

Examples for the `azure-document-intelligence` node using the shared `azure-auth-config`.

## Before running

1. Open the included **Azure Entra** config node and keep Microsoft Entra ID selected.
2. Replace `https://YOUR-RESOURCE.cognitiveservices.azure.com/` with your Document Intelligence endpoint.
3. Make sure the identity used by Node-RED has permission to call the Document Intelligence resource.
4. Replace the placeholder public document URL or Base64 document data before running the relevant example.

The examples use the node's current default model ID: `prebuilt-document`.

## Examples

- **01 Static URL analysis** — model and public document URL are configured directly on the node.
- **02 Message document URL** — the document URL is resolved from `msg.documentUrl`.
- **03 Dynamic analysis** — analysis parameters are supplied through `msg.document`; this example analyzes page 1.
- **04 Base64 and custom target** — Base64 document input comes from `msg.documentBase64` and the result is written to `msg.result`.

## Dynamic message shape

Example:

```js
msg.document = {
    modelId: 'prebuilt-document',
    data: 'https://example.com/document.pdf',
    inputType: 'url',
    outputContentFormat: 'text',
    pages: '1',
};
```

The endpoint and Azure authentication remain configured on the node/config node.
