# TDTWorld · validación local y prueba pendiente en MGU21

## Resultado actual · 0.2.11 local

El usuario confirmó **vídeo continuo en una prueba temporal en su i4**, tras filtrar el DASH a una representación de vídeo y una pista española. Esa selección y la contrapresión de la cola se han incorporado al código local. **No se ha oído audio y el paquete integrado aún no se ha probado en el coche.** No se instaló una versión persistente, reinició ni publicó nada.

Tras la primera consulta de solo lectura, se realizaron las pruebas temporales autorizadas: sonda MSDK, reproducción y diagnóstico de audio. Antes de desconectar ENET se verificó el reproductor original ejecutándose, ninguna sonda activa, foco propio liberado y DynamicTempMedia desconectado. SSH sigue habilitado por petición del usuario. La conexión se perdió antes de poder borrar la carpeta temporal de TDT; su limpieza queda pendiente para la próxima conexión, sin volver a ejecutar pruebas automáticamente.

## Evidencia física de los parones

1. El usuario veía congelaciones mientras una marca blanca de diagnóstico seguía moviéndose. El compositor no estaba congelado: el productor entregaba imágenes iguales. La comparación de píxeles antes de añadir la marca encontró hasta **320 cuadros repetidos**, unos 16 segundos a 20 fps.
2. La fuente activa era DASH, con cuatro calidades de vídeo, tres audios y subtítulos. En el demultiplexado se observaron saltos de DTS de aproximadamente +8,04 s y −3,96 s; el filtro de FPS rellenaba huecos repitiendo imágenes. Aumentar el búfer o medir solo la secuencia de MGVF no detectaba ese problema.
3. Se repitió el ensayo conservando una representación AVC 640×360 y el audio español, sin alterar SegmentTimeline. El usuario confirmó continuidad. Durante el ensayo de 90 s: máximo **1 cuadro repetido**, cero vaciados y reconexiones; hueco productor máximo **76 ms** y hueco de la copia a pantalla **87 ms**. Son contadores del ensayo, no una garantía para todos los canales.
4. El PCM de esta prueba se drenaba a un receptor de diagnóstico. **No acredita sonido.** Al terminar se restauró el worker original; la corrección no quedó instalada en el coche.

`tdt-dash.js` selecciona el perfil AVC/AAC con plantilla de segmentos, conserva tiempos y limita XML a 256 KiB, 8000 nodos y 24 niveles. Otros perfiles conservan la ruta original. `tdt-dash-relay.js`, en el proceso de red con UID OAP, refresca el MPD y sirve solo las plantillas registradas por una URL local con secreto por reproducción. Verifica TLS/certificados hacia el CDN; FFmpeg solo accede al HTTP de loopback de esa reproducción. Límites: ocho peticiones, diez segundos, segmentos de 16 MiB y 64 plantillas con caducidad. Cerrar/retunar destruye las peticiones y el servidor. No se distribuyen certificados privados ni se desactiva TLS.

La selección confirmada en el coche utilizó un servidor HTTPS temporal. La implementación integrada usa el relay anterior para evitar claves/certificados locales en producción: **ese transporte nuevo está validado localmente, pendiente de repetir en MGU**. La prueba con FFmpeg real descubrió además que el MPD debe llevar longitud explícita; se añadió `Content-Length` para evitar el fallo de fin de archivo con respuesta chunked.

### Causas demostradas y correcciones

1. **Proxy incompatible con Node 8 en rutas de error.** `ServerResponse.writeHead()` no devuelve la respuesta en Node 8. El código encadenaba `.end()` al enviar 407/403/502. Una resolución/conexión fallida podía lanzar TypeError y cerrar el proxy, en vez de devolver HTTP 502. La regresión reproduce las semánticas Node 8 y comprueba que sigue atendiendo tras cada error. No prueba que sea la única causa del coche.
2. **Recuperación que quitaba audio sin comprobar la causa.** Un error antes del primer fotograma volvía a abrir la fuente sin audio. Ahora solo se permite ese descenso si FFmpeg confirma que no existe la pista de audio. Un HTTP 429/5xx o timeout tiene reintento limitado conservando audio. Un error de mapa de streams permite corregir la selección del programa, sin confundirlo con un fallo de red.
3. **Observabilidad.** Contadores por reproducción: intentos, reconexiones, hueco máximo entre cuadros decodificados y publicados, cola, descartes y vaciados. Audio separa bytes recibidos, enviados al pipe, descartados y contrapresión. Enviar bytes al pipe no acredita escritura ALSA ni altavoces. Los contadores periódicos son muestras cada cinco segundos, no el total final de la sesión.

Se conserva el búfer de dos segundos, resolución 640×360 y 20 fps. Con la cola llena se pausa el stdout del decodificador y se conservan los bytes pendientes; ya no se borran los cuadros futuros de cada ráfaga. PCM sigue drenándose independientemente. La ruta MGU pasa a entrada sin `-re`, con contrapresión acotada; la previsualización conserva entrada acompasada. En el ensayo MGU de 35 s, la misma cola con `-re` produjo dos vaciados y hueco máximo 4279 ms; sin él, cero vaciados y 85 ms. Esa mejora de entrega **no eliminaba los cuadros duplicados**: también hizo falta la selección DASH descrita arriba.

## Hardware: primera vía investigada

REA identificó el ELF x86-64 `libNmeVideoMSDK.so`, SHA-256 `66af80f2d55c5c9c7bc8bb87bf5ee6652c5eebc700bdce0aa6cd5a097cb15221`. No hay proveedor de pseudocódigo compatible disponible; se usan símbolos, dependencias y desensamblado LLVM previamente documentado, sin llamarlo decompilación completa.

- La ruta original usa `libdispatch_shared`, Intel Media SDK, VA-API **libva.so.1** / libva-drm.so.1 y renderD128. En el binario ya se verificaron DecodeHeader, DecodeFrameAsync y SyncOperation; salida NV12. Las selecciones AVC/MPEG-2/HEVC no prueban todos sus perfiles ni su disponibilidad para el UID OAP.
- `libmfxhw64-p.so.1.24`, SHA-256 `fa95f7b1b017626fb6ca037b7579bc5b8d1dcfb725f69df52556b4eb310d7f85`, exporta Init/InitEx/DecodeFrameAsync/SyncOperation/SetHandle. La ABI no se sustituye por libva.so.2 o oneVPL de un PC moderno.
- El FFmpeg distribuido se compila con `--disable-everything --disable-autodetect` y sin habilitar VA-API/QSV. **Añadir `-hwaccel vaapi` al comando no habilita una función ausente.** La biblioteca libavcodec de serie tampoco acredita HLS ni un ejecutable FFmpeg utilizable.
- La regla de dispositivo copiada anteriormente asigna 0660/grupo video. El proceso FFmpeg toma el UID/GID OAP del proxy; el servicio de interfaz no declara User. Hay que comprobar UID y grupos efectivos del decodificador, no inferir permisos porque el servicio sea root. No se cambia chmod, grupos ni política global.
- `tools/tdt-runtime/probe-vaapi.c` abre el render node con el usuario que la ejecute, carga libva 1, consulta perfiles/entrypoint VLD/soporte YUV420 y comprueba carga/símbolo MFX. Informa expresamente **decodedFrames=0**. Se ejecutó la consulta en la MGU; no mide NV12→I420 ni certifica fluidez. No se ejecuta automáticamente ni se instala como servicio.
- Compilación Zig 0.14.1, C11 `-Wall -Wextra -Werror -O2`, x86_64-linux-gnu.2.27; ELF con `/lib/ld-linux-x86-64.so.2`, libc/libdl/libpthread y símbolos GLIBC_2.2.5. Binario local de 7008 bytes, SHA-256 `85ff0b11f5146ec93fba2d994f5e80c3a8861044739b4dbaa0a49a72eb17db31`.

**Decodificación real:** `probe-msdk.c`, compilada contra las cabeceras públicas MIT de Intel Media SDK 1.x, decodificó en MGU los **100/100 cuadros** de una muestra AVC sintética: primer cuadro 26,1 ms, total 752,9 ms, checksum 2965455793. InitEx/QueryIMPL confirmaron hardware y VA-API, con salida NV12 a memoria. La prueba inicial drenaba 94 cuadros; se corrigió el vaciado final del decodificador. No incluye escalado, MGVF, canal en directo ni altavoces.

Fuente propia `tools/tdt-runtime/probe-msdk.c`; cabeceras `mfxvideo.h`, `mfxsession.h`, `mfxvstructures.h`, `mfxstructures.h`, `mfxcommon.h`, `mfxdefs.h` de `api/include` del repositorio público Intel Media SDK. Compilador Zig 0.14.1, ABI 1.24 (`MFX_VERSION=1024`), C gnu11 con `-Wall -Wextra -Werror`, destino x86_64-linux-gnu.2.27 y enlace libdl. ELF local `dist/bmw-local-tdt-test/probe-msdk`, SHA-256 `5d3b53d86ce6c767f4b5007548b22c76a23e2e63163acd4dd4de9dffcd0d01a5`. Las cabeceras y muestra quedan en el área privada de herramientas; no se redistribuye firmware.

El proceso de producción usa UID/GID 12252 sin grupo video y obtuvo EACCES al abrir renderD128. Una sonda con ese UID y GID 44, aplicado **solo a su proceso**, accedió al dispositivo. No se cambiaron grupos, chmod ni configuración global. El backend hardware no se ha activado en producción: hace falta completar transferencia/escalado, B-frames y comparación de extremo a extremo.

La referencia comunitaria `waze-on-cluster/src/decoder_msdk.cpp` ofrece MSDK + VPP y salida NV12. Es GPL-3.0-or-later y orientada a H.264 Annex-B de proyección; no se ha copiado a BMWLauncher ni se asume que su orden de cuadros sirva para todos los canales con B-frames. Ayuda a plantear un auxiliar separado con licencia/ABI verificadas. [Código primario](https://github.com/robertnisipeanu/idrive-apps/tree/main/native/waze-on-cluster), [Intel Media SDK](https://github.com/Intel-Media-SDK/MediaSDK), [libva 1.8.3](https://github.com/intel/libva/blob/1.8.3/va/va.h).

Para reconstruir la sonda con el compilador local:

```powershell
& "$env:TEMP/bmw-launcher-knob-tools/ziglang/zig.exe" cc -target x86_64-linux-gnu.2.27 -std=c11 -Wall -Wextra -Werror -O2 -s tools/tdt-runtime/probe-vaapi.c -ldl '-Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2' -o dist/bmw-local-tdt-test/probe-vaapi
```

## Ensayos de PC anteriores a la selección DASH

Windows x86-64, Node 8.16.2 y FFmpeg 9.0.2; 640×360 a 20 fps, receptor PCM de prueba. No son tiempos de MGU ni fotogramas físicamente presentados por Winston.

| Escenario | Resultado |
| --- | --- |
| Referencia del reproductor anterior: dos segmentos demorados 1400 ms + bloqueo UI de 650 ms | 250 cuadros; hueco productor máx. 65 ms; 13 cuadros avanzados durante bloqueo UI; 2.371.200 bytes PCM |
| Nuevo ensayo con HTTP 503 y PCM normal | 250 cuadros; primer cuadro 773 ms; hueco productor 66 ms; cero vaciados/reconexiones; PCM 2.361.600 bytes |
| Nuevo ensayo, además un HTTP 503; sin audio | 250 cuadros; primer cuadro 701 ms; hueco productor 65 ms; cero vaciados/reconexiones; 13 cuadros durante bloqueo UI |
| Mismo ensayo con receptor PCM bloqueado | 250 cuadros; primer cuadro 772 ms; hueco productor 59 ms; cero vaciados/reconexiones de vídeo; aviso audio-pipe y recuperación acotada del auxiliar; 13 cuadros durante bloqueo UI |
| La 1 pública, 30 s | 221 cuadros; primer cuadro 16.563 ms; un vaciado; hueco productor 2.518 ms; PCM 2.121.600 bytes; sin fallo del receptor |
| La 2 pública, 30 s | 324 cuadros; primer cuadro 4.070 ms; un vaciado; hueco productor 9.928 ms; PCM 3.110.400 bytes |
| La 2, ensayo sin `-re`, otros 30 s | 380 cuadros; primer cuadro 6.391 ms; un vaciado; hueco productor 4.723 ms; PCM 3.648.000 bytes |

El observador del anillo se bloquea deliberadamente junto a la UI: sus huecos de unos 700 ms no son los del productor aislado. Las emisiones de esta tabla no cumplían fluidez. No se utiliza la comparación secuencial sin `-re` como evidencia controlada del coche; las medidas MGU posteriores están descritas arriba.

### Comprobaciones tras integrar la corrección

- DASH sintético offline, dos calidades AVC y AAC, FFmpeg 9.0.2 real y Node 8.16.2: selección adaptada activa, 130 cuadros, primero a 363 ms, hueco productor máximo 66 ms, cero vaciados/reconexiones. El transporte HTTPS está sustituido por una fixture; no es una prueba de TLS ni de altavoces. Comando: `node tools/Probar-DASH-TDT.js RUTA_FFMPEG`.
- HLS con 503, dos segmentos retrasados, salida PCM bloqueada y UI bloqueada 650 ms: 250 cuadros, cero vaciados/reconexiones, hueco productor máximo 67 ms, 13 cuadros avanzados durante bloqueo de UI. El aviso y los reintentos de audio no reiniciaron vídeo.
- La 2 pública en PC, 30 s: 546 cuadros, cero imágenes repetidas en las muestras, hueco productor máximo 70 ms y 5.164.800 bytes al receptor PCM. Esta fuente del catálogo era HLS; **no se presenta como validación del relay DASH real**. `--dash` permite exigir DASH y falla si no está anunciado.
- Suite completa y compatibilidad Node 8 se registran en BITACORA. Los contadores de `stats` son la última muestra periódica, pueden ser inferiores al total final del observador.

```powershell
node --test emulator/split/*.test.js
& "$env:TEMP/bmwlauncher-node-v8.16.2/node.exe" tools/Probar-Reproduccion.js RUTA_FFMPEG
& "$env:TEMP/bmwlauncher-node-v8.16.2/node.exe" tools/Probar-Reproduccion.js RUTA_FFMPEG --block-audio
& "$env:TEMP/bmwlauncher-node-v8.16.2/node.exe" tools/Probar-Reproduccion.js RUTA_FFMPEG --no-audio
& "$env:TEMP/bmwlauncher-node-v8.16.2/node.exe" tools/Probar-Canal-TDT.js RUTA_FFMPEG "La 1"
```

`Probar-Canal-TDT.js` no guarda la emisión ni registra URL/tokens; solo contadores y estados. La prueba sintética incluye 503, retrasos y bloqueo UI. El PCM se envía a un receptor de PC, no a SmartX. [FFmpeg: readrate y -re](https://ffmpeg.org/ffmpeg.html).

## Audio y aceptación pendiente en el coche

La ruta configurada sigue siendo la de medios `smartx:MediaSink_AudioOut_Front_CF_48_COMBINED_STEREO_MULTICHANNEL`. En el i4 abrió y comunicó RUNNING, pero terminó bloqueada con EAGAIN, incluso con foco temporal concedido. PCM → pipe → ALSA → SmartX → foco/ruta de medios → altavoces son comprobaciones diferentes. No se usan canales de avisos. La cola actual no transporta PTS explícitos: sincronía labial pendiente, especialmente tras descarte, vaciado o reinicio del auxiliar. [SmartX de Intel](https://github.com/intel/AVB-AudioModules/blob/master/private/src/alsa_smartx_plugin/IasAlsaSmartXConnector.cpp).

La prueba del reproductor nativo aceptaba foco/lista y seguía detenida. El análisis local encontró que seleccionaba posición 0, centinela de «ninguna pista»; la primera es 1. Se ha corregido **la sonda**, añadido posición/tiempo/error y un vigilante de liberación. No se ha cambiado a esa vía en producción sin validarla. [Evidencia y siguiente ensayo de audio](TDT-AUDIO-MGU21.md).

Para cerrar la prueba: conexión ENET/SSH disponible; autorización concreta para copiar/ejecutar la sonda y el paquete, como UID del decodificador; después una muestra AVC/AAC de canal con hardware y software, misma variante y salida, incluyendo MSDK/VPP, transferencia NV12, conversión I420, MGVF y presentación real. Medir CPU/RSS, entrada→pantalla, primer cuadro, huecos p50/p95/máximo, PTS y latencia. Probar 30 minutos con el coche parado y confirmar de oído los altavoces. Cortar red, bloquear audio, retunar rápido y cerrar; comprobar cierre de auxiliares/anillos/foco. Si la sonda carga bibliotecas, eso solo desbloquea la siguiente prueba, no autoriza a elegir hardware automáticamente.

## Reversión

Restaurar app y motor de 0.2.10 con un número de paquete superior si ya se instaló la prueba, conservando IDs/UUID y favoritos. La sonda es un fichero independiente sin unidad systemd; borrarla no cambia configuración del coche. Revertir el modo de mapa a 0.2.10 también recuperaría OSM: no hacerlo si se quiere mantener el requisito de BMW local exclusivo.
