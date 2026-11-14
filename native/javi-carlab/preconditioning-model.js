'use strict';

function valid(frame) {
    return !!frame && typeof frame.available === 'boolean' && typeof frame.pending === 'boolean' &&
        (frame.active === null || typeof frame.active === 'boolean') &&
        (frame.mode === null || Number.isInteger(frame.mode) && frame.mode >= 0 && frame.mode <= 3) &&
        (frame.restriction === null || Number.isInteger(frame.restriction) && frame.restriction >= 0 && frame.restriction <= 5) &&
        (frame.requestId === null || typeof frame.requestId === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(frame.requestId)) &&
        [null, 'confirmed', 'restricted', 'unavailable', 'error', 'timeout'].includes(frame.result);
}
module.exports = { valid };
