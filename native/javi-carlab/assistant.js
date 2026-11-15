'use strict';

const { createConfig } = require('./assistant-config');
const { connect } = require('./assistant-client');
const { validArguments } = require('./assistant-tools');
const { isolatedAudio } = require('./assistant-audio');
const errors = { AUTH: 'API key rechazada o sin permiso para el modelo. Revísala en Ajustes.', QUOTA: 'El proveedor indica cuota agotada o demasiadas peticiones.',
    CREDIT_BALANCE: 'Saldo de la API agotado. Revisa la facturación del proveedor.',
    MODEL: 'El modelo seleccionado no está disponible para esta clave.',
    PROVIDER_ERROR: 'El proveedor ha rechazado la petición.', RESPONSE_FAILED: 'El proveedor no ha podido generar la respuesta.',
    DNS: 'No se pudo resolver el servidor del asistente. Comprueba el DNS.',
    TLS: 'No se ha podido verificar la conexión segura con el proveedor.',
    UPLINK: 'La conexión de la MGU a internet no está disponible. Revisa mgu-uplink.',
    WORKER: 'No se ha podido iniciar el proceso de conexión del asistente.',
    PROTOCOL: 'El proveedor ha devuelto una respuesta incompatible.',
    NO_CAPTURE: 'Micrófono pendiente de integrar en BMWLauncher. Usa «Escribir».', NO_SPEECH: 'No se ha detectado voz.',
    AUDIO_OUTPUT: 'Salida de voz no disponible en este entorno.',
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
    let outputFailed = false, voiceSession = false, speechAt = 0;
    const seen = new Set(), cancelled = new Set();
    function refresh() { state.config = config.snapshot(); invalidate(); }
    function inform(message) {
        state.message = message;
        if (options.notify) options.notify(message);
        invalidate();
    }
    config.ready.then(() => { state.loading = false; refresh(); });
    function stop() {
        generation++; clearTimeout(turnTimer); if (client) client.close(); client = null; pendingText = null;
        audioToken = null; if (audio) audio.close(); audio = null; pendingListen = false;
        outputFailed = false; voiceSession = false; speechAt = 0;
        state.indicator = '';
        state.busy = false; if (state.status !== 'error') state.status = 'idle'; seen.clear(); cancelled.clear(); queue = Promise.resolve(); invalidate();
    }
    function fail(code) {
        const provider = state.config.provider === 'gemini' ? 'Gemini' : 'OpenAI';
        const localAudio = ['NO_CAPTURE', 'NO_SPEECH', 'AUDIO_OUTPUT', 'MICROPHONE'].includes(code);
        const http = /^HTTP_(\d{3})$/.exec(code || '');
        state.status = 'error';
        inform((localAudio ? '' : provider + ' · ') + (errors[code] || (http ? 'El servidor devolvió HTTP ' + http[1] + '.' : 'La sesión no se ha podido completar.')));
        stop();
    }
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
        if (event.type === 'interrupt') { stop(); inform('Respuesta interrumpida. Puedes hacer otra petición.'); return; }
        if (event.type === 'ready') { state.status = 'ready'; if (pendingListen) { pendingListen = false; beginListening(); } else if (pendingText) { const text = pendingText; pendingText = null; sendText(text); } }
        else if (event.type === 'text') state.answer = (state.answer + event.text).slice(-8000);
        else if (event.type === 'input') state.input = ((state.input === 'Petición por voz' ? '' : state.input) + event.text).slice(-1000);
        else if (event.type === 'turn') {
            if (audio) audio.finish();
            clearTimeout(turnTimer); state.busy = voiceSession && state.indicator === 'speaking'; state.status = 'ready';
            if (voiceSession && state.indicator !== 'speaking') stop();
        }
        else if (event.type === 'audio') {
            ensureAudio();
            if (audio && !outputFailed) { if (voiceSession) state.indicator = 'speaking'; audio.pcm(event.data); }
        }
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
            if (event.type === 'capture') {
                if (state.status !== 'listening' || !client) return;
                client.send({ op: 'pcm', data: event.data });
                if (voiceSession && event.speaking) speechAt = Date.now();
                else if (voiceSession && speechAt && Date.now() - speechAt >= 900) audio.listen();
            }
            else if (event.type === 'capture-end') {
                if (state.status !== 'listening') return;
                clearTimeout(turnTimer);
                if (!event.samples) { fail('MICROPHONE'); return; }
                if (voiceSession && !speechAt) { fail('NO_SPEECH'); return; }
                if (event.samples < 2400) { fail('MICROPHONE'); return; }
                if (client) client.send({ op: 'audio-end' }); state.status = 'thinking';
                if (voiceSession) state.indicator = 'processing';
                turnTimer = setTimeout(() => fail('SETUP_TIMEOUT'), 90000);
            } else if (event.type === 'audio-error') {
                state.audio = '';
                if (state.status === 'listening') { fail('MICROPHONE'); return; }
                outputFailed = true;
                audioToken = null; if (audio) audio.close(); audio = null;
                if (voiceSession) fail('AUDIO_OUTPUT');
                else inform(event.message);
            } else if (event.type === 'audio-status') {
                if (event.failed) {
                    state.audio = '';
                    if (voiceSession) fail('AUDIO_OUTPUT');
                    else inform(event.message);
                } else {
                    state.audio = event.message;
                    if (voiceSession && event.finished && state.status === 'ready') beginListening();
                }
            }
            invalidate();
        });
    }
    function beginListening() {
        outputFailed = false;
        ensureAudio(); if (!audio || !client) return;
        state.status = 'listening'; state.busy = true; state.input = 'Petición por voz'; state.answer = ''; state.message = '';
        speechAt = 0;
        if (voiceSession) state.indicator = 'listening';
        clearTimeout(turnTimer);
        turnTimer = setTimeout(() => {
            if (voiceSession && !speechAt) fail('NO_SPEECH');
            else if (voiceSession) audio.listen();
            else fail('MICROPHONE');
        }, voiceSession ? 15000 : 35000);
        client.send({ op: 'listen' }); audio.listen(); invalidate();
    }
    function open(credentials, epoch) {
        client = (options.assistantConnect || connect)(Object.assign({}, credentials, { audio: !!(options.assistantAudio && options.assistantAudio.playback) }), (event) => receive(event, epoch), options.assistantNetwork);
    }
    return { state, ready: config.ready,
        setVisible(value) { if (active && !value) stop(); active = value; },
        toggleVoice() {
            if (voiceSession) { stop(); state.message = ''; invalidate(); return false; }
            if (closed || !active || state.loading) return false;
            if (!options.assistantAudio || !options.assistantAudio.capture) { fail('NO_CAPTURE'); return false; }
            const credentials = config.credentials();
            if (!credentials.key) { fail('CONFIG'); return false; }
            if (!options.assistantAudio.playback) { fail('AUDIO_OUTPUT'); return false; }
            stop();
            voiceSession = pendingListen = true;
            state.indicator = 'connecting';
            state.status = 'connecting'; state.busy = true; state.message = '';
            open(credentials, generation);
            invalidate(); return true;
        },
        previewVoice() {
            if (!options.assistantAudio || !options.assistantAudio.playback) {
                fail('AUDIO_OUTPUT');
                return false;
            }
            return this.submit('Di únicamente: Hola, soy tu asistente BMWLauncher. Esta es mi voz generada por inteligencia artificial.');
        },
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
            if (!options.assistantAudio || !options.assistantAudio.capture) { fail('NO_CAPTURE'); return false; }
            const credentials = config.credentials(); if (!credentials.key) { fail('CONFIG'); return false; }
            if (client && state.status === 'ready') { beginListening(); return true; }
            stop(); pendingListen = true; state.status = 'connecting'; state.busy = true; open(credentials, generation); invalidate(); return true;
        },
        async configure(patch) {
            if (state.saving || closed) return false;
            stop(); state.saving = true; invalidate();
            try { await config.update(patch); state.message = ''; refresh(); return true; }
            catch (_) { inform('No se pudo guardar. Revisa el valor y el almacenamiento privado.'); return false; }
            finally { state.saving = false; invalidate(); }
        },
        stop,
        close() { closed = true; active = false; stop(); }
    };
}
module.exports = { createAssistant };
