'use strict';

function parseContext(reply) {
    const fields = /^ok (-?\d+) (-?\d+) -?\d+ -?\d+ -?\d+\s*$/.exec(reply);
    if (!fields) return null;
    const state = Number(fields[1]);
    const applet = Number(fields[2]);
    if (!Number.isSafeInteger(state) || state < 0 || !Number.isSafeInteger(applet) || applet < 0) return null;
    return { state, applet };
}

function isLauncher(context, applet) {
    return !!context && Number.isInteger(applet) && (context.applet === applet || context.applet === applet + 3000);
}

function openContext(context) {
    return 'open ' + context.state + ' ' + context.applet;
}

module.exports = { parseContext, isLauncher, openContext };
