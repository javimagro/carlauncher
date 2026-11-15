'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const profile = require('../../native/javi-carlab/display-profile');
const { apply } = require('../../native/javi-carlab/display-profile-install');

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmw-tall-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return { configFile: path.join(dir, 'renderer.conf'), pendingFile: path.join(dir, 'pending') };
}

test('tall activation waits for boot and removal restores the exact previous settings', (t) => {
    const options = fixture(t), original = '# owner settings\r\nfps = 30\r\ntouch_area = auto';
    fs.writeFileSync(options.configFile, original);
    let env = { JAVI_DRIVEHUB_TALL: '1' };
    assert.equal(profile.selectEnvironment(env, options), false);
    assert.equal(env.JAVI_DRIVEHUB_TALL, '0');
    assert.match(apply(true, options).reboot, /Reinicia/);
    const activated = fs.readFileSync(options.configFile, 'utf8');
    assert(activated.startsWith(original));
    assert.equal(activated.includes('app_area'), false);
    assert.equal(profile.configured(activated), true);
    assert.equal(profile.selectEnvironment({ JAVI_DRIVEHUB_TALL: '1' }, options), false);
    assert.match(apply(true, options).reboot, /Reinicia/);
    assert.equal(fs.readFileSync(options.configFile, 'utf8'), activated);
    fs.unlinkSync(options.pendingFile); // /run is cleared on head-unit boot.
    assert.equal(profile.selectEnvironment({ JAVI_DRIVEHUB_TALL: '1' }, options), true);
    assert.equal(apply(true, options).reboot, undefined);
    assert.equal(profile.selectEnvironment({ JAVI_DRIVEHUB_TALL: '0' }, options), false);
    assert.match(apply(false, options).reboot, /restaurar/);
    assert.equal(fs.readFileSync(options.configFile, 'utf8'), original);
    assert.equal(profile.selectEnvironment({ JAVI_DRIVEHUB_TALL: '1' }, options), false);
    apply(false, options);
    assert.equal(fs.readFileSync(options.configFile, 'utf8'), original);
});

test('an absent local configuration can be activated and rolled back without changing other settings', (t) => {
    const options = fixture(t);
    apply(true, options);
    fs.appendFileSync(options.configFile, 'fps.other_app = 20\n');
    apply(false, options);
    assert.equal(fs.readFileSync(options.configFile, 'utf8'), 'fps.other_app = 20\n');
});

test('custom areas and edited owned blocks are preserved rather than overwritten', (t) => {
    const options = fixture(t);
    for (const custom of ['touch_area = 10,20,500,500\n', 'app_area = 10,20,500,500\n']) {
        fs.writeFileSync(options.configFile, custom);
        assert.throws(() => apply(true, options), /personalizada/);
        assert.equal(fs.readFileSync(options.configFile, 'utf8'), custom);
        assert.equal(fs.existsSync(options.pendingFile), false);
    }
    const activated = profile.editConfig('', true);
    assert.throws(() => profile.editConfig(activated + activated, true), /modificado/);
    const overridden = activated + 'touch_area = auto\n';
    assert.equal(profile.configured(overridden), false);
    assert.throws(() => profile.editConfig(overridden, true), /anula/);
    assert.equal(profile.editConfig(overridden, false), 'touch_area = auto\n');
    assert.throws(() => profile.editConfig(activated.replace('2880,840', '2880,960'), false), /modificado/);
});

test('only the BMWLauncher PLACE gains the top strip and stops above climate controls', () => {
    const screen = { w: 2880, h: 960 }, area = { x: 0, y: 76, w: 2880, h: 764 };
    const info = { modes: ['layer'], appArea: area, touch: true };
    const normal = profile.selectArea(screen, info, 1960, 520);
    const tall = profile.selectArea(screen, info, 1960, 572);
    assert.equal(normal.y, 76);
    assert.equal(tall.y, 0);
    assert.equal(tall.h, 840);
    assert(tall.x >= 0 && tall.x + tall.w <= 2880);
    assert.equal(tall.y + tall.h, normal.y + normal.h);
    assert.deepEqual(info.appArea, { x: 0, y: 76, w: 2880, h: 764 });
    assert.equal(profile.selectArea({ w: 1920, h: 720 }, info, 1960, 572), null);
    assert.equal(profile.selectArea(screen, { modes: ['embed'], appArea: area }, 1960, 572), null);
    assert.equal(profile.selectArea(screen, { modes: ['layer'], appArea: { x: 0, y: 0, w: 2880, h: 960 } }, 1960, 572), null);
    assert.equal(profile.selectArea(screen, {}, 1960, 572), null);
});

test('service and Store package carry both display activation and reversible removal', () => {
    const root = path.join(__dirname, '../../native/javi-carlab');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'component.json')));
    assert.deepEqual(manifest.activate, ['node', 'display-profile-install.js', 'activate']);
    assert.deepEqual(manifest.deactivate, ['node', 'display-profile-install.js', 'deactivate']);
    assert.equal(manifest.requires['mgu-deploy'], '0.7.0');
    for (const file of ['display-profile.js', 'display-profile-install.js']) assert(manifest.files.some((f) => f.path === file));
    assert.match(fs.readFileSync(path.join(root, 'javi-carlab.service'), 'utf8'), /Environment=JAVI_DRIVEHUB_TALL=1/);
});

test('the tall session claims the higher home button and releases input when hidden or covered', () => {
    const script = `
        const assert = require('assert'), { EventEmitter } = require('events');
        const createSession = require('./native/javi-carlab/drivehub-session');
        const profile = require('./native/javi-carlab/display-profile');
        const { width, height, home } = require('./native/javi-carlab/drivehub-state');
        assert.strictEqual(height, 572);
        const gpu = new EventEmitter(); let placed, claimed, exits = 0, visible = false;
        Object.assign(gpu, { place(a) { placed = a; }, claim(a) { claimed = a; },
            show(on) { visible = on; }, frame() {}, close() {}, grab() {} });
        const session = createSession(gpu, { fixture: { news: [] }, diagnostics: true,
            area(screen, info) { return profile.selectArea(screen, info, width, height); },
            onExit() { exits++; session.show(false); } });
        try {
            gpu.emit('ready', { w: 2880, h: 960 }, { modes: ['layer'], touch: true,
                appArea: { x: 0, y: 76, w: 2880, h: 764 } });
            session.show(true); gpu.emit('state', { onScreen: true });
            assert.strictEqual(visible, true);
            assert.deepStrictEqual(claimed, [{ x: 0, y: 0, w: 1960, h: 572 }]);
            const x = home.x + home.w / 2, y = home.y + home.h / 2;
            assert(placed.y + y * placed.scale < 76, 'home is in the gained strip');
            const click = () => { gpu.emit('touch', 'down', x, y); gpu.emit('touch', 'up', x, y); };
            click(); assert.strictEqual(exits, 1); assert.strictEqual(visible, false);
            click(); assert.strictEqual(exits, 1);
            session.show(true); gpu.emit('state', { onScreen: false });
            click(); assert.strictEqual(exits, 1);
            gpu.emit('state', { onScreen: true }); click(); assert.strictEqual(exits, 2);
        } finally { session.close(); }
    `;
    const result = require('node:child_process').spawnSync(process.execPath, ['-e', script], {
        cwd: path.join(__dirname, '../..'), encoding: 'utf8', timeout: 10000,
        env: Object.assign({}, process.env, { JAVI_DRIVEHUB_TALL: '1' })
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
});
