# Auditoría de BMWLauncher · 13 de noviembre de 2026

La revisión posterior de las funciones nuevas, sus correcciones y medidas del 14-11-2026 está en [Auditoría integral](AUDITORIA-INTEGRAL.md). Este documento conserva la evidencia histórica de multimedia y mando.

## Alcance y resultado

Base: `7c5b544` / `v0.2.9`, más los cambios locales previos de los iconos y centrado del cockpit, que se conservan. Revisión de OAP, servicio, sesión, proveedores, reproducción, telemetría, captura C++ y manifiestos. Incluye dos revisiones independientes de corrección y estructura, reproducción local e inspección del firmware descargado. No se ha conectado con el coche ni publicado una versión durante esta auditoría.

Los fallos de arquitectura reproducidos se han corregido en local. **No está demostrado aún que SmartX produzca sonido en el i4 ni que Hmi8 cargue el filtro en su instalación actual.** La nueva instrumentación permite distinguir esos casos de los fallos de software corregidos.

Verificación final: **45 pruebas locales**, sintaxis de 35 módulos con Node 8.16.2, catálogo/permisos de telemetría, enlace OAP con donante sintético, artefacto del renderer y lectura de los tres componentes por la Store en un USB simulado. Se revisó la captura del diagnóstico y se conservó la tarjeta Trayecto. No se publicaron paquetes ni se modificaron los IDs o la versión distribuida.

## Hallazgos y correcciones

| Prioridad | Evidencia | Cambio local | Límite pendiente |
| --- | --- | --- | --- |
| P1 | La app dependía del renderer, pero no de `javi-ccu-gate`. Instalar/actualizar BMWLauncher no garantizaba instalar el filtro. | Dependencia explícita app → gate; se mantiene gate → renderer, sin ciclo. | El preload se aplica al iniciar Hmi8. Falta conocer el estado instalado/cargado del i4. |
| P1 | Lease de 700 ms renovada al terminar una consulta HMI y esperar otros 400 ms; escaneos síncronos OAP y `/proc`. | Renovación cada 200 ms, contexto máximo 800 ms, descubrimiento asíncrono y caché de identidad 5 s; filtro comprobado cada 2 s. Diagnóstico del motivo de captura inactiva. | Los 700 ms del filtro se conservan. Tras la última observación del contexto, la captura puede mantenerse como máximo hasta 800 + 700 ms; pérdida de capa o conexión la retira inmediatamente. |
| P1 | Un JPEG 1080p bloqueó unos 320 ms el mismo proceso que gestionaba el vídeo y el mando. | Cola de una descarga/decodificación activa, hasta ocho pendientes, descartes por generación antes de CPU y proceso separado para JPEG/PNG/reescalado. No cargar fanart durante reproducción. | Crear un proceso tiene coste: mejora fluidez del hilo, no necesariamente el tiempo total de la foto. |
| P1 | Presentación I420 y PCM dependían del mismo temporizador que la interfaz. | `tdt-worker.js` gobierna reproducción y anillo, sin pasar píxeles por IPC. Reloj monotónico y plazos de presentación compensados. | PTS/sincronía labial y carga real deben comprobarse en MGU. La prueba no mide el tiempo de composición del panel. |
| P1 | Tras un `stall` de ALSA solo había un arranque del auxiliar; PCM posterior se descartaba permanentemente. | Recuperación independiente del auxiliar, tres reintentos acotados con espera creciente; eventos antiguos no afectan al nuevo auxiliar. Drenaje de PCM continuo. | Reabrir una ruta no le concede foco ni conecta SmartX a los altavoces. |
| P2 | Anillo publicaba secuencia y ranura en una escritura, sin garantizar el orden del protocolo. | Píxeles → ranura → secuencia, según MGVF. | Verificado protocolo y test; composición física pendiente. |
| P2 | TDT leía el catálogo en el arranque aunque su tarjeta no se usase. | Lectura diferida hasta el primer foco TDT. | No se dispone de medida de arranque frío del coche. |
| P2 | Diagnóstico no mostraba si la captura estaba activa ni en qué etapa se detenía vídeo. | Filas de captura y contadores de reproducción: presentados, cola, vaciados y hueco máximo. Se conservan errores del dispositivo. | Los contadores se reciben cada 5 s; el hueco es del productor, no del panel físico. |

La generación de órdenes gráficas ya es corta en el PC. No hay evidencia que justifique reescribir la interfaz completa en C++. Se mantiene JS para estado/entrada/red y C/C++ para codecs, ALSA, compositor e interposición. Las tareas de CPU se aíslan antes de añadir otro lenguaje.

## Mediciones reproducibles

Windows x86-64, Node **8.16.2**. Datos sintéticos, FFmpeg **9.0.2**. Estos tiempos no son medidas del procesador de la MGU.

| Escenario | Referencia | Con aislamiento |
| --- | --- | --- |
| JPEG 1920×1080, 795.756 bytes → 528×297: intervalo máximo del temporizador del hilo principal | 319,8 ms | 44,3 ms |
| Mismo JPEG: tiempo completo de la operación | 319,5 ms | 613,1 ms |
| HLS local + PCM, dos segmentos retrasados 1.400 ms y bloqueo deliberado UI de 650 ms: hueco máximo de presentación | 666 ms, ejecución `--inline` | 65 ms, proceso separado |
| Fotogramas avanzados durante los 650 ms de bloqueo UI | 0 | 13 |
| Descartes / vaciados de cola en la muestra de estadísticas | 12 / 0 | 0 / 0 |
| Fotogramas finales / PCM recibido | 250 / 2.361.600 bytes | 250 / 2.371.200 bytes |

Los contadores periódicos se capturan antes de terminar los 250 fotogramas; no deben confundirse con el total final. PCM se entrega a un receptor de prueba. **No se ha escuchado sonido en SmartX con esta revisión.**

Carga de módulos medida: 54,1 ms; descompresión del artwork: 49,0 ms; emisión de órdenes de pantalla: mediana 0,69 ms, p95 2,70 ms, máximo 9,82 ms. La referencia previa de carga era aproximadamente 50 ms: no se afirma una mejora medida de arranque. Se ha eliminado lectura innecesaria de TDT del camino de arranque y quedan por medir las consultas a HMI y primer fotograma en el i4.

```powershell
node --test emulator/split/*.test.js
& "$env:TEMP/bmwlauncher-node-v8.16.2/node.exe" tools/Medir-Rendimiento.js RUTA_JPEG_LOCAL
& "$env:TEMP/bmwlauncher-node-v8.16.2/node.exe" tools/Probar-Reproduccion.js RUTA_FFMPEG
& "$env:TEMP/bmwlauncher-node-v8.16.2/node.exe" tools/Probar-Reproduccion.js RUTA_FFMPEG --inline
```

`Probar-Reproduccion.js` crea una muestra HLS, servidor y receptor PCM locales. Su servidor corre en otro proceso para que el bloqueo de UI no simule accidentalmente un bloqueo de red. La prueba exige progreso de vídeo durante el bloqueo y bytes PCM recibidos; no depende de disponibilidad de un canal público.

## Audio: lo comprobado en el firmware

`libasound_module_pcm_smartx.so` extraído anteriormente del i4, SHA-256 `378a928f1cf649c1280b63f1b8ec88979b138a6eb3a8ed90a7b7789230708d7b`:

- Es un complemento SmartX basado en memoria compartida y control entre procesos, no un dispositivo físico directo.
- El desensamblado con LLVM muestra `IasAudioRingBuffer::waitWrite` en `0xae13` y `0xd4f0`, `setStreamingState` en `0x182e9` y una ruta de rechazo del arranque que referencia el texto en `0x21228` desde `0x1981d`.
- La configuración original de `mediaengine` usa `smartx:MediaSink_AudioOut_Front_CF_48_COMBINED_STEREO_MULTICHANNEL`. Esa ruta coincide con nuestro destino. Coincidir en el nombre no prueba exclusividad, concesión de foco ni conexión a salida.
- El código público de Intel permite relacionar `startStream`, control IPC y `transferJob`; un búfer sin lector puede devolver cero/EAGAIN. Es una explicación compatible con el síntoma, **no una captura del fallo del i4**.
- El catálogo de la unidad contiene `AudioControl.requestAudioFocus`, `abandonAudioFocus`, `onAudioFocusChange` y `MediaSource.selectSource`. Todavía no está demostrado que pedir ese foco conecte nuestro PCM a la ruta elegida. No se han añadido llamadas de control a ciegas.

REA identificó el ELF CommonAPI y su hash, pero el proveedor de decompilación no está disponible para ELF en este entorno Windows. Se continuó con el desensamblador LLVM existente y fuentes públicas. Esto es análisis estático, no pseudocódigo decompilado ni observación de ejecución.

El auxiliar C ahora comprueba el resultado de `snd_pcm_nonblock` e informa del estado ALSA al fallar. Compilado con Zig 0.14.1/Clang, destino `x86_64-linux-gnu.2.27`, avisos como errores. ELF comprobado: intérprete `/lib/ld-linux-x86-64.so.2`, dependencias libc/libdl/libpthread y símbolos GLIBC 2.2.5. SHA-256 `ca661eec5f32594b130fe1a8bca717821168a7a5a7e8b4d073970319bc783456`. No se ejecutó este ELF nuevo: WSL no está instalado en el PC. La compilación y el receptor PCM simulado no sustituyen la prueba ALSA Linux ni SmartX.

## Fuentes primarias contrastadas

- [mgu-render: protocolo, vídeo y ocultación por falta de actividad](https://github.com/robertnisipeanu/mgu-store/blob/main/native/mgu-render/PROTOCOL.md). Consultado el 13-11-2026; árbol `native/mgu-render` `b7f55ba3957c0aa30318a27312ac927cad57eb26`. El renderer repinta vídeos nuevos y exige actividad de la app al menos cada segundo.
- [MGU Store: herramientas preload y publicación](https://github.com/robertnisipeanu/mgu-store/blob/main/docs/PUBLISHING.md) y [filtro comunitario FrontCCU](https://github.com/cauliflowermossgrape/idrive7-apps/blob/main/kit/renderd/inputgate/mgu-inputgate.cpp). Ver [MANDO-MGU21.md](MANDO-MGU21.md) para la ABI y diferencia Hmi8/HmiMain3D.
- [IterioDev/car-apps](https://github.com/IterioDev/car-apps): referencia de herramientas ID8 y despliegue, no prueba de nuestro coche.
- [Intel AVB-AudioModules · IasAlsaSmartXConnector.cpp](https://github.com/intel/AVB-AudioModules/blob/master/private/src/alsa_smartx_plugin/IasAlsaSmartXConnector.cpp), blob `47ed91dc5d7ddc418c5cc986d71bafc299e16469`. Repositorio archivado: útil para interpretar este firmware, no dependencia nueva a instalar.
- [ALSA PCM](https://www.alsa-project.org/alsa-doc/alsa-lib/group___p_c_m.html), [FFmpeg: entrada y ritmo](https://ffmpeg.org/ffmpeg.html), [Node: evitar bloquear el bucle de eventos](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop).

## Comprobaciones que siguen abiertas

1. **Mando en el i4:** comprobar fila «Mando · captura exclusiva», componente instalado y mapa de Hmi8 tras su carga. Si no está activo, el diagnóstico identifica el requisito fallido. La prueba incluye arriba/izquierda, giro, casita, cámara y recuperación de iDrive.
2. **Audio real:** correlacionar códigos del auxiliar con estado de SmartX y de la fuente original, sin apropiarse de avisos/llamadas. Si hay PCM pero no avance de ALSA, investigar lector/arbitraje; si ALSA avanza pero no se oye, investigar ruta/mute. No tocar volumen global como solución genérica.
3. **Vídeo real:** observar los contadores y CPU/RSS/retraso del bucle durante el mismo canal. Si el productor es fluido y la pantalla se para, revisar renderer; si la cola se vacía, separar red y velocidad de decodificación. Aceleración VA-API sigue pendiente de prueba de dispositivo.
4. **Arranque:** medir desde apertura OAP a primer fotograma, frío y caliente, con y sin caché y conectividad. La latencia de HMI no puede medirse fielmente en Windows.

Para revertir esta revisión local, revertir únicamente sus módulos y manifiestos desde la base revisada, conservando los cambios previos del cockpit. No usar `reset --hard`. Una versión ya instalada debe revertirse mediante un paquete de versión superior que contenga el código anterior, como requiere la actualización por Store.
