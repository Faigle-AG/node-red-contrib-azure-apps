'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Topic colours from the shared palette: File Storage (Soft Tan) and Directory Operations
// (Warm Amber) for the Azure Files nodes, LLM & AI Models, cloud (Azure Blue) for Foundry.
const EDITORS = [
    { file: 'file-read.html', type: 'azure-file-read', color: '#DEB887' },
    { file: 'file-write.html', type: 'azure-file-write', color: '#DEB887' },
    { file: 'file-transfer.html', type: 'azure-file-transfer', color: '#DEB887' },
    { file: 'directory-action.html', type: 'azure-directory-action', color: '#E6B86A' },
    { file: 'directory-transfer.html', type: 'azure-directory-transfer', color: '#E6B86A' },
    { file: 'directory-watch.html', type: 'azure-directory-watch', color: '#E6B86A' },
    { file: 'foundry-llm.html', type: 'azure-foundry-llm', color: '#90CAF9' },
];

// Evaluates the editor's registration scripts against a minimal RED stub and returns
// the registered definitions by type.
function loadDefinitions(html) {
    const registered = new Map();
    const anything = () =>
        new Proxy(function () {}, { get: () => anything(), apply: () => anything() });
    const RED = {
        nodes: { registerType: (type, definition) => registered.set(type, definition) },
        validators: anything(),
        _: (key) => key,
    };
    const scripts = [...html.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g)];
    for (const [, source] of scripts) vm.runInNewContext(source, { RED, $: anything() });
    return registered;
}

describe('azure editors', function () {
    for (const editor of EDITORS) {
        describe(editor.file, function () {
            const html = fs.readFileSync(path.join(__dirname, '../src', editor.file), 'utf8');

            it(`registers ${editor.type} with its topic colour`, function () {
                const definition = loadDefinitions(html).get(editor.type);
                assert.ok(definition, `${editor.type} is registered`);
                assert.equal(definition.color, editor.color);
                assert.equal(definition.category, 'azure');
            });

            it('uses the shared editor.css and .faigle-node-editor wrapper', function () {
                assert.match(
                    html,
                    /href="resources\/@faigle\/node-red-runtime-utils\/editor\.css"/,
                );
                assert.match(html, /class="faigle-node-editor"/);
            });
        });
    }
});

// Every registered palette node and its topic colour from the shared palette. Config editors
// are not on the palette and get no colour.
const PALETTE = {
    'azure-email-read': '#80CBC4', // Email & Notifications (Mint Teal)
    'azure-email-transfer': '#80CBC4',
    'azure-email-write': '#80CBC4',
    'azure-document-intelligence': '#B39DDB', // Document Processing, cloud (Deep Lavender)
    'azure-foundry-llm': '#90CAF9', // LLM & AI Models, cloud (Azure Blue)
    'azure-file-read': '#DEB887', // File Storage (Soft Tan)
    'azure-file-write': '#DEB887',
    'azure-file-transfer': '#DEB887',
    'azure-directory-action': '#E6B86A', // Directory Operations (Warm Amber)
    'azure-directory-transfer': '#E6B86A',
    'azure-directory-watch': '#E6B86A',
    'azure-ai-search-index': '#81D4FA', // Search & Vector DB (Steel Blue)
    'azure-ai-search-query': '#81D4FA',
    'azure-ai-search-sync': '#81D4FA',
};
const CONFIG_TYPES = ['azure-auth-config', 'azure-email-config', 'azure-file-config'];

describe('azure palette', function () {
    // Each manifest entry src/<name>.js has its editor in src/<name>.html.
    const definitions = new Map();
    for (const script of Object.values(require('../package.json')['node-red'].nodes)) {
        const file = path.join(__dirname, '..', script.replace(/\.js$/, '.html'));
        for (const [type, definition] of loadDefinitions(fs.readFileSync(file, 'utf8')))
            definitions.set(type, definition);
    }

    it('registers exactly the palette nodes and the config editors', function () {
        assert.deepEqual(
            [...definitions.keys()].sort(),
            [...Object.keys(PALETTE), ...CONFIG_TYPES].sort(),
        );
    });

    for (const [type, color] of Object.entries(PALETTE)) {
        it(`registers ${type} in the azure category with ${color}`, function () {
            const definition = definitions.get(type);
            assert.ok(definition, `${type} is registered`);
            assert.equal(definition.category, 'azure');
            assert.equal(definition.color, color);
        });
    }

    for (const type of CONFIG_TYPES) {
        it(`registers ${type} as a config editor without a colour`, function () {
            const definition = definitions.get(type);
            assert.ok(definition, `${type} is registered`);
            assert.equal(definition.category, 'config');
            assert.equal(definition.color, undefined);
        });
    }
});
