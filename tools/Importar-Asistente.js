'use strict';

// PC-only. An explicit decrypted export is required; Android Keystore ciphertext is not portable.
const fs = require('node:fs/promises'), path = require('node:path');
const { createConfig, validKey, providers } = require('../native/javi-carlab/assistant-config');
async function main(source, destination) {
    if (!source || !destination) throw new Error('Uso: node tools/Importar-Asistente.js EXPORTACION_PRIVADA.json CARPETA_PRIVADA_FUERA_DEL_REPO');
    const repo = await fs.realpath(path.resolve(__dirname, '..'));
    const src = await fs.realpath(path.resolve(source)), dest = path.resolve(destination);
    const parent = await fs.realpath(path.dirname(dest));
    for (const candidate of [src, path.join(parent, path.basename(dest))]) {
        const relative = path.relative(repo, candidate);
        if (!relative || !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw new Error('La exportación y el almacén privado deben estar fuera del repositorio');
    }
    const info = await fs.lstat(src);
    if (!info.isFile() || info.size > 16384) throw new Error('Exportación no válida');
    const value = JSON.parse(await fs.readFile(src, 'utf8'));
    const keys = value.keys || {};
    if (!Object.keys(keys).length || Object.keys(keys).some((p) => !Object.prototype.hasOwnProperty.call(providers, p) || !validKey(keys[p]))) throw new Error('Se requiere una exportación con claves descifradas; no sirve el XML cifrado de Android');
    const config = createConfig(dest); await config.ready;
    for (const p of Object.keys(keys)) await config.update({ provider: p, key: keys[p], voice: value.voices && value.voices[p] || providers[p].voices[0] });
    if (value.provider) await config.update({ provider: value.provider });
    console.log('Configuración importada al almacén privado. No se muestran claves ni se modifica ningún paquete.');
}
if (require.main === module) main(process.argv[2], process.argv[3]).catch(() => { console.error('No se pudo importar: comprueba formato, claves descifradas y rutas fuera del repositorio.'); process.exitCode = 1; });
module.exports = { main };
