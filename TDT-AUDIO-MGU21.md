# Audio nativo de TDT · MGU21

## Foco del directo validado en el i4 · 15-11-2026

El usuario ha confirmado **sonido continuo y limpio del canal** en dos pruebas temporales: primero manteniendo únicamente el foco `DynamicMediaPlayerMedia`, y después con el nuevo controlador de foco. Se mantiene FFmpeg → PCM → SmartX; no se reproduce un segundo archivo BMW. La segunda prueba estaba programada para 90 s, pero el usuario reinició iDrive durante ella: no se atribuyen 90 s completos ni una medición de sincronía a esa confirmación.

### Qué impedía avanzar

- El firmware HWGEN21/highf anuncia `DynamicMediaPlayer` (`0xb0c0`, v1.0), instancias Media=1 y TempMedia=2. No anuncia `MediaPlayer/OapGenericMedia` (`0xb042`, v2, instancia 40), aunque el catálogo enumere esa instancia. La configuración HWGEN18 sí registra OapGenericMedia; no copiar esa ruta al i4 ni habilitarla modificando el firmware.
- El directo abría ALSA sin adquirir el foco de BMW. Retunar mientras se conservaba un foco temporal permitió oír el canal; al terminar el ensayo dejaba de sonar. La prueba de solo foco, con el auxiliar PCM recién abierto y sin crear playlist/PLAY, permitió sonido limpio confirmado por el usuario.
- La sonda de archivos tenía además un identificador incorrecto: ASCII `00000001` se transforma en `0x3030303030303031`; el consumidor usa sus 32 bits bajos como posición del medio. El ByteBuffer binario `00 00 00 01` sí selecciona la pista 1. La sonda C++ queda corregida y compilada.
- Corregido el identificador, `mediaengine` abre el archivo y anuncia 1/1, pero devuelve `informationError` **17** y DynamicMediaPlayer `ITEM_UNPLAYABLE`, tanto con WAV como MP3. No equivale a formato no compatible: la tabla del firmware traduce 17 desde el error interno 18, que agrupa `CinemoErrorResources` (12) y `CinemoErrorVideoResources` (100). No se ha determinado cuál de los dos originó el rechazo. La reproducción de archivos por Cinemo sigue pendiente y no se presenta como arreglada.

### Implementación y cierre

`tdt-audio.js` espera al foco antes de abrir `tdt-pcm`; sigue drenando el PCM y presentando vídeo durante la espera o el fallo. `tdt-audio-focus.js` crea un supervisor y un propietario en `tdt-focus-process.js`. El contrato mínimo observado vive en `tdt-focus-session.js` y usa el módulo SOME/IP nativo ya instalado, en Node 8, fuera del hilo de interfaz. Los tres archivos se declaran en `component.json`.

El supervisor está conectado antes de que el propietario solicite foco; vigila un permiso local renovado cada 750 ms, con caducidad de 3,5 s. Solo libera el token cuyo `clientId` aleatorio de esa sesión y nombre de aplicación coinciden. Si muere el propietario, cubre también la posible respuesta tardía de adquisición. No modifica volumen, autoplay, playlist, conexiones globales ni canales de avisos. Pérdida de foco, cierre o agotamiento de reintentos de ALSA cierran el auxiliar. No se recupera el foco automáticamente frente a otra fuente activa.

Tras reiniciar, esta MGU puede anunciar CONNECTED/HAS_FOCUS con los tres campos de propietario vacíos y `PLAYER_STATE_STOP`. Ese estado se admite como selección inactiva; con reproducción activa, propietario presente o lecturas incompletas se rechaza. LOST_FOCUS con propietario antiguo y conexión cerrada no se «limpia» volviendo a adquirir el foco.

### Evidencia y límites

- Pruebas físicas de cierre normal, SIGKILL del propietario y SIGKILL del cliente: fuente sin propietario y desconectada después de cada una. No se reinició la MGU desde nuestras herramientas; el reinicio observado lo confirmó el usuario como suyo. Sin modificaciones del cockpit.
- Verificación final: `node --test --test-concurrency=4 emulator/split/*.test.js`, **260/260**; las ocho regresiones de foco también pasaron aisladas. Carga de los módulos modificados y sintaxis del servicio comprobadas con Node 8.16.2; los tres auxiliares figuran en el componente. La primera ejecución simultánea tuvo un fallo temporal en la espera de escritura de preferencias de navegación; ese archivo pasó aislado y no se modifica navegación para ocultar el resultado.
- El ELF manual se compiló con C++14, `-Wall -Wextra -Werror`; x86-64, intérprete `/lib/ld-linux-x86-64.so.2`, versiones requeridas hasta GLIBC 2.14 y GLIBCXX 3.4.22; SHA-256 `0c5db9476fa609ce32ff004845f3f6b539a2a549df1f81bcd232667f7dd0e911`. El cambio de payload se probó físicamente con la sonda JS equivalente; ese ELF concreto no se ejecutó en la MGU.
- Cierre de la sesión física: cero procesos temporales propios, foco libre y conexión cerrada. Retirados únicamente los tres módulos del directorio temporal de validación. SSH permanece abierto.
- La integración se incluye en la 0.2.19. Falta instalarla y repetir cambios de canal, visibilidad y convivencia con otras fuentes durante una sesión larga. Los contratos completos, bibliotecas y trazas de la unidad permanecen fuera del repositorio.

## Muestra BMW de 30 segundos · 0.2.17

Añadido modo explícito de prueba en TDTWorld, separado del directo. Captura acotada del mismo canal, WAV completo y vídeo I420, presentación por reloj BMW, limpieza y rechazo de fuente ocupada. No reclama que HLS continuo funcione con el reproductor nativo.

Ensayo real autorizado por SSH el 15-11: preparación del archivo en ~23–24 segundos; CommandControl disponible y connect devuelve E_OK, pero MediaPlayer/OapGenericMedia no se anuncia antes ni después. La lectura directa de playerState devuelve Service unavailable. No se llegó a playFile ni a sonido audible. Se liberó la conexión temporal; la consulta final conserva solo la conexión original. No se instalaron paquetes, no se reinició la MGU y no se modificaron capas del cockpit. El orden connect → esperar MediaPlayer y su retirada ante fallo quedan cubiertos por regresión.

Regresión del directo en PC con FFmpeg 9.0.2: 250 cuadros, cero vaciados/reconexiones, hueco máximo del presentador 58 ms y 12 avances durante el bloqueo sintético de UI de 650 ms. El receptor PCM recibió 2.380.800 bytes. No son cifras de altavoces/MGU. La captura sintética valida formato WAV, límites, cancelación y seguimiento de reloj; la disponibilidad del reproductor de este i4 sigue bloqueando la prueba audible.

## Referencias de YouTube de MGU Store · 25-11-2026

El catálogo actual de [IterioDev/car-apps](https://github.com/IterioDev/car-apps) no ofrece YouTube. La documentación del [renderer de MGU Store](https://github.com/robertnisipeanu/mgu-store/blob/main/native/mgu-render/README.md#video) conserva la referencia a la app de IterioDev y su ejecutable `mgu-ytplay`. Acredita el uso del anillo I420 en memoria compartida para presentar con GPU. El catálogo revisado no permite descargar ese reproductor.

| Referencia revisada | Vídeo | Audio |
| --- | --- | --- |
| Bube 0.1.10 / `drake1804-ytplay` 0.1.16, fuentes `543a23b` | FFmpeg sin aceleración de decodificación configurada, I420 en anillo MGVF y composición en GPU | Un FFmpeg aparte decodifica AAC a PCM estéreo de 48 kHz. `ytaudio` abre ALSA en otro proceso, cuenta vaciados y usa `snd_pcm_delay` para estimar el audio reproducido. El vídeo ajusta su reloj a esa estimación. El autor registró que la unidad abrió dispositivos sin que se oyera audio. |
| RideTube 0.6.4, `eb0973bd8f6a3b90b52af4710b093e6afb1ca384` | Intel Media SDK decodifica H.264 o VP9 y VPP escala. Copia I420 a MGVF para mgu-render. | `MediaPlayer.playFile` de BMW reproduce M4A locales y publica el reloj que sigue el vídeo. Utiliza archivos de audio completos y advierte de un posible hueco al pasar de la muestra inicial al fichero completo. |
| BMWLauncher 0.2.24 | FFmpeg decodifica y escala con CPU. El worker escribe I420 en MGVF y mgu-render compone con GPU. | La salida SmartX recibe PCM estéreo de 48 kHz. Con precarga, `tdt-player.js` entrega bloques de PCM con el temporizador del vídeo y descarta muestras cuando descarta fotogramas para recuperar el ritmo. |

Se descargaron los dos paquetes de Bube del catálogo `Releases`, con SHA-256 coincidente, y su código fuente, con el digest de la API de GitHub verificado. Se descargó también la etiqueta de RideTube. El catálogo de Bube y el catálogo generado por RideTube declaran `ID7`, incluido el servicio del que depende cada app. Se examinaron los paquetes y el código en el PC. [Releases de Bube](https://github.com/Drake1804/bube-releases/releases/tag/catalog) · [Servicio de RideTube](https://github.com/JustAnotherPU/ridetube/blob/eb0973bd8f6a3b90b52af4710b093e6afb1ca384/native/jap-ridetube-d/README.md) · [Decodificador de RideTube](https://github.com/JustAnotherPU/ridetube/blob/eb0973bd8f6a3b90b52af4710b093e6afb1ca384/native/ytdec/README.md)

Para localizar los chasquidos, en la misma emisión conviene cotejar el instante oído con los descartes PCM del worker, el retardo y los vaciados en ALSA y el estado de foco de BMW. Un descarte al recuperar el reloj puede cortar la continuidad de onda, pero esa coincidencia aún no está medida en el i4. El reloj de audio de las dos referencias orienta el ensayo. Cambiar la decodificación de vídeo a GPU requiere primero verificar la ABI y medir presión de CPU coincidente con el fallo en MGU21.

## Ruta de RideTube contrastada con el i4 · 15-11-2026

Investigación pública posterior a publicar 0.2.15, sin ENET. Referencia: `JustAnotherPU/ridetube`, revisión **63364945d85344071dda0821464c4822372001e7**. Su [README](https://github.com/JustAnotherPU/ridetube/blob/63364945d85344071dda0821464c4822372001e7/README.md) declara prueba en un X5 G05 iDrive 7; no valida automáticamente MGU21/ID8. Las capturas de interfaz del README son renders de PC, no fotos del coche.

### Diferencia respecto a nuestra reproducción

[ytd.js, Audio](https://github.com/JustAnotherPU/ridetube/blob/63364945d85344071dda0821464c4822372001e7/native/jap-ridetube-d/ytd.js#L650) obtiene `MediaPlayer` en la instancia `OapGenericMedia`, conecta la fuente 1046 al sink 1024 mediante `CommandControl.connect` y llama `playFile` sobre un archivo de audio local. **No entrega PCM a nuestro auxiliar ALSA ni usa DynamicTempMedia para reproducirlo.** Se suscribe a tiempo, estado y error de reproducción; su vídeo sigue el tiempo que anuncia el reproductor BMW.

Su [decodificador](https://github.com/JustAnotherPU/ridetube/blob/63364945d85344071dda0821464c4822372001e7/native/ytdec/README.md) usa Media SDK/VPP y copia GPU antes de escribir MGVF, el mismo formato de anillo que admite nuestro renderer. Es una referencia para un backend futuro, no motivo para cambiar ahora el decodificador ya publicado. No se han trasladado a nuestro rendimiento las cifras que el autor mide en otro coche.

### Coincidencias comprobadas en nuestros datos descargados

Catálogo `someip-interfaces.json` del 14-11 y captura `audio-active-decoded.json` del 13-11, mantenidos fuera del repositorio:

| Elemento | MGU21 del i4 |
| --- | --- |
| MediaPlayer | Servicio `0xb042`, versión 2.0; instancia `OapGenericMedia = 40` |
| playFile | Método `258`; path UTF-16BE y LanguageCode; responde EntError |
| setTime / sendButtonEvent | Métodos `264` / `257` |
| CommandControl | Servicio `0xb020`, versión 1.1, instancia 1 |
| connect / disconnect | Métodos 1 / 2 |
| Fuente anunciada | `1046`, nombre `OAPGenericMedia` |
| Salida anunciada | `1024`, nombre `MediaSink_Front` |

Esto demuestra coincidencia de contrato e identificadores. **No demuestra que playFile esté disponible ni suene en nuestro coche**, porque no se ha probado esa combinación. La prueba anterior de foco y PCM utilizaba otra ruta. Los números se volverán a verificar por nombre y disponibilidad en el coche, sin elegir fuentes de avisos o llamadas.

### Límite del directo y ensayo siguiente

El [servicio de RideTube](https://github.com/JustAnotherPU/ridetube/blob/63364945d85344071dda0821464c4822372001e7/native/jap-ridetube-d/README.md) necesita archivos M4A completos: primero prepara un fragmento inicial y luego cambia al archivo completo. El autor advierte que la transición puede oírse. **Esto no prueba reproducción HLS en directo ni audio sin huecos con fragmentos sucesivos.** No se sustituye TDT por archivos parciales concatenados ni se anuncia resuelto el audio.

La prueba siguiente debe separar tres hechos: (1) reproducir un WAV/M4A completo mediante esta fuente y confirmar sonido limpio; (2) reproducir una muestra finita del canal y seguir el reloj BMW para medir A/V; (3) comprobar si el motor admite una fuente continua, registrando errores y tiempo efectivo, antes de diseñar el transporte del directo. Sin el tercer punto, RideTube aporta una vía para diagnosticar la salida, no una solución completa a TDT.

El ensayo debe negarse si OAPGenericMedia ya está ocupado y liberar únicamente una conexión creada por él. No copiar el barrido de conexiones por sourceID que realiza RideTube: la fuente puede estar compartida con otra app. No cambiar volumen, rutas globales ni estado de las fuentes de seguridad. Es investigación local; **ninguna de estas acciones se ejecuta al instalar 0.2.15**.

Se revisó también [MGU Video Hub](https://github.com/NamelsMissing/mgu-apps/blob/6440ecd937d98306e096168967e8798e52f819a1/apps/mgu_video_hub/README.md): documenta ALSA/aplay experimental, apagado por defecto y sin ruta BMW verificada. No aporta evidencia de sonido corregido frente a nuestro fallo.

## Corrección local de pérdidas de PCM · 14-11-2026, sin ENET

**Hay una pérdida de audio corregida en el PC; el sonido limpio en el i4 sigue pendiente.** No se incorporan las variantes ALSA que el usuario seguía oyendo distorsionadas.

Con los nuevos contadores se reprodujo un fallo independiente de SmartX: la cola eliminaba **169.088 bytes (0,881 s de PCM estéreo a 48 kHz)** por desbordamiento, aunque el vídeo no perdía cuadros. FFmpeg adelanta audio respecto al vídeo y la contrapresión solo en stdout no protegía esa cola. Se mantiene su límite de cinco segundos: ahora se pausa el productor al alcanzar cuatro segundos de PCM **si hay dos segundos de vídeo disponibles**, y se reanuda con dos segundos de PCM o cuando falta reserva de vídeo. La disponibilidad de ALSA no controla esa pausa; el reloj sigue consumiendo aunque falle el auxiliar. Cancelar libera ambas tuberías.

También se corrigió la excepción síncrona al lanzar el auxiliar: antes lo intentaba con cada bloque, fuera del límite de reintentos. La regresión reproduce 40 intentos frente a los dos permitidos; después son dos y sigue drenando PCM. No se atribuye este fallo al coche sin evidencia de ejecución.

### Comparación local

Windows, Node 24.12.0, FFmpeg Windows 9.0.2 existente, SHA-256 `3256173f3f8bffd7df12227c68adf68025edb1832273a9530688a7bb1ed8edec`. `tools/Probar-Reproduccion.js`: HLS sintético, HTTP 503, dos segmentos retrasados y bloqueo deliberado de UI de 650 ms. **El receptor PCM no es ALSA ni los altavoces.** Los contadores cada cinco segundos son la última muestra, no un cierre exacto al cuadro 250.

| Escenario | Desborde PCM | Cuadros al terminar | Vaciados/reconexiones de vídeo | Hueco máximo del productor |
| --- | ---: | ---: | --- | ---: |
| Antes, política anterior con contadores | 169.088 bytes | 250 | 0 / 0 | 75 ms |
| Después, receptor normal | 0 | 250 | 0 / 0 | 64 ms |
| Después, receptor bloqueado | 0 | 250 | 0 / 0 | 64 ms |
| Después, Node 8.16.2 y receptor normal | 0 | 250 | 0 / 0 | 65 ms |

En los cuatro avanzaron 13 cuadros durante el bloqueo de UI. Los 650–708 ms del observador corresponden a su bloqueo deliberado; no son una pausa del productor. Persisten descartes de arranque del receptor local (50–200 ms según ejecución), separados como `notReadyBytes`; no se declara sincronía perfecta. Con destino bloqueado se descarta PCM para preservar vídeo y se conserva el aviso/reintento acotado. El benchmark ahora falla si detecta desbordamiento PCM.

`tools/tdt-runtime/Analizar-Audio-TDT.js` analiza trazas privadas sin conectar ni imprimir URL/tokens. El ensayo conjunto del i4 da **36.010 tramas PCM/s** durante 42,228 s y 1.708.800 bytes descartados en su última muestra. El separado da **47.432 tramas/s** durante 46,551 s. Son tramas estéreo aceptadas por software, no muestras oídas; **la corrección de cola no demuestra resuelta esa diferencia de SmartX**.

Ghidra local permitió decompilar SmartX (`transferJob` 0xc870, `getFramePointer` 0xc500, configuración 0x15780, arranque 0x180c0). Se confirma el camino de anillo compartido/control IPC, sin evidencia para cambiar canales/frecuencia con un factor supuesto.

Próxima prueba física: una sola salida PCM propia, foco sostenido, mismo canal/representación y contadores de recepción, cola y aceptación ALSA. Comprobar ausencia de auxiliares anteriores, sonido y sincronía de oído. No tocar rutas de llamadas/avisos. Cambios locales, sin publicación ni instalación.

## Actualización física del 14-11-2026 · 0.2.14

**El audio no está corregido todavía.** Se ha conseguido sonido sostenido en pruebas temporales, pero el usuario sigue oyendo distorsión en la reproducción conjunta y desfase al separar los decodificadores. No se han instalado ni publicado estas variantes.

Se probó `DynamicTempMedia` libre, sin propietario previo, con `getAudioFocus` y heartbeat cero; se esperó a CONNECTED antes de abrir una salida PCM nueva. El modo de foco no crea lista, no solicita PLAY y no cambia volumen. La sonda mantuvo el foco durante toda la prueba y restauró su estado al terminar, con vigilante independiente. La sonda anterior liberaba el foco a los 16 segundos: sus ensayos más largos no demostraban continuidad de la ruta después de ese instante.

| Ensayo | Medición | Observación del usuario |
| --- | --- | --- |
| Audio del canal en decodificador separado, PCM preacumulado y entregado cada 50 ms | Aproximadamente 47 s de escrituras sostenidas, unas 47.400 muestras/s aceptadas; sin contrapresión ni fallo del auxiliar después del arranque | Primera prueba: continuo. Repetición: casi limpio, alguna distorsión y desfase con la imagen |
| Vídeo/audio del reproductor instalado, foco mantenido, auxiliar instrumentado | Aproximadamente 36.000 muestras/s aceptadas frente a las 48.000 requeridas; contrapresión y descarte de PCM, sin reinicio de vídeo en el ensayo | Distorsión |
| Reproductor normal instalado, solo foco temporal y retune manual | Lecturas del auxiliar en torno a 144 kB/s | Distorsión también, por lo que no se atribuye únicamente a la copia de vídeo de la sonda |

Estas cifras son aceptación/escritura de software, **no un contador de muestras oídas**. El temporizador de 50 ms del ensayo separado deriva respecto al reloj monotónico; no adoptarlo como solución de sincronía.

ALSA negoció 48 kHz, entrada S16_LE estéreo, período de 1024 muestras y búfer de 3072. `plug` convierte a un destino SmartX de **ocho canales**, con datos en 0/1 y silencio en los restantes. La configuración descargada declara la misma salida frontal de medios, período 1024 y tres períodos. No se cambiaron rutas de avisos, llamadas o seguridad.

No eliminaron la distorsión: `snd_pcm_wait` en lugar de pausa fija, escrituras de períodos completos, apertura no bloqueante desde el inicio, espera adicional tras adquirir foco, salida directa MMAP de ocho canales, entrega independiente cada 10 ms, umbral de inicio de un período, lectura FFmpeg con `-re`, ni abrir ALSA al entregar el primer PCM. Esas variantes **no se incorporan a producción**. La causa del ritmo insuficiente en la reproducción conjunta sigue sin demostrarse; no declarar que el foco resuelve también la distorsión.

Se guardaron sondas, fuentes, registros y hashes fuera del árbol publicable; los nativos experimentales compilaron con Clang/LLD, glibc 2.27 y `-Wall -Wextra -Werror`. Al cambiar la prioridad del usuario a AA se comprobaron ausencia de token propio y de procesos de prueba, y se retiró el directorio temporal. La app y su auxiliar PCM instalados permanecen sin cambios.

Los apartados siguientes conservan la investigación anterior y sus límites en esa fecha; no sustituyen los resultados nuevos.

Investigación del 13-11-2026. Herramienta manual: `tools/tdt-runtime/probe-dynamic-audio.cpp`. No forma parte del componente instalado ni se lanza al abrir TDTWorld.

## Resultado y límite

**Con vídeo corregido:** ensayo HLS + SmartX + la misma sonda de foco. El usuario oyó unos 10–15 s con microcortes. A los diez segundos ya había contrapresión y 307.200 bytes descartados; el foco todavía no se había liberado. Después apareció `state=3`, `stall=-11` y se agotaron los reintentos. El vídeo permaneció estable (cero vaciados/reconexiones, hueco máximo 66 ms). Hay un problema de entrega PCM anterior a la liberación de foco, por lo que prolongar la sonda no basta como corrección. La versión publicada 0.2.12 no incluye las sondas ni una supuesta solución de audio.


**Ensayo ENET del 14-11, tarde:** el usuario oyó dos ráfagas del canal durante la prueba completa de DynamicTempMedia. La variante de solo foco no produjo sonido. Repetir la prueba completa con el aviso ALSA ya fijo tampoco; volver a abrir el canal y repetirla sí produjo ráfagas. El usuario confirmó que el sonido se interrumpía al congelarse el vídeo y no regresaba después de quedar fijo «ALSA sin avance (3)», aunque avanzase la imagen. Se comprobó por `/proc` que, en ese estado final, seguían el worker y FFmpeg, pero no el auxiliar `tdt-pcm`: sus reintentos son limitados. Esto acredita sonido intermitente oído, no reproducción continua ni una ruta de audio corregida.

La sonda mantuvo CONNECTED, STOP y tiempo cero; liberó su token y la consulta posterior confirmó desconexión. El inspector de la fuente propia fue inconcluyente al alcanzar su límite de 64 MiB. No se atribuyen las ráfagas a la reproducción de la pista WAV ni se amplía ese límite sin una búsqueda más precisa. La observación independiente del anillo de vídeo registró pausas de hasta 6766 ms. Sigue pendiente distinguir el agotamiento de la cola de vídeo de la pérdida de avance del PCM.

El audio **sigue sin validación continua por los altavoces**. La sonda seleccionaba posición **0**, que este consumidor usa como «ninguna pista seleccionada»; se corrigió a **1**, pero los ensayos posteriores del 14-11 mantuvieron STOP y tiempo cero. El cambio de índice no era suficiente. La decompilación local posterior confirma que el servicio responde OK a `createPlaylist` **antes de terminar de construir la lista**: ese OK no acredita una pista cargada ni reproduciéndose.

El camino de producción, FFmpeg → PCM → SmartX, sigue sin validación audible. Abrir el PCM frontal dejó ALSA en RUNNING y terminó con EAGAIN/salida bloqueada; adquirir foco con DynamicTempMedia no hizo avanzar por sí solo ese PCM. Se prepara un inspector de la fuente propia para separar recepción de lista, selección y actividad nativa antes de decidir un cambio de transporte. No se han apropiado fuentes de llamadas, avisos o seguridad.

## Evidencia de la prueba en el coche

- Servicio DynamicMediaPlayer `0xb0c0`, instancia **2** (DynamicTempMedia), versión 1.0. Se comprobó que estaba desconectado y sin propietario antes de pedir foco.
- `getAudioFocus` con heartbeat distinto de cero devolvió BAD_ARGUMENT. Con cero obtuvo un token propio. En este firmware el heartbeat del servicio está desactivado; no se cambia esa configuración. La prueba necesita su propio cierre independiente.
- `setAutoplay`, `createPlaylist`, `setCurrentItemPositionAndTime(0,0)` y PLAY devolvieron OK. La conexión llegó a **3/CONNECTED**, mientras que playerState continuó en **2/STOP**.
- El usuario confirmó que no oyó los tonos suaves. Esperar a CONNECTED antes de seleccionar y repetir PLAY no cambió ese resultado.
- La liberación del token devolvió OK. La comprobación posterior mostró fuente desconectada, sin token propio y sin procesos de prueba activos.
- La captura DLT intentada no produjo mensajes del motor; solo quedó la salida de la sonda. No se atribuye a DLT una causa que no observó.

Los registros completos y el firmware siguen en la carpeta privada de extracción. No se incorporan tokens, configuraciones privadas ni binarios BMW al repositorio.

## Trazabilidad estática del índice de pista

Artefacto: `/usr/bin/mediaapp` de la extracción de la unidad. SHA-256 `a95e789dc5efeb8007faa30ff3e932185bfdfd8f745a21815bdba26c2b3cf722`.

Análisis con LLVM y Capstone; no se presenta como pseudocódigo decompilado. Direcciones virtuales del ELF descargado:

| Punto | Evidencia |
| --- | --- |
| `0xf7bb70`–`0xf7bd1a` | El adaptador de `setCurrentItemPositionAndTime` recibe la posición UInt32 y la reenvía sin incrementarla a la función virtual `+0x5f8`. |
| Vtable `0x187c0b8` | El RTTI identifica `CDeviceOAPDynamic`; la entrada `+0x5f8` apunta a `0x8cd950`. |
| `0x8cdc6c`–`0x8cdc99` | El consumidor compara posición con el tamaño de la lista y pasa la misma posición a `setTrackAndTimeByPos`, `0x8cd600`. Que la petición devuelva OK no exige una pista distinta de cero. |
| `0x8d1147` | Al crear una lista se ponen a cero la posición de pista y su tiempo. |
| `0x8cd800`–`0x8cd846` | Para crear la reproducción de una pista se indexa el vector con **posición − 1**, multiplicado por el tamaño interno del elemento. |
| `0x8d8e30`–`0x8d8e59`, `0x8d9178` | `SourceActivityOn` distingue posición cero; esa rama no activa la lista como una pista seleccionada. |

Por tanto, la petición de la sonda original `(posición=0, tiempo=0)` no seleccionaba su única pista. La sonda nueva envía **1** tanto en el elemento de la lista como al seleccionarlo. El comportamiento de la selección del elemento está demostrado estáticamente; que ahora se oiga requiere repetir la prueba en la unidad.

## Contrato verificado y controles de la sonda nueva

- Posición y tiempo son UInt32 en orden de red. MetadataValue usa longitud UInt32 y discriminante UInt32: numérico **1**, texto **2**, identificador **3**. El índice interno inverso de CommonAPI Variant no se copia al cable: OutputStream lo convierte. [Runtime CommonAPI 3.1.12](https://github.com/COVESA/capicxx-someip-runtime/blob/3.1.12/include/CommonAPI/SomeIP/OutputStream.hpp).
- FILE_NAME=16, TITLE=3 e ITEM_TYPE=1 proceden del catálogo MGU21 y contienen URI UTF-16BE, título y bit de audio, respectivamente. No se inventa una fuente PCM como URL.
- `--inspect` es el modo predeterminado de solo lectura. `--play` es explícito y acotado; `--release` solo utiliza el token de la propia prueba. Siempre usa TempMedia, sin alternativas a otras clases de audio.
- Solo adquiere foco si los tres campos de propietario están vacíos y la conexión está desconectada. Guarda el token con 0600 y no lo imprime. La carpeta propia tiene 0755 para que el proceso `mediaengine` (usuario distinto de root) pueda leer la muestra WAV 0644; nunca se amplían permisos de dispositivos o rutas globales.
- Conserva/restaura el estado de autoplay anterior. El modo de reproducción crea antes de adquirir foco un vigilante separado: tras 40 s reejecuta `--release`; el proceso principal tiene límite de 35 s. En una salida normal con foco liberado cancela su propio vigilante.
- Registra el evento `playbackErrorEvent` (`0x8012`), posición/total de pistas y tiempo transcurrido/total, además de conexión y playerState. No imprime el ID ni los metadatos del contenido.
- Las respuestas se correlacionan por método y sesión SOME/IP y se sincronizan entre el hilo de recepción y el de control. La sonda descarta respuestas tardías y limita su tamaño a 4096 bytes.

## Compilación local y siguiente prueba

La compilación cruzada se ha ejecutado con Clang/LLD del NDK 28.2, sysroot GCC 7/glibc 2.27, C++14 y `-Wall -Wextra -Werror`. Cabeceras vSomeIP de la referencia comunitaria; las bibliotecas del firmware solo se usan para enlazar y permanecen fuera del repositorio.

```powershell
& tools/tdt-runtime/Compilar-Sonda-Audio.ps1 -PrivateRoot 'D:\Usuarios\javie\BMW\MGU21-20261113-mapas-video'
```

ELF comprobado: x86-64, intérprete `/lib/ld-linux-x86-64.so.2`; dependencias `libvsomeip.so.2`, `libstdc++.so.6`, `libgcc_s.so.1`, `libc.so.6`, `libpthread.so.0`. Máximos requeridos GLIBC 2.14 y GLIBCXX 3.4.22, cubiertos por las bibliotecas descargadas. SHA-256 del ELF compilado: `4e52d58a8dff337f9da2e21f8ebcd7d4abbce1ad771441ac31e4986e5f9d6246`. **No ejecutado en Linux ni en el i4 después de esta corrección.**

Cuando vuelva a estar autorizada y disponible la conexión: copiar únicamente sonda propia y WAV suave a la carpeta temporal, ejecutar primero inspección y después la reproducción. Exigir posición **1/1**, tiempo creciente y PLAY, registrar cualquier error de reproducción y pedir confirmación de sonido. Si sigue STOP, revisar primero error de contenido/URI; si avanza y no se oye, investigar ruta/mute mediante lecturas. No elevar volumen global ni cambiar rutas de seguridad para forzar el resultado.

Reversión: la sonda no se instala. Liberar su token, esperar o cancelar su vigilante propio, confirmar estado desconectado y retirar solo su carpeta temporal. No cerrar SSH si el usuario ha pedido mantenerlo abierto.

## Ensayos del 14-11-2026

La corrección de posición **1** se ejecutó en el i4. El foco y las órdenes devolvieron OK, pero durante dieciséis segundos se mantuvieron conexión CONNECTED, playerState STOP, posición **0/0** y tiempo **0/0**. No se recibió `playbackErrorEvent`. La aceptación de la lista no demuestra que el motor haya empezado a reproducirla; queda descartado presentar la corrección del índice como solución suficiente.

Se contrastó una segunda hipótesis: la conexión podría reiniciar la lista enviada antes de CONNECTED. La sonda se modificó para esperar esa confirmación **antes** de autoplay/createPlaylist, registrar la posición inmediatamente después y omitir la reproducción si no conecta. Resultado: `CONNECTED_BEFORE_PLAYLIST=1`, `PLAYLIST_RESULT=0`, `POSITION_AFTER_PLAYLIST=0/0`; STOP y tiempo cero durante toda la observación. Ese cambio de orden tampoco resuelve el fallo.

Comprobaciones adicionales:

- mediaapp y mediaengine usan el mismo espacio de montaje y `PrivateTmp=no`; ambos ven la muestra WAV de lectura pública en la carpeta propia 0755. No se cambiaron sus permisos de servicio ni dispositivos de audio.
- El journal recogió actividad del motor, pero ninguna causa explícita de rechazo de la pista. REA abrió mediaapp (mismo hash documentado), pero `analyze_function` devolvió `provider_unavailable`; el contraste adicional usa catálogo y desensamblado LLVM, sin pseudocódigo recuperado. No se atribuye un fallo de URI, códec o arbitraje sin más evidencia.
- En cada ensayo se restauró autoplay y se confirmó `releaseAudioFocus`. Inspección final: desconectado, STOP y sin token propio. Ningún proceso de prueba activo y temporales eliminados. No se utilizaron fuentes de avisos/llamadas ni se alteró el volumen.
- La captura de TDT de producción sigue indicando **«Audio · ALSA sin avance (3)»**. La prueba del reproductor nativo es independiente y todavía no sustituye ese transporte.

Como en la sonda del mapa, el plazo RPC manual se acota con reloj monotónico y pausas de 10 ms para no depender de la espera temporizada que no expiró en la MGU. Compilación final con avisos como errores y ELF verificado: x86-64, intérprete `/lib/ld-linux-x86-64.so.2`, GLIBC máximo 2.14 / GLIBCXX 3.4.22. SHA-256 del ELF ejecutado **`7723eafc06d445feddb9a50b33193c66a3c17842ad4056ba6ae0cc677236a83b`**. Pasan las 192 pruebas locales; no prueban sonido por altavoces.

Evidencias privadas: `play-audio-after-reboot.txt`, `audio-connected.txt`, `audio-path.txt`, journal y comprobación final de la sesión `MGU21-20261114-audio-mapa`. Próximo paso: observar la recepción efectiva de metadata/selección y la apertura del contenido en mediaengine, separándolas del foco. No repetir PLAY ni aumentar búferes como supuesto arreglo de este resultado.

## Preparación sin ENET: lista aceptada frente a fuente activa

Continuación del 14-11-2026, sin acceso al coche. REA no tenía proveedor disponible para analizar la función; se utilizó **Ghidra 12.1.4 local** con las copias privadas, contrastando direcciones y bytes con LLVM. La imagen PIE de mediaapp se analiza con base ELF cero; no reutilizar el primer análisis que Ghidra importó con base 0x100000.

Evidencia del mismo mediaapp cuyo hash figura arriba:

- `0xf83780` recibe la lista y la transforma mediante `0xb32560`/`0xb30f50`. La vtable de `CDeviceOAPDynamic`, `0x187c0b8`, ranura `0x5b0`, lleva a `0x8d7190`.
- `0x8d7190` verifica el token propio y responde OK **antes** de vaciar la lista anterior y construir las nuevas URI/metadatos. El vector de streams comienza en `+0x110`, termina en `+0x118` y tiene capacidad en `+0x120`, con elementos de 0x48 bytes. La lista de URI en `+0xb0` tiene contador en su cabecera `+4`; `SourceActivityOn:0x8d8a20` lo imprime junto a la posición.
- El transformador `0xb25ea0` y la tabla de `0xb1edf0` llevan FILE_NAME 16 a clave interna 0x20 de texto. `parseDataFromStream:0x8d2d50` consume esa clave. El catálogo y las implementaciones de deployment del proxy confirman longitud de arrays de cuatro bytes, struct sin prefijo y union con longitud/discriminante UInt32. **No se ha encontrado un error de tamaño ni de clave FILE_NAME en el payload actual.** Esto no demuestra que mediaengine acepte su URI.
- `setTrackAndTimeByPos:0x8cd600` puede dejar una selección pendiente según la actividad de la fuente. El objeto en `+0x18` tiene el indicador de actividad en `+0x110`; `0x8d8a20` lo pone a uno cuando llega SourceActivityOn. CONNECTED no sustituye esa comprobación.

### Herramientas preparadas

`Inspeccionar-Audio-Propio.js` es exclusivamente manual, Node 8, no se incorpora a `component.json`. Verifica SHA-256 de mediaapp, identidad del proceso y token privado de **nuestra** prueba antes de interpretar offsets. Abre `/proc/<pid>/mem` con `r`, sin ptrace, señales, pausas, inyección ni escritura. Busca como máximo 64 MiB/3 s en memoria privada de heap; no guarda un volcado. Solo devuelve contadores y flags del objeto cuyo token coincide, nunca token, direcciones, URI ni metadatos. Rechaza resultados ambiguos, parciales o cambiantes; una instantánea sigue sin ser atómica ni demostrar sonido.

La sonda nativa correlaciona también cliente y tipo de respuesta SOME/IP. Separa resultados de autoplay/lista/selección/PLAY, no continúa enviando órdenes dependientes si se rechaza una etapa y elimina la segunda pulsación PLAY. El resultado final indica `PLAYBACK_ADVANCED` y siempre `AUDIBLE_NOT_MEASURED`. Código **7**: no se observó avance; **5**: queda pendiente liberar el token propio. Código 0 no significa «sonido oído». Mantiene el vigilante de liberación y restaura autoplay.

Preparación ejecutada:

```powershell
& tools/tdt-runtime/Compilar-Sonda-Audio.ps1 -PrivateRoot 'RUTA_PRIVADA_MGU' -OutputDirectory 'dist/audio-probe-offline' -AudioFixture 'RUTA_PRIVADA_MGU/audio-probe.wav'
node --test emulator/split/audio-own-inspector.test.js
```

El directorio contiene únicamente la sonda propia, inspector, muestra suave y metadatos de compilación. La muestra original se comprobó como WAV PCM estéreo 48 kHz/16 bits, cinco segundos, pico 0,0366 FS; no se cambia el volumen del vehículo. SHA del ELF nuevo: **`986d3c1187d09ff96c9b39c4d591498af356c4478ff75e922f2176907e442988`**. Compilación C++14/Werror; ELF x86-64, intérprete `/lib/ld-linux-x86-64.so.2`, GLIBC máximo 2.14 y GLIBCXX 3.4.22. No ejecutado en Linux/MGU; sin WSL en este PC. Cinco pruebas de comportamiento del inspector y carga con Node 8.16.2 verificadas.

### Próxima comprobación, antes del mapa

Con ENET y permiso vigente, reutilizar la configuración SOME/IP privada ya contrastada. Inspeccionar primero la fuente libre. Ejecutar una sola prueba de tono (`--play`) y, mientras conserva su token, leer su estado con:

```sh
BMWLAUNCHER_AUDIO_TRIAL=1 node /tmp/bmwlauncher-audio-probe/Inspeccionar-Audio-Propio.js --inspect-own "$(pidof mediaapp)"
```

No lanzar el inspector fuera del intervalo de la sonda. Si hay más de un PID, firmware diferente, datos parciales o token ausente, la salida es inconcluyente y no se relajan sus controles. Capturar una muestra después de `PHASE playlist` y otra durante la observación, sin repetir PLAY.

| Observación | Siguiente comprobación |
| --- | --- |
| Lista interna vacía pese a OK | Conversión/recepción de metadata y finalización del callback; no culpar al altavoz. |
| Lista de una pista, selección 1, actividad falsa | Inicio de fuente/arbitraje de TempMedia. No forzar flags en memoria. |
| Lista y actividad presentes, tiempo detenido | Apertura de URI y respuesta de mediaengine. El inspector no observa por sí mismo la apertura del archivo. |
| Tiempo crece pero no se oye | Ruta multimedia/mute y salida frontal. Confirmación auditiva independiente. |

Tras el ensayo, comprobar la liberación del token y fuente, retirar solo los archivos temporales propios. La reversión no requiere instalar nada ni reiniciar. No se ha alterado FFmpeg, el vídeo validado por el usuario ni ningún canal de avisos.
