'use strict';

const width = 1960;
const height = 520;
const viewport = { x: 966, y: 4, w: width - 970, h: 468 };
const gap = 9;
const wide = 556;
const narrow = viewport.w - wide - gap;
const cards = [
    { id: 'trip', title: 'TRAYECTO', w: wide },
    { id: 'radio', title: 'RADIO', w: narrow },
    { id: 'weather', title: 'EL TIEMPO', w: wide },
    { id: 'news', title: 'NOTICIAS', w: viewport.w }
];
let offset = 0;
for (const card of cards) {
    card.x = offset;
    offset += card.w + gap;
}
const anchors = [0, cards[1].x, cards[3].x];
const cardPages = [0, 0, 1, 2];
const pageCards = [0, 1, 3];
const directions = { 1: 'up', 2: 'up', 4: 'right', 5: 'right', 7: 'down', 8: 'down', 10: 'left', 11: 'left' };
const dailyChart = { x: 36, y: 281, w: wide - 57, h: 153 };
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const contains = (rect, x, y) => x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;

function createDriveHub(invalidate, now = Date.now) {
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
                scroll = clamp(gesture.scroll + dx, 0, anchors[2]);
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
            interact(start.index, Math.sign(dy));
        } else if (Math.max(Math.abs(dx), Math.abs(dy)) < 15 && contains(viewport, x, y) && start.index >= 0) {
            const localX = x - viewport.x - cards[start.index].x + position();
            if (cards[start.index].id === 'weather' && state.weatherPage === 'rain'
                && contains(dailyChart, localX, y - viewport.y)) {
                state.weatherDay = Math.floor((localX - dailyChart.x) * 7 / dailyChart.w);
            }
            select(start.index, start.page);
        } else {
            select(state.selected, start.page);
        }
    }

    return {
        state,
        position,
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
            if (event.press === 15 && event.tilt === 15) return;
            if (knob !== undefined) {
                const delta = ((event.knob - knob + 32768) & 0xffff) - 32768;
                if (delta && Math.abs(delta) <= 64) moveCard(delta);
            }
            knob = event.knob;
            const down = event.press === 1 || event.press === 2;
            if (down && !pressed) interact(state.selected, 1);
            pressed = down;
            const direction = directions[event.tilt];
            if (direction && direction !== tilt) {
                if (direction === 'up' || direction === 'down') interact(state.selected, direction === 'up' ? -1 : 1);
                else moveCard(direction === 'left' ? -1 : 1);
            }
            tilt = direction;
        }
    };
}

module.exports = { width, height, cards, viewport, dailyChart, createDriveHub };
