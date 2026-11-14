'use strict';

const width = 1960;
const height = 520;
const inset = 4;
const formerSidebarWidth = 84;
const split = 966 + formerSidebarWidth;
const energyBar = { x: inset, y: height - inset - 40, w: split - 3 * inset, h: 40 };
const map = { x: energyBar.x, y: inset, w: energyBar.w, h: energyBar.y - 2 * inset };
const home = { x: map.x + map.w - 66, y: map.y + 10, w: 56, h: 48 };
const preconditioningButton = { x: map.x + map.w - 248, y: home.y, w: 52, h: home.h };
const viewport = { x: split, y: inset, w: width - split - inset, h: height - 2 * inset };
const gap = 9;
const wide = Math.round((viewport.w - gap) * 0.57);
const narrow = viewport.w - wide - gap;
const cards = [
    { id: 'trip', title: 'TRAYECTO', w: wide },
    { id: 'radio', title: 'RADIO', w: narrow },
    { id: 'weather', title: 'EL TIEMPO', w: wide },
    { id: 'news', title: 'NOTICIAS', w: viewport.w },
    { id: 'tdtworld', title: 'TDTWORLD', w: viewport.w }
];
let offset = 0;
for (const card of cards) {
    card.x = offset;
    offset += card.w + gap;
}
const pageCards = [0, 1, 3, 4];
const anchors = pageCards.map((index) => cards[index].x);
const cardPages = [0, 0, 1, 2, 3];
const directions = { 1: 'up', 2: 'up', 4: 'right', 5: 'right', 7: 'down', 8: 'down', 10: 'left', 11: 'left' };
const knobRange = 0xffff; // This value itself means invalid.
const halfKnobRange = Math.floor(knobRange / 2);
const dailyChart = { x: 36, y: 281, w: wide - 57, h: viewport.h - 315 };
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const contains = (rect, x, y) => x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;

function createDriveHub(invalidate, now = Date.now, tdt, radio) {
    const state = { selected: 0, weatherPage: 'summary', weatherDay: 0, article: 0 };
    let targetPage = 0;
    let scroll = 0;
    let transition;
    let gesture;
    let articleCount = 0;
    let knob;
    let pressed = false;
    let tilt = 0;

    function position() {
        if (!transition) return scroll;
        const elapsed = clamp((now() - transition.start) / 230, 0, 1);
        scroll = transition.from + (anchors[targetPage] - transition.from) * (1 - (1 - elapsed) ** 3);
        if (elapsed === 1) transition = undefined;
        return scroll;
    }

    function select(index, page = cardPages[index]) {
        const from = position();
        state.selected = index;
        targetPage = page;
        transition = from === anchors[page] ? undefined : { from, start: now() };
        invalidate();
    }

    function moveCard(direction) {
        select(clamp(state.selected + direction, 0, cards.length - 1));
    }

    function interact(index, direction) {
        if (cards[index].id === 'weather') {
            state.weatherPage = state.weatherPage === 'summary' ? 'rain' : 'summary';
            invalidate();
        } else if (cards[index].id === 'news' && articleCount > 0) {
            state.article = clamp(state.article + direction, 0, articleCount - 1);
            invalidate();
        }
    }

    function cardAt(x) {
        const at = x - viewport.x + position();
        return cards.findIndex((card) => at >= card.x && at < card.x + card.w);
    }

    function touch(phase, x, y) {
        if (phase === 'down') {
            gesture = contains(viewport, x, y) ? {
                x, y, index: cardAt(x), page: targetPage, scroll: position()
            } : undefined;
            return;
        }
        if (!gesture) return;
        if (phase === 'cancel') {
            gesture = undefined;
            select(state.selected, targetPage);
            return;
        }
        const dx = gesture.x - x;
        const dy = gesture.y - y;
        if (phase === 'move') {
            if (!gesture.axis && Math.max(Math.abs(dx), Math.abs(dy)) > 12) {
                gesture.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
            }
            if (gesture.axis === 'x') {
                transition = undefined;
                scroll = clamp(gesture.scroll + dx, 0, anchors[anchors.length - 1]);
                invalidate();
            }
            return;
        }
        if (phase !== 'up') return;
        const start = gesture;
        gesture = undefined;
        const axis = start.axis || (Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y');
        if (axis === 'x' && Math.abs(dx) >= 42) {
            if (dx > 0) {
                const page = clamp(start.page + 1, 0, anchors.length - 1);
                select(pageCards[page], page);
            } else {
                moveCard(-1);
            }
        } else if (axis === 'y' && Math.abs(dy) >= 40 && start.index >= 0) {
            select(start.index, start.page);
            if (tdt && cards[start.index].id === 'tdtworld') {
                tdt.touch(x - viewport.x, y - viewport.y, viewport.w, viewport.h, Math.sign(dy));
            } else if (radio && cards[start.index].id === 'radio') {
                radio.touch(x - viewport.x - cards[start.index].x + position(), y - viewport.y, cards[start.index].w, viewport.h, Math.sign(dy));
            } else interact(start.index, Math.sign(dy));
        } else if (Math.max(Math.abs(dx), Math.abs(dy)) < 15 && contains(viewport, x, y) && start.index >= 0) {
            const localX = x - viewport.x - cards[start.index].x + position();
            if (cards[start.index].id === 'weather' && state.weatherPage === 'rain'
                && contains(dailyChart, localX, y - viewport.y)) {
                state.weatherDay = Math.floor((localX - dailyChart.x) * 7 / dailyChart.w);
            }
            select(start.index, start.page);
            if (tdt && cards[start.index].id === 'tdtworld') tdt.touch(localX, y - viewport.y, viewport.w, viewport.h);
            if (radio && cards[start.index].id === 'radio') radio.touch(localX, y - viewport.y, cards[start.index].w, viewport.h);
        } else {
            select(state.selected, start.page);
        }
    }

    return {
        state,
        position,
        selectCard(index) { if (Number.isInteger(index) && index >= 0 && index < cards.length) select(index); },
        touch,
        animating: () => !!transition,
        setArticleCount(count, selected = state.article) {
            articleCount = count;
            state.article = clamp(selected, 0, Math.max(0, count - 1));
        },
        resetInput() {
            gesture = undefined;
            knob = undefined;
            pressed = false;
            tilt = 0;
            select(state.selected, targetPage);
        },
        controller(event) {
            if (event.knob === knobRange || (event.press === 15 && event.tilt === 15)) return;
            const down = event.press === 1 || event.press === 2;
            const direction = directions[event.tilt];
            if (knob === undefined) {
                knob = event.knob;
                pressed = down ? event.press : false;
                tilt = direction;
                return;
            }
            const delta = (event.knob - knob + knobRange + halfKnobRange) % knobRange - halfKnobRange;
            if (delta && Math.abs(delta) <= 64) {
                if (tdt && cards[state.selected].id === 'tdtworld') tdt.rotate(delta);
                else if (radio && cards[state.selected].id === 'radio') radio.rotate(delta);
                else moveCard(delta);
            }
            knob = event.knob;
            const deflected = direction && direction !== tilt;
            if (deflected && (direction === 'left' || direction === 'right')) {
                if (!(radio && cards[state.selected].id === 'radio' && radio.tilt(direction))) moveCard(direction === 'left' ? -1 : 1);
            } else if (radio && cards[state.selected].id === 'radio') {
                if (event.press === 2 && pressed !== 2) radio.press(true);
                if (!down && pressed === 1) radio.press(false);
                if (deflected) radio.tilt(direction);
            } else if (tdt && cards[state.selected].id === 'tdtworld') {
                if (event.press === 2 && pressed !== 2) tdt.press(true);
                if (!down && pressed === 1) tdt.press(false);
                if (deflected) tdt.tilt(direction === 'up' ? -1 : 1);
            } else {
                if (down && !pressed) interact(state.selected, 1);
                if (deflected) interact(state.selected, direction === 'up' ? -1 : 1);
            }
            pressed = down ? event.press : false;
            tilt = direction;
        }
    };
}

module.exports = { width, height, cards, map, home, preconditioningButton, energyBar, viewport, dailyChart, contains, createDriveHub };
