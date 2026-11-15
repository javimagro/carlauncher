# Estado de BMWLauncher · 15-11-2026

## Punto de partida
- Rama de este relevo: `codex/aa-left-video`; base publicada en `main`: `a4caf012df7839eea34d46521e4bb166d8d6eef1`.
- Publicada [v0.2.21 de prueba](https://github.com/javimagro/carlauncher/releases/tag/v0.2.21), con ZIP USB y `SHA256SUMS.txt`; etiqueta comprobada contra ese commit.
- Integradas PR11–14: foco de Radio, consulta de este documento, AA y nuevo icono de navegación. El commit de relevo modifica únicamente `ESTADO.md`.
- Este worktree estaba limpio antes de escribir el relevo; localizar su commit documental con `git log -1 --oneline -- ESTADO.md`.
- Otro checkout `main` conserva cambios sin commit de navegación, TDT/audio, telemetría, interfaz y asistente; no se incorporaron automáticamente. Consultar `git worktree list` y su `git status` antes de integrarlos.

## Qué funciona y cómo se comprobó
- Suite local: `node --test --test-concurrency=4 emulator/split/*.test.js`, **456/456**; sintaxis de **123 archivos instalados** con Node **8.16.2**.
- Puente de formato recompilado con avisos como errores: **406 comprobaciones portables**, ELF x86-64 y GLIBC ≤2.17. No equivale a una prueba en la MGU.
- Lector oficial Store: cuatro componentes aceptados, enlace OAP con donante sintético y ZIP de **166 archivos** comprobados. Los cambios posteriores al código probado son documentación e icono, verificado también en el ZIP.
- Por SSH se confirmó que Hmi8 usa `hmi8.service`; el filtro anterior apuntaba a `hmi.service` inactivo. Corregido el destino del preload y cubierta su dependencia por una regresión.
- El usuario confirmó que toque y rueda funcionan en AA original antes de actualizar. Los cuatro hashes del firmware coinciden con el perfil del puente.
- Imagen/toque/rueda y tamaño adaptado se validaron en ensayos separados; **falta validar conjuntamente la 0.2.21 instalada**, alternancia AA/BMW, restauración y cockpit. No se instaló ni reinició la MGU en este cierre.
- Recuperación AA: tres regresiones reproducían el panel vacío; ahora conserva el último anillo, bloquea entrada durante la espera y libera archivos al sustituir, ocultar o fallar.
- Búsquedas BMW y Radio tienen correcciones locales comprobadas; faltan resultados, logos y sonido reales. Micrófono LLM pendiente: la consulta SSH fue solo lectura, sin grabación ni activación de reconocimiento.

## Decisiones vigentes
- AA ocupa exclusivamente la izquierda con energía debajo; BMW conserva búsquedas/ETA. DriveHub sigue a la derecha. El selector está en el engranaje de energía → **Pantalla y controles**.
- Solo se adquiere AA **MAIN**; no reclamar IC ni modificar el mapa del cockpit. Restaurar formato/foco al salir; una retirada incierta bloquea nuevas adquisiciones.
- App/motor **0.2.21**, Captura del mando **1.1.0**, Formato de Android Auto **1.0.0**. Preloads en `hmi8.service` y `aapd.service`, cargados al siguiente arranque completo.
- **No reiniciar aapd aisladamente**: un ensayo anterior dejó sin controles AA original; se recuperó con reinicio completo autorizado. No inferir permiso de instalación/reinicio de una consulta SSH.
- Mantener Node 8 en producto, auxiliares nativos aislados, filas sin dato honestas y cartografía BMW local; no sustituirla por mapas externos. No publicar firmware, credenciales ni registros privados.

## Dónde mirar
- Coordinación y recuperación AA: `native/javi-carlab/aa-integration.js`, `aa-process.js`, `aa-worker.js`, `aa-player.js`; entrada/vista: `aa-input-process.js`, `aa-ui.js`, `aa-view.js`.
- Formato y ensayo/reversión: `native/javi-carlab/aa-format.js`, `ANDROID-AUTO-MGU21.md`, `tools/aa-format-runtime/TEST-PLAN.md`; regresión: `emulator/split/aa-recovery.test.js`.
- Búsquedas/Radio: `apps/javi_carlauncher/navegacion-acciones.js`, `radio-bmw.js`, `radio-datos.js`; contratos y pendientes en `NAVEGACION-MGU21.md`, `RADIO-MGU21.md`, `ASISTENTE-MGU21.md`.
- Mapa BMW propio aún pendiente: `MAPA-ENSAYO-LOCAL.md`, `tools/map-runtime/Ensayar-Mapa-Propio.js`; próxima hipótesis: INITIALIZATION y confirmación por handle antes de VISIBLE, todavía sin validación física.
- Verificación mínima local: `node --test emulator/split/aa-recovery.test.js`; suite completa arriba. Evidencia/paquetes locales: `dist/release-0.2.21/` (ignorado por Git).
- SHA-256 del ZIP publicado: `6f1ac52de2409d3a1b5d6a06c252a2d102e60385642c15db2112d3e941add6d3`.

## Siguiente paso
- Usuario: Store → `javimagro/carlauncher` → Tags → Comprobar ahora; actualizar los cuatro componentes y reiniciar iDrive completamente con el coche parado.
- Verificar AA original; abrir BMWLauncher con el teléfono conectado y probar altura sin bandas, toque/arrastre, giro/OK y cambio de foco AA/DriveHub. Alternar AA/BMW varias veces y volver al AA original.
- Resultado esperado: imagen adaptada y controles operativos, restauración original y cockpit intacto. Si falla, leer diagnóstico/fases por ENET sin repetir reinicios parciales ni darlo por validado.
- ENET/SSH estaban disponibles; comprobar conectividad y autorización vigente al retomar. No hay bloqueo local de empaquetado; falta la instalación y observación física. Después continuar mapa BMW, búsquedas/Radio y micrófono según sus pendientes.
