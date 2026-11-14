'use strict';

const { preconditioningButton: box, map } = require('./drivehub-state');
const { preconditioningIcon } = require('./cockpit-view');
const { valid } = require('./preconditioning-model');
const reasons = ['Sin restricciones', 'Autonomía insuficiente', 'El coche está cargando',
    'Autonomía restante insuficiente', 'Autonomía crítica', 'Modo de máxima eficiencia activo'];
function createPreconditioningUI(send, changed) {
    let frame, at = 0, sequence = 0, request, message = '', until = 0;
    const prefix = 'hv-' + Date.now().toString(36) + '-';
    function inform(text, now) { message = text; until = now + 8000; changed(); }
    function state(now) {
        const available = frame && now - at < 5000 && frame.available && frame.active !== null && frame.mode !== null;
        if (request && now - request.at > 16000) { request = null; inform('BMW no ha confirmado el cambio', now); }
        return { available: !!available, selected: !!(available && (frame.active || frame.mode === 1 || frame.mode === 3)),
            pending: !!request || !!(frame && now - at < 5000 && frame.pending), message: now < until ? message : '' };
    }
    return { state,
        receive(value, now) {
            frame = valid(value) ? value : null; at = now;
            if (request && frame && frame.requestId === request.id && frame.result && !frame.pending) {
                const enabled = request.enabled; request = null;
                const labels = { confirmed: enabled ? 'Preacondicionamiento HV solicitado a BMW' : 'Preacondicionamiento HV desactivado',
                    restricted: 'BMW: ' + (reasons[frame.restriction] || 'Preparación no disponible'),
                    unavailable: 'Estado de la batería no disponible', error: 'BMW no ha aceptado el cambio', timeout: 'BMW no ha confirmado el cambio' };
                inform(labels[frame.result], now);
            }
            changed();
        },
        toggle(now) {
            const current = state(now);
            if (current.pending) return;
            if (!current.available) { inform('Esperando el estado de preacondicionamiento de BMW', now); return; }
            const command = { id: prefix + (++sequence), op: 'precondition', enabled: !current.selected };
            if (!send || !send(command)) { inform('Sin conexión con el control de batería BMW', now); return; }
            request = { id: command.id, enabled: command.enabled, at: now };
            inform(command.enabled ? 'Solicitando preacondicionamiento HV…' : 'Desactivando preacondicionamiento HV…', now);
        },
        reset() { request = null; frame = null; message = ''; until = 0; changed(); }
    };
}
function drawPreconditioning(cv, ui, now, night) {
    const s = ui ? ui.state(now) : { available: false };
    const surface = s.pending ? (night ? '#665021' : '#ffe6a3') : s.selected ? '#175c66' : night ? '#293747' : '#ffffff';
    const ink = s.selected ? '#e4ffff' : !s.available ? (night ? '#a0adba' : '#667381') : night ? '#f0f4f8' : '#17212c';
    cv.roundRect(box.x, box.y, box.w, box.h, 8, surface);
    preconditioningIcon(cv, box.x + 6, box.y + 5, ink);
    cv.text(s.pending ? '…' : 'HV', box.x + box.w / 2, box.y + 42, 12, ink, { align: 'center' });
    if (s.message) {
        const x = map.x + 300, w = map.w - 320;
        const bg = night ? '#293747' : '#ffffff', color = night ? '#f0f4f8' : '#17212c';
        cv.roundRect(x, box.y + box.h + 8, w, 38, 7, bg);
        cv.text(s.message, x + w / 2, box.y + box.h + 33, 17, color, { align: 'center' });
    }
}
module.exports = { createPreconditioningUI, drawPreconditioning };
