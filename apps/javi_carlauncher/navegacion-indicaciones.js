'use strict';

const names = ['NONE', 'STRAIGHT_ON', 'LEFT', 'SLIGHT_LEFT', 'HARD_LEFT', 'RIGHT', 'SLIGHT_RIGHT', 'HARD_RIGHT', 'UTURN_RIGHT', 'UTURN_LEFT'];
function description(value) {
    return value && Array.isArray(value.elements) ? value.elements.map((e) => typeof e.text === 'string' ? e.text : '')
        .filter(Boolean).join(' ').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 140) : '';
}
function instruction(dart) {
    const u = dart && dart.maneuver;
    if (!u) return null;
    const kind = ['intersection', 'roundabout', 'branch', 'destinationManeuver'].find((key) => u[key]);
    if (!kind || u[kind].unreliable === true) return null;
    const item = u[kind], distance = item.formattedDistance && item.formattedDistance.rawDistance;
    let direction = typeof item.direction === 'number' ? names[item.direction] : item.direction;
    if (kind === 'branch') {
        const branch = item.branchType;
        if ([1, 3, 6, 9, 11, 'BRANCH_LEFT', 'HIGHWAY_IN_LEFT', 'HIGHWAY_OUT_LEFT', 'FORK_LEFT', 'TRIPLE_FORK_LEFT'].includes(branch)) direction = 'SLIGHT_LEFT';
        else if ([2, 4, 7, 10, 12, 'BRANCH_RIGHT', 'HIGHWAY_IN_RIGHT', 'HIGHWAY_OUT_RIGHT', 'FORK_RIGHT', 'TRIPLE_FORK_RIGHT'].includes(branch)) direction = 'SLIGHT_RIGHT';
        else direction = 'STRAIGHT_ON';
    }
    return { kind, direction: names.includes(direction) ? direction : 'NONE',
        metres: Number.isFinite(distance) && distance >= 0 ? distance : null,
        road: description(item.description), exit: kind === 'roundabout' && Number.isInteger(item.exitNumber) ? item.exitNumber : null };
}
module.exports = { instruction, description };
