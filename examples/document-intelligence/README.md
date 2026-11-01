# Azure Document Intelligence examples

Examples for the `azure-document-intelligence` node with the shared `azure-auth-config`.

## Before running

Each example imports as its own **disabled** tab. Its configuration nodes are on the same tab.

1. Before you start Node-RED, set `NODE_RED_EXAMPLE_AZURE_DOCUMENT_ENDPOINT` to your Document Intelligence endpoint (for example `https://<resource>.cognitiveservices.azure.com/`). Also set these variables where an example needs them:
    - 02 and 03: `NODE_RED_EXAMPLE_AZURE_DOCUMENT_URL`, the URL of a document that Azure can fetch and that you may send to Azure;
    - 01: `NODE_RED_EXAMPLE_AZURE_FILES_URL`, your storage account file endpoint (for example `https://<account>.file.core.windows.net`), and `NODE_RED_EXAMPLE_AZURE_SHARE`, a disposable share that holds the PDF you want analyzed at `examples/sample.pdf`.

    If a variable is unset, the node that needs it reports what is missing and makes no request.

2. The authentication node **EDIT ME: example Document Intelligence identity** uses **Microsoft Entra ID**, because the node requests Entra tokens only. It uses whatever identity the Node-RED process can obtain: environment variables, managed identity, or an Azure CLI login. Run Node-RED under a **dedicated test identity** that has access to that resource only. No example contains a secret.
3. 01 only: the file configuration **EDIT ME: example file share** reads the share endpoint from `NODE_RED_EXAMPLE_AZURE_FILES_URL`. Open its authentication node **EDIT ME: example storage authentication** and enter a SAS token for the share.
4. Enable the tab, deploy, then click the example's button.

Configure everything first. A node checks its fields when the flow reaches it, so earlier steps of a click may already have run. In 01, for example, the share may already have been read. Nothing is rolled back.

The model is not a variable. Every example uses `prebuilt-layout`: set on the node in 01, 02 and 04, and in `msg.document` in 03.

## Examples

- **01 Static URL analysis**: reads `examples/sample.pdf` from your share and sends its bytes to the model, with Markdown output. Despite the filename, the flow sends the file bytes, not a URL.
- **02 Message document URL**: the Inject node puts the URL from `NODE_RED_EXAMPLE_AZURE_DOCUMENT_URL` into `msg.documentUrl`, and Azure fetches and analyzes it.
- **03 Dynamic analysis**: with **Dynamic** on, `msg.document` supplies the model, the document URL, text output and page 1.
- **04 Base64 and custom target**: the Inject node carries a small one-page PDF with synthetic text as Base64 in `msg.documentBase64`. The result is written to `msg.result`.

The result arrives after Azure finishes, and the node polls every 2 seconds.

## Dynamic message shape

Example 03 builds `msg.document` with this JSONata expression in its Inject node:

```
{"modelId": "prebuilt-layout", "data": $env("NODE_RED_EXAMPLE_AZURE_DOCUMENT_URL"), "inputType": "url", "outputContentFormat": "text", "pages": "1"}
```

The endpoint and the Azure authentication stay configured on the node and its configuration node.

## Cleanup

The flows provision no Azure resource. Each analysis runs as an operation in the service, which keeps its result and bills it under its own rules. These flows do not remove either. Remove the sample document from your share, or from the URL, if you placed it there for these examples.

## Not verified

- A real Document Intelligence resource or model.
- Whether Azure accepts a particular document, and what it extracts. The tests fake Azure and the identity, and treat documents as opaque bytes.
- Behaviour in the Node-RED editor.
