'use strict';

const { preconditioningButton: box } = require('./drivehub-state');
const { preconditioningIcon } = require('./cockpit-view');
const { valid } = require('./preconditioning-model');
const reasons = ['Sin restricciones', 'Autonomía insuficiente', 'El coche está cargando',
    'Autonomía restante insuficiente', 'Autonomía crítica', 'Modo de máxima eficiencia activo'];
const failures = {
    permission: 'BMWLauncher no tiene permiso para cambiar el precalentamiento.',
    'no-response': 'El control de batería BMW no respondió a la orden.',
    service: 'Se perdió la conexión con el control de batería BMW.',
    rejected: 'BMW rechazó la orden de precalentamiento sin indicar el motivo.'
};
function createPreconditioningUI(send, changed, notify = () => {}) {
    let frame, at = 0, sequence = 0, request;
    const prefix = 'hv-' + Date.now().toString(36) + '-';
    function state(now) {
        const available = frame && now - at < 5000 && frame.available && frame.active !== null && frame.mode !== null;
        if (request && now - request.at > 16000) {
            request = null;
            notify('BMWLauncher no ha recibido respuesta del control de precalentamiento.', now);
        }
        return { available: !!available, selected: !!(available && (frame.active || frame.mode === 1 || frame.mode === 3)),
            pending: !!request || !!(frame && now - at < 5000 && frame.pending) };
    }
    return { state,
        receive(value, now) {
            frame = valid(value) ? value : null; at = now;
            if (request && frame && frame.requestId === request.id && frame.result && !frame.pending) {
                const enabled = request.enabled; request = null;
                const outcome = frame.result === 'error' && enabled && frame.restriction > 0 ? 'restricted' : frame.result;
                const labels = { confirmed: enabled ? 'Preacondicionamiento HV solicitado a BMW' : 'Preacondicionamiento HV desactivado',
                    restricted: 'Precalentamiento bloqueado por BMW · ' + (reasons[frame.restriction] || 'Restricción sin identificar'),
                    unavailable: 'BMW no ha enviado un estado válido de la batería para cambiar el precalentamiento.',
                    error: failures[frame.failure] || 'La orden de precalentamiento ha fallado y BMW no ha comunicado la causa.',
                    timeout: 'BMW no ha confirmado el precalentamiento. Comprueba su estado en el menú Carga.' };
                notify(labels[outcome], now);
            }
            changed();
        },
        toggle(now) {
            const current = state(now);
            if (current.pending) return;
            if (!current.available) { notify('Esperando el estado de preacondicionamiento de BMW', now); return; }
            const command = { id: prefix + (++sequence), op: 'precondition', enabled: !current.selected };
            if (!send || !send(command)) { notify('Sin conexión con el control de batería BMW', now); return; }
            request = { id: command.id, enabled: command.enabled, at: now };
            notify(command.enabled ? 'Solicitando preacondicionamiento HV…' : 'Desactivando preacondicionamiento HV…', now);
        },
        reset() { request = null; frame = null; changed(); }
    };
}
function drawPreconditioning(cv, ui, now, night) {
    const s = ui ? ui.state(now) : { available: false };
    const surface = s.pending ? (night ? '#665021' : '#ffe6a3') : s.selected ? '#175c66' : night ? '#293747' : '#ffffff';
    const ink = s.selected ? '#e4ffff' : !s.available ? (night ? '#a0adba' : '#667381') : night ? '#f0f4f8' : '#17212c';
    cv.roundRect(box.x, box.y, box.w, box.h, 8, surface);
    preconditioningIcon(cv, box.x + 6, box.y + 5, ink);
    cv.text(s.pending ? '…' : 'HV', box.x + box.w / 2, box.y + 42, 12, ink, { align: 'center' });
}
module.exports = { createPreconditioningUI, drawPreconditioning };
