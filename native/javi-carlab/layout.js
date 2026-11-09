'use strict';

const { width, height, leftPanel, rightPanel } = require('./launcher-view.js');

module.exports = function layout(area) {
    const scale = Math.min(area.w / width, area.h / height);
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    const launcher = { x: area.x + Math.floor((area.w - w) / 2), y: area.y + Math.floor((area.h - h) / 2), w, h, scale };
    const position = (panel) => ({
        x: launcher.x + Math.round(panel.x * scale), y: launcher.y + Math.round(panel.y * scale),
        w: Math.round(panel.w * scale), h: Math.round(panel.h * scale), scale
    });
    return { launcher, projection: position(leftPanel), radio: position(rightPanel) };
};
