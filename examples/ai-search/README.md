# Azure AI Search Node-RED examples

Examples for:

- `azure-ai-search-index`
- `azure-ai-search-sync`
- `azure-ai-search-query`

All examples are fully in English. Endpoints and customer data are placeholders or synthetic test values.

## Before running

For each imported flow:

1. Open the **EDIT: Azure Entra ID** config node and configure or replace it with your shared Azure authentication node.
2. Replace:

    `https://YOUR-SEARCH-SERVICE.search.windows.net`

    with your Azure AI Search endpoint.

3. The examples use the index name `test`.

The index definition and sample customer data are embedded directly in the Inject nodes. No external JSON files are required.

## Examples

### 01 Create test index

The Inject node contains the full English `test` index definition in `msg.indexDefinition`.

### 02 Sync sample documents

The Inject node contains three synthetic customer documents in `msg.test`. The Sync node uses `mergeOrUpload`.

### 03 Simple text query

Searches for `Anna Keller` and writes matching documents to `msg.searchResults`.

### 04 Filtered query and count

Searches all documents, filters to active low-risk test, selects a subset of fields, enables the result count, and writes the full Azure Search response to `msg.searchResponse`.

### 05 Message-driven query

The Inject node provides the endpoint, index name, search text, and additional query parameters through message properties.

### 06 Delete document

The Inject node contains the key of customer `K0003`. The Sync node uses the `delete` action.

### 07 End-to-end create sync query

A single Inject node contains:

- the complete index definition,
- the synthetic customer data,
- the search text.

The flow then creates/updates the index, synchronizes the documents, and queries the index.

## Test data

All names, customer numbers, policy IDs, insurance numbers, addresses, e-mail addresses, telephone numbers, bank details, and other customer information are synthetic test data.
