# @faigle/node-red-contrib-azure-apps

A collection of Node-RED nodes for interacting with Microsoft Azure services, specifically Microsoft Graph (Emails) and Azure Cognitive Services (Document Intelligence).

These nodes utilize the `@azure/identity` package's `DefaultAzureCredential`, enabling seamless, zero-code authentication whether running locally via the Azure CLI or hosted in Azure via Managed Identities.

## Installation

Run the following command in your Node-RED user directory (typically `~/.node-red`):

npm install @faigle/node-red-contrib-azure-apps

_(Note: Replace with the actual package name if different)_

## Authentication & Prerequisites

These nodes do not require you to input Client Secrets or Tenant IDs in the UI. They use **DefaultAzureCredential**.

- **Local Development:** Run `az login` in your terminal before starting Node-RED.
- **Azure Hosting:** Assign a **System-Assigned** or **User-Assigned Managed Identity** to your Node-RED host container/app service.

### Permissions Required

- **Email Nodes (Graph API):** The executing identity must be granted the `Mail.Read`, `Mail.ReadWrite`, and/or `Mail.Send` **Application Permissions** for the Microsoft Graph API. (Note: Managed Identities require these permissions to be assigned via PowerShell/CLI, not the Azure Portal UI).
- **Document Intelligence:** The executing identity must be assigned the **Cognitive Services User** RBAC role on the specific Document Intelligence resource.

---

## Included Nodes

### 1. azure-document-intelligence

Analyzes a document (URL or Buffer) using Azure Document Intelligence (API version `2023-07-31`).

**Properties:**

- **Endpoint URL:** Your Cognitive Services endpoint (e.g., `https://<resource-name>.cognitiveservices.azure.com/`).
- **Model / Prompt:** The model to use (e.g., `prebuilt-document`, `prebuilt-receipt`, `prebuilt-layout`).
- **Document Data:** An HTTP(S) URL string or a binary Buffer of the document.
- **Dynamic Mode:** If _Load from msg.document_ is enabled, UI properties are overridden by:
    - `msg.document.modelId` (string)
    - `msg.document.data` (string | buffer)

**Outputs:**
Stores the Azure analysis result in the configured output property (default: `msg.analysis`), and appends metadata to `msg.document` (action, status, modelId).

---

### 2. email-read

Reads emails from a specific user's Microsoft 365 inbox.

**Properties:**

- **User ID / Email:** The UserPrincipalName or Azure Object ID of the target mailbox.
- **Email Count:** Maximum number of emails to retrieve (OData `$top`).
- **Include Attachments:** Expands the Graph API request to download attachments.
- **Dynamic Mode:** If _Load from msg.email_ is enabled, UI properties are overridden by:
    - `msg.email.limit` (number)
    - `msg.email.downloadAttachments` (boolean)

**Outputs:**
Stores the retrieved emails in the configured output property (default: `msg.emails`). Appends metadata to `msg.email` including `action`, `count`, and `list`.

---

### 3. email-write

Sends an HTML or plain text email from a specified user's mailbox.

**Properties:**

- **User ID / Email:** The sender's UserPrincipalName or Azure Object ID.
- **To:** Comma-separated list of recipient email addresses.
- **Subject:** The subject line.
- **Body:** The email content.
- **Dynamic Mode:** If _Load from msg.email_ is enabled, UI properties are overridden by:
    - `msg.email.to` (string)
    - `msg.email.subject` (string)
    - `msg.email.body` (string)

**Outputs:**
Passes through the original message and appends `msg.email.status` (`sent`) and `msg.email.action` (`write`).

---

### 4. email-transfer

Moves an existing email to a different folder (e.g., Archive, DeletedItems).

**Properties:**

- **User ID / Email:** The UserPrincipalName or Azure Object ID of the mailbox.
- **Message ID:** The Graph API Base64 ID of the message to move.
- **Dest. Folder:** The target folder ID (well-known names like `Archive`, `DeletedItems`, or custom IDs).
- **Dynamic Mode:** If _Load from msg.email_ is enabled, UI properties are overridden by:
    - `msg.email.messageId` (string)
    - `msg.email.destinationId` (string)

**Outputs:**
Appends the API response and metadata to `msg.email` (action, messageId, destinationId).

---

## Troubleshooting

- **Error 401: Unauthorized (Audience is incorrect):** Ensure your Node-RED server was hard-restarted if you recently updated token scopes in the code. Verify you have the correct RBAC roles (Cognitive Services User).
- **Error 403: Forbidden (Graph API):** Your Managed Identity lacks the necessary Entra ID Application Permissions to access the Graph API.
- **Error InvalidIdMalformed:** Ensure you are passing the proper Graph API Object ID (`id`), not the `internetMessageId`, and that strings are trimmed of whitespace and line breaks.
