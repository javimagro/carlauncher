# Audio nativo de TDT · MGU21

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

Se ha encontrado y corregido **un fallo en la sonda de reproducción nativa**, no se ha demostrado todavía audio por los altavoces: seleccionaba la posición **0**, que este consumidor usa como «ninguna pista seleccionada». La primera pista es **1**. La lista y el foco se aceptaban, pero eso no acreditaba que hubiera comenzado la reproducción.

El camino de producción, FFmpeg → PCM → SmartX, sigue sin validación audible. Abrir el PCM frontal dejó ALSA en RUNNING y terminó con EAGAIN/salida bloqueada; adquirir foco con DynamicTempMedia no hizo avanzar por sí solo ese PCM. La sonda corregida permitirá probar el reproductor original completo antes de decidir un cambio de transporte. No se han apropiado fuentes de llamadas, avisos o seguridad.

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
