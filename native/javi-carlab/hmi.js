'use strict';

const { spawn } = require('child_process');
const { createInterface } = require('readline');

module.exports = function connect(helper, stopped) {
    const child = spawn(helper, ['serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
    let pending;
    let alive = true;
    function finish(error) {
        if (!alive) return;
        alive = false;
        if (pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
            pending = null;
        }
        child.kill();
        stopped(error);
    }
    child.on('error', finish);
    child.stdin.on('error', finish);
    child.on('exit', (code) => finish(new Error('hmictl salió: ' + code)));
    createInterface({ input: child.stdout }).on('line', (line) => {
        if (!pending || !/^(?:ok|error)(?:\s|$)/.test(line)) return;
        const request = pending;
        pending = null;
        clearTimeout(request.timer);
        request.resolve(line);
    });
    return function request(line) {
        return new Promise((resolve, reject) => {
            if (!alive || pending) return reject(new Error('hmictl no disponible'));
            pending = { resolve, reject, timer: setTimeout(() => finish(new Error('Tiempo de espera de hmictl')), 2500) };
            child.stdin.write(line + '\n');
        });
    };
};
