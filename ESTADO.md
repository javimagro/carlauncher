# Estado de BMWLauncher · 20-11-2026

## Versión 0.2.24

- **Publicada y verificada en GitHub.** `v0.2.24` apunta al commit `d473f0d69edd6d08494cd5edb8251bc3bb6dc169` de `main`. El ZIP de 169 archivos y `SHA256SUMS.txt` se descargaron de nuevo. SHA-256 `f6f229d71e404804fa58d5d8169d3576bb2c353af07add6dd35d08113070d9f5`.
- App y motor **0.2.24**, Captura del mando **1.1.0**, Formato de Android Auto **1.0.0**. La PR #24 incorpora el cuadro, el trayecto y la observación del guiado en segundo plano.
- El cuadro se ofrece al arrancar y actualiza los datos mientras está seleccionado. Trayecto sigue recibiendo las lecturas originales de BMW. El resumen de la ruta activa usa sus datos vigentes y las paradas que BMW confirma como completadas.
- Confirmado por el usuario el 25-11-2026: el cuadro muestra datos al ir al menú principal y aunque no se abra BMWLauncher. Tras apagar y arrancar con el widget personalizado seleccionado, iDrive vuelve a la vista de velocidad. Las otras vistas sí conservan su selección. La recuperación del widget sigue pendiente. [Release y ZIP USB](https://github.com/javimagro/carlauncher/releases/tag/v0.2.24).

## Versión 0.2.23

- **Publicada y verificada en GitHub.** `v0.2.23` apunta al commit `e21081e21a97cb58764646b50621ac11dbf142e1`. Se descargaron de nuevo el ZIP de 168 archivos y `SHA256SUMS.txt`. La descarga dio SHA-256 `919be8aca035accdcd6c147184d69b88236bde031b4465669d5af2d9dca95d70`. [Release y ZIP USB](https://github.com/javimagro/carlauncher/releases/tag/v0.2.23).
- App y motor **0.2.23**, Captura del mando **1.1.0**, Formato de Android Auto **1.0.0**. La integración reúne las PR de arranque y cierre de AA/TDTWorld, energía útil del i4 y radio FM/DAB.
- Radio solicita la fuente al abrir fuera de TDTWorld y permite cambiar, guardar favoritos y filtrar desde el panel. BMW tiene prioridad en los logos. TDTWorld recupera Cuatro y otras señales y usa el orden de Carlinkit.
- La lectura de energía útil y los mensajes eléctricos de AA se verifican en local. Queda probar en el i4 el envío al teléfono, el cálculo de paradas, la conexión de AA y el sonido de radio y TDT. [Bitácora técnica](BITACORA.md).

## Prueba del i4 con 0.2.22

El usuario confirma que los sensores de 0.2.22 ya funcionan. AA original abre a pantalla completa y el integrado daba error. La corrección espera el arranque de la sesión si el puente aún anuncia `off` y muestra el código del fallo. TDTWorld adopta la prioridad de Carlinkit, resuelve siete canales de Mediaset, recupera cuatro señales locales mediante HLS y separa las emisiones que comparten guía. Los ensayos locales cubren ambas correcciones. Queda comprobar AA integrado y la reproducción de los canales recuperados en el i4. Consulte [la bitácora](BITACORA.md) para las causas y las pruebas.

## Versión unificada 0.2.22

- App y motor **0.2.22**, Captura del mando **1.1.0**, Formato de Android Auto **1.0.0**. Mantiene IDs, manifiestos y binarios nativos anteriores. La [release 0.2.22](https://github.com/javimagro/carlauncher/releases/tag/v0.2.22) es el destino del ZIP y `SHA256SUMS.txt`; el hash del commit está en la etiqueta y en el informe de empaquetado.
- Reconciliados el `main` remoto, los tres worktrees anteriores y la PR16 del icono reducido. El código local antiguo ya estaba integrado o superado; se conserva intacto para no perder trabajo del usuario. Se recuperan las notas pendientes de eRoute/RTTI, sin activar experimentos ni incluir firmware.
- **Publicada y descargada de nuevo para verificar:** `v0.2.22`, commit `8d4b9153ca0e0d3751389643592d6bb3d53725a7` de `main`. Integradas PR16 y PR17. ZIP de 166 archivos y 23618809 bytes; SHA-256 `80725275216c5beb03ed1864ea0bbfc23b058e52a2553deb7f8c0d82f4620837`. La etiqueta y ambos adjuntos se han comprobado en GitHub. El informe y la verificación descargada quedan en `dist/release-0.2.22/`, ignorado por Git.

## Comprobado en local

- **472/472 pruebas** con `node --test --test-concurrency=4 emulator/split/*.test.js`. Diez regresiones iniciales fallan contra los módulos anteriores; la nueva suite cubre conexión/reconexión, llamadas detenidas, baja/cierre, respuestas tardías, ocultación/reapertura inmediata y contrapresión PCM.
- **123 archivos JS instalados** pasan sintaxis Node **8.16.2**; cargan los tres módulos de producción modificados. La telemetría actualizada tras la última revisión vuelve a pasar sintaxis/carga.
- HLS sintético con FFmpeg **9.0.2** y Node **8.16.2**: 250 cuadros, cero vaciados/reconexiones y 14 avances durante bloqueo deliberado de UI. Los bytes PCM recibidos no acreditan sonido. No se presenta la diferencia de tiempos del PC como mejora medida en MGU.
- Lector Store en Node 8: cuatro componentes y enlace OAP con donante sintético (21 módulos). ZIP final de 166 archivos, versiones/dependencias comprobadas. CRC y contenido cotejados contra el commit; descarga pública y SHA-256 comprobados.

## Cambios y límites

- Telemetría: plazos de ocho segundos, reintentos a dos segundos, cierre nativo antes de reemplazar una conexión y descarte de respuestas antiguas. Cerrar/reabrir espera la generación anterior; un cierre pendiente o fallido no crea proxies nuevos.
- AA: espera contexto HMI reciente antes de capturar y hasta cuatro segundos si caduca durante el arranque. Ocultar cancela. Se mantienen restauración y bloqueo por retirada incierta. La causa física de las conexiones fallidas del usuario no se ha capturado.
- TDT: cola PCM de hasta 100 ms durante contrapresión breve; conserva orden y retira únicamente audio si se desborda. Mantiene presupuesto de reintentos, vídeo y foco BMW. Los chasquidos reales siguen pendientes de contraste audible.
- Conservados cockpit, barra de energía, TDT/logos, navegación, Radio, temas, toast e icono reducido. Mapa BMW propio y micrófono físico del asistente siguen pendientes. No se anuncia como terminada ninguna de esas funciones.
- No se ha conectado por SSH, instalado ni reiniciado el coche. No reiniciar `aapd` aisladamente. Los preloads usan `hmi8.service` y `aapd.service` y sus cambios de instalación requieren el arranque completo previsto por Store.

## Prueba instalada pendiente

Actualizar BMWLauncher y Motor gráfico a 0.2.22 desde Store → `javimagro/carlauncher` → Tags → Comprobar ahora. Cerrar y volver a abrir la app. Comprobar varios arranques de Datos y AA, alternancia AA/BMW, controles, recuperación tras ocultación y cámara, cockpit intacto y TDT prolongada por altavoces. Registrar fase/diagnóstico del fallo antes de reiniciar. Conectar o escribir en la unidad requiere autorización expresa vigente.

Para volver atrás, reinstalar app y motor 0.2.21 conservando los datos privados. Las fuentes experimentales y extracciones permanecen fuera del paquete distribuido. Detalles y evidencia: [BITACORA.md](BITACORA.md), [ARQUITECTURA.md](ARQUITECTURA.md).
