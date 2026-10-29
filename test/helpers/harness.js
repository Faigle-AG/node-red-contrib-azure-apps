'use strict';

// Sends one message to a loaded node and resolves with its first outcome:
//   { msg, statuses }          when the wired output node receives a message;
//   { err, errMsg, statuses }  when the node reports node.error(err, msg) / done(err).
// `statuses` holds every node.status() payload seen up to the outcome.
function trigger(helper, nodeId, outputId, input, options = {}) {
    const node = helper.getNode(nodeId);
    const output = outputId ? helper.getNode(outputId) : null;
    const timeout = options.timeout || 1500;
    const statuses = [];

    return new Promise((resolve, reject) => {
        const onStatus = (call) => statuses.push(call.args[0]);
        const onError = (call) => finish(resolve, { err: call.args[0], errMsg: call.args[1] });
        const onOutput = (msg) => finish(resolve, { msg });
        const timer = setTimeout(
            () => finish(reject, new Error(`No output or error within ${timeout}ms`)),
            timeout,
        );

        function finish(settle, value) {
            clearTimeout(timer);
            node.removeListener('call:status', onStatus);
            node.removeListener('call:error', onError);
            if (output) output.removeListener('input', onOutput);
            settle(value instanceof Error ? value : { ...value, statuses });
        }

        node.on('call:status', onStatus);
        node.on('call:error', onError);
        if (output) output.on('input', onOutput);
        node.receive(input);
    });
}

// Text of the last status shown before the outcome.
function lastStatusText(result) {
    const last = result.statuses[result.statuses.length - 1];
    return last ? last.text : undefined;
}

// Resolves with the messages a node emits within `ms` (for nodes without an input port).
function collect(helper, outputId, ms) {
    const output = helper.getNode(outputId);
    const messages = [];
    const onOutput = (msg) => messages.push(msg);
    output.on('input', onOutput);
    return new Promise((resolve) =>
        setTimeout(() => {
            output.removeListener('input', onOutput);
            resolve(messages);
        }, ms),
    );
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { trigger, lastStatusText, collect, delay };
