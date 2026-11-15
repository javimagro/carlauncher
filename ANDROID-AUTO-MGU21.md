# Vídeo de Android Auto en MGU21

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
