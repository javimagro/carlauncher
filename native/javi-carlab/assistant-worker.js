'use strict';

// The only process that holds a cloud connection. Credentials arrive over IPC, never argv.
const WebSocket = require('./vendor/ws');
const protocol = require('./assistant-protocol');
const { validKey, providers } = require('./assistant-config');
const { validArguments } = require('./assistant-tools');
function start(config, emit, dependencies) {
    dependencies = dependencies || {};
    if (!config || !Object.prototype.hasOwnProperty.call(providers, config.provider) || !validKey(config.key) || !providers[config.provider].voices.includes(config.voice)) throw new Error('CONFIG');
    const connect = protocol.connection(config), WS = dependencies.WebSocket || WebSocket;
    const socket = new WS(connect.url, { headers: connect.headers, lookup: dependencies.lookup,
        handshakeTimeout: 12000, maxPayload: 256 * 1024, perMessageDeflate: false, followRedirects: false });
    let ended = false, ready = false, responseEnded = false, hadTools = false, count = 0, idle, timeout;
    const pending = new Map(), seen = new Set();
    function close() {
        if (ended) return; ended = true; clearTimeout(idle); clearTimeout(timeout); pending.clear();
        socket.terminate();
    }
    function fail(code) { if (!ended) { emit({ type: 'error', code }); close(); } }
    function touch() { clearTimeout(idle); idle = setTimeout(() => fail('IDLE_TIMEOUT'), 120000); }
    function send(event) {
        if (ended || socket.readyState !== WS.OPEN) return false;
        if (socket.bufferedAmount > 256 * 1024) { fail('NETWORK_BACKPRESSURE'); return false; }
        try { socket.send(JSON.stringify(event), (error) => { if (error) fail('NETWORK'); }); return true; }
        catch (_) { fail('NETWORK'); return false; }
    }
    function complete() {
        if (config.provider !== 'openai' || !responseEnded || pending.size) return;
        responseEnded = false;
        if (hadTools) { hadTools = false; send({ type: 'response.create' }); }
        else emit({ type: 'turn' });
    }
    socket.on('open', () => send(protocol.setup(config)));
    socket.on('error', () => fail('NETWORK_OR_AUTH'));
    socket.on('unexpected-response', (_, response) => { const code = response.statusCode; response.resume(); fail(code === 401 || code === 403 ? 'AUTH' : code === 429 ? 'QUOTA' : 'HTTP_' + code); });
    socket.on('close', () => fail('DISCONNECTED'));
    socket.on('message', (bytes) => {
        if (ended) return;
        let message; try { message = JSON.parse(String(bytes)); } catch (_) { fail('PROTOCOL'); return; }
        touch();
        for (const event of protocol.events(config.provider, message)) {
            if (ended) break;
            if (event.type === 'error') { fail(event.code); break; }
            if (event.type === 'ready') { ready = true; clearTimeout(timeout); emit(event); }
            else if (event.type === 'tool') {
                if (!ready || typeof event.id !== 'string' || event.id.length > 200 || !event.id) { fail('PROTOCOL'); break; }
                if (seen.has(event.id)) continue;
                if (++count > 32 || seen.size >= 128) { fail('TOOL_LIMIT'); break; }
                seen.add(event.id); pending.set(event.id, event.name); hadTools = true;
                if (!validArguments(event.name, event.args)) result(event.id, { status: 'error', message: 'Herramienta o argumentos no válidos' });
                else emit(event);
            } else if (event.type === 'turn') {
                if (config.provider === 'openai') { responseEnded = true; complete(); }
                else if (!pending.size) emit(event);
            } else if (event.type === 'cancel') {
                event.ids.slice(0, 32).forEach((id) => pending.delete(id)); emit(event);
            } else if (event.type === 'audio') {
                if (config.audio && typeof event.data === 'string' && event.data.length <= 192000) emit(event);
            } else if (event.type === 'text' || event.type === 'input') {
                if (typeof event.text === 'string') emit({ type: event.type, text: event.text.slice(0, 4000) });
            } else emit(event);
        }
    });
    function result(id, value) {
        if (ended || !pending.has(id)) return;
        const name = pending.get(id); pending.delete(id);
        protocol.toolResult(config.provider, id, name, value).forEach(send); complete();
    }
    timeout = setTimeout(() => fail('SETUP_TIMEOUT'), 15000); touch();
    return { close, result,
        beginAudio() { count = 0; if (config.provider === 'gemini') send({ realtimeInput: { activityStart: {} } }); },
        text(value) {
            if (!ready || ended || typeof value !== 'string' || !value.trim() || value.length > 1000) return false;
            count = 0; touch(); protocol.textInput(config.provider, value).forEach(send); return true;
        },
        audio(bytes, finish) {
            if (!ready || ended) return;
            if (finish) {
                if (config.provider === 'openai') { send({ type: 'input_audio_buffer.commit' }); send({ type: 'response.create' }); }
                else send({ realtimeInput: { activityEnd: {} } });
            } else if (bytes && bytes.length <= 48000) {
                const base64 = bytes.toString('base64');
                send(config.provider === 'openai' ? { type: 'input_audio_buffer.append', audio: base64 } :
                    { realtimeInput: { audio: { data: base64, mimeType: 'audio/pcm;rate=24000' } } });
            }
        }
    };
}
if (require.main === module) {
    let session, outgoing = 0;
    const emit = (message) => {
        if (!process.connected) return;
        if (++outgoing > 32) { if (session) session.close(); process.exit(1); return; }
        process.send(message, () => { outgoing--; });
    };
    process.on('message', (m) => {
        try {
            if (m.op === 'start' && !session) session = start(m.config, emit, { lookup: m.uplink ? require('./drivehub-network').lookupForUplink() : undefined });
            else if (m.op === 'text' && session) session.text(m.text);
            else if (m.op === 'result' && session) session.result(m.id, m.result);
            else if (m.op === 'listen' && session) session.beginAudio();
            else if (m.op === 'pcm' && session && typeof m.data === 'string' && m.data.length <= 64000) session.audio(Buffer.from(m.data, 'base64'));
            else if (m.op === 'audio-end' && session) session.audio(null, true);
            else if (m.op === 'close') { if (session) session.close(); process.exit(0); }
        } catch (_) { emit({ type: 'error', code: 'WORKER' }); if (session) session.close(); process.exitCode = 1; }
    });
    process.on('disconnect', () => { if (session) session.close(); process.exit(0); });
}
module.exports = { start };
