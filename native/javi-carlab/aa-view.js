'use strict';

const { map, home, preconditioningButton, energyBar, viewport } = require('./drivehub-state');
const { palettes } = require('./navigation-panels');
const { icon } = require('./navigation-icons');
const { fitGeometry } = require('./aa-frame');
const menu = { x: viewport.x + 24, y: viewport.y + 16, w: viewport.w - 48, h: viewport.h - 32 };
const column = (menu.w - 60) / 2;
const layout = {
    source: { x: preconditioningButton.x - 172, y: home.y, w: 164, h: home.h },
    settings: { x: energyBar.x + energyBar.w - 48, y: energyBar.y, w: 48, h: energyBar.h },
    energyInset: 56,
    content: map,
    menu,
    bmw: { x: menu.x + 24, y: menu.y + 94, w: column, h: 52 },
    aa: { x: menu.x + 36 + column, y: menu.y + 94, w: column, h: 52 },
    'focus-drivehub': { x: menu.x + 24, y: menu.y + 190, w: column, h: 52 },
    'focus-aa': { x: menu.x + 36 + column, y: menu.y + 190, w: column, h: 52 },
    diagnostics: { x: menu.x + 24, y: menu.y + 262, w: menu.w - 48, h: 52 },
    precondition: { x: menu.x + 24, y: menu.y + 326, w: menu.w - 48, h: 52 },
    home: { x: menu.x + 24, y: menu.y + 390, w: menu.w - 48, h: 52 },
    close: { x: menu.x + menu.w - 68, y: menu.y + 12, w: 44, h: 44 }
};
const menuActions = ['bmw', 'aa', 'focus-drivehub', 'focus-aa', 'diagnostics', 'precondition', 'home', 'close'];
const centered = { align: 'center' };
function button(cv, box, label, p, active, enabled) {
    cv.roundRect(box.x, box.y, box.w, box.h, 8, active ? p.selected : p.control);
    if (active) cv.strokeRoundRect(box.x + 1, box.y + 1, box.w - 2, box.h - 2, 8, 2, p.accent);
    cv.text(label, box.x + box.w / 2, box.y + box.h / 2 + 7, 18, enabled === false ? p.secondary : p.text, centered);
}
function drawSource(cv, ui, night) {
    if (!ui || !ui.state.header) return;
    const p = palettes[night ? 'night' : 'day'];
    button(cv, layout.source, 'Android Auto', p, false);
}
function drawSettings(cv, ui) {
    if (!ui || !ui.state.settings) return;
    const b = layout.settings, p = palettes.night;
    cv.roundRect(b.x, b.y, b.w, b.h, 8, ui.state.menu ? p.selected : p.control);
    icon(cv, 'settings', b.x + b.w / 2, b.y + b.h / 2, p.text, p.control, 0.8);
}
function drawMenu(cv, ui, night, preconditioning, now) {
    if (!ui || !ui.state.menu) return;
    const p = palettes[night ? 'night' : 'day'], b = layout.menu;
    const hv = preconditioning ? preconditioning.state(now) : { available: false };
    cv.fillRect(viewport.x, viewport.y, viewport.w, viewport.h, [0, 0, 0, 145]);
    cv.roundRect(b.x, b.y, b.w, b.h, 12, p.surface);
    cv.text('Pantalla y controles', b.x + 24, b.y + 43, 24, p.text);
    cv.text('MAPA', b.x + 24, b.y + 83, 14, p.secondary);
    cv.text('MANDO', b.x + 24, b.y + 179, 14, p.secondary);
    const labels = { bmw: 'BMW', aa: 'Android Auto', 'focus-drivehub': 'DriveHub', 'focus-aa': 'Android Auto',
        diagnostics: 'Datos del coche', precondition: 'Preacondicionamiento HV · ' +
            (hv.pending ? 'Solicitando…' : !hv.available ? 'Sin dato' : hv.selected ? 'Activado' : 'Desactivado'), home: 'Volver a iDrive' };
    menuActions.forEach((action, index) => {
        const box = layout[action], selected = action === ui.state.source || action === 'focus-' + ui.state.focus;
        if (action === 'close') {
            cv.roundRect(box.x, box.y, box.w, box.h, 8, p.control);
            icon(cv, 'close', box.x + box.w / 2, box.y + box.h / 2, p.text, p.control, 0.8);
        } else button(cv, box, labels[action], p, selected,
            action === 'focus-aa' ? ui.status().inputReady : action === 'precondition' ? hv.available && !hv.pending : true);
        if (action === 'home') {
            const x = box.x + 26, y = box.y + box.h / 2;
            cv.polyline([[x - 12, y], [x, y - 11], [x + 12, y]], 2, p.text);
            cv.strokeRoundRect(x - 8, y - 1, 16, 13, 2, 2, p.text);
        }
        if (index === ui.state.menuIndex) cv.strokeRoundRect(box.x - 2, box.y - 2, box.w + 4, box.h + 4, 9, 2, p.accent);
    });
}
function drawAA(cv, ui, night) {
    const p = palettes[night ? 'night' : 'day'], box = layout.content;
    cv.roundRect(map.x, map.y, map.w, map.h, 10, p.ground);
    const frame = ui.frame(), status = ui.status();
    const picture = frame && fitGeometry(box, frame.geometry);
    if (picture) {
        if (frame.image) cv.image(frame.image, picture.x, picture.y, picture.w, picture.h);
        else cv.video(frame.id, picture.x, picture.y, picture.w, picture.h);
    }
    const message = {
        unavailable: 'Conecta el teléfono a Android Auto',
        waiting: status.detail === 'aa-gate-restart-required' ? 'Actualiza el control del mando y reinicia iDrive' :
            status.detail === 'context-unavailable' ? 'Esperando a iDrive…' : 'Esperando los controles de BMWLauncher…',
        starting: 'Conectando Android Auto…', armed: 'Esperando la imagen de Android Auto…',
        'recovery-needed': 'Reconectando Android Auto…', error: 'No se ha podido abrir Android Auto'
    }[status.state];
    if (message) {
        const y = frame ? box.y + box.h - 28 : box.y + box.h / 2;
        if (frame) cv.roundRect(box.x + 20, y - 24, box.w - 40, 36, 8, p.surface);
        cv.text(message, box.x + box.w / 2, y, 21, p.text, centered);
        if (!frame) {
            const detail = status.state === 'error' && status.detail;
            cv.text(detail ? 'Código: ' + detail : status.state === 'error' ? 'Selecciona BMW y vuelve a Android Auto para reintentar' :
                'El mapa y los controles del teléfono aparecerán aquí', box.x + box.w / 2, y + 30, 17, p.secondary, centered);
        }
    } else if (status.state === 'playing' && !status.inputReady) {
        cv.text('Controles de Android Auto no disponibles', box.x + box.w / 2, box.y + box.h - 9, 16, p.secondary, centered);
    }
}

module.exports = { drawAA, drawSource, drawSettings, drawMenu, layout, menuActions };
