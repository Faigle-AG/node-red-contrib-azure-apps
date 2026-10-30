# @faigle/node-red-contrib-azure-apps

A collection of Node-RED nodes for interacting with Microsoft Azure services, including Azure Files storage, Microsoft Graph email operations, Azure Document Intelligence, Azure AI Foundry language models, and Azure AI Search.

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
- a configurable timeout passed to the SDK (not a node-wide end-to-end deadline)

#### Configuration

- **Authentication:** Microsoft Entra ID or API key.
- **Endpoint:** A Foundry resource endpoint or project endpoint.
- **Model:** The deployed model name.
- **Instructions:** Optional system-level instructions.
- **Input:** A typed Node-RED value containing the prompt, Responses API input array, buffer, or JSON object.
- **Max Tokens:** Optional `max_output_tokens` value.
- **Temperature:** Optional value from `0` to `2`. Leave it empty when the selected model does not accept temperature.
- **Max Retries:** Number of SDK retries. The default is `4`.
- **Timeout:** SDK request timeout in milliseconds. The editor default is `120000`; retries can make total elapsed time longer.
- **Output Value:** Generated text or the complete Responses API object.
- **Output To:** A `msg`, `flow`, or `global` property.
- **Include Raw Response:** Adds the complete response to `msg.foundry.response`.
- **Enable Logging:** Logs model, input-size and retry/timeout metadata. Error messages and SDK causes are separate diagnostic paths; do not assume all error content is credential-redacted.

#### Endpoint examples

Prefer an explicit API base to avoid the legacy bare-host normalization behavior.

Resource API base:

```text
https://<resource-name>.services.ai.azure.com/openai/v1
```

Project API base:

```text
https://<resource-name>.services.ai.azure.com/api/projects/<project-name>/openai/v1
```

A base already ending in `/openai/v1` or `/openai/v1/responses` is accepted. A project path without the suffix has `/openai/v1/` appended. A bare host currently produces a double slash before `openai/v1`; specifying the full API base avoids that behavior. The endpoint must use HTTPS.

#### Input handling

Strings and Responses API input arrays are sent directly. Buffers are converted to UTF-8. Other objects, including Azure Document Intelligence output, are serialized as JSON. Numbers and booleans are converted to text. Arrays are Responses input items, not automatically translated Chat Completions history.

Input supports `msg`, `flow`, `global`, `str`, `jsonata`, and `env`; output supports only `msg`, `flow`, and `global`. Existing saved fields remain `input/inputType` and `output/outputType`. Empty strings/arrays are currently passed to the service; typed-property resolution can turn a missing/null value into an empty string, while a missing parent path can throw. Use a nonempty text prompt for a portable flow.

Example configuration for a Document Intelligence result:

```text
Input:  msg.document.content
Output: msg.payload
```

#### Output metadata

Generated-text mode writes extracted response text; complete-response mode writes the native Responses object. Text mode fails when no nonempty text is available. JSON-looking model text is not automatically parsed or validated, and tools are not automatically executed.

The selected result is written to the configured output. Other input fields are preserved except `msg.foundry`, which is replaced with request metadata:

```javascript
msg.foundry = {
    id,
    requestId,
    model,
    status,
    usage,
    outputText,
    maxRetries,
    timeoutMs,
};
```

When **Include Raw Response** is enabled:

```javascript
msg.foundry.response;
```

contains the complete Responses API result.

Choose an output target outside `msg.foundry`, such as `msg.answer`. The current runtime does not reject overlapping targets; writing the metadata afterwards can overwrite the selected result. A context output still forwards the incoming message with `msg.foundry` metadata.

#### Portable text flow

```text
Inject (text in msg.payload) → Azure Foundry LLM → Debug (msg.answer)
Catch (scoped to Azure Foundry LLM) → error-handling flow
```

Select your Azure authentication config, an explicit HTTPS API base, and a deployed model. Set **Input** to `msg.payload`, **Output To** to `msg.answer`, and **Output Value** to generated text. Inject `Explain Node-RED in one sentence.` A normal result is a string at `msg.answer`, while the original prompt remains at `msg.payload` and metadata appears at `msg.foundry`.

This text-in/text-out pattern is shared with Ollama and OpenAI V1 Compatible, but not their native schemas. Ollama sends a `prompt`; OpenAI sends Chat Completions `messages`; this node sends Responses `input` with separate `instructions`. There is no automatic provider-history conversion, streaming, conversation memory or tool execution.

#### Errors and lifecycle

Failures report through Node-RED Catch handling, not a success output. HTTP failures show `HTTP <status>` in node status; other errors use their code or message. Local validation errors may have the generic code `Error`, so inspect `msg.error.message` as well. SDK errors can carry raw causes/details; universal secret redaction is not guaranteed. Validate model output and redact sensitive diagnostics before forwarding or logging them.

This node currently has no request-abort handler on close. Do not assume redeploying it cancels in-flight SDK calls or remote generation/billing. Concurrent messages are independent, and results can arrive out of order.

#### Retry behavior

The OpenAI SDK retries transient connection failures and retryable HTTP responses, including:

- `408 Request Timeout`
- `409 Conflict`
- `429 Too Many Requests`
- `5xx` server errors

Retries use exponential backoff. **Max Retries** controls the number of additional attempts. Timeout handling belongs to the SDK and is not an overall deadline across retries, response processing, authentication and output writes; do not assume the node will finish within the configured timeout.

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

## Storage Message Protocol (msg.file)

The storage nodes in this package operate on **Azure Files shares** through `azure-file-config`. They are `azure-file-read`, `azure-file-write`, `azure-file-transfer`, `azure-directory-action`, `azure-directory-transfer`, and `azure-directory-watch`. This is not a Blob Storage or Table Storage interface.

Configure an Azure Files configuration node and a share name. Authentication belongs in the configuration/authentication nodes, not in `msg.file`. The message vocabulary matches the local file/directory nodes, while the differences below preserve existing flows.

### Requests and typed fields

Enable **Load from msg.file** to supply the following operation fields dynamically. Share selection and configured output properties remain active even in dynamic mode. Without dynamic mode, use the configured typed inputs.

| Node                     | Action                     | Required dynamic fields            | Optional fields                                                    |
| ------------------------ | -------------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| azure-file-read          | `read`, `exists`, `stat`   | `action`, `path`                   | Combine actions as an array                                        |
| azure-file-write         | `write`, `append`          | `action`, `path`, `data`           | `createDir`                                                        |
| azure-file-transfer      | `copy`, `move`             | `action`, `source`, `destination`  | `createDir`                                                        |
| azure-file-transfer      | `delete`                   | `action`, `source`                 | Destination ignored                                                |
| azure-directory-action   | `create`, `delete`, `list` | `action`; `path` for create/delete | Empty/omitted path lists share root; `recursive` for create/delete |
| azure-directory-transfer | `copy`, `move`             | `action`, `source`, `destination`  | `recursive`                                                        |

Use exact lowercase names for portability. Read also accepts action arrays such as `['read', 'exists', 'stat']` or literal-boolean objects such as `{read: true, stat: true}`. Azure normalizes action-string tokens; historical local string parsing differs, so arrays are preferable for combinations.

Dynamic `createDir` and `recursive` are enabled only by literal `true`; omission does not inherit UI checkbox defaults. Directory list is not recursive. Directory copy requires recursive enabled; directory move can create destination parents when recursive is enabled.

```js
// azure-file-read, Load from msg.file enabled; Output To: msg.file
msg.file = { action: ['read', 'exists', 'stat'], path: 'in/report.txt' };
return msg;
```

```js
// azure-file-write, Load from msg.file enabled
msg.file = {
    action: 'write',
    path: 'out/report.txt',
    data: 'Report content',
    createDir: true,
};
return msg;
```

```js
// azure-file-transfer, Load from msg.file enabled
msg.file = {
    action: 'copy',
    source: 'in/report.txt',
    destination: 'archive/report.txt',
    createDir: true,
};
return msg;
```

```js
// azure-directory-action, Load from msg.file enabled; Output To: msg.payload
msg.file = { action: 'list', path: '' }; // Share root.
return msg;
```

Input-driven share/path fields support `msg`, `flow`, `global`, `str`, `jsonata`, and `env`. File-write data additionally supports `json`. Output properties support `msg`, `flow`, and `global`. Watch source/share settings omit `msg` because watch starts without an input message.

Write/append supports strings, Buffers, ArrayBuffer/views and JSON-serializable objects; other defined scalar values are converted to strings. Empty writes are valid. Missing dynamic data errors; dynamic `null` writes the text `null`. With default static `file.data`, `msg.file = {}` writes an empty file, but omitting `msg.file` entirely instead causes a TypeError with code `DATA_MISSING` without a storage mutation. Successful typed resolutions of undefined/null become an empty string. Keep authentication credentials in configuration nodes; do not copy them into example flows or diagnostics.

### Paths and result routing

Paths are relative to the selected share. Backslashes become forward slashes, surrounding whitespace and empty slash segments are removed, and `.`/`..` segments are rejected. Empty directory paths select the share root for list/watch only; root mutation and transfer require nonempty paths. Source and destination of a transfer use the **same configured share**. Cross-share, cross-account and local-to-Azure transfer are not provided by these requests.

Common metadata contains `filetype`, `path`, `dir`, `base`, `name`, and `ext`.

- **Read:** merges metadata and requested `data` (Buffer), `exists` (boolean), or `stats` into the configured output property, default `msg.file`. Stats are a plain object of Azure properties with `size`, `mtime` and `ctime` aliases when properties exist, not a native `fs.Stats` instance.
- **Write/append:** merges path metadata into `msg.file` and preserves payload.
- **File copy/move:** merges `action`, `source`, `destination` and destination metadata into `msg.file`. Same normalized path succeeds without storage I/O and returns metadata, unlike local file-transfer's unchanged-message no-op.
- **File delete:** uses delete-if-exists and sets `msg.file.deleted` to true/false. `destination` is null; `path` describes the deleted/requested resource. Payload is preserved, unlike local file delete's `payload = true`.
- **Directory create/delete:** merges metadata into `msg.file` and writes boolean `true` to the configured output on success; delete also adds `deleted`. Recursive missing-directory deletion can still fail while listing children.
- **Directory list:** the configured output property receives a whole metadata object with `contents: Metadata[]`. Local directory list instead returns child-name strings. Default output is `msg.file.content`, for both editor and runtime. No additional metadata assignment to `msg.file` is performed independently of the selected result path.
- **Directory copy/move:** merges transfer metadata into `msg.file`; copy adds `copied: {files, directories}`. Same-path directory transfer forwards the original message unchanged.
- **Watch:** has no input. It writes a new event object to the configured target, default `msg.file`, with `action`, `filetype`, watched-root `source`, changed-entry `path`, path metadata and SDK `stats` (null for deletion). It combines discovery scans with pending-file property checks rather than subscribing to a durable change stream; transient changes between observations may not be observed. An invalid ignored-file regex is reported once as a SyntaxError during startup; polling does not start. Correct the pattern and redeploy.

With **Output To: msg.payload**, a directory list result looks like:

```js
msg.payload = {
    filetype: 'directory',
    path: 'archive',
    dir: '',
    base: 'archive',
    name: 'archive',
    ext: '',
    contents: [
        {
            filetype: 'file',
            path: 'archive/report.txt',
            dir: 'archive',
            base: 'report.txt',
            name: 'report',
            ext: '.txt',
        },
    ],
};
```

Merges preserve custom fields and can retain earlier results. Only requested/computed fields should be treated as fresh. Selecting a result property that overlaps `msg.file` can replace metadata; choose output routes deliberately.

### Watch timing and failures

`azure-directory-watch` uses discovery scans and separate property checks for pending file events. It is not a durable change stream: transient changes between observations may be missed.

- **Poll interval** is the normal delay after a poll finishes before the next scan starts. It defaults to `5000` ms, with an effective minimum of `250` ms. Scanning and output-processing time add to discovery latency.
- **Await write finish** holds file Add/Change events until their observed quiet period passes. The signature contains ETag, last-modified time, content length and the SDK's SMB `fileLastWriteOn` field. The quiet period is measured locally from the first observation or last observed signature change, not from the age of the server timestamp.
- **Threshold** defaults to `2000` ms. At a pending file's quiet-period deadline, a fresh `getProperties()` request checks the signature independently of the next scan. A change restarts the wait. Initial enrollment happens after the discovery scan finishes, so a long scan, API latency or failure backoff can delay checking. Eligible events also wait for earlier output writes: typed writes and sends are serialized. The threshold is not an exact delivery deadline or proof that an upload is complete.
- Pending file checks add Azure requests; idle files do not receive these extra checks. SDK retries can add further requests. Directory and Delete events are not held for file stability. **Ignore initial** uses the first complete poll as the baseline without initial Adds. For compatibility, a saved threshold of `0` still selects `2000` ms; turn off Await write finish to disable the stability wait.

Runtime errors are coalesced through `node.error`/Catch: after the first report, further errors are not reported again until a complete poll succeeds, including the output writes it awaits. A poll already running when an error occurs can provide that recovery. A successful event can replace the error status before full-poll recovery; status is not a durable outage indicator.

Consecutive failed polls retry after `P`, `2P`, `4P`, and so on, capped at 60 seconds unless the configured poll interval `P` is longer. A failed file-properties recheck also postpones the start of polls and other pending checks by the current retry delay. A scan already running is not interrupted. A completely successful poll resets the delay and error reporting. Startup configuration or regex failures still report once without starting polling.

**Known polling limit:** poll intervals above `2147483647` ms overflow Node's poll timer and can cause polling after only `1` ms. This pre-existing limitation is not a limit on the separately segmented stability threshold. The backoff bounds above assume a poll interval within the timer's range.

Output failures can lose events; this watcher does not provide durable replay or exactly-once delivery. On close it stops initiating new work, including queued output writes, and suppresses late sends, statuses and error reporting. A request or context write already started can still complete; close does not roll it back.

### Errors and operational boundaries

Failures use Node-RED's error/Catch mechanism rather than a second output. Input failures retain the triggering message; watch/configuration errors have no input message. Catch exposes `msg.error.message` and `msg.error.code` when supplied. Existing status text remains separate. Provider errors may retain SDK codes rather than a universal filesystem error code.

| Condition                                                     | Current result / codes                                                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Missing configuration/share                                   | `AZURE_CONFIG_MISSING`, `SHARE_NAME_MISSING`                                                                                         |
| Missing dynamic request/action                                | `FILE_MISSING`, `ACTION_MISSING` or `INVALID_ACTION`, depending on node                                                              |
| Missing/invalid path                                          | `SOURCE_PATH_MISSING`, `TARGET_PATH_MISSING`, `DESTINATION_PATH_MISSING`, `DIRECTORY_PATH_MISSING`, `PATH_MISSING` or `INVALID_PATH` |
| Invalid mutation action                                       | `INVALID_ACTION`                                                                                                                     |
| Missing dynamic write data                                    | `DATA_MISSING`                                                                                                                       |
| Default static `file.data` with no `msg.file` object          | TypeError with `DATA_MISSING`; no storage mutation; status retains the original error message                                        |
| Invalid watcher ignore pattern                                | One SyntaxError reported at startup; no polling starts                                                                               |
| Directory destination inside source                           | `INVALID_DESTINATION`                                                                                                                |
| Directory copy without recursive                              | `RECURSIVE_REQUIRED`                                                                                                                 |
| Exists-only for missing file                                  | Success, `exists: false`                                                                                                             |
| Stat-only for missing file                                    | Success, `stats: null` (local stat throws instead)                                                                                   |
| Read of missing file                                          | `FILE_NOT_FOUND`, also when read is combined with exists/stat                                                                        |
| Delete missing file                                           | Success, `deleted: false`                                                                                                            |
| Unrecognized read action                                      | May perform no actions and forward metadata; use documented tokens                                                                   |
| Permission/authentication, throttling, network or SDK failure | Propagated error; do not assume it means not-found                                                                                   |
| Output/context failure                                        | Error; remote storage mutations may already have completed                                                                           |

The nodes are not a transaction service. Tree copies/deletes and chunked writes can partially complete. Azure append resizes the file and uploads ranges; concurrent appenders can race, and failure after resize can leave partial changes. Inspect results before retrying and coordinate writes to the same resource externally.

Path validation is not authorization. Use least-privilege Azure permissions and restrict who can inject share/path values. Do not place SAS tokens, account keys, connection strings, complete SDK request objects or file content in status messages or shared logs. Existing SDK error objects may contain diagnostic details; redact before forwarding them outside the trusted flow. Do not infer credential redaction or remote operation rollback from a Catch event.

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
