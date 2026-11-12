'use strict';

const service = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';
const instance = 'SystemFunctionsInternalTasuInst1';
const batteryEcu = 0x07;
const voltageDid = 0xe54d;
const currentDid = 0xe561;

function readValue(event, did) {
    if (!event || (event.errorCode !== 'NO_ERROR' && event.errorCode !== 0)) return;
    const bytes = event.udsResponse;
    if (!Array.isArray(bytes) && !(bytes instanceof Uint8Array)) return;
    const frame = Buffer.from(bytes);
    // TASU prepends nine bytes to the ECU's UDS reply.
    if (frame.length < 14 || frame[2] === 0x7f || frame[6] !== batteryEcu ||
        frame[9] !== 0x62 || frame.readUInt16BE(10) !== did) return;
    if (did === voltageDid) return frame.readUInt16BE(12) / 100;
    if (did === currentDid && frame.length >= 16) return -frame.readInt16BE(14) / 100;
}

function createPowerProbe(builders, { periodMs = 1000, retryMs = 5000, replyMs = 1500 } = {}) {
    const signal = 'batteryPowerHv';
    let record = { signal, status: 'no-sample' };
    let current;
    let closing = Promise.resolve();

    async function read(job, proxy, did) {
        const data = Buffer.from([did >> 8, did & 0xff]);
        let timer;
        const response = new Promise((resolve) => {
            job.cancel = () => resolve(null);
            timer = setTimeout(job.cancel, replyMs);
            job.onResponse = (event) => {
                const value = readValue(event, did);
                if (value !== undefined) resolve({ value, at: Date.now() });
            };
        });
        try {
            const result = await proxy.sendTasuRequest({
                sourceAddress: 0xf2, targetAddress: batteryEcu, serviceID: 0x22, subroutineID: 0,
                udsDataLength: data.length, udsData: data, deadlockTime: 0
            });
            const verdict = result && typeof result === 'object' ? result.TasuErrorEnum : result;
            if (verdict !== 'NO_ERROR' && verdict !== 'REQUEST_PENDING' && verdict !== 0 && verdict !== 1) return null;
            return await response;
        } catch (_) {
            return null;
        } finally {
            clearTimeout(timer);
            job.onResponse = null;
            job.cancel = null;
        }
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
                if (volts) await pause(job, 25);
                if (job !== current) break;
                const amps = volts && await read(job, proxy, currentDid);
                if (job !== current) break;
                const paired = amps && amps.at >= volts.at && amps.at - volts.at <= replyMs;
                if (paired) {
                    record = { signal, status: 'sample', sampledAt: amps.at, freshForMs: 3 * periodMs,
                        fields: { kw: volts.value * amps.value / 1000, volts: volts.value, amps: amps.value } };
                } else {
                    record = { signal, status: 'error', phase: 'getter' };
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
