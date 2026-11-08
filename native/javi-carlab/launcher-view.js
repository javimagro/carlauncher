'use strict';

const width = 1600;
const height = 520;
const rightPanel = { x: 878, y: 6, w: 716, h: 428 };
const status = [
    ['Bateria', '64 %'],
    ['Autonomia', '248 km'],
    ['Temp. HV', '24 C'],
    ['Parada de carga', '38 km'],
    ['Al llegar', '19 %']
];

function drawLauncher(cv, { expanded = false, external = false } = {}) {
    const panelX = expanded ? 96 : rightPanel.x;
    const panelW = width - panelX - 6;
    cv.clear(external ? [0, 0, 0, 0] : '#080b0e');
    if (external) {
        cv.fillRect(0, 0, panelX, height, '#080b0e');
        cv.fillRect(panelX, 0, width - panelX, rightPanel.y, '#080b0e');
        cv.fillRect(panelX + panelW, 0, 6, height, '#080b0e');
        cv.fillRect(panelX, 434, panelW, height - 434, '#080b0e');
    }

    cv.roundRect(6, 6, 84, 508, 10, '#04080c');
    if (!expanded) {
        cv.roundRect(96, 6, 776, 508, 10, '#142631');
        cv.text('Ruta de ejemplo', 120, 54, 28, '#afc0cf');
        cv.polyline([[235, 387], [360, 307], [419, 224], [572, 248], [690, 124]], 7, '#55baff');
        cv.circle(235, 387, 9, '#80cdff');
        cv.circle(690, 124, 9, '#80cdff');
    }
    if (!external) {
        cv.roundRect(panelX, 6, panelW, 428, 10, '#101a26');
        cv.text('Carlauncher', panelX + 24, 53, 27, '#afc0cf');
        cv.text('Hello World', panelX + 32, 220, 50, '#f0f5fa', { font: 'bold' });
        cv.text('Panel propio  /  Datos de ejemplo', panelX + 34, 263, 24, '#afc0cf');
    }

    const column = panelW / status.length;
    cv.roundRect(panelX, 440, panelW, 74, 10, '#04080c');
    status.forEach(([label, value], index) => {
        const x = panelX + column * index + 12;
        cv.text(label, x, 468, 17, '#afc0cf');
        cv.text(value, x, 499, 24, index === 0 ? '#a2e2b3' : '#f0f5fa');
    });
}

module.exports = { width, height, rightPanel, drawLauncher };
