# Mando de iDrive 8 en BMWLauncher

Se analizó el ejecutable `Hmi8` copiado del i4, las bibliotecas x86-64 de la revisión `036_010_004` y el catálogo SOME/IP de la unidad. Las direcciones corresponden a esos ELF. El análisis fue estático.

## Cómo llega el mando a BMWLauncher y a iDrive

| Evento de FrontCCU, servicio `0xb508` | Contenido | Ruta en `Hmi8` |
| --- | --- | --- |
| `0x8002`, `statusRotaryEncoderState` | Secuencia, giro acumulado de 16 bits, pulsación central e inclinación. Los valores corto y largo son `1/2` arriba, `4/5` derecha, `7/8` abajo y `10/11` izquierda. | `CHmiCCSDevice::onFrontRotaryEncoderState` (`0x4e0dc20`) llama a `processRotaryAction` en `0x4e0de2b`. Este traduce la inclinación y la pulsación central a teclas de interfaz y llama a `dispatchKeyEvent` en `0x4e0cc94`. |
| `0x8001`, `statusPushButtonsState` | Estado de ocho botones físicos, con valores propios de reposo, pulsación corta y larga. | `CHmiCCSDevice::onFrontPushButtonsState` (`0x4e0fb40`) llama a `processButtonAction` en `0x4e0fd44`. Es una ruta independiente del movimiento de la rueda. |

BMWLauncher 0.2.3 observaba `0x8002` mediante el OAP cuando el renderizador carecía de captura. El OAP recibía su copia y mandaba al servicio los giros y las inclinaciones verticales. `Hmi8` recibía la suya y ejecutaba su comportamiento normal. El setter `rotaryEncoderControl` configura la aceleración y la posición central del mando. La definición del servicio carece de un método para que un OAP adquiera la entrada en exclusiva.

En `Hmi8`, `CHmiFwStateManager::performShiftLeftInternal` llama a `performBackInternal` en `0x425db77`, `0x425dda7` y `0x425e9f8`. La inclinación izquierda puede retroceder en el historial según el estado de la interfaz. BMW documenta que la inclinación hacia arriba abre el acceso rápido de iDrive 8. El binario contiene el servicio `CHmiToolbeltService` y el estado de los accesos directos. [Funcionamiento de iDrive 8 según BMW](https://www.press.bmwgroup.com/usa/article/detail/T0327734EN_US/the-all-new-bmw-idrive?showMedia=photo)

## Dónde interceptar los eventos

En `libCommonAPI-SomeIP.so.3.1.12`, `Connection::receive` llama a `Connection::handleProxyReceive` en `0x3d200` a través de la PLT (`0x321a0`). Hay una reubicación `R_X86_64_JUMP_SLOT` para ese símbolo en `0x284b18`. La firma enlaza con la interfaz `vsomeip::message` de `libvsomeip.so.2`. El filtro comunitario usa ese mismo símbolo para reenviar el evento original al renderizador y entregar a iDrive el giro congelado, la pulsación central suelta y la inclinación centrada. La llamada a través de la PLT permite esa interposición en el binario inspeccionado. [Código del filtro comunitario](https://github.com/cauliflowermossgrape/idrive7-apps/blob/main/kit/renderd/inputgate/mgu-inputgate.cpp)

El paquete comunitario declara ID7 y carga el filtro en `HmiMain3D`. La unidad inspeccionada ejecuta `/usr/bin/Hmi8`. La configuración publicada de `mgu-render` busca `HmiMain3D` por defecto para anunciar `info.controller`. BMWLauncher 0.2.4 mantiene el OAP como fuente de eventos y usa un permiso propio para su filtro ID8. [Protocolo de captura](https://github.com/robertnisipeanu/mgu-store/blob/main/native/mgu-render/PROTOCOL.md#touch-and-controller) · [Paquete comunitario](https://github.com/cauliflowermossgrape/idrive7-apps/blob/main/mgu-repo.json)

## Salida desde la casita

La auditoría del 13-11-2026 corrigió la distribución: BMWLauncher requiere ahora el filtro, que antes era solo una herramienta opcional sin dependencia desde la app. Actualizar la app anterior no demostraba que estuviera instalado. El servicio comprueba su carga de forma asíncrona y muestra «Mando · captura exclusiva» en el diagnóstico. Un temporizador de 200 ms mantiene la lease únicamente con contexto reciente (800 ms como máximo) y las demás condiciones válidas; la lease nativa sigue venciendo a 700 ms. [Medidas, correcciones y comprobaciones pendientes](AUDITORIA-RUNTIME.md)

- **Mando.** `javi-ccu-gate` congela la rueda, centra la inclinación y suelta la pulsación central en `0x8002`. En `0x8001` entrega a `Hmi8` los ocho botones frontales en reposo, incluidos Menú y Atrás. El filtro se limita a las notificaciones de la instancia 1 con las longitudes comprobadas. El permiso de `/run/javi-carlab/frontccu.lease` caduca tras 700 ms.
- **Toque.** BMWLauncher reclama toda su área de contenido porque el renderizador cierra una capa si la pulsación empieza fuera de su área reclamada. La casita responde al toque que comienza y termina dentro del botón.
- **Retorno a iDrive.** `CHmiFwStateManager::openHomeState` (`0x4258520`) lee el estado registrado en `this + 0x570` y lo pasa a `requestStateInternal` en `0x42586f5`. BMWLauncher guarda el contexto anterior que devuelve `hmictl ctx` y usa `hmictl open` para volver a ese estado y applet. El servicio espera la transición antes de ocultar la capa. Si falta un contexto válido o falla la salida, iDrive conserva el mando.

La prueba en el coche debe comprobar giro, pulsación, inclinación corta y larga en cuatro direcciones, Atrás e Inicio físicos, la casita y la recuperación del mando al perder visibilidad, al mostrarse la cámara o al detener el renderizador. MGU Store admite un filtro como herramienta `preload` con protección de arranque y retirada tras fallos repetidos. [Herramientas preload en MGU Store](https://github.com/robertnisipeanu/mgu-store/blob/main/docs/PUBLISHING.md)
