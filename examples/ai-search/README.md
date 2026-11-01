# Azure AI Search Node-RED examples

Examples for:

- `azure-ai-search-index`
- `azure-ai-search-sync`
- `azure-ai-search-query`

All examples are in English. The customer data is synthetic test data.

## Before running

Each example imports as its own **disabled** tab. The tab's configuration node is on the same tab.

1. Before you start Node-RED, set:
    - `NODE_RED_EXAMPLE_AZURE_SEARCH_ENDPOINT`: your Azure AI Search endpoint (for example `https://<service>.search.windows.net`);
    - `NODE_RED_EXAMPLE_AZURE_SEARCH_INDEX`: the name of a **disposable** index, used only for these examples.

    All Search examples use the same index, so they agree with each other. If a variable is unset, the node reports what is missing and sends no request.

2. Open the configuration node **EDIT ME: example Search key** (API key authentication) and enter an admin or query key, as the example needs. No example contains a key.
3. Enable the tab, deploy, then click the example's button.

Configure everything first. A node checks its fields when the flow reaches it, so earlier steps of a click may already have run. Nothing is rolled back.

The index definition and the sample customer data are embedded in the Inject nodes. No external JSON files are required.

## Examples

### 01 Create customers index

The Inject node puts the synthetic customer index definition into `msg.indexDefinition`. The definition carries no name of its own: the node creates or updates the index named by `NODE_RED_EXAMPLE_AZURE_SEARCH_INDEX`.

### 02 Sync sample documents

The Inject node puts three synthetic customer documents into `msg.customers`. The Sync node uploads them with `mergeOrUpload`. Run 01 first.

### 03 Simple text query

Searches for `Anna Keller` in the fields `first_name`, `last_name`, `customer_number`, `insurance_number`, `policy_id` and `notes`, and writes the matching documents to `msg.searchResults`. Run 01 and 02 first.

The index definition sets `searchable` on the name and notes fields but leaves it unset on `customer_number`, `insurance_number` and `policy_id`. Whether the service treats those three as searchable follows its own defaults; the examples do not establish that.

### 04 Filtered query and count

Searches all documents, filters to active low-risk customers, selects a subset of fields, asks for the total count, and writes the complete search response to `msg.searchResponse`.

### 05 Message-driven query

The Inject node fills `msg.searchEndpoint` and `msg.searchIndex` from the same two variables. It also sets the search text and the query options in `msg.searchOptions`. The Query node reads all of them from the message. The options are applied last, so their `top: 5` replaces the node's `top` of 10.

### 06 Delete document

**This is destructive.** The Inject node holds the key of customer `K0003`, and the Sync node deletes that document with the `delete` action. It is a separate button on purpose.

### 07 End-to-end create sync query

A single Inject node carries:

- the index definition;
- the synthetic customer data;
- the search text.

One click creates or updates the index, uploads the documents, and queries the index, in that order. The results go to `msg.searchResults`.

## Cleanup

Delete the example index when you are done.

## Test data

All names, customer numbers, policy IDs, insurance numbers, addresses, e-mail addresses, telephone numbers, bank details and other customer information are synthetic test data.

## Not verified

- A real Search service: the tests fake the HTTP calls.
- Behaviour in the Node-RED editor.
