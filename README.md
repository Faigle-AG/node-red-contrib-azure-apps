# @faigle/node-red-contrib-azure-apps

A collection of Node-RED nodes for interacting with Microsoft Azure services, including Microsoft Graph email operations, Azure Document Intelligence, and Azure AI Foundry language models.

The Azure nodes use `@azure/identity` and `DefaultAzureCredential`, enabling the same configuration to run locally with environment variables or Azure CLI credentials and in Azure with managed identity or workload identity. The Foundry LLM node also supports API-key authentication.

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
    - `Mail.Read` (for `email-read`)
    - `Mail.ReadWrite` (for `email-transfer`)
    - `Mail.Send` (for `email-write`)
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

Analyzes a document using Azure Document Intelligence (API version `2023-07-31`).

- **Endpoint URL:** Your Cognitive Services endpoint (e.g., `https://<resource-name>.cognitiveservices.azure.com/`).
- **Model / Prompt:** The model ID to use (e.g., `prebuilt-document`, `prebuilt-receipt`, `prebuilt-layout`).
- **Document Data:** An HTTP/HTTPS URL string or a binary Buffer of the file.
- **Input Format:** Specify how to interpret the incoming data (`auto`, `buffer`, `base64`, or `url`).
- **Dynamic Mode:** Override UI properties via `msg.document.modelId`, `msg.document.data`, and `msg.document.inputType`.

### 2. email-read

Reads emails from a specific user's Microsoft 365 inbox.

- **User ID / Email:** The UserPrincipalName or Azure Object ID of the target mailbox.
- **Email Count:** Maximum number of emails to retrieve (maps to OData `$top`).
- **Include Attachments:** Expands the Graph API request to include attachments.
- **Dynamic Mode:** Override UI properties via `msg.email.limit` and `msg.email.downloadAttachments`.

### 3. email-write

Sends an HTML or plain text email from a specified user's mailbox.

- **User ID / Email:** The sender's UserPrincipalName or Azure Object ID.
- **To:** A comma-separated string, a single recipient object (`{ name: "...", address: "..." }`), or an array of recipient objects.
- **Subject:** The subject line.
- **Body:** The HTML or plain text content.
- **Attachments:** An optional array of objects containing `name` and `content` (Buffer or Base64 string).
- **Dynamic Mode:** Override UI properties via `msg.email.to`, `msg.email.subject`, `msg.email.body`, and `msg.email.attachments`.

### 4. email-transfer

Moves an existing email to a different folder (e.g., Archive, DeletedItems).

- **User ID / Email:** The UserPrincipalName or Azure Object ID of the mailbox.
- **Message ID:** The Graph API message ID.
- **Dest. Folder:** The target folder ID (well-known names like `Archive`, `DeletedItems`, or custom IDs).
- **Dynamic Mode:** Override UI properties via `msg.email.messageId` and `msg.email.destinationId`.

### 5. foundry-llm

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

---

## Troubleshooting

- **Error 401: Unauthorized / PermissionDenied:** Ensure Node-RED was restarted after updating token permissions or `.env` variables. Verify the App Registration is assigned the **Cognitive Services User** role.
- **Error 403: Forbidden (Graph API):** Ensure **Application permissions** (not Delegated) were granted and admin consent was executed in Entra ID.
- **Error InvalidIdMalformed:** Verify you are passing the Graph API Object ID (`id`), not the header `internetMessageId`, and strip any whitespace.

- **Foundry 401 Unauthorized:** Verify the endpoint, model deployment, identity, role assignment, and token audience. Entra ID authentication must request `https://ai.azure.com/.default`.
- **Foundry ConnectTimeoutError:** Increase the node timeout, keep retries enabled, and verify DNS, proxy, firewall, private endpoint, and outbound network connectivity from the Node-RED host or container.
- **Foundry 429 or 5xx:** The SDK retries these responses automatically. Reduce concurrency or increase **Max Retries** when throttling persists.
- **Foundry model rejects temperature:** Clear the **Temperature** field for reasoning models or deployments that do not support it.
