# Audio nativo de TDT · MGU21

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
