'use strict';

const { width, height, rightPanel } = require('./launcher-view.js');

module.exports = function layout(area) {
    const scale = Math.min(area.w / width, area.h / height);
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    const launcher = { x: area.x + Math.floor((area.w - w) / 2), y: area.y + Math.floor((area.h - h) / 2), w, h, scale };
    const radio = {
        x: launcher.x + Math.round(rightPanel.x * scale), y: launcher.y + Math.round(rightPanel.y * scale),
        w: Math.round(rightPanel.w * scale), h: Math.round(rightPanel.h * scale), scale
    };
    return { launcher, radio };
};
