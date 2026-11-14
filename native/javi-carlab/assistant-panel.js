'use strict';

const { providers, validKey } = require('./assistant-config');
function action(ui, id, show, invalidate) {
    const s = ui.state, assistant = ui.assistant;
    if (!assistant || id.indexOf('assistant:') !== 0) return false;
    const name = id.slice(10), a = assistant.state;
    if (name !== 'remove') s.confirmKeyRemoval = false;
    if (name === 'open') show('assistant');
    else if (name === 'settings') show('assistant-settings');
    else if (name === 'provider') assistant.configure({ provider: a.config.provider === 'openai' ? 'gemini' : 'openai' });
    else if (name === 'voice') { s.assistantVoiceOffset = 0; show('assistant-voices'); }
    else if (name.indexOf('voice:') === 0) { assistant.configure({ voice: name.slice(6) }); s.stack.pop(); s.panel = 'assistant-settings'; s.focus = -1; }
    else if (name === 'voices-up') s.assistantVoiceOffset = Math.max(0, (s.assistantVoiceOffset || 0) - 4);
    else if (name === 'voices-down') s.assistantVoiceOffset = Math.min(providers[a.config.provider].voices.length - 4, (s.assistantVoiceOffset || 0) + 4);
    else if (name === 'speak') assistant.configure({ speak: !a.config.speak });
    else if (name === 'preview') { show('assistant'); assistant.submit('Di únicamente: Hola, soy tu asistente BMWLauncher. Esta es mi voz generada por inteligencia artificial.'); }
    else if (name === 'stop') assistant.stop();
    else if (name === 'listen') assistant.listen ? assistant.listen() : (a.message = a.audio);
    else if (name === 'key' || name === 'write') {
        s.assistantEditor = { kind: name === 'key' ? 'key' : 'text', draft: '', numbers: false, caps: name === 'key' };
        show('assistant-edit');
    } else if (name === 'remove') {
        if (s.confirmKeyRemoval) { s.confirmKeyRemoval = false; assistant.configure({ key: '' }); }
        else s.confirmKeyRemoval = true;
    } else if (s.assistantEditor) {
        const edit = s.assistantEditor, max = edit.kind === 'key' ? 2048 : 1000;
        if (edit.saving) return true;
        edit.error = '';
        if (name === 'erase') edit.draft = edit.draft.slice(0, -1);
        else if (name === 'clear') edit.draft = '';
        else if (name === 'numbers') edit.numbers = !edit.numbers;
        else if (name === 'caps') edit.caps = !edit.caps;
        else if (name.indexOf('char:') === 0 && edit.draft.length < max) edit.draft += name.slice(5);
        else if (name === 'save') {
            if (edit.kind === 'key' && !validKey(edit.draft)) { edit.error = 'La clave está incompleta o contiene caracteres no válidos'; return true; }
            function complete(ok) {
                if (s.assistantEditor !== edit) return;
                edit.saving = false;
                if (ok) {
                    edit.draft = ''; s.assistantEditor = null;
                    if (s.panel === 'assistant-edit') {
                        s.stack.pop(); s.panel = edit.kind === 'key' ? 'assistant-settings' : 'assistant'; s.focus = -1;
                    } else s.stack = s.stack.filter((entry) => entry.panel !== 'assistant-edit');
                } else edit.error = a.message || 'No se pudo completar. Puedes volver a intentarlo.';
                if (invalidate) invalidate();
            }
            if (edit.kind === 'key') {
                edit.saving = true;
                Promise.resolve(assistant.configure({ key: edit.draft })).then(complete, () => complete(false));
            } else complete(assistant.submit(edit.draft));
        }
    }
    return true;
}
function draw(surface) {
    const { ui, x, y, w, p, text, wrap, button } = surface, s = ui.state, a = ui.assistant.state;
    const busy = a.loading || a.saving, provider = providers[a.config.provider];
    if (s.panel === 'assistant-settings') {
        text('Proveedor y modelo', x + 20, y + 88, 18, p.secondary);
        button('assistant:provider', provider.label + ' · ' + provider.model, x + 20, y + 100, w - 40, 48, { disabled: busy });
        text('API key', x + 20, y + 177, 18, p.secondary);
        button('assistant:key', a.config.configured[a.config.provider] ? 'Configurada · sustituir' : 'Introducir API key', x + 20, y + 188, w - 164, 48, { disabled: busy });
        button('assistant:remove', s.confirmKeyRemoval ? 'Confirmar' : 'Borrar', x + w - 132, y + 188, 112, 48, { disabled: busy || !a.config.configured[a.config.provider] });
        text('Voz del asistente · generada por IA', x + 20, y + 263, 18, p.secondary);
        button('assistant:voice', a.config.voices[a.config.provider], x + 20, y + 274, 240, 48, { disabled: busy });
        button('assistant:preview', 'Oír voz', x + 272, y + 274, 156, 48, { disabled: busy || !a.config.configured[a.config.provider] });
        button('assistant:speak', a.config.speak ? 'Voz: activada' : 'Voz: desactivada', x + 440, y + 274, w - 460, 48, { disabled: busy });
        wrap(a.config.error || a.message || a.audio, x + 20, y + 357, w - 40, 18, a.config.error ? p.danger : p.secondary, 2);
    } else if (s.panel === 'assistant-voices') {
        const offset = s.assistantVoiceOffset || 0;
        text(provider.label + ' · elige una voz', x + 20, y + 88, 20, p.secondary);
        provider.voices.slice(offset, offset + 4).forEach((voice, i) => button('assistant:voice:' + voice, voice,
            x + 20, y + 108 + i * 58, w - 40, 48, { primary: voice === a.config.voices[a.config.provider], disabled: busy }));
        button('assistant:voices-up', 'Anterior', x + 20, y + 353, 200, 48, { disabled: !offset });
        button('assistant:voices-down', 'Siguiente', x + w - 220, y + 353, 200, 48, { disabled: offset + 4 >= provider.voices.length });
    } else if (s.panel === 'assistant') {
        text(({ idle: 'Listo', connecting: 'Conectando…', ready: 'Conectado', thinking: 'Consultando…', error: 'Revisa la conexión', listening: 'Escuchando…' })[a.status] || a.status,
            x + 20, y + 89, 18, p.accent);
        text(a.input || 'Pide una emisora, una tarjeta o los datos del coche.', x + 20, y + 124, 20, p.secondary, w - 40);
        wrap(a.message || a.answer || 'Por ejemplo: «Pon Onda Cero» o «Muéstrame el tiempo».', x + 20, y + 165, w - 40, 21, a.status === 'error' ? p.danger : p.text, 5);
        text(a.audio, x + 20, y + 333, 16, p.secondary, w - 40);
        button('assistant:write', 'Escribir', x + 20, y + 350, 156, 52, { primary: true, disabled: a.busy });
        button('assistant:listen', a.status === 'listening' ? 'Terminar' : 'Hablar', x + 188, y + 350, 148, 52, { disabled: a.busy && a.status !== 'listening' });
        button('assistant:stop', 'Detener', x + 348, y + 350, 148, 52);
        button('assistant:settings', 'Ajustes', x + 508, y + 350, w - 528, 52);
    } else if (s.panel === 'assistant-edit') {
        const edit = s.assistantEditor;
        if (!edit) return;
        text(edit.error || (edit.kind === 'key' ? 'API key · se guarda solo en este dispositivo' : 'Tu petición'), x + 20, y + 87, 18, edit.error ? p.danger : p.secondary, w - 40);
        text(edit.kind === 'key' ? (edit.draft ? '********' : 'Introduce la clave') : edit.draft.slice(-60) || 'Escribe aquí', x + 20, y + 124, 22, p.text, w - 45);
        const rows = edit.numbers ? ['1234567890-_', '@.:/+=!?(),', '[]{}#%&*;'] : ['qwertyuiop', 'asdfghjklñ', 'zxcvbnm'];
        rows.forEach((row, i) => {
            const letters = (edit.caps ? row.toUpperCase() : row).split(''), kw = (w - 40) / 11;
            letters.forEach((letter, j) => button('assistant:char:' + letter, letter, x + 20 + j * kw, y + 147 + i * 53, kw - 5, 46));
        });
        button('assistant:caps', edit.caps ? 'abc' : 'ABC', x + 20, y + 309, 90, 44);
        button('assistant:numbers', edit.numbers ? 'Letras' : '123', x + 120, y + 309, 100, 44);
        button('assistant:char: ', 'Espacio', x + 230, y + 309, 200, 44, { disabled: edit.kind === 'key' });
        button('assistant:erase', 'Borrar', x + 440, y + 309, 126, 44);
        button('assistant:clear', 'Vaciar', x + 578, y + 309, w - 598, 44);
        button('assistant:save', edit.saving ? 'Guardando…' : edit.kind === 'key' ? 'Guardar clave' : 'Enviar', x + 20, y + 365, w - 40, 50,
            { primary: true, disabled: busy || edit.saving || (edit.kind === 'key' ? !validKey(edit.draft) : !edit.draft.trim()) });
    }
}
module.exports = { action, draw };
