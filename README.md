# @faigle/node-red-contrib-azure-apps

A collection of Node-RED nodes for interacting with Microsoft Azure services, specifically Microsoft Graph (Emails) and Azure Cognitive Services (Document Intelligence).

These nodes utilize the `@azure/identity` package's `DefaultAzureCredential`, enabling seamless, zero-code authentication whether running locally via environment variables/Azure CLI or hosted in Azure via Managed Identities.

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

---

## Troubleshooting

- **Error 401: Unauthorized / PermissionDenied:** Ensure Node-RED was restarted after updating token permissions or `.env` variables. Verify the App Registration is assigned the **Cognitive Services User** role.
- **Error 403: Forbidden (Graph API):** Ensure **Application permissions** (not Delegated) were granted and admin consent was executed in Entra ID.
- **Error InvalidIdMalformed:** Verify you are passing the Graph API Object ID (`id`), not the header `internetMessageId`, and strip any whitespace.
