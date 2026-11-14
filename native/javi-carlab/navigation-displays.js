'use strict';

// These are BMW preferences, not a second maneuver renderer or a HUD takeover.
const settings = [
    ['junction3dViewInKombiEnabled', 'Cruces 3D en el cuadro'],
    ['visualizationInKombiNonNaviEnabled', 'Guiado con otros contenidos del cuadro'],
    ['additionalInformationEnabled', 'Información adicional de navegación'],
    ['guidingPopupsEnabled', 'Avisos de maniobra BMW'],
    ['signboardPopupsEnabled', 'Carteles de dirección BMW']
];
const types = { NONE: 'Sin maniobra', HIGH_GUIDING: 'Maniobra', JUNCTION_VIEW: 'Cruce 3D', CITY_HIGHWAY_MAP: 'Mapa de cruce/autovía',
    SIGN_POST_INFO: 'Cartel de dirección', SAPA: 'Vista de guiado BMW', TUNNEL: 'Túnel', SCREENSHOT: 'Imagen BMW', NOTIFY: 'Aviso BMW' };
function validate(value) {
    if (value === undefined) return true; // Compatible with the previous OAP.
    if (!value || typeof value.available !== 'boolean' || !value.options || !value.hud || !Array.isArray(value.views) || value.views.length > 16) return false;
    if (!settings.every((s) => value.options[s[0]] === null || typeof value.options[s[0]] === 'boolean')) return false;
    if (![true, false, null].includes(value.hud.ready) || ![true, false, null].includes(value.hud.mapSelected) ||
        value.hud.layout !== null && (typeof value.hud.layout !== 'string' || value.hud.layout.length > 64)) return false;
    return value.views.every((v) => v && typeof v.id === 'string' && v.id.length <= 128 && ['IC', 'HUD'].includes(v.target) &&
        (v.type === null || Object.prototype.hasOwnProperty.call(types, v.type)) && typeof v.preview === 'boolean' && typeof v.consistent === 'boolean');
}
function summary(presentation, target) {
    if (!presentation) return 'Esperando datos BMW';
    const list = presentation.views.filter((v) => v.target === target && v.consistent && !v.preview && v.type && v.type !== 'NONE');
    const names = list.map((v) => types[v.type]).filter((n, i, all) => all.indexOf(n) === i);
    return names.length ? names.join(' · ') : 'Sin contenido anunciado';
}
function draw(context) {
    const { ui, x, y, w, p, text, wrap, button } = context, s = ui.state, nav = s.nav || {}, d = nav.presentation;
    text('Guiado original BMW · ' + (nav.state === 'active' ? 'ruta activa' : nav.state === 'calculating' ? 'calculando ruta' : 'sin ruta confirmada'), x + 20, y + 88, 19, p.text, w - 40);
    const ready = d && d.hud.ready;
    text('HUD: ' + (ready === true ? 'preparado' : ready === false ? 'no preparado' : 'sin lectura') + ' · BMW anuncia: ' + summary(d, 'HUD'), x + 20, y + 118, 17, p.secondary, w - 40);
    text('Cuadro · BMW anuncia: ' + summary(d, 'IC'), x + 20, y + 143, 17, p.secondary, w - 40);
    settings.forEach((setting, index) => {
        const value = d && d.options[setting[0]], yy = y + 159 + index * 44;
        text(setting[1], x + 20, yy + 26, 18, p.text, w - 176);
        button('guidance-setting:' + setting[0], value === true ? 'Activado' : value === false ? 'Desactivado' : 'Sin dato', x + w - 150, yy, 130, 38,
            { size: 17, primary: value === true, disabled: typeof value !== 'boolean' || s.pending || s.controls && s.controls.busy });
    });
    const message = s.message || s.displayFeedback;
    const errors = { BMW_GUIDANCE_SETTING_REJECTED: 'BMW no ha confirmado el cambio. Conserva su ajuste actual.',
        BMW_GUIDANCE_SETTING_UNAVAILABLE: 'Este ajuste no está disponible en BMW.' };
    wrap(s.pending ? 'Esperando confirmación de BMW…' : message === 'confirmed' ? 'Ajuste confirmado por BMW.' : message ? errors[message] || 'No se pudo confirmar el ajuste. Revisa la conexión.' :
        'Estos ajustes se guardan en BMW. El coche decide dónde mostrar cada vista.', x + 20, y + 402, w - 40, 15, message === 'confirmed' ? p.good : message ? p.warn : p.secondary, 2);
}
module.exports = { settings, types, validate, summary, draw };
