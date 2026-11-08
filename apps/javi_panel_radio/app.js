'use strict';

// La herramienta instala el módulo común fuera del bundle OAP. Node 8 no tiene createRequire().
const load = require('module')._load;
const directory = '/var/opt/javi-carlab/current';
let radio;
try {
    radio = load(directory + '/radio.js')();
} catch (err) { console.error('Radio de prueba: ' + err.message); }
require('./oap.js')(radio);
