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
