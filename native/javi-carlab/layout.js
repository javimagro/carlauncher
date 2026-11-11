'use strict';

const { width, height, leftPanel, rightPanel } = require('./launcher-view.js');

function fitArea(area, logicalWidth, logicalHeight) {
    const scale = Math.min(area.w / logicalWidth, area.h / logicalHeight);
    const w = Math.round(logicalWidth * scale);
    const h = Math.round(logicalHeight * scale);
    return { x: area.x + Math.floor((area.w - w) / 2), y: area.y + Math.floor((area.h - h) / 2), w, h, scale };
}

module.exports = function layout(area) {
    const launcher = fitArea(area, width, height);
    const { scale } = launcher;
    const position = (panel) => ({
        x: launcher.x + Math.round(panel.x * scale), y: launcher.y + Math.round(panel.y * scale),
        w: Math.round(panel.w * scale), h: Math.round(panel.h * scale), scale
    });
    return { launcher, projection: position(leftPanel), radio: position(rightPanel) };
};
module.exports.fitArea = fitArea;
