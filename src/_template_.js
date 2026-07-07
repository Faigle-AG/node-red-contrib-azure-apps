module.exports = function (RED) {
    const { extendNode } = require('@faigle/node-red-runtime-utils')(RED);

    function ExampleTemplateNode(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name;
        this.enableLogging = config.enableLogging;

        var node = this;

        extendNode(node);

        node.on('input', function (msg, send, done) {
            if (node.enableLogging) {
                node.log('Received payload: ' + JSON.stringify(msg.payload));
            }

            node.status.processing('processing message');

            send(msg);

            if (done) done();

            node.status.succeeded('finished processing', {
                next: () => node.status.waiting('waiting for input'),
            });
        });
    }

    RED.nodes.registerType('_template_', ExampleTemplateNode);
};
