'use strict';

// Offline, in-memory stand-in for the @azure/storage-file-share clients used by the
// storage nodes. Paths are share-relative and '/'-joined; '' is the share root.
// Only the client methods the nodes call are implemented. No network, no credentials.

const crypto = require('crypto');

function restError(statusCode, code) {
    const err = new Error(`Fake Azure Files error: ${code}`);
    err.name = 'RestError';
    err.statusCode = statusCode;
    err.code = code;
    return err;
}

function joinPath(base, name) {
    return base ? `${base}/${name}` : name;
}

function parentOf(itemPath) {
    const index = itemPath.lastIndexOf('/');
    return index === -1 ? '' : itemPath.slice(0, index);
}

class FakeShare {
    constructor(name) {
        this.name = name;
        this.dirs = new Set(['']);
        this.files = new Map();
        this.calls = [];
        this.faults = [];
        this.gates = [];
        // Listings are delivered in pages of this size; each further page is a recorded request.
        this.pageSize = Infinity;
        this.rootDirectoryClient = new FakeDirectoryClient(this, '');
    }

    // Test setup helpers -------------------------------------------------------------

    addDir(dirPath) {
        const segments = dirPath.split('/').filter(Boolean);
        let current = '';
        for (const segment of segments) {
            current = joinPath(current, segment);
            this.dirs.add(current);
        }
        return this;
    }

    addFile(filePath, content, properties = {}) {
        this.addDir(parentOf(filePath));
        this.files.set(filePath, {
            data: Buffer.from(content),
            contentType: properties.contentType,
            metadata: properties.metadata,
            etag: crypto.randomUUID(),
            lastModified: new Date(),
        });
        return this;
    }

    readFile(filePath) {
        const entry = this.files.get(filePath);
        return entry ? entry.data.toString() : undefined;
    }

    // Fail the next call of `method` on `itemPath` (or any path when omitted) with `error`.
    failOnce(method, itemPath, error) {
        this.faults.push({ method, itemPath, error });
        return this;
    }

    // Hold the next call of `method` on `itemPath` (or any path) until release(error?) is called.
    // `reached` resolves when that call arrives.
    gateOnce(method, itemPath) {
        let release;
        let notifyReached;
        const released = new Promise((resolve) => (release = resolve));
        const reached = new Promise((resolve) => (notifyReached = resolve));
        this.gates.push({ method, itemPath, released, notifyReached });
        return { reached, release: (error) => release(error) };
    }

    mutations() {
        const mutating = [
            'create',
            'createIfNotExists',
            'deleteIfExists',
            'uploadData',
            'uploadRange',
            'resize',
            'rename',
        ];
        return this.calls.filter((call) => mutating.includes(call.method));
    }

    // Internal ------------------------------------------------------------------------

    record(method, itemPath) {
        this.calls.push({ method, path: itemPath });
        const index = this.faults.findIndex(
            (fault) =>
                fault.method === method &&
                (fault.itemPath === undefined || fault.itemPath === itemPath),
        );
        if (index !== -1) {
            const [fault] = this.faults.splice(index, 1);
            throw fault.error;
        }
    }

    async passGate(method, itemPath) {
        const index = this.gates.findIndex(
            (gate) =>
                gate.method === method &&
                (gate.itemPath === undefined || gate.itemPath === itemPath),
        );
        if (index === -1) return;
        const [gate] = this.gates.splice(index, 1);
        gate.notifyReached();
        const error = await gate.released;
        if (error) throw error;
    }

    requireParent(itemPath) {
        if (!this.dirs.has(parentOf(itemPath))) throw restError(404, 'ParentNotFound');
    }

    touch(entry) {
        entry.etag = crypto.randomUUID();
        entry.lastModified = new Date();
    }

    moveTree(fromPath, toPath, replaceIfExists) {
        this.requireParent(toPath);
        if (!replaceIfExists && (this.dirs.has(toPath) || this.files.has(toPath))) {
            throw restError(409, 'ResourceAlreadyExists');
        }

        const remap = (itemPath) =>
            itemPath === fromPath ? toPath : toPath + itemPath.slice(fromPath.length);
        const inTree = (itemPath) => itemPath === fromPath || itemPath.startsWith(fromPath + '/');

        for (const dirPath of [...this.dirs].filter(inTree)) {
            this.dirs.delete(dirPath);
            this.dirs.add(remap(dirPath));
        }
        for (const [filePath, entry] of [...this.files].filter(([key]) => inTree(key))) {
            this.files.delete(filePath);
            this.files.set(remap(filePath), entry);
        }
    }
}

class FakeDirectoryClient {
    constructor(share, dirPath) {
        this.share = share;
        this.path = dirPath;
    }

    getDirectoryClient(name) {
        return new FakeDirectoryClient(this.share, joinPath(this.path, name));
    }

    getFileClient(name) {
        return new FakeFileClient(this.share, joinPath(this.path, name));
    }

    async exists() {
        this.share.record('exists', this.path);
        return this.share.dirs.has(this.path);
    }

    async create() {
        this.share.record('create', this.path);
        this.share.requireParent(this.path);
        if (this.share.dirs.has(this.path)) throw restError(409, 'ResourceAlreadyExists');
        this.share.dirs.add(this.path);
        return { succeeded: true };
    }

    async createIfNotExists() {
        this.share.record('createIfNotExists', this.path);
        if (this.share.dirs.has(this.path)) return { succeeded: false };
        this.share.requireParent(this.path);
        this.share.dirs.add(this.path);
        return { succeeded: true };
    }

    async deleteIfExists() {
        this.share.record('deleteIfExists', this.path);
        if (!this.share.dirs.has(this.path)) return { succeeded: false };
        const prefix = this.path + '/';
        const hasChildren =
            [...this.share.dirs].some((dirPath) => dirPath.startsWith(prefix)) ||
            [...this.share.files.keys()].some((filePath) => filePath.startsWith(prefix));
        if (hasChildren) throw restError(409, 'DirectoryNotEmpty');
        this.share.dirs.delete(this.path);
        return { succeeded: true };
    }

    async getProperties() {
        this.share.record('getProperties', this.path);
        if (!this.share.dirs.has(this.path)) throw restError(404, 'ResourceNotFound');
        return {
            etag: `dir:${this.path}`,
            lastModified: new Date(0),
            fileAttributes: 'Directory',
        };
    }

    async rename(destinationPath, options = {}) {
        this.share.record('rename', this.path);
        if (!this.share.dirs.has(this.path)) throw restError(404, 'ResourceNotFound');
        this.share.moveTree(this.path, destinationPath, options.replaceIfExists === true);
        return { destinationDirectoryClient: new FakeDirectoryClient(this.share, destinationPath) };
    }

    listFilesAndDirectories() {
        const share = this.share;
        const dirPath = this.path;
        return (async function* () {
            share.record('listFilesAndDirectories', dirPath);
            await share.passGate('listFilesAndDirectories', dirPath);
            if (!share.dirs.has(dirPath)) throw restError(404, 'ResourceNotFound');

            const prefix = dirPath ? dirPath + '/' : '';
            const isChild = (itemPath) =>
                itemPath !== dirPath &&
                itemPath.startsWith(prefix) &&
                !itemPath.slice(prefix.length).includes('/');

            const items = [
                ...[...share.dirs].filter(isChild).map((itemPath) => ({
                    kind: 'directory',
                    name: itemPath.slice(prefix.length),
                })),
                ...[...share.files.keys()].filter(isChild).map((itemPath) => ({
                    kind: 'file',
                    name: itemPath.slice(prefix.length),
                    properties: { contentLength: share.files.get(itemPath).data.length },
                })),
            ].sort((a, b) => a.name.localeCompare(b.name));

            for (let index = 0; index < items.length; index++) {
                if (index > 0 && index % share.pageSize === 0) {
                    share.record('listFilesAndDirectories:page', dirPath);
                    await share.passGate('listFilesAndDirectories:page', dirPath);
                }
                yield items[index];
            }
        })();
    }
}

class FakeFileClient {
    constructor(share, filePath) {
        this.share = share;
        this.path = filePath;
    }

    entry() {
        const entry = this.share.files.get(this.path);
        if (!entry) throw restError(404, 'ResourceNotFound');
        return entry;
    }

    async exists() {
        this.share.record('exists', this.path);
        return this.share.files.has(this.path);
    }

    async getProperties() {
        this.share.record('getProperties', this.path);
        await this.share.passGate('getProperties', this.path);
        const entry = this.entry();
        return {
            contentLength: entry.data.length,
            contentType: entry.contentType,
            metadata: entry.metadata,
            etag: entry.etag,
            lastModified: entry.lastModified,
            fileAttributes: 'Archive',
        };
    }

    async downloadToBuffer(offset = 0, count) {
        this.share.record('downloadToBuffer', this.path);
        const entry = this.entry();
        const end = count === undefined ? entry.data.length : offset + count;
        return Buffer.from(entry.data.subarray(offset, end));
    }

    async uploadData(buffer) {
        this.share.record('uploadData', this.path);
        this.share.requireParent(this.path);
        this.share.files.set(this.path, {
            data: Buffer.from(buffer),
            etag: crypto.randomUUID(),
            lastModified: new Date(),
        });
        return {};
    }

    async create(size, options = {}) {
        this.share.record('create', this.path);
        this.share.requireParent(this.path);
        const headers = options.fileHttpHeaders || {};
        this.share.files.set(this.path, {
            data: Buffer.alloc(size),
            contentType: headers.fileContentType,
            metadata: options.metadata,
            etag: crypto.randomUUID(),
            lastModified: new Date(),
        });
        return {};
    }

    async uploadRange(buffer, offset, count) {
        this.share.record('uploadRange', this.path);
        const entry = this.entry();
        if (offset + count > entry.data.length) throw restError(416, 'InvalidRange');
        Buffer.from(buffer).copy(entry.data, offset, 0, count);
        this.share.touch(entry);
        return {};
    }

    async resize(size) {
        this.share.record('resize', this.path);
        const entry = this.entry();
        const resized = Buffer.alloc(size);
        entry.data.copy(resized, 0, 0, Math.min(size, entry.data.length));
        entry.data = resized;
        this.share.touch(entry);
        return {};
    }

    async deleteIfExists() {
        this.share.record('deleteIfExists', this.path);
        return { succeeded: this.share.files.delete(this.path) };
    }

    async rename(destinationPath, options = {}) {
        this.share.record('rename', this.path);
        this.entry();
        this.share.moveTree(this.path, destinationPath, options.replaceIfExists === true);
        return { destinationFileClient: new FakeFileClient(this.share, destinationPath) };
    }
}

class FakeShareServiceClient {
    constructor() {
        this.shares = new Map();
        this.requestedShares = [];
    }

    share(name) {
        if (!this.shares.has(name)) this.shares.set(name, new FakeShare(name));
        return this.shares.get(name);
    }

    getShareClient(name) {
        this.requestedShares.push(name);
        return this.share(name);
    }
}

// Node-RED module that registers a stub `azure-file-config` whose getClient() returns
// the given fake service. Load it alongside the node under test.
function fakeConfigNode(service) {
    return function (RED) {
        function FakeAzureFilesConfigNode(config) {
            RED.nodes.createNode(this, config);
            this.getClient = () => service;
        }
        RED.nodes.registerType('azure-file-config', FakeAzureFilesConfigNode);
    };
}

module.exports = { FakeShareServiceClient, fakeConfigNode, restError };
