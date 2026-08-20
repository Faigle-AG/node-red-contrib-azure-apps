'use strict';

module.exports = function (RED) {
    function createError(message, code) {
        const err = new Error(message);
        if (code) err.code = code;
        return err;
    }

    function AzureEmailConfigNode(config) {
        RED.nodes.createNode(this, config);

        this.name = config.name;
        this.authNode = RED.nodes.getNode(config.auth);
        this.userId = config.userId;
        this.userIdType = config.userIdType || 'str';

        const node = this;

        node.getToken = function (scope) {
            if (!node.authNode) {
                throw createError(
                    'Missing Azure authentication configuration',
                    'AZURE_CONFIG_MISSING',
                );
            }
            return node.authNode.getToken(scope);
        };
    }

    RED.nodes.registerType('azure-email-config', AzureEmailConfigNode);
};
