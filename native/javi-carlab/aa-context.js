'use strict';

const { spawn } = require('child_process');
const { parseContext } = require('./home-context');

// A bounded, read-only query. hmictl may ignore TERM while waiting in serve().
function readContext(options) {
    options = options || {};
    return new Promise((resolve) => {
        let child, ended = false, buffer = '', timer;
        function finish(value) {
            if (ended) return;
            ended = true; clearTimeout(timer);
            if (child) child.kill('SIGKILL');
            resolve(value);
        }
        timer = setTimeout(() => finish(null), 2500);
        try {
            child = (options.spawn || spawn)(options.helper || '/var/opt/iteriodev-overlays/current/hmictl', ['serve'],
                { stdio: ['pipe', 'pipe', 'ignore'] });
            child.on('error', () => finish(null));
            child.on('exit', () => finish(null));
            child.stdin.on('error', () => finish(null));
            child.stdout.on('data', (chunk) => {
                if (ended) return;
                buffer += chunk.toString();
                if (buffer.length > 4096) return finish(null);
                let at;
                while ((at = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
                    if (/^(ok|error)(\s|$)/.test(line)) return finish(parseContext(line));
                }
            });
            child.stdin.write('ctx\n');
        } catch (_) { finish(null); }
    });
}

// Observed on the hash-guarded MGU21 profile, not a cross-firmware assumption.
function isNativeAA(context) { return !!context && context.state === 1 && context.applet === 50; }

async function restoreFocus(session, context, attempted) {
    if (!attempted) return 'not-acquired';
    const current = await context();
    if (!current) return 'context-unavailable';
    // The user may already have returned to the original AA application.
    if (isNativeAA(current)) return 'native-aa-retained';
    await session.focusNative();
    return 'restored';
}

module.exports = { readContext, isNativeAA, restoreFocus };
