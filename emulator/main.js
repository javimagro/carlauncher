'use strict';
const mgu = require('./kit/mgu');
const { width, height, drawLauncher } = require('./launcher-view');

mgu.run({
    async start(ctx) {
        let expanded = false;
        let optionsOpen = false;

        function render() {
            const cv = ctx.canvas(width, height);
            drawLauncher(cv, { expanded });
            cv.roundRect(16, 16, 64, 58, 12, '#205577');
            cv.text('Menu', 48, 51, 19, '#f0f5fa', { align: 'center' });
            cv.target(16, 16, 64, 58, () => {
                optionsOpen = !optionsOpen;
                return render();
            }, 'launcher_menu');

            if (optionsOpen) {
                cv.roundRect(96, 16, 270, 68, 10, '#205577');
                cv.text(expanded ? 'Vista dividida' : 'Pantalla completa', 116, 57, 24, '#f0f5fa');
                cv.target(96, 16, 270, 68, () => {
                    expanded = !expanded;
                    optionsOpen = false;
                    return render();
                }, 'launcher_resize');
            }
            return ctx.ui.image('MAIN_GFX', cv);
        }

        ctx.loop('MAIN', 10, render);
    }
});
