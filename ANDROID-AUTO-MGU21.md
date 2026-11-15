# Vídeo de Android Auto en MGU21

## Referencia comunitaria contrastada · 15-11-2026

Petición del usuario: estudiar los mapas de Waze en el cockpit de otros proyectos para aprovechar su vídeo en el panel izquierdo. Consulta pública de `robertnisipeanu/idrive-apps`, revisión **1fc3812993847096311e629fe4cb2a73439c241e**, posterior a la entrega 0.2.15. No se ha conectado ni modificado la MGU.

### Qué hace realmente Waze on cluster

- [README del receptor](https://github.com/robertnisipeanu/idrive-apps/blob/1fc3812993847096311e629fe4cb2a73439c241e/native/waze-on-cluster/README.md): recibe un **segundo flujo de proyección** que el teléfono genera para el cuadro. Documenta Waze/Apple Maps/Google Maps por **CarPlay** y Google Maps por **Android Auto**. Esto no establece qué mapas alternativos admite hoy cada versión de Waze para Android.
- El flujo es H.264 en RTP en `media_transport.avb_streaming.15`. [avb_source.cpp](https://github.com/robertnisipeanu/idrive-apps/blob/1fc3812993847096311e629fe4cb2a73439c241e/native/waze-on-cluster/src/avb_source.cpp) usa un receptor adicional con `ias_avbbridge_create_receiver`, `ias_avbbridge_register_H264_cb` y `ias_avbbridge_destroy_receiver`. No captura la pantalla completa de Hmi8. La cola acotada separa recepción, decodificación Media SDK y presentación en cluster-render.
- El [parche de AA](https://github.com/robertnisipeanu/idrive-apps/blob/1fc3812993847096311e629fe4cb2a73439c241e/native/waze-on-cluster/patch/PATCH.md#android-auto) habilita el segundo display, su arranque y geometría en aapd/aapd.conf. **El propio proyecto rechaza aapd 23.16.5 de ID8**, build-id `ef291b7185f210a24d8e68855d94d44e9f32cb62`: cambia la condición SECOND_VIDEO_SCREEN_MODE y falta onNewNavigationStatus. No es evidencia de compatibilidad del parche con nuestro i4 ni una identificación del build-id de nuestro ELF.
- Esta ruta contiene el mapa secundario: no implica disponer de los menús o del vídeo central completo, ni admite asumir entrada táctil/rueda sobre esa imagen. La activación y el dibujo en el cuadro del proyecto son ajenos a nuestro objetivo de preservar el cockpit.

### Aplicación a BMWLauncher

La referencia refuerza la viabilidad de recibir vídeo **antes de la composición**, pero no resuelve qué flujo central publica nuestra MGU. El análisis local anterior ya encontró la URI AVB .15; todavía no se ha probado su asociación con MAIN_DISPLAY. El ensayo físico del 14-11 únicamente confirmó el estado de streaming central con BMWLauncher abierto.

La próxima comprobación útil es inventariar de forma pasiva la configuración AVB y el puente de esta unidad, identificar el flujo MAIN y comprobar si admite un receptor adicional sin cambiar productor ni destinatario. Faltan en las extracciones revisadas aapd.conf y la implementación del puente `libias-media_transport-avb_ufipc_bridge`. Un segundo flujo ya activo podría ser otra fuente de imagen, pero no se solicitará ni reconfigurará el display IC para hacerlo aparecer. No se instala el parche de Waze on cluster ni se toca coding, RAMSES, DCSM o la geometría de Hmi8.

Si se valida una fuente independiente: recibir RTP/H.264 con cola acotada, esperar SPS/PPS/keyframe, decodificar y escribir nuestro anillo MGVF para dibujarlo solo en el panel izquierdo. Si el central sigue siendo interno de Cinemo, continuar con el consumidor OnVideoFrame documentado abajo. La imagen real y el control interactivo son verificaciones separadas. Esta investigación **no añade una captura operativa a 0.2.15**.

## Continuación sin ENET · 14-11-2026

Análisis de los mismos ELF descargados, sin conexión a la MGU. El proveedor ELF de REA sigue sin estar disponible en Windows; se usó el **Ghidra 12.1.4 local**, con base de imagen cero, decompilación centrada en funciones y contraste de límites con `.eh_frame`/LLVM. Pseudocódigo y binarios se conservan fuera del repositorio. Los tipos inferidos no son una cabecera ABI validada.

- `libNmeAndroidAuto.so`, `OnVideoFrame` **0x960b0–0x9617e**: bloquea el mutex `this+0x28`, lee el consumidor en `this+8` y reenvía cuatro argumentos por su tabla virtual, desplazamiento `0x48`. Si `this+0x26` indica espera, descarta hasta que las banderas contienen `0x10`. Es un punto de entrada útil; no prueba que los argumentos sean ya píxeles ni identifica una instancia viva.
- La creación de pantallas **0x8ea90** consulta `NMEMETANAME_ANDROIDAUTO_VIDEO_DISPLAY_TYPE`. El objeto guarda tipo interno en `+0x18`, tipo recibido en `+0x1c` y subtipo auxiliar en `+0x20`. `0x96e50` actualiza esos campos y `0x96260` registra el consumidor en `+8`. Hay datos para filtrar la pantalla: no basta interceptar todas las llamadas y tomar la primera.
- En **aapd**, `0x155ba0` distingue su enum `0=MAIN_DISPLAY`, `1=KOMBI_DISPLAY`. **No se asume que ese enum sea idéntico al metadato interno Cinemo**: falta seguir la configuración que conecta ambos. El filtro central debe quedar comprobado antes de copiar un flujo.
- Otra ruta, `WriteVideoFrame` **0x50500**, copia un búfer y longitud, conserva una marca temporal y banderas y lo encola. Es evidencia de una ruta anterior a la presentación, no prueba de que sea el consumidor concreto del objeto observado.
- Hay una función **CreateDumpFile, 0x891c0**, que llama al `NmeProjectionDump::Create` importado y forma un nombre terminado en `_AndroidAuto.dump` si existe directorio configurado. Su formato, activación y selección de pantalla no están resueltos. No activarla a ciegas: podría abarcar más que la pantalla central. Para seguir esa vía faltan las implementaciones de `libNme`/`libNmeBaseClasses` que no están en esta extracción.

El adaptador antiguo `aa.js` queda protegido contra el movimiento de Hmi8/100, procesos HMI/cockpit, superficies compartidas y capas fuera de screen 4. Lee también el formato real de encabezados IVI sin dos puntos y rechaza capturas concatenadas. Se aplican las comprobaciones al colocar y al restaurar. **Ese adaptador no es la nueva captura de AA y no está conectado a la interfaz actual.** Sus regresiones solo prueban el aislamiento.

Para el siguiente ensayo: observar primero el objeto central y su consumidor, confirmar formato/tiempos/keyframe y transporte de copia acotado, y solo entonces alimentar MGVF. No mover Hmi8, no invocar el gestor IC y no anunciar disponibilidad a partir de `isVideoStreaming`.

## Ensayo físico del 14-11-2026: vídeo con BMWLauncher abierto

Con la 0.2.14 instalada, el coche parado y ENET/SSH autorizados:

- Con Android Auto visible, `isVideoStreaming` devuelve `true`. Al abrir BMWLauncher devuelve `false` de forma sostenida. El teléfono permanece conectado.
- Winston (`wayland-0`) sigue mostrando la superficie **100 de Hmi8**, 2880 × 960; no anuncia una superficie independiente de AA. `ivi-control scene` en `wayland-1` devuelve **«no ivi_controller interface found»**. No se ha cambiado la geometría de Hmi8 ni sus barras.
- Se probó exclusivamente `AndroidAutoProjectedManager`, servicio **0xfb73**, instancia **128**, versión 1.0. `videoFocusNotification`, método **10**, acepta `PROJECTED=0` con `unsoliticed=true`. El enum se serializa como **UInt32 big endian**, seguido del booleano de un byte. La primera sonda, que trataba el enum como un byte, recibió `E_MALFORMED_MESSAGE` (9); no es una denegación funcional de BMW.
- Con el contrato corregido, devuelve `NO_ERROR` como UInt32. Durante **12 segundos**, seis consultas del getter **1** devolvieron `true` con BMWLauncher abierto. El usuario confirmó que la pantalla central y el mapa del cockpit seguían igual. **Es confirmación del estado anunciado del flujo, no una captura de sus fotogramas.**
- La restauración a `NATIVE=1`, también no solicitada por el teléfono, fue aceptada. El getter aún daba `true` a los 500 ms; una observación posterior de seis segundos confirmó `false` sostenido. No considerar el ACK de restauración equivalente a restauración ya observada.
- La sonda tenía vigilante independiente y límite temporal. No se llamó a `AndroidAutoProjectedICManager`, no se reiniciaron procesos BMW ni se instalaron cambios. Se retiraron las sondas y sus archivos; no quedaron tokens ni marcadores propios. SSH se dejó abierto por instrucción del usuario.

`aapd` tiene cargados `libNmeAndroidAuto`, `libNmeVideoMSDK`, `libNmeVideoDevice` y Media SDK 1.24, y mantiene cuatro descriptores `anon_inode:dmabuf`. **No se ha identificado qué descriptor corresponde al vídeo central ni su contenido.** Abrirlos por `/proc/<pid>/fd` devolvió `ENXIO` en el kernel 4.14.300-apl; no se pueden tratar como archivos de imagen. No se inyectó código ni se pausó Hmi8/aapd para obtenerlos.

Se conservaron fuera del repositorio los componentes de esta unidad y los registros del ensayo. SHA-256: `aapd` `a7971d64fc0feb4e48942441dc76a67d6df282b56cb5d64e92248ff83f18d62e`; `libNmeAndroidAuto.so` `10446b6de0d99272cc28d0e51e9afa0e2bbcbb40eef6c7ad688f1544857ef1ac`; `libNmeVideoDevice.so` `26cd4fabed14aa59d9332faf8e5f9b3f4a786e6c356cb8436d4db67fcfd9f2a5`.

### Qué falta para mostrar AA a la izquierda

El foco central es viable en el ensayo. **La imagen todavía no se ha mostrado dentro de BMWLauncher.** Falta identificar/copiar el flujo central antes de Hmi8, transportar los fotogramas al renderer y validar cadencia, proporción, sincronización y entrada. El estado `isVideoStreaming` no habilita por sí solo la capacidad de dibujo. No mover la superficie 100 como sustituto: contiene todo Hmi8.

La decisión del usuario es conservar **BMW local y Android Auto como dos opciones**. BMW mantiene sus consultas, rutas y guiado nativos. AA usa la proyección y la navegación del teléfono; no se envían órdenes de ruta BMW como si controlasen AA. La selección visual y su activación estable quedan condicionadas a tener una fuente de imagen real para cada opción. El cockpit permanece fuera de ambos adaptadores del panel central.

## Punto de extracción

El firmware `036_010_004` contiene el receptor `aapd` en `SWFL 000056E8`. El ejecutable usa Cinemo. En `libNmeAndroidAuto.so` de la MGU, `NmeAndroidAutoDisplay::OnVideoFrame` está en el RVA `0x960b0`. La función conserva los argumentos del fotograma y los reenvía al consumidor del objeto de pantalla. Tiene un camino de espera para el fotograma de sincronización. Es un punto para observar el vídeo de la sesión BMW antes de decodificarlo y componerlo. Para usarlo hay que identificar qué objeto corresponde a la pantalla central durante una sesión.

El receptor tiene definiciones separadas para `MAIN_DISPLAY` y `KOMBI_DISPLAY`. El binario configura un puente de proyección con una salida H.264 por AVB en `media_transport.avb_streaming.15`. Las rutas de recuperación del puente aparecen en los servicios de pantalla alternativa y cuadro interactivo. Su asociación con la pantalla central queda sin confirmar. Los servicios SOME/IP `AndroidAutoProjectedManager` y `AndroidAutoProjectedICManager` llevan estado, foco y configuración de proyección. Sus campos y métodos no incluyen el contenido de los fotogramas.

## Punto de captura tras decodificar

`Hmi8` importa la API de RAMSES para crear texturas de vídeo por ID IVI y configurar el socket del compositor embebido. Los binarios de Cinemo y la configuración de vídeo apuntan a `wayland-1`. La MGU tiene ese socket y la captura de la superficie final en Winston muestra Android Auto ya compuesto dentro de `Hmi8`. El ID 28 aparece en las opciones de vídeo del equipo y no está identificado como la superficie de Android Auto de la pantalla central. [Composición Wayland embebida en RAMSES](https://ramses-sdk.readthedocs.io/en/latest/core.html)

La próxima comprobación en la unidad es observar qué cliente y qué ID IVI entregan buffers a `wayland-1` cuando se abre y se cierra Android Auto. Si se pueden leer esos buffers sin interferir con su consumidor, adaptar una copia a I420 y usar el soporte `VIDEO` de `mgu-render`. Si esa vía queda cerrada, comprobar los fotogramas en `OnVideoFrame` y filtrar el objeto de la pantalla central antes de probar un decodificador. El toque y el mando necesitan una prueba independiente de foco y coordenadas. [Protocolo de vídeo de mgu-render](https://github.com/robertnisipeanu/mgu-store/blob/main/native/mgu-render/PROTOCOL.md#video)

## Prueba local del encuadre

Se usó la pantalla actual de BMWLauncher en el simulador y una captura del i4. La imagen de Android Auto se ajustó con su proporción original a la zona izquierda. Se comprobó por comparación de píxeles que las tarjetas y la franja de energía de la derecha son idénticas. La captura panorámica queda a 952 × 290 dentro de un panel de 952 × 508. Para aprovechar la altura hay que validar la negociación de un tamaño de proyección más estrecho. El PNG local `bmwlauncher-aa-prueba-estatica.png` muestra el encuadre. La prueba del flujo de vídeo en directo y de la entrada sigue pendiente.

La distribución posterior reserva 1038 × 468 píxeles lógicos para la proyección y coloca la franja de energía debajo, en el mismo lado. Esta es el área que debe usar la próxima prueba de vídeo.
