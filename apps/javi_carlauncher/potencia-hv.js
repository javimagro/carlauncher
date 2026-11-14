'use strict';

const service = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';
const instance = 'SystemFunctionsInternalTasuInst1';
const batteryEcu = 0x07;
const voltageDid = 0xe54d;
const currentDid = 0xe561;
const methodExpired = Symbol('TASU method timeout');
const tasuErrors = [
    'NO_ERROR', 'REQUEST_PENDING', 'TAS_CONNECTION_ERROR', 'TIMEOUT_ERROR', 'DEACTIVATED',
    'INVALID_REQUEST', 'INVALID_LENGTH', 'APP_REQUEST_TEMPORARILY_NOT_ACCEPTED', 'INVALID_SESSION',
    'EXCLUSIVE_MODE_REQUESTED', 'EXCLUSIVE_MODE_OCCUPIED', 'EXCLUSIVE_MODE_ACTIVE',
    'EXCLUSIVE_MODE_PENDING', 'WRONG_IDENTIFIER'
];

function tasuCode(value) {
    if (Number.isInteger(value) && value >= 0 && value < tasuErrors.length) return value;
    return tasuErrors.indexOf(value);
}

function readReply(event, did) {
    if (!event) return;
    const code = tasuCode(event.errorCode);
    if (code > 1) return { failure: 'tasu', code };
    const value = event.udsResponse;
    const bytes = value && value.data ? value.data : value;
    // runner.js executes the OAP bundle in a new VM context. SOME/IP Buffers
    // originate in Node's native context and fail the app's instanceof check.
    if (!Buffer.isBuffer(bytes) && !Array.isArray(bytes) &&
        !(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) return;
    const frame = Buffer.from(bytes);
    // TASU prepends nine bytes to the ECU's UDS reply.
    if (frame.length >= 5 && frame[2] === 0x7f) return { failure: 'tasu', code: frame[4] };
    if (frame.length < 12 || frame[6] !== batteryEcu) return;
    if (frame[9] === 0x7f && frame[10] === 0x22) {
        return frame[11] === 0x78 ? { pending: true } : { failure: 'uds', code: frame[11] };
    }
    if (frame[9] !== 0x62 || frame.readUInt16BE(10) !== did) return;
    const valueOffset = did === voltageDid ? 12 : 14;
    if (frame.length < valueOffset + 2) return { failure: 'format' };
    const raw = did === voltageDid ? frame.readUInt16BE(valueOffset) : -frame.readInt16BE(valueOffset);
    return { value: raw / 100, at: Date.now() };
}

function createPowerProbe(builders, { periodMs = 1000, retryMs = 5000, replyMs = 4000, requestMs = 8000 } = {}) {
    const signal = 'batteryPowerHv';
    let record = { signal, status: 'no-sample' };
    let current;
    let closing = Promise.resolve();

    async function read(job, proxy, did) {
        const data = Buffer.from([did >> 8, did & 0xff]);
        let replyTimer;
        let requestTimer;
        let finish;
        let done = false;
        let pending = false;
        let unmatched = false;
        function waitForReply() {
            clearTimeout(replyTimer);
            replyTimer = setTimeout(() => {
                finish({ failure: pending ? 'pending-timeout' : unmatched ? 'unmatched' : 'timeout' });
            }, pending ? 2 * replyMs : replyMs);
        }
        const response = new Promise((resolve) => {
            finish = (reply) => {
                done = true;
                clearTimeout(replyTimer);
                resolve(reply);
            };
            job.cancel = () => finish({ failure: 'timeout' });
            job.onResponse = (event) => {
                if (done) return;
                const reply = readReply(event, did);
                if (!reply) unmatched = true;
                else if (!reply.pending) finish(reply);
                else if (!pending) {
                    pending = true;
                    if (replyTimer) waitForReply();
                }
            };
        });
        try {
            const result = await Promise.race([
                proxy.sendTasuRequest({
                    sourceAddress: 0xf2, targetAddress: batteryEcu, serviceID: 0x22, subroutineID: 0,
                    udsDataLength: data.length, udsData: data, deadlockTime: 0
                }),
                new Promise((resolve) => { requestTimer = setTimeout(() => resolve(methodExpired), requestMs); })
            ]);
            clearTimeout(requestTimer);
            if (result === methodExpired) return { failure: 'request-timeout' };
            const verdict = result && typeof result === 'object' ? result.TasuErrorEnum : result;
            const code = tasuCode(verdict);
            // Some SDK wrappers resolve without a verdict. In that case the event supplies the result.
            if (code > 1) return { failure: 'tasu', code };
            if (verdict != null && code < 0) return { failure: 'request' };
            // Keep events received before the method returns, but measure the wait from acceptance.
            if (!done) waitForReply();
            return await response;
        } catch (_) {
            return { failure: 'request' };
        } finally {
            clearTimeout(requestTimer);
            clearTimeout(replyTimer);
            job.onResponse = null;
            job.cancel = null;
        }
    }

    function failedReading(stage, { failure, code }) {
        record = { signal, status: 'error', phase: 'getter', fields: { stage, failure, code } };
    }

    function pause(job, ms) {
        return new Promise((resolve) => {
            const timer = setTimeout(finish, ms);
            function finish() {
                clearTimeout(timer);
                job.cancel = null;
                resolve();
            }
            job.cancel = finish;
        });
    }

    async function collect(job) {
        if (job !== current) return;
        let proxy;
        let subscription;
        let phase = 'proxy';
        try {
            proxy = await builders.buildAndInitTypedProxy(service, instance, { timeoutMs: 10000 });
            if (job !== current) return;
            phase = 'subscribe';
            subscription = await proxy.sendTasuResponse.subscribe((event) => {
                if (job === current && job.onResponse) job.onResponse(event);
            });
            while (job === current) {
                const start = Date.now();
                const volts = await read(job, proxy, voltageDid);
                if (job !== current) break;
                if (volts.failure) {
                    failedReading('voltage', volts);
                    if (volts.failure === 'request-timeout') break;
                    await pause(job, retryMs);
                    continue;
                }
                await pause(job, 25);
                if (job !== current) break;
                const amps = await read(job, proxy, currentDid);
                if (job !== current) break;
                const paired = !amps.failure && amps.at >= volts.at && amps.at - volts.at <= 1000;
                if (paired) {
                    record = { signal, status: 'sample', sampledAt: amps.at, freshForMs: 3 * periodMs,
                        fields: { kw: volts.value * amps.value / 1000, volts: volts.value, amps: amps.value } };
                } else {
                    failedReading('current', amps.failure ? amps : { failure: 'late' });
                    if (amps.failure === 'request-timeout') break;
                }
                const delay = paired ? Math.max(0, periodMs - (Date.now() - start)) : retryMs;
                await pause(job, delay);
            }
        } catch (_) {
            if (job === current) record = { signal, status: 'error', phase };
        } finally {
            if (subscription !== undefined) {
                await Promise.resolve().then(() => proxy.sendTasuResponse.unsubscribe(subscription)).catch(() => {});
            }
            // The installed OAP SDK owns native subscriptions through shutdown().
            // Keep dispose as a fallback for older adapters, never call both.
            const closeProxy = proxy && (proxy.shutdown || proxy.dispose);
            if (typeof closeProxy === 'function') {
                await Promise.resolve().then(() => closeProxy.call(proxy)).catch(() => {});
            }
        }
    }

    async function run(job) {
        while (job === current) {
            await collect(job);
            if (job === current) await pause(job, retryMs);
        }
    }

    return {
        show(on) {
            if (on === Boolean(current)) return;
            record = { signal, status: 'no-sample' };
            if (on) {
                const job = {};
                current = job;
                job.done = closing.then(() => run(job));
            } else {
                const job = current;
                current = undefined;
                if (job.cancel) job.cancel();
                closing = job.done;
            }
        },
        snapshot: () => record
    };
}

module.exports = { createPowerProbe, service, instance };
