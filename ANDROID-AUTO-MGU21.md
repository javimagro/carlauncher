# Vídeo de Android Auto en MGU21

## Toque y rueda confirmados; encuadre pendiente · 15-11-2026

En otro ensayo temporal el usuario confirmó **toque, arrastre y rueda funcionando dentro del panel izquierdo**, con el cockpit igual. Después señaló que el mapa se veía pequeño y con franjas negras. Esa observación limita la validación: la entrada funciona, pero el formato panorámico original aún no se adapta al área del producto. La integración completa y su publicación siguen pendientes; no se instaló ni reinició la MGU en este ensayo.

### Entrada y contexto MAIN

- El contexto original observado es `state=1, applet=50`. Un cliente root de mgu-render puede superponer su capa mientras ese contexto permanece debajo. No se mueve la superficie de Hmi8 ni se utiliza el display IC.
- Con AA original visible, InputRelay 128 recibió 24 eventos táctiles y ocho del mando; giro horario `key=6`, antihorario `key=5`, ambos con `status=0`. El getter del relay también valía cero: no equivale a ausencia de entrada.
- El toque se entrega directamente a Hmi8 por UDP loopback 30567, PDU `0xB0048002`, 96 bytes de payload, presión 50 y tipos down/move/up 1/2/3. Referencia: [screencast de IterioDev](https://github.com/IterioDev/car-apps/blob/main/tools/iteriodev-screencast/screencast.js), blob `15fa2a5a5cc8c027f516f9740ecdf303953da635`. Una sonda del consumidor aapd confirmó down/up, no solo envío UDP.
- Geometría observada: vídeo 1920×1080; rectángulo HMI `[120,0,2880,840]`; ratio 1,4375; margen vertical total 496. Coordenadas del cuadro completo: `xHmi=120+x*1,4375`, `yHmi=(y-248)*1,4375`. Recorte visual vigente `[0,260,1920,560]`. No aplicar a otro perfil sin validarlo.
- El ensayo del panel registró 11 gestos y cerró con «Terminar prueba». La última generación entregó 557 cuadros; declaró cero pérdidas/incompletos/malformados, tamaño H.264 máximo 69.113 bytes y hueco máximo del productor 140,6 ms. Hubo una recuperación previa al superar 61.440 bytes: no se presenta toda la sesión como libre de interrupciones.
- Tras cerrar: contexto BMWLauncher restaurado, cero eventos propios y cero auxiliares de prueba. SSH permaneció abierto.

### Integración local y límites

La interfaz distingue los dos modos solicitados: AA dispone de todo el panel izquierdo, con energía debajo y sin controles BMW superpuestos; BMW conserva sus iconos, búsquedas y ETA. El selector y las acciones adicionales se abren desde la barra, en un panel temporal sobre DriveHub. Se verificaron capturas de día/noche a 1960×520 y 1960×572 y 351 pruebas locales; no sustituyen una prueba de esta integración instalada.

El anillo actual es 1536×448, frente a 960×280 del primer ensayo. En la misma muestra de 134 cuadros, tres decodificaciones MGU a 1536×448 tardaron 2,957/2,932/2,830 s, con 32,6–33,7 MiB RSS. Solo se midió decodificación; no es latencia de interacción. En una repetición posterior de 40 segundos, el usuario confirmó nitidez y ausencia de la franja original de AA por encima de la capa, con cockpit igual. Sigue viendo contenido pequeño y franjas dentro del panel: el formato panorámico está pendiente de renegociar. Ese ensayo registró 18 gestos, 750 cuadros, máximo H.264 113.222 bytes y hueco máximo 520,4 ms, sin pérdidas/incompletos/malformados. No prueba cadencia perfecta.

Una solicitud temporal `AndroidAutoProjectedManagerInst1.requestProjectedUi(MAPS=2)` terminó correctamente y cerró el proxy. Su respuesta vacía se declara `retSchema: {}`; el addon rechazó antes `Struct` con `e: []` sin enviar la orden. El firmware traduce Maps a una tecla nativa; no garantiza desactivar el escritorio dividido. Se restauró contexto BMWLauncher y se verificaron cero sondas y auxiliares propios tras el ensayo. No se instaló ni reinició nada.

Se corrigió además el timeout al arrancar el auxiliar de toque: su primer ACK tardó 840 ms en un ensayo real, superando el antiguo límite de 700 ms. Se admite hasta 2000 ms únicamente antes del primer ACK, sin entregar entrada; después se conserva la caducidad de 700 ms. El ensayo posterior con perfil alto recibió ACK a 822 ms, no registró error de entrada y entregó 745 cuadros en la generación final, sin pérdidas ni registros incompletos/malformados. La capacidad inicial H.264 pasa de 60 a 120 KiB tras observar keyframes de 72.717 bytes. No hubo recuperación de captura en ese ensayo. El hueco máximo de producción fue 235,9 ms; no se presenta como cadencia perfecta.

`aa-capture` valida firmware y captura solo MAIN, con lease y guardián. `aa-worker` contiene captura/decodificación; MGVF transporta píxeles. `aa-underlay` conserva AA debajo de la capa y retorna al contexto guardado solo mientras conserva su propiedad. Pérdida de capa o contexto externo cede a AA nativo, sin reanudar automáticamente la superposición.

`aa-input-process` aísla el emisor táctil y envía up al cancelar, caducar o desconectarse. Las pruebas de muerte del proceso en PC/Node 8 no demuestran todos los fallos conjuntos en MGU. `aa-ui` asigna el mando a AA o DriveHub; tocar la derecha lo devuelve a DriveHub. El filtro nuevo permite a Hmi8 giro/pulsación central únicamente con foco AA; mantiene neutralizadas inclinaciones y botones. Se comprueba el ELF realmente mapeado. **Falta validar físicamente ese filtro tras cargarlo.**

El OAP observa una lease root de 700 ms para conservar lecturas/audio bajo la superposición; mantiene separado el registro de visibilidad HMI real.

Al recibir hide se retira el registro HMI inmediatamente y, si aún no se había observado la lease, se realiza una comprobación asíncrona nueva de hasta 50 ms. Así se evita apagar y reabrir audio/datos/mando entre la creación del archivo y el sondeo periódico. La lectura no renueva la lease, no admite respuestas previas al hide ni posteriores al plazo y falla cerrada. Después de esta corrección, 358/358 pruebas locales y Node 8.16.2 aprobados.

El teléfono produce el formato de la pantalla central completa. El primer ensayo lo reducía a 960×280 y lo encajaba conservando proporción. Aumentar el anillo conserva más píxeles, pero no adapta la composición del teléfono. Google documenta márgenes/DPI para otros formatos en [DHU](https://developer.android.com/training/cars/testing/dhu#video-configuration); eso no demuestra renegociación en vivo en MGU21. El catálogo MAIN no publica setter de geometría; `streamConfig` pertenece a IC y no se utiliza. Se ha localizado `SetMargins` en la interfaz local de Cinemo: requiere ejecutar sobre la instancia viva de aapd, observar la respuesta y restaurar la configuración original dentro de la misma sesión. No se ha ejecutado ni instalado ese puente. Sigue la investigación exclusiva de MAIN.

Una observación escalar de `sourceVideoConfigCallback` en `libNmeAndroidAuto.so+0x82d30` registró MAIN (`display=0`, `cfg=0`) con caché de VideoInterface vacía (`ui=0`, `mask=0`). No era la configuración seleccionada: el adaptador de VideoEndpoint conserva una copia distinta. Por tanto, `GetMargins` de VideoInterface no sirve como baseline inicial. Una segunda sonda en `0x132f48`, sobre el registro seleccionado, obtuvo **resolution=3 (1920×1080), marginW=0, marginH=496, UiConfig flags=0x9, insets mask=0xf y T/B=248, L/R=0**. Ambas observaciones tuvieron un evento y cero pérdidas/overrun. El baseline debe tomarse de ese registro y conservar los demás campos de UiConfig; no deducirlo del recorte visual de 260/560 ni del archivo de configuración. Todavía no se aplicó SetMargins. Se retiraron las instancias y sondas propias, sin cambiar trazado global ni IC.

FFmpeg final `5e2789d8377dbe5b9513715118b8a9d1e4be708f31771ad94b7d87678ecebf46`, Actions 43712405844: decodificó en MGU 134 cuadros de 960×280, salida 0, sin errores. Capturador final `b5a6a197ec1c6685580e39101bce155ee0b0b68ccb202f6d9a43ea7e115c55ad`: EOF, caducidad y SIGKILL terminaron con cero probes propias. [Medidas](tools/aa-runtime/VALIDATION.md).

Evidencia privada fuera de Git: `D:/Usuarios/javie/BMW/MGU21-20261115-aa`, archivos `observe-physical-input.txt`, `test-touch-geometry.txt`, `input-trial-1.txt` y `check-trial-cleanup.txt`. No publicar capturas, firmware ni registros privados.

## Vista izquierda confirmada · 15-11-2026

**Resultado físico:** con BMWLauncher abierto y el teléfono conectado, se recibió el vídeo MAIN, se decodificó **en la MGU** y se dibujó la región de Google Maps en una capa propia dentro del panel izquierdo. El usuario confirmó «Sí, aparece el mapa y el resto sigue igual», incluyendo DriveHub y cockpit. Es un **ensayo temporal**, todavía sin integrar en la app instalada. No se reinstaló, reinició ni sustituyó ningún componente. SSH permanece abierto por indicación del usuario.

### Transporte comprobado

- `BPF_MAP_CREATE` devuelve `ENOSYS (38)`: no se puede asumir eBPF disponible. El fallback con lectura diferida de `/proc/PID/mem` copió 111 unidades y rechazó 318 porque el búfer había cambiado. Faltaban SPS/PPS/IDR; esa muestra no se podía decodificar.
- Una sonda de metadatos encontró la primera unidad de 9.082 bytes con flags `0x31` y NAL SPS (`0x67`). La configuración sí pasa por `OnVideoFrame`. No hay que activar un dump global ni tocar el segundo display.
- El receptor final registra 64 eventos propios en `0x960b0`, con 120 palabras de 64 bits copiadas por evento. Filtra TGID y display cero; recompone por hilo/búfer/marca/banderas/tamaño y entrega solo unidades completas. Límites: diez segundos, 16 MiB de salida, 61.440 bytes por unidad, 16 ensamblajes y 512 KiB de anillo perf por CPU. No utiliza ptrace ni lectura diferida del búfer. La copia ocurre en los handlers antes de que continúe el hilo; no garantiza atomicidad frente a otros hilos.
- Primera muestra válida: **342 unidades**, 1.648.364 bytes H.264, SPS/PPS/IDR presentes, sin pérdidas ni incompletos registrados. Decodificación local completa sin errores: H.264 Baseline, YUV420P, **1920×1080**, con márgenes negros y el contenido ancho de AA dentro del cuadro. La imagen incluye mapa, columna AA y Spotify; el ensayo recorta la región del mapa, sin cambiar la resolución negociada con el teléfono.
- Ensayo visible: **421 unidades y 174 cuadros entregados al anillo**, cero pérdidas perf/incompletos/malformados y **una unidad descartada por exceder el límite** (61.665 bytes). Hubo una inversión de DTS al drenar anillos de CPU distintas. No confundir ausencia de pérdidas perf con vídeo completo o cadencia estable. El intervalo máximo entre ventanas fue 1,75 ms; no mide el coste total de todas las sondas.

### Decodificación y presentación

- El FFmpeg mínimo instalado no admite entrada `h264` ni filtro `crop`. La sonda encapsula unidades en MPEG-TS con PAT/PMT/PES, PTS/PCR monotónicos y continuidad; la muestra encapsulada decodificó sus 342 cuadros en PC. Un auxiliar recorta la región YUV y escribe un anillo MGVF propio: píxeles → ranura → secuencia. No transporta imágenes por JSON/base64 ni trabaja en el hilo de interfaz.
- Se reprodujo **SIGSEGV/139** del FFmpeg estático al iniciar hilos con esa muestra. Cambiar únicamente `PT_GNU_STACK.p_memsz` de cero a **8 MiB**, en una copia temporal, permitió decodificar en MGU. La fuente musl 1.2.5 confirma el default de 128 KiB y su ampliación mediante esa cabecera; FFmpeg crea esos hilos con atributos predeterminados. No se obtuvo backtrace ni se midió el mínimo suficiente. [Pila de hilos en musl](https://wiki.musl-libc.org/functional-differences-from-glibc.html#thread-stack-size).
- `tools/tdt-runtime/build-ffmpeg.sh` deja el ajuste reproducible `-Wl,-z,stack-size=8388608`. **El binario empaquetado y el instalado siguen sin sustituir**: falta reconstrucción y regresión TDT antes de publicar. SHA original `e3e865cc24dee43170917c63eee6a869850ddf888c76b00f876b4dabe6e370bc`; copia de ensayo `ecb3dcb1d75f0a6572f2c5950a8af8de3d0c21fda67d1ceba2e6f4dd185e2433`. Ocho MiB es capacidad por pila, no una medición de RSS ni una mejora de velocidad.
- La capa usa el cliente mgu-render existente, no reclama toque/mando y deja libres controles y barra de energía. MAIN se solicita de forma acotada y se devuelve a NATIVE con vigilancia independiente. El ACK de restauración no prueba cambio inmediato del getter: seguía verdadero a los 500 ms y estaba falso al iniciar el siguiente ensayo. Cada ensayo retiró su grupo/eventos, FIFO, anillo y auxiliares; aapd mantuvo su PID.

### Límites para integrar

No conectar aún esta instrumentación de diagnóstico al arranque normal. Faltan coste completo, unidades mayores, orden entre CPU, pérdida de teléfono/foco y recuperación de keyframes. El recorte depende de la composición observada; no es negociación adaptable del área AA. **Toque, rueda, botones, rutas y menús de AA no están conectados a esta imagen.** Captura, control interactivo y versión instalable son verificaciones separadas. No se usa el display IC para resolverlas.

Fuentes propias, scripts y muestras privadas: `D:/Usuarios/javie/BMW/MGU21-20261115-aa`, fuera del árbol publicable. Evidencias: `capture-copy.txt`, `view-live3.txt`, `test-native-stack.txt` y `offline/FFMPEG-STACK.md`. `aa-perf-copy` compiló con `-Wall -Wextra -Werror`, ELF x86-64 y glibc ≤2.17; pasaron las pruebas de ensamblaje y cinco del parser. Las capturas y el firmware no se redistribuyen.

**Cierre:** después del ensayo el usuario reinició iDrive. Recuperado SSH, se comprobó uptime de 98,87 s, nuevo PID de aapd, cero procesos de prueba y ausencia del directorio temporal, anillo MGVF, grupos de eventos e instancia privada. SSH responde y no se ha cerrado. Pasaron las **272 pruebas generales** del repositorio, `bash -n` del build y `git diff --check`; no sustituyen la validación de una integración AA, que aún no existe. El ELF de prueba conserva GNU_STACK RW con tamaño `0x800000`.

## Identificación del flujo central · 15-11-2026

ENET/SSH y pruebas temporales autorizados, coche parado. El usuario dejó AA visible y después abrió BMWLauncher conservando la conexión al teléfono. No se instala, reinicia, codifica ni modifica ningún componente BMW. Las extracciones y las muestras permanecen fuera del repositorio.

- **La salida AVB `.15` es del segundo display.** El análisis de aapd en `0x3195d0` muestra `configureProjectionBridge` obteniendo `GetDisplay(1)`, que entrega al puente. El tipo 9 del puente selecciona `NmeMuxAVC_RTP` en `libNmeSDK.so`, `0x133bf3`. El display central se obtiene aparte con `GetDisplay(0)` en `0xe8e65–0xe8e71`, identificado por el literal `CINEMO_ANDROIDAUTO_DISPLAY_MAIN` y añadido a la playlist. Esto cierra la distinción que quedaba pendiente en el estudio comunitario.
- **Contraste de AVB en vivo:** un receptor adicional con nombre propio se registró correctamente en `.15`; no recibió paquetes durante 15 segundos con AA visible. Cerró limpiamente. No se solicitó el display IC ni se reconfiguró el productor. El PID de aapd se mantuvo. El resultado no demuestra ausencia de vídeo en la pantalla central: pertenece a otra ruta.
- **Compositor interno:** la consulta del registro Wayland anuncia `xs_capture` en `wayland-0`, pero no en `wayland-1`. Este último ofrece composición, `ivi_application` y dma-buf, sin `ivi_controller` ni interfaz de captura anunciada. No se puede trasladar la captura de Winston al compositor interno suponiendo los mismos protocolos.
- **Primer dato de vídeo central observado:** una traza temporal de `NmeAndroidAutoDisplay::OnVideoFrame`, desplazamiento de archivo `0x960b0`, registró 99 llamadas en dos segundos, todas de una instancia con tipo interno, metadato de display y subtipo iguales a cero. RSI apunta al búfer; RDX lleva tamaños de 2030 a 2753 bytes; los cuatro primeros bytes son `00 00 00 01`. Es compatible con Annex B, pendiente de validar el códec mediante decodificación de una muestra completa. RCX conserva una marca temporal de 64 bits; su unidad no está validada. R8D contiene las banderas, `0x20` en esta muestra.
- **Aislamiento del ensayo:** traza en una instancia privada de tracefs, búfer de 128 KiB por CPU y selección de hilos de aapd. Se verificó el hash del ELF antes de registrar el punto, se retiraron el evento y la instancia al terminar y aapd conservó su PID. No se usa ptrace ni se detienen procesos para inspeccionarlos. La captura de píxeles y la vista izquierda aún no quedan acreditadas por estas llamadas.
- **No activar el dump global:** `NmeProjectionDump` también escribe audio y su `WriteVideo` no lleva identificador de pantalla. No es una captura central filtrada por el mero hecho de existir.

Artefactos nuevos, obtenidos de esta unidad: `libias-media_transport-avb_ufipc_bridge.so.1.3.11`, SHA-256 `551dbee684fbf4c9e4aae31fcce66038a9a9f4ece897778ca3aec26d33c42eba`; `libNmeSDK.so`, `0fa7e320d7bf223a3a8c9680c4a7c15a3a462e565f3774fee6c94a07b03bd4aa`; `libNmeBaseClasses.so`, `b4fd26751d34e5eff5d14f773bbcb4535b849dba88d549f54c889d96961c7e60`. REA verificó los exports del puente; la cadena de llamadas usa Ghidra/LLVM local y las llamadas reales se observaron mediante uprobes de la MGU. Son evidencias diferentes. [Contrato del trazador de Linux](https://www.kernel.org/doc/html/v4.19/trace/uprobetracer.html).

Siguiente comprobación: copiar una muestra acotada de MAIN, comprobar SPS/PPS/IDR y decodificación y, únicamente después, alimentarla al anillo MGVF dentro del panel izquierdo. La captura de muestra, el vídeo en directo, la cadencia y el toque/mando son verificaciones separadas.

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
