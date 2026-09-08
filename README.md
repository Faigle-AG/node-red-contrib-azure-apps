# @faigle/node-red-contrib-azure-apps

A collection of Node-RED nodes for interacting with Microsoft Azure services, including Microsoft Graph email operations, Azure Document Intelligence, Azure AI Foundry language models, and Azure AI Search.

The Azure nodes use `@azure/identity` and `DefaultAzureCredential`, enabling the same configuration to run locally with environment variables or Azure CLI credentials and in Azure with managed identity or workload identity. The Foundry LLM and Azure AI Search nodes also support API-key authentication.

## Requirements

- Node.js 20 or later
- Node-RED
- Access to the Azure resources used by the configured nodes

## Installation

Run the following command in your Node-RED user directory (typically `~/.node-red`):

```bash
npm install @faigle/node-red-contrib-azure-apps
```

## Azure Portal Setup

To authenticate using a Service Principal, configure the required resources and permissions in the Azure Portal:

### 1. Create an App Registration

1. Navigate to **Microsoft Entra ID** > **App registrations** > **New registration**.
2. Provide a name and register the application.
3. From the **Overview** page, copy the **Application (client) ID** and **Directory (tenant) ID**.
4. Navigate to **Certificates & secrets** > **New client secret**, generate a secret, and copy the **Value**.

### 2. Configure Microsoft Graph API Permissions

1. In your App Registration, navigate to **API permissions** > **Add a permission** > **Microsoft Graph** > **Application permissions**.
2. Select the required permissions based on the nodes you use:
    - `Mail.Read` (for `azure-email-read`)
    - `Mail.ReadWrite` (for `azure-email-transfer`)
    - `Mail.Send` (for `azure-email-write`)
3. Click **Grant admin consent for [Your Tenant]** to activate the permissions.

### 3. Configure Document Intelligence RBAC Role

1. Navigate to your **Document Intelligence** resource in the Azure Portal.
2. Select **Access control (IAM)** > **Add** > **Add role assignment**.
3. Select the **Cognitive Services User** role.
4. Assign access to **User, group, or service principal**, and select your App Registration.

### 4. Configure Azure AI Foundry RBAC

For Microsoft Entra ID authentication:

1. Navigate to the relevant **Azure AI Foundry account or project**.
2. Select **Access control (IAM)** > **Add** > **Add role assignment**.
3. Assign the **Foundry User** role to the managed identity, workload identity, user, or service principal used by Node-RED.
4. Ensure that the identity can access the model deployment configured in the node.

The Foundry node requests access tokens for:

```text
https://ai.azure.com/.default
```

API-key authentication can be selected directly in the node editor and does not use `DefaultAzureCredential`.

### 5. Configure Azure AI Search RBAC

For Microsoft Entra ID authentication, assign roles on the **Azure AI Search service** according to the operations used by Node-RED:

- **Search Index Data Reader** — query/search documents.
- **Search Index Data Contributor** — upload, merge, merge-or-upload, and delete documents.
- **Search Service Contributor** — create, update, read, and delete index definitions.

The Azure AI Search nodes request access tokens for:

```text
https://search.azure.com/.default
```

For API-key authentication:

- Query operations can use a query key or admin key.
- Document synchronization and index-management operations require an admin key.

The shared `azure-auth-config` node can be reused for Azure AI Search. No Search-specific authentication configuration is required.

---

## Authentication Configuration (.env Setup)

When running Node-RED locally or outside of Azure infrastructure, configure `DefaultAzureCredential` using environment variables.

### 1. Create the `.env` File

Create a `.env` file in your Node-RED user directory (`~/.node-red/.env`) with the credentials obtained from the Azure Portal:

```env
AZURE_TENANT_ID="your-directory-tenant-id"
AZURE_CLIENT_ID="your-application-client-id"
AZURE_CLIENT_SECRET="your-client-secret-value"
```

### 2. Load Environment Variables in Node-RED

Open your Node-RED configuration file (`~/.node-red/settings.js`) and add the following line to the very top of the file:

```javascript
require('dotenv').config();
```

Restart your Node-RED server to apply the credentials. Alternatively, you can authenticate locally by running `az login` in your terminal prior to starting Node-RED.

---

## Included Nodes

### 1. azure-document-intelligence

Analyzes documents using Azure Document Intelligence REST API version `2024-11-30`.

- **Endpoint URL:** Enter only the Azure resource endpoint, for example `https://<resource-name>.cognitiveservices.azure.com/`. Do not append `/formrecognizer` or `/documentintelligence`; the node builds the v4 route `/documentintelligence/documentModels/{modelId}:analyze`.
- **Model / Prompt:** The model ID to use, such as `prebuilt-layout`, `prebuilt-read`, `prebuilt-invoice`, `prebuilt-receipt`, `prebuilt-idDocument`, or a custom model ID.
- **General document extraction:** `prebuilt-document` is not available in v4. Use `prebuilt-layout`. Add the `keyValuePairs` feature when general key/value extraction is required.
- **Document Data:** An HTTP/HTTPS URL string, Base64 string, or binary Buffer.
- **Input Format:** Specify how to interpret the incoming data (`auto`, `buffer`, `base64`, or `url`).
- **Content Format:** Select `text` or `markdown`.
- **Advanced Parameters:** Supports `pages`, `locale`, `stringIndexType`, `features`, `queryFields`, and additional outputs such as `pdf` or `figures`.
- **Dynamic Mode:** Override settings through `msg.document`, including `modelId`, `data`, `inputType`, `outputContentFormat`, `pages`, `locale`, `stringIndexType`, `features`, `queryFields`, and `outputOptions`.

Example for general document extraction:

```text
Model / Prompt: prebuilt-layout
Features: keyValuePairs
```

Leave **Features** empty when only text, tables, structure, and layout information are required.

### 2. azure-email-read

Reads emails from a selected Microsoft 365 mail folder. The node editor provides a folder dropdown that can load the complete mailbox folder hierarchy, including nested and hidden folders.

- **User ID / Email:** The UserPrincipalName or Azure Object ID of the target mailbox. The value can be configured as `str`, `env`, `msg`, `flow`, `global`, or `jsonata`.
- **Mail Folder:** Select the folder to read from the dropdown. The refresh button loads all root and nested folders and displays their hierarchy as paths such as `Projects › Customer A`.
- **Email Count:** Maximum number of emails to retrieve. The accepted range is `1` to `1000`; Microsoft Graph pagination is followed until the requested count is reached or no additional messages are available.
- **Include Attachments:** Expands the Graph API request to include attachments.
- **Output To:** Stores the result in the configured `msg`, `flow`, or `global` property.
- **Dynamic Mode:** Override the read options through `msg.email.folderId`, `msg.email.folderName`, `msg.email.limit`, and `msg.email.downloadAttachments`.

#### Folder dropdown

The dropdown is populated through Microsoft Graph when the editor opens and when the refresh button is selected.

Folder loading in the editor requires **User ID / Email** to use the static `str` type because `msg`, `flow`, `global`, `env`, and JSONata values are not resolved in the Node-RED editor. Runtime email reading still supports all configured typed-input sources.

The folder list includes:

- Root mail folders
- Nested child folders at every depth
- Hidden folders
- Folder paths, IDs, parent IDs, child-folder counts, total item counts, and unread item counts

The selected Microsoft Graph folder ID is saved in `folderId`. The displayed folder path is saved in `folderName`.

#### Dynamic input example

Enable **Load from msg.email** and send:

```javascript
msg.email = {
    folderId: 'AAMkAG...',
    folderName: 'Projects › Customer A',
    limit: 25,
    downloadAttachments: true,
};

return msg;
```

`folderId` is required to select a custom folder dynamically. When it is empty or omitted, the node defaults to the well-known `inbox` folder.

#### Output

The configured output property contains:

```javascript
{
    action: 'read',
    userId: 'user@domain.com',
    folderId: 'AAMkAG...',
    folderName: 'Projects › Customer A',
    count: 25,
    list: [],
}
```

`list` contains the Microsoft Graph message objects returned from the selected folder.

### 3. azure-email-write

Sends an HTML or plain text email from a specified user's mailbox.

- **User ID / Email:** The sender's UserPrincipalName or Azure Object ID.
- **To:** A comma-separated string, a single recipient object (`{ name: "...", address: "..." }`), or an array of recipient objects.
- **Subject:** The subject line.
- **Body:** The HTML or plain text content.
- **Attachments:** An optional array of objects containing `name` and `content` (Buffer or Base64 string).
- **Dynamic Mode:** Override UI properties via `msg.email.to`, `msg.email.subject`, `msg.email.body`, and `msg.email.attachments`.

### 4. azure-email-transfer

Moves an existing email to a selected Microsoft 365 mail folder. The destination is selected from a dropdown containing the mailbox folder hierarchy.

- **User ID / Email:** The UserPrincipalName or Azure Object ID of the mailbox. The value can be configured as `str`, `env`, `msg`, `flow`, `global`, or `jsonata`.
- **Message ID:** The Microsoft Graph message ID to move. The value can be configured as `str`, `msg`, `flow`, `global`, `jsonata`, or `env`.
- **Dest. Folder:** Select the target folder from the dropdown. The refresh button loads root, nested, and hidden mail folders and displays their paths, such as `Projects › Customer A`.
- **Dynamic Mode:** Override the transfer properties through `msg.email.messageId`, `msg.email.destinationId`, and optionally `msg.email.destinationName`.

#### Destination-folder dropdown

The dropdown is populated through Microsoft Graph when the editor opens and when the refresh button is selected.

Folder loading in the editor requires **User ID / Email** to use the static `str` type. Other typed-input values are resolved only when the deployed node receives a message.

The selected Microsoft Graph folder ID is saved in `destinationId`. Its displayed path is saved in `destinationName`. Folder discovery follows Microsoft Graph pagination and recursively loads child folders.

The `/email-transfer/folders` admin endpoint is protected by the Node-RED `email-transfer.read` permission. Microsoft Graph authentication remains in the Node-RED runtime and is not exposed to the editor browser.

#### Dynamic input example

Enable **Load from msg.email** and send:

```javascript
msg.email = {
    messageId: 'AAMkAG...',
    destinationId: 'AAMkAG...',
    destinationName: 'Projects › Customer A',
};

return msg;
```

`destinationId` is required in dynamic mode. It may contain a Microsoft Graph folder ID or a supported well-known folder name such as `archive` or `deleteditems`. `destinationName` is optional and descriptive only.

#### Output

The node merges the transfer result into `msg.email`:

```javascript
msg.email = {
    action: 'transfer',
    messageId: 'AAMkAG...',
    destinationId: 'AAMkAG...',
    destinationName: 'Projects › Customer A',
    apiResponse: {},
};
```

`apiResponse` contains the Microsoft Graph message object returned by the move operation.

### 5. azure-foundry-llm

Calls a deployed language model through the Azure AI Foundry **Responses API**.

The runtime uses:

- the `openai` JavaScript SDK for `client.responses.create()`
- `@azure/identity` for Microsoft Entra ID authentication
- SDK-managed connection and HTTP retries
- a configurable overall request timeout

#### Configuration

- **Authentication:** Microsoft Entra ID or API key.
- **Endpoint:** A Foundry resource endpoint or project endpoint.
- **Model:** The deployed model name.
- **Instructions:** Optional system-level instructions.
- **Input:** A typed Node-RED value containing the prompt, Responses API input array, buffer, or JSON object.
- **Max Tokens:** Optional `max_output_tokens` value.
- **Temperature:** Optional value from `0` to `2`. Leave it empty when the selected model does not accept temperature.
- **Max Retries:** Number of SDK retries. The default is `4`.
- **Timeout:** Overall request timeout in milliseconds. The default is `120000`.
- **Output Value:** Generated text or the complete Responses API object.
- **Output To:** A `msg`, `flow`, or `global` property.
- **Include Raw Response:** Adds the complete response to `msg.foundry.response`.
- **Enable Logging:** Logs request metadata without logging authentication secrets.

#### Endpoint examples

Resource endpoint:

```text
https://<resource-name>.services.ai.azure.com
```

Project endpoint:

```text
https://<resource-name>.services.ai.azure.com/api/projects/<project-name>
```

The node normalizes either form to an `/openai/v1/` base URL.

#### Input handling

Strings and Responses API input arrays are sent directly. Buffers are converted to UTF-8. Other objects, including Azure Document Intelligence output, are serialized as JSON.

Example configuration for a Document Intelligence result:

```text
Input:  msg.document.content
Output: msg.payload
```

#### Output metadata

The incoming message is preserved. The selected result is written to the configured output, and request metadata is added to:

```javascript
msg.foundry = {
    id,
    requestId,
    model,
    status,
    usage,
    outputText,
};
```

When **Include Raw Response** is enabled:

```javascript
msg.foundry.response;
```

contains the complete Responses API result.

#### Retry behavior

The OpenAI SDK retries transient connection failures and retryable HTTP responses, including:

- `408 Request Timeout`
- `409 Conflict`
- `429 Too Many Requests`
- `5xx` server errors

Retries use exponential backoff. **Max Retries** controls the number of additional attempts. The timeout applies to each SDK request lifecycle.

#### Authentication examples

Local Azure CLI authentication:

```bash
az login
az account get-access-token --scope https://ai.azure.com/.default
```

Service-principal environment variables:

```env
AZURE_TENANT_ID="your-directory-tenant-id"
AZURE_CLIENT_ID="your-application-client-id"
AZURE_CLIENT_SECRET="your-client-secret-value"
```

### 6. azure-ai-search-index

Creates, updates, reads, or deletes Azure AI Search index definitions.

#### Configuration

- **Azure Config:** Shared `azure-auth-config` node using Microsoft Entra ID or an API key.
- **Endpoint:** Azure AI Search service endpoint, for example `https://<search-service>.search.windows.net`.
- **Index Name:** Name of the index, for example `customers`.
- **Operation:** Create/update, get definition, or delete.
- **Definition:** The Azure AI Search index schema. For create/update operations this must contain a non-empty `fields` array with exactly one field marked as `key: true`.
- **Output To:** A `msg`, `flow`, or `global` property.
- **Timeout:** Request timeout in milliseconds.

Example index definition:

```json
{
    "name": "customers",
    "fields": [
        {
            "name": "id",
            "type": "Edm.String",
            "key": true,
            "filterable": true
        },
        {
            "name": "first_name",
            "type": "Edm.String",
            "searchable": true,
            "analyzer": "en.microsoft"
        },
        {
            "name": "last_name",
            "type": "Edm.String",
            "searchable": true,
            "analyzer": "en.microsoft"
        }
    ]
}
```

The document-upload API does not create missing indexes automatically. Create the index first with this node or another Azure management mechanism.

### 7. azure-ai-search-sync

Uploads and synchronizes documents with an existing Azure AI Search index.

#### Supported actions

- `upload` — create a document or replace the existing document with the same key.
- `merge` — update only the supplied fields of an existing document.
- `mergeOrUpload` — update an existing document or create it if it does not exist. This is the recommended default for synchronization.
- `delete` — delete documents by key.

#### Configuration

- **Azure Config:** Shared `azure-auth-config` node using Microsoft Entra ID or an admin API key.
- **Endpoint:** Azure AI Search service endpoint.
- **Index Name:** Existing target index.
- **Documents:** A single document, an array of documents, or an object containing a `value` array.
- **Action:** Index action applied to documents that do not already contain `@search.action`.
- **Batch Size:** Maximum documents per request. Azure AI Search accepts at most 1,000 documents in a single indexing batch.
- **Fail on Document Error:** Treat an individual document failure in the Azure batch response as a Node-RED error.
- **Output Mode:** Summary or complete indexing result.
- **Timeout:** Request timeout in milliseconds.

Example message:

```javascript
msg.customers = {
    value: [
        {
            id: 'K0001',
            customer_number: 'K-100001',
            first_name: 'Anna',
            last_name: 'Keller',
            insurance_number: 'INS-100001',
            policy_id: 'POL-100001',
            customer_status: 'active',
        },
    ],
};

return msg;
```

With **Action** set to `mergeOrUpload`, the node adds the required indexing action before sending the request.

Delete example:

```javascript
msg.documentsToDelete = [{ id: 'K0001' }];

return msg;
```

Set **Action** to `delete`.

### 8. azure-ai-search-query

Queries documents in an existing Azure AI Search index.

#### Configuration

- **Azure Config:** Shared `azure-auth-config` node using Microsoft Entra ID or an API key.
- **Endpoint:** Azure AI Search service endpoint.
- **Index Name:** Index to search.
- **Query:** Search text. The value can be configured as a typed Node-RED input.
- **Query Syntax:** Simple or full query syntax, depending on the node configuration.
- **Search Mode:** Controls whether any or all search terms must match.
- **Search Fields:** Optional comma-separated list of searchable fields.
- **Select:** Optional comma-separated list of fields returned in each document.
- **Filter:** Optional OData filter expression.
- **Top / Skip:** Result paging controls.
- **Count:** Include the total matching document count.
- **Semantic Configuration:** Optional semantic-search configuration name.
- **Additional Parameters:** Optional JSON object merged into the Azure Search request for advanced parameters.
- **Output Mode:** Matching documents only or the complete Azure Search response.
- **Output To:** A `msg`, `flow`, or `global` property.

Simple message-driven query:

```javascript
msg.searchText = 'Anna Keller';
return msg;
```

Example node settings:

```text
Query:         msg.searchText
Search Fields: first_name,last_name,customer_number,insurance_number,policy_id,notes
Top:           10
Output To:     msg.searchResults
```

Filtered query example:

```text
Query:  *
Filter: customer_status eq 'active' and risk_class eq 'low'
Select: id,customer_number,first_name,last_name,insurance_type,customer_status,risk_class
Count:  enabled
```

Advanced parameters can also be supplied dynamically:

```javascript
msg.searchOptions = {
    filter: "insurance_type eq 'Household contents insurance'",
    select: 'id,customer_number,first_name,last_name,policy_id,insurance_type',
    count: true,
    top: 5,
};

return msg;
```

Configure **Additional Parameters** as `msg.searchOptions`.

#### Typical flow

A complete provisioning and data flow is:

```text
AI Search - Index
    create/update index definition
        ↓
AI Search - Sync
    mergeOrUpload documents
        ↓
AI Search - Query
    search the indexed documents
```

The index schema and documents must use the same field names and compatible Azure Search data types.

---

## Troubleshooting

- **Error 401: Unauthorized / PermissionDenied:** Ensure Node-RED was restarted after updating token permissions or `.env` variables. Verify the App Registration is assigned the **Cognitive Services User** role.
- **Error 403: Forbidden (Graph API):** Ensure **Application permissions** (not Delegated) were granted and admin consent was executed in Entra ID.
- **Mail Folder dropdown does not load:** Configure **User ID / Email** as a static `str` value, verify that `DefaultAzureCredential` can authenticate, and confirm that the identity has the Microsoft Graph `Mail.Read` application permission with admin consent.
- **Mail Folder dropdown shows an error:** Check the Node-RED runtime log for the Microsoft Graph response. The folder-discovery request runs through the protected `/azure-email-read/folders` admin endpoint.
- **Previously selected folder is unavailable:** Reload the dropdown. If the folder was deleted or its ID changed, select the folder again; the node falls back to `inbox` only when no folder ID is supplied.
- **Dynamic folder selection reads the Inbox:** Ensure `msg.email.folderId` contains the Microsoft Graph folder ID, not only its display name or path.
- **Destination Folder dropdown does not load:** Configure **User ID / Email** as a static `str` value, verify that `DefaultAzureCredential` can authenticate, and confirm that the identity has the Microsoft Graph `Mail.ReadWrite` application permission with admin consent.
- **Destination Folder dropdown shows an error:** Check the Node-RED runtime log for the Microsoft Graph response. The transfer folder-discovery request runs through the protected `/email-transfer/folders` admin endpoint.
- **Previously selected transfer destination is unavailable:** Reload the dropdown. If the folder was deleted or its ID changed, select it again before deploying the flow.
- **Dynamic transfer reports Destination Folder ID is missing:** Ensure `msg.email.destinationId` contains a Microsoft Graph folder ID or supported well-known folder name. `msg.email.destinationName` is descriptive only and cannot replace the ID.
- **Error InvalidIdMalformed:** Verify you are passing the Graph API Object ID (`id`), not the header `internetMessageId`, and strip any whitespace.
- **Document Intelligence 404 Resource not found:** Verify that the endpoint is the base resource endpoint and that the node uses `/documentintelligence/documentModels/...` with API version `2024-11-30`.
- **Document Intelligence ModelNotFound:** Verify the exact model ID and resource. For v4 general document extraction, replace `prebuilt-document` with `prebuilt-layout`; add `features=keyValuePairs` when key/value pairs are required.
- **Custom Document Intelligence model not found:** Custom models are resource-specific. Confirm that the model exists in the same Azure resource referenced by the configured endpoint.

- **Foundry 401 Unauthorized:** Verify the endpoint, model deployment, identity, role assignment, and token audience. Entra ID authentication must request `https://ai.azure.com/.default`.
- **Foundry ConnectTimeoutError:** Increase the node timeout, keep retries enabled, and verify DNS, proxy, firewall, private endpoint, and outbound network connectivity from the Node-RED host or container.
- **Foundry 429 or 5xx:** The SDK retries these responses automatically. Reduce concurrency or increase **Max Retries** when throttling persists.
- **Foundry model rejects temperature:** Clear the **Temperature** field for reasoning models or deployments that do not support it.

- **Azure AI Search 403 when managing indexes:** For Microsoft Entra ID, assign **Search Service Contributor** to the identity used by `DefaultAzureCredential`. For API-key authentication, use an admin key rather than a query key.
- **Azure AI Search 403 when synchronizing documents:** For Microsoft Entra ID, assign **Search Index Data Contributor**. For API-key authentication, use an admin key.
- **Azure AI Search 403 when querying:** For Microsoft Entra ID, assign **Search Index Data Reader** or a role with broader Search data-plane permissions.
- **Azure AI Search index not found:** The Sync and Query nodes require an existing index. Create it first with `azure-ai-search-index`.
- **Azure AI Search Sync succeeds but no documents appear:** Inspect the Sync node output and verify the per-document results. Query the index directly with `search: "*"` and `count: true`; Azure Portal index statistics can lag behind actual indexing.
- **Azure AI Search request timeout:** Increase the node timeout and verify DNS, proxy, firewall, private endpoint, and outbound connectivity from the Node-RED runtime.
