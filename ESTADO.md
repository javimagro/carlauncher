# Estado de BMWLauncher · 19-11-2026

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
