'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Phase 2.9: what each Azure editor offers. T1 pins, per typed field, the offered types in order
// (the custom ai-search-query entries by their type ID, plus their options or validator), the
// selected default type, the type-field binding and the saved defaults, and that no other typed
// inputs exist.

const SRC = path.join(__dirname, '../src');

const VALUE = ['msg', 'flow', 'global', 'str', 'jsonata', 'env'];
const TARGET = ['msg', 'flow', 'global'];
const WATCHED = ['flow', 'global', 'str', 'jsonata', 'env'];
const field = (types, type, value) => ({ types, type, value });

// Per editor file: the node type and, per field, the offered types, the default type (selected
// and saved) and the saved value.
const EDITORS = {
    'ai-search-index.html': [
        'azure-ai-search-index',
        {
            endpoint: field(VALUE, 'str', ''),
            indexName: field(VALUE, 'str', ''),
            definition: field(
                ['msg', 'flow', 'global', 'str', 'json', 'jsonata', 'env'],
                'msg',
                'payload',
            ),
            output: field(TARGET, 'msg', 'payload'),
        },
    ],
    'ai-search-query.html': [
        'azure-ai-search-query',
        {
            endpoint: field(VALUE, 'str', ''),
            indexName: field(VALUE, 'str', ''),
            query: field(VALUE, 'msg', 'payload'),
            additionalParameters: field(
                ['msg', 'flow', 'global', 'json', 'jsonata', 'env'],
                'json',
                '{}',
            ),
            output: field(TARGET, 'msg', 'payload'),
            searchFields: field(VALUE, 'str', ''),
            select: field(VALUE, 'str', ''),
            filter: field(VALUE, 'str', ''),
            semanticConfiguration: field(VALUE, 'str', ''),
            querySyntax: field(VALUE, 'str', 'simple'),
            searchMode: field(VALUE, 'str', 'any'),
            outputMode: field(VALUE, 'str', 'documents'),
            top: field(['msg', 'flow', 'global', 'num', 'jsonata', 'env'], 'num', 10),
            skip: field(['msg', 'flow', 'global', 'num', 'jsonata', 'env'], 'num', ''),
            timeoutMs: field(['msg', 'flow', 'global', 'num', 'jsonata', 'env'], 'num', 30000),
            count: field(['msg', 'flow', 'global', 'bool', 'jsonata', 'env'], 'bool', false),
            enableLogging: field(
                ['msg', 'flow', 'global', 'bool', 'jsonata', 'env'],
                'bool',
                false,
            ),
        },
    ],
    'ai-search-sync.html': [
        'azure-ai-search-sync',
        {
            endpoint: field(VALUE, 'str', ''),
            indexName: field(VALUE, 'str', ''),
            documents: field(['msg', 'flow', 'global', 'json', 'jsonata', 'env'], 'msg', 'payload'),
            output: field(TARGET, 'msg', 'payload'),
        },
    ],
    'directory-action.html': [
        'azure-directory-action',
        {
            shareName: field(VALUE, 'str', ''),
            source: field(VALUE, 'str', ''),
            property: field(TARGET, 'msg', 'file.content'),
        },
    ],
    'directory-transfer.html': [
        'azure-directory-transfer',
        {
            shareName: field(VALUE, 'str', ''),
            source: field(VALUE, 'str', ''),
            destination: field(VALUE, 'str', ''),
        },
    ],
    'directory-watch.html': [
        'azure-directory-watch',
        {
            shareName: field(WATCHED, 'str', ''),
            source: field(WATCHED, 'str', ''),
            target: field(TARGET, 'msg', 'file'),
            ignoredFiles: field(['re'], 're', ''),
        },
    ],
    'document-intelligence.html': [
        'azure-document-intelligence',
        {
            endpoint: field(VALUE, 'str', ''),
            modelId: field(VALUE, 'str', 'prebuilt-document'),
            documentData: field(VALUE, 'msg', 'payload'),
            output: field(TARGET, 'msg', 'analysis'),
        },
    ],
    'email-config.html': ['azure-email-config', { userId: field(['str', 'env'], 'str', '') }],
    'email-read.html': ['azure-email-read', { output: field(TARGET, 'msg', 'emails') }],
    'email-transfer.html': [
        'azure-email-transfer',
        { messageId: field(VALUE, 'msg', 'email.messageId') },
    ],
    'email-write.html': [
        'azure-email-write',
        {
            to: field(
                ['msg', 'flow', 'global', 'str', 'json', 'jsonata', 'env'],
                'msg',
                'email.to',
            ),
            subject: field(VALUE, 'msg', 'email.subject'),
            body: field(VALUE, 'msg', 'email.body'),
            attachments: field(
                ['msg', 'flow', 'global', 'json', 'jsonata'],
                'msg',
                'email.attachments',
            ),
        },
    ],
    'file-config.html': ['azure-file-config', { serviceUrl: field(['str', 'env'], 'str', '') }],
    'file-read.html': [
        'azure-file-read',
        {
            shareName: field(VALUE, 'str', ''),
            source: field(VALUE, 'str', ''),
            target: field(TARGET, 'msg', 'file'),
        },
    ],
    'file-transfer.html': [
        'azure-file-transfer',
        {
            shareName: field(VALUE, 'str', ''),
            source: field(VALUE, 'str', ''),
            destination: field(VALUE, 'str', ''),
        },
    ],
    'file-write.html': [
        'azure-file-write',
        {
            shareName: field(VALUE, 'str', ''),
            target: field(VALUE, 'str', ''),
            data: field(
                ['msg', 'flow', 'global', 'str', 'json', 'bin', 'jsonata', 'env'],
                'msg',
                'file.data',
            ),
        },
    ],
    'foundry-llm.html': [
        'azure-foundry-llm',
        {
            endpoint: field(VALUE, 'str', ''),
            model: field(VALUE, 'str', ''),
            instructions: field(VALUE, 'str', ''),
            input: field(
                ['msg', 'flow', 'global', 'str', 'json', 'jsonata', 'env'],
                'msg',
                'payload',
            ),
            output: field(TARGET, 'msg', 'payload'),
        },
    ],
};

// The custom ai-search-query entries: choice options, or a validator, on their own type.
const QUERY_CHOICES = {
    querySyntax: [
        ['simple', 'Simple'],
        ['full', 'Full Lucene'],
        ['semantic', 'Semantic'],
    ],
    searchMode: [
        ['any', 'Any term'],
        ['all', 'All terms'],
    ],
    outputMode: [
        ['documents', 'Documents only'],
        ['response', 'Complete response object'],
    ],
};
// Per integer field: values its number entry accepts and values it rejects.
const QUERY_VALIDATED = {
    top: [
        ['', '1', 1, ' 2 '],
        ['0', '1.5', 'x', -1],
    ],
    skip: [
        ['', '0', 0, '7'],
        ['-1', '0.5', 'x'],
    ],
    timeoutMs: [
        ['1000', 30000],
        ['', '999', '1000.5', 'x'],
    ],
};

// Runs an editor's registration script and its oneditprepare against a recording jQuery stub, and
// returns the registered definition and every typedInput it creates, by field.
function loadEditor(file, nodeType) {
    const html = fs.readFileSync(path.join(SRC, file), 'utf8');
    const registered = new Map();
    const inputs = {};
    const element = (selector) =>
        new Proxy(function () {}, {
            get(target, prop) {
                if (prop === 'selector') return selector;
                if (prop === 'length') return 0;
                if (prop === 'typedInput') {
                    return (options) => {
                        inputs[selector.replace(/^#node-(config-)?input-/, '')] = {
                            options,
                            // Copied into this realm: the editor script runs in its own.
                            types: Array.from(options.types, (t) =>
                                typeof t === 'string' ? t : t.value,
                            ),
                            default: options.default,
                            typeField: options.typeField && options.typeField.selector,
                        };
                        return element(selector);
                    };
                }
                // val() reads an empty value; val(x) sets it and chains.
                if (prop === 'val') return (...args) => (args.length ? element(selector) : '');
                if (prop === 'prop' || prop === 'is') return () => false;
                return () => element(selector);
            },
            apply: () => element(selector),
        });
    const anything = () =>
        new Proxy(function () {}, { get: () => anything(), apply: () => anything() });
    const RED = {
        nodes: { registerType: (type, definition) => registered.set(type, definition) },
        validators: anything(),
        settings: anything(),
        _: (key) => key,
    };
    for (const [, source] of html.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g))
        vm.runInNewContext(source, { RED, $: (selector) => element(String(selector)) });
    const definition = registered.get(nodeType);
    const self = Object.fromEntries(
        Object.entries(definition.defaults).map(([key, spec]) => [key, spec.value]),
    );
    definition.oneditprepare.call(self);
    return { definition, inputs };
}

describe('typed inputs (Phase 2.9): Azure editors', function () {
    it('covers all 61 typed fields of the 16 nodes', function () {
        const fields = Object.values(EDITORS).flatMap(([, f]) => Object.keys(f));
        assert.equal(Object.keys(EDITORS).length, 16);
        assert.equal(fields.length, 61);
    });

    for (const [file, [nodeType, fields]] of Object.entries(EDITORS)) {
        describe(nodeType, function () {
            const { definition, inputs } = loadEditor(file, nodeType);
            const prefix = nodeType.endsWith('-config') ? 'node-config-input' : 'node-input';

            it('creates exactly the expected typed inputs', function () {
                assert.deepEqual(Object.keys(inputs).sort(), Object.keys(fields).sort());
            });

            for (const [name, expected] of Object.entries(fields)) {
                it(`${name}: offered types, default type, type field and saved defaults`, function () {
                    assert.deepEqual(inputs[name].types, expected.types);
                    assert.equal(inputs[name].default, expected.type);
                    assert.equal(inputs[name].typeField, `#${prefix}-${name}Type`);
                    assert.equal(definition.defaults[name].value, expected.value);
                    assert.equal(definition.defaults[`${name}Type`].value, expected.type);
                });
            }
        });
    }

    describe('T2 runtime parity', function () {
        // Each runtime's list, by field, equals its editor's offer. The User ID is offered by the
        // email configuration, which owns its list, and checked by the three email nodes.
        for (const [file, [nodeType, fields]] of Object.entries(EDITORS)) {
            it(`${nodeType}: the runtime allows exactly the offered types`, function () {
                const { TYPES } = require(path.join(SRC, file.replace(/\.html$/, '.js')));
                assert.deepEqual(Object.keys(TYPES).sort(), Object.keys(fields).sort());
                for (const [name, expected] of Object.entries(fields)) {
                    assert.deepEqual([...TYPES[name]].sort(), [...expected.types].sort(), name);
                }
            });
        }
    });

    describe('azure-ai-search-query custom entries', function () {
        const { inputs } = loadEditor('ai-search-query.html', 'azure-ai-search-query');
        const custom = (name, type) =>
            Array.from(inputs[name].options.types).find(
                (t) => typeof t === 'object' && t.value === type,
            );

        for (const [name, choices] of Object.entries(QUERY_CHOICES)) {
            it(`${name}: its str entry offers exactly the choices`, function () {
                assert.deepEqual(
                    Array.from(custom(name, 'str').options, (o) => [o.value, o.label]),
                    choices,
                );
            });
        }

        for (const [name, [valid, invalid]] of Object.entries(QUERY_VALIDATED)) {
            it(`${name}: its num entry validates as before`, function () {
                const { validate } = custom(name, 'num');
                for (const v of valid)
                    assert.equal(validate(v), true, `accepts ${JSON.stringify(v)}`);
                for (const v of invalid)
                    assert.equal(validate(v), false, `rejects ${JSON.stringify(v)}`);
            });
        }
    });
});
