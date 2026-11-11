# Vídeo de Android Auto en MGU21

## Punto de extracción

El firmware `036_010_004` contiene el receptor `aapd` en `SWFL 000056E8`. El ejecutable usa Cinemo. En `libNmeAndroidAuto.so` de la MGU, `NmeAndroidAutoDisplay::OnVideoFrame` está en el RVA `0x960b0`. La función conserva los argumentos del fotograma y los reenvía al consumidor del objeto de pantalla. Tiene un camino de espera para el fotograma de sincronización. Es un punto para observar el vídeo de la sesión BMW antes de decodificarlo y componerlo. Para usarlo hay que identificar qué objeto corresponde a la pantalla central durante una sesión.

El receptor tiene definiciones separadas para `MAIN_DISPLAY` y `KOMBI_DISPLAY`. El binario configura un puente de proyección con una salida H.264 por AVB en `media_transport.avb_streaming.15`. Las rutas de recuperación del puente aparecen en los servicios de pantalla alternativa y cuadro interactivo. Su asociación con la pantalla central queda sin confirmar. Los servicios SOME/IP `AndroidAutoProjectedManager` y `AndroidAutoProjectedICManager` llevan estado, foco y configuración de proyección. Sus campos y métodos no incluyen el contenido de los fotogramas.

## Punto de captura tras decodificar

`Hmi8` importa la API de RAMSES para crear texturas de vídeo por ID IVI y configurar el socket del compositor embebido. Los binarios de Cinemo y la configuración de vídeo apuntan a `wayland-1`. La MGU tiene ese socket y la captura de la superficie final en Winston muestra Android Auto ya compuesto dentro de `Hmi8`. El ID 28 aparece en las opciones de vídeo del equipo y no está identificado como la superficie de Android Auto de la pantalla central. [Composición Wayland embebida en RAMSES](https://ramses-sdk.readthedocs.io/en/latest/core.html)

La próxima comprobación en la unidad es observar qué cliente y qué ID IVI entregan buffers a `wayland-1` cuando se abre y se cierra Android Auto. Si se pueden leer esos buffers sin interferir con su consumidor, adaptar una copia a I420 y usar el soporte `VIDEO` de `mgu-render`. Si esa vía queda cerrada, comprobar los fotogramas en `OnVideoFrame` y filtrar el objeto de la pantalla central antes de probar un decodificador. El toque y el mando necesitan una prueba independiente de foco y coordenadas. [Protocolo de vídeo de mgu-render](https://github.com/robertnisipeanu/mgu-store/blob/main/native/mgu-render/PROTOCOL.md#video)

## Prueba local del encuadre

Se usó la pantalla actual de BMWLauncher en el simulador y una captura del i4. La imagen de Android Auto se ajustó con su proporción original a la zona izquierda. Se comprobó por comparación de píxeles que las tarjetas y la franja de energía de la derecha son idénticas. La captura panorámica queda a 952 × 290 dentro de un panel de 952 × 508. Para aprovechar la altura hay que validar la negociación de un tamaño de proyección más estrecho. El PNG local `bmwlauncher-aa-prueba-estatica.png` muestra el encuadre. La prueba del flujo de vídeo en directo y de la entrada sigue pendiente.
