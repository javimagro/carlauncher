'use strict';

const { viewport, contains } = require('./drivehub-state');
const { mapInputPoint } = require('./aa-frame');
const { layout, menuActions } = require('./aa-view');

// Only assigns UI regions. The adapter owns transport, capture and BMW focus.
function createAAUI(adapter, changed, notify, action) {
    const state = { source: adapter ? 'aa' : 'bmw', focus: 'drivehub', header: false, settings: false, menu: false, menuIndex: 0 };
    let visible = false, active = false, closed = false, inputFocused = false, gesture, lastPoint, unwatch;
    let menuKnob, menuPressed = false;
    changed = changed || (() => {}); notify = notify || (() => {});
    action = action || (() => {});
    function status() { return adapter && adapter.status() || { state: 'unavailable', inputReady: false }; }
    function available() { const s = status(); return visible && active && s.state === 'playing' && !!s.inputReady; }
    function synchronizeFocus() {
        const next = available() && state.focus === 'aa' && !state.menu;
        if (inputFocused === next) return;
        inputFocused = next;
        if (adapter.setInputFocus) adapter.setInputFocus(next);
    }
    function cancel() {
        if (gesture && gesture.type === 'content' && lastPoint) adapter.touch('cancel', lastPoint);
        gesture = lastPoint = undefined;
    }
    function checkGesture() {
        if (!available() || (gesture && gesture.type === 'content' && gesture.frame !== adapter.frame())) cancel();
    }
    function refresh() {
        if (closed) return;
        checkGesture();
        synchronizeFocus(); changed();
    }
    if (adapter && adapter.changed) unwatch = adapter.changed(refresh);
    function focus(target) {
        if (state.focus === target) { synchronizeFocus(); return; }
        cancel(); state.focus = target; synchronizeFocus(); changed();
    }
    function setActive(next) {
        if (next === active) return;
        cancel(); active = next; synchronizeFocus(); adapter.setVisible(next); changed();
    }
    function update(onScreen, diagnostics, header) {
        visible = !!onScreen;
        state.header = !!adapter && visible && !diagnostics && state.source === 'bmw' && !!header;
        state.settings = !!adapter && visible && !diagnostics && state.source === 'aa';
        if (adapter) {
            setActive(visible && !diagnostics && state.source === 'aa');
            if (!state.settings && state.menu) showMenu(false);
            // IPC readiness can change without a playback-state notification.
            // Synchronize without marking the frame dirty or repeating writes.
            checkGesture();
            synchronizeFocus();
        }
    }
    function select(source) {
        if (source !== state.source) {
            cancel(); state.source = source; focus('drivehub'); setActive(visible && source === 'aa');
            state.header = false; state.settings = visible && source === 'aa';
        }
        showMenu(false);
    }
    function showMenu(open) {
        cancel(); state.menu = open; menuKnob = undefined; menuPressed = false;
        if (open) state.menuIndex = 0;
        synchronizeFocus(); changed();
    }
    function perform(chosen) {
        if (chosen === 'settings' || chosen === 'close') showMenu(chosen === 'settings' && !state.menu);
        else if (chosen === 'bmw' || chosen === 'aa') select(chosen);
        else if (chosen === 'focus-aa' || chosen === 'focus-drivehub') {
            if (chosen === 'focus-aa' && !available()) return notify('Los controles de Android Auto aún no están disponibles');
            focus(chosen === 'focus-aa' ? 'aa' : 'drivehub'); showMenu(false);
        } else { showMenu(false); action(chosen); }
    }
    function actionAt(x, y) {
        if (state.settings && contains(layout.settings, x, y)) return 'settings';
        if (state.menu) return menuActions.find(id => contains(layout[id], x, y));
        if (state.header && contains(layout.source, x, y)) return 'aa';
    }
    function touch(phase, x, y) {
        if (!adapter || !visible) return false;
        const action = actionAt(x, y);
        if (phase === 'down') {
            cancel();
            if (action) { gesture = { type: 'button', action, valid: true }; return true; }
            if (state.menu) {
                if (!contains(layout.menu, x, y)) showMenu(false);
                gesture = { type: 'ignored' }; return true;
            }
            if (contains(viewport, x, y)) { focus('drivehub'); return false; }
            if (!active || !contains(layout.content, x, y)) return false;
            const frame = adapter.frame();
            const point = frame && frame.geometry && mapInputPoint(layout.content, x, y, false, frame.geometry);
            if (!point || !available()) { gesture = { type: 'ignored' }; return true; }
            focus('aa'); lastPoint = point; gesture = { type: 'content', frame }; adapter.touch('down', point); return true;
        }
        if (!gesture) return false;
        if (gesture.type === 'content') {
            if (!available() || gesture.frame !== adapter.frame()) { cancel(); return true; }
            lastPoint = mapInputPoint(layout.content, x, y, true, gesture.frame.geometry) || lastPoint;
            if (phase === 'move' || phase === 'up' || phase === 'cancel') adapter.touch(phase, lastPoint);
        } else if (gesture.type === 'button') {
            if (gesture.action !== action) gesture.valid = false;
            if (phase === 'up' && gesture.valid) {
                const chosen = gesture.action; gesture = undefined;
                perform(chosen);
            }
        }
        if (phase === 'up' || phase === 'cancel') gesture = lastPoint = undefined;
        return true;
    }
    return {
        state, status, update, touch,
        frame: () => active && adapter.frame(),
        ready(info) { if (adapter) adapter.ready(info); },
        controller(event) {
            if (state.menu) {
                const valid = Number.isInteger(event.knob) && event.knob >= 0 && event.knob < 65535;
                const pressed = event.press === 1 || event.press === 2;
                if (valid && menuKnob !== undefined) {
                    const delta = (event.knob - menuKnob + 65535 + 32767) % 65535 - 32767;
                    if (delta && Math.abs(delta) <= 64) { state.menuIndex = Math.max(0, Math.min(menuActions.length - 1, state.menuIndex + delta)); changed(); }
                    if (!pressed && menuPressed) perform(menuActions[state.menuIndex]);
                }
                if (valid) menuKnob = event.knob;
                menuPressed = pressed;
                return true;
            }
            if (!active || state.focus !== 'aa') return false;
            if (available()) adapter.controller(event);
            return true;
        },
        ownsInput: () => active && state.focus === 'aa' && !state.menu,
        focusDriveHub: () => focus('drivehub'),
        close() {
            if (closed) return;
            cancel(); if (adapter) setActive(false); closed = true;
            if (typeof unwatch === 'function') unwatch();
            if (adapter) adapter.close();
        }
    };
}
module.exports = { createAAUI };
