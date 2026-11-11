import { createGfx } from '/gfx/mgu-gfx.js';

const stage = document.getElementById('stage');
const status = document.getElementById('status');
const home = document.documentElement.hasAttribute('data-drivehub');
const layers = new Map();
let sending = Promise.resolve();
let pointer;
let pressed = false;

function send(input) {
    sending = sending.then(async () => {
        const response = await fetch('/input', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input)
        });
        if (!response.ok) throw new Error('Entrada rechazada');
    }).catch((error) => { status.textContent = error.message; });
}

function touch(event, phase) {
    const r = stage.getBoundingClientRect();
    const { width, height } = layers.get('launcher').canvas;
    send({ phase, x: (event.clientX - r.left) * width / r.width, y: (event.clientY - r.top) * height / r.height });
}

try {
    for (const name of ['panel', 'launcher']) {
        const canvas = document.getElementById(name);
        layers.set(name, { canvas, gfx: await createGfx(canvas) });
    }
    const source = new EventSource('/frames');
    source.onmessage = ({ data }) => {
        const { layer, reset, data: encoded } = JSON.parse(data);
        const { canvas, gfx } = layers.get(layer);
        if (reset) gfx.reset();
        const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
        if (gfx.feed(bytes) < 0) {
            status.textContent = gfx.stats().error;
            return;
        }
        const info = gfx.stats();
        canvas.dataset.visible = String(info.visible);
        canvas.dataset.frames = info.frames;
        if (layers.get('launcher').canvas.dataset.visible === 'true') {
            const panel = layers.get('panel').gfx.stats();
            status.textContent = home ? 'Simulador conectado'
                : panel.visible ? `Dos procesos visibles · Radio en ${panel.place.w} × ${panel.place.h}` : 'CarLauncher visible · Radio cerrada';
        }
    };
    source.onerror = () => { status.textContent = 'Reconectando con el simulador local…'; };
} catch (error) {
    status.textContent = error.message;
    throw error;
}

stage.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || pointer !== undefined) return;
    stage.focus({ preventScroll: true });
    stage.setPointerCapture(event.pointerId);
    pointer = event.pointerId;
    touch(event, 1);
});
stage.addEventListener('pointermove', (event) => {
    if (home && pointer === event.pointerId) touch(event, 2);
});
for (const [name, phase] of [['pointerup', 3], ['pointercancel', 0], ['lostpointercapture', 0]]) {
    stage.addEventListener(name, (event) => {
        if (pointer !== event.pointerId) return;
        pointer = undefined;
        touch(event, phase);
    });
}
stage.addEventListener('wheel', (event) => {
    if (!event.deltaY) return;
    event.preventDefault();
    send({ turn: Math.sign(event.deltaY), press: pressed });
}, { passive: false });
stage.addEventListener('keydown', (event) => {
    const turns = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 };
    if (event.key === 'Enter') {
        event.preventDefault();
        if (pressed) return;
        pressed = true;
        send({ turn: 0, press: true });
    } else if (home && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        send({ turn: 0, press: pressed, tilt: event.key === 'ArrowUp' ? 1 : 7 });
        send({ turn: 0, press: pressed, tilt: 0 });
    } else if (Object.hasOwn(turns, event.key)) {
        event.preventDefault();
        send({ turn: turns[event.key], press: pressed });
    }
});
function release() {
    if (!pressed) return;
    pressed = false;
    send({ turn: 0, press: false });
}
stage.addEventListener('keyup', (event) => { if (event.key === 'Enter') release(); });
stage.addEventListener('blur', release);
