'use strict';

const { createConfig } = require('./assistant-config');
const { connect } = require('./assistant-client');
const { validArguments } = require('./assistant-tools');
const { isolatedAudio } = require('./assistant-audio');
const errors = { AUTH: 'API key rechazada. Revísala en Ajustes.', QUOTA: 'El proveedor indica cuota agotada o demasiadas peticiones.',
    SETUP_TIMEOUT: 'El asistente no ha respondido. Comprueba la conexión.', NETWORK: 'Sin conexión para el asistente.',
    NETWORK_OR_AUTH: 'No se pudo conectar. Revisa internet y la API key.', CONFIG: 'Configura primero la API key.',
    DISCONNECTED: 'La conexión del asistente se ha cerrado.', IDLE_TIMEOUT: 'Sesión cerrada por inactividad.',
    MICROPHONE: 'No se pudo recibir el micrófono. Puedes reintentar o escribir tu petición.' };
function createAssistant(options, execute, invalidate) {
    options = options || {}; invalidate = invalidate || (() => {});
    const config = options.config || createConfig(options.assistantDirectory);
    const state = { status: 'idle', message: '', input: '', answer: '', config: config.snapshot(), busy: false, loading: true,
        audio: 'Micrófono y salida de voz pendientes de validar en la MGU', saving: false };
    let client, audio, audioToken, generation = 0, active = false, closed = false, pendingText, pendingListen = false, turnTimer, queue = Promise.resolve();
    let outputFailed = false;
    const seen = new Set(), cancelled = new Set();
    function refresh() { state.config = config.snapshot(); invalidate(); }
    config.ready.then(() => { state.loading = false; refresh(); });
    function stop() {
        generation++; clearTimeout(turnTimer); if (client) client.close(); client = null; pendingText = null;
        audioToken = null; if (audio) audio.close(); audio = null; pendingListen = false;
        outputFailed = false;
        state.busy = false; if (state.status !== 'error') state.status = 'idle'; seen.clear(); cancelled.clear(); queue = Promise.resolve(); invalidate();
    }
    function fail(code) { state.status = 'error'; state.message = errors[code] || 'No se pudo completar la petición. Vuelve a intentarlo.'; stop(); }
    function sendText(text) {
        outputFailed = false;
        audioToken = null; if (audio) audio.close(); audio = null;
        state.input = text; state.answer = ''; state.message = ''; state.busy = true; state.status = 'thinking';
        clearTimeout(turnTimer); turnTimer = setTimeout(() => fail('SETUP_TIMEOUT'), 90000);
        client.send({ op: 'text', text }); invalidate();
    }
    function receive(event, epoch) {
        if (closed || !active || epoch !== generation) return;
        if (event.type === 'error') { fail(event.code); return; }
        if (event.type === 'interrupt') { stop(); state.message = 'Respuesta interrumpida. Puedes hacer otra petición.'; return; }
        if (event.type === 'ready') { state.status = 'ready'; if (pendingListen) { pendingListen = false; beginListening(); } else if (pendingText) { const text = pendingText; pendingText = null; sendText(text); } }
        else if (event.type === 'text') state.answer = (state.answer + event.text).slice(-8000);
        else if (event.type === 'input') state.input = ((state.input === 'Petición por voz' ? '' : state.input) + event.text).slice(-1000);
        else if (event.type === 'turn') { if (audio) audio.finish(); clearTimeout(turnTimer); state.busy = false; state.status = 'ready'; }
        else if (event.type === 'audio') { ensureAudio(); if (audio) audio.pcm(event.data); }
        else if (event.type === 'cancel') event.ids.forEach((id) => cancelled.add(id));
        else if (event.type === 'tool') {
            if (!state.busy || seen.has(event.id)) return;
            if (seen.size >= 128) { fail('TOOL_LIMIT'); return; }
            seen.add(event.id);
            const alive = () => !closed && active && epoch === generation && !cancelled.has(event.id);
            queue = queue.then(async () => {
                if (!alive()) return;
                let result;
                try { result = validArguments(event.name, event.args) ? await execute(event.name, event.args, alive) : { status: 'error', message: 'Argumentos no válidos' }; }
                catch (_) { result = { status: 'error', message: 'La acción no se pudo completar' }; }
                if (alive() && client) {
                    if (Buffer.byteLength(JSON.stringify(result || {})) > 24000) result = { status: 'error', message: 'Resultado demasiado grande. Concreta la petición.' };
                    client.send({ op: 'result', id: event.id, result: result || { status: 'unavailable' } });
                }
            });
        }
        invalidate();
    }
    function ensureAudio() {
        if (audio || outputFailed || !options.assistantAudio) return;
        const epoch = generation, token = {}; audioToken = token;
        audio = (options.assistantAudioFactory || isolatedAudio)(options.assistantAudio, (event) => {
            if (epoch !== generation || token !== audioToken || !active || closed) return;
            if (event.type === 'capture') { if (client) client.send({ op: 'pcm', data: event.data }); }
            else if (event.type === 'capture-end') {
                if (state.status !== 'listening') return;
                clearTimeout(turnTimer);
                if (event.samples < 2400) { fail('MICROPHONE'); return; }
                if (client) client.send({ op: 'audio-end' }); state.status = 'thinking';
                turnTimer = setTimeout(() => fail('SETUP_TIMEOUT'), 90000);
            } else if (event.type === 'audio-error') {
                state.audio = event.message;
                if (state.status === 'listening') { fail('MICROPHONE'); return; }
                outputFailed = true;
                audioToken = null; if (audio) audio.close(); audio = null;
            } else if (event.type === 'audio-status') state.audio = event.message;
            invalidate();
        });
    }
    function beginListening() {
        outputFailed = false;
        ensureAudio(); if (!audio || !client) return;
        state.status = 'listening'; state.busy = true; state.input = 'Petición por voz'; state.answer = ''; state.message = '';
        clearTimeout(turnTimer); turnTimer = setTimeout(() => fail('MICROPHONE'), 35000);
        client.send({ op: 'listen' }); audio.listen(); invalidate();
    }
    function open(credentials, epoch) {
        client = (options.assistantConnect || connect)(Object.assign({}, credentials, { audio: credentials.speak && !!(options.assistantAudio && options.assistantAudio.playback) }), (event) => receive(event, epoch), options.assistantNetwork);
    }
    return { state, ready: config.ready,
        setVisible(value) { if (active && !value) stop(); active = value; },
        submit(text) {
            if (closed || !active || state.loading || state.busy || typeof text !== 'string' || !text.trim()) return false;
            text = text.trim().slice(0, 1000);
            const credentials = config.credentials();
            if (!credentials.key) { fail('CONFIG'); return false; }
            if (client && state.status === 'ready') { sendText(text); return true; }
            stop(); const epoch = generation; state.status = 'connecting'; state.busy = true; state.message = ''; pendingText = text;
            open(credentials, epoch);
            invalidate(); return true;
        },
        listen() {
            if (closed || !active || state.loading) return false;
            if (state.status === 'listening' && audio) { audio.listen(); return true; }
            if (state.busy) return false;
            if (!options.assistantAudio || !options.assistantAudio.capture) { state.message = 'Micrófono de la MGU pendiente de validar. Puedes escribir tu petición.'; invalidate(); return false; }
            const credentials = config.credentials(); if (!credentials.key) { fail('CONFIG'); return false; }
            if (client && state.status === 'ready') { beginListening(); return true; }
            stop(); pendingListen = true; state.status = 'connecting'; state.busy = true; open(credentials, generation); invalidate(); return true;
        },
        async configure(patch) {
            if (state.saving || closed) return false;
            stop(); state.saving = true; invalidate();
            try { await config.update(patch); state.message = 'Configuración guardada'; refresh(); return true; }
            catch (_) { state.message = 'No se pudo guardar. Revisa el valor y el almacenamiento privado.'; return false; }
            finally { state.saving = false; invalidate(); }
        },
        stop,
        close() { closed = true; active = false; stop(); }
    };
}
module.exports = { createAssistant };
