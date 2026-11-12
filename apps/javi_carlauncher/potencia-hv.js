'use strict';

const service = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';
const instance = 'SystemFunctionsInternalTasuInst1';
const batteryEcu = 0x07;
const voltageDid = 0xe54d;
const currentDid = 0xe561;
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
    if (!Array.isArray(bytes) && !(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) return;
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

function createPowerProbe(builders, { periodMs = 1000, retryMs = 5000, replyMs = 4000 } = {}) {
    const signal = 'batteryPowerHv';
    let record = { signal, status: 'no-sample' };
    let current;
    let closing = Promise.resolve();

    async function read(job, proxy, did) {
        const data = Buffer.from([did >> 8, did & 0xff]);
        let timer;
        const response = new Promise((resolve) => {
            const expire = () => resolve({ failure: 'timeout' });
            job.cancel = expire;
            timer = setTimeout(expire, replyMs);
            let pending = false;
            job.onResponse = (event) => {
                const reply = readReply(event, did);
                if (!reply) return;
                if (!reply.pending) resolve(reply);
                else if (!pending) {
                    pending = true;
                    clearTimeout(timer);
                    timer = setTimeout(expire, 2 * replyMs);
                }
            };
        });
        try {
            const result = await proxy.sendTasuRequest({
                sourceAddress: 0xf2, targetAddress: batteryEcu, serviceID: 0x22, subroutineID: 0,
                udsDataLength: data.length, udsData: data, deadlockTime: 0
            });
            const verdict = result && typeof result === 'object' ? result.TasuErrorEnum : result;
            const code = tasuCode(verdict);
            // Some SDK wrappers resolve without a verdict. In that case the event supplies the result.
            if (code > 1) return { failure: 'tasu', code };
            if (verdict != null && code < 0) return { failure: 'request' };
            return await response;
        } catch (_) {
            return { failure: 'request' };
        } finally {
            clearTimeout(timer);
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
            if (proxy && typeof proxy.dispose === 'function') {
                await Promise.resolve().then(() => proxy.dispose()).catch(() => {});
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
