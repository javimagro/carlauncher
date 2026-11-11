# Bitácora técnica de BMWLauncher

Registra aquí los cambios relevantes, las incidencias y las pruebas que ayuden a reproducirlas. La [arquitectura](ARQUITECTURA.md) describe las decisiones vigentes. Lee las entradas relacionadas antes de cambiar el mismo componente. Añade las entradas más recientes arriba y actualiza una incidencia abierta cuando se confirme su causa o se cierre.

## Formato de una entrada

- **Fecha, versión y área.** Añade el commit o la etiqueta cuando esté disponible.
- **Qué se hizo y por qué.** Describe el cambio y dónde se aplica.
- **Síntoma, reproducción y causa.** Para fallos, registra los pasos, lo que se observó y si la causa está confirmada.
- **Corrección y verificación.** Anota el cambio, el comando o prueba, el entorno y el resultado.
- **Pendiente.** Indica la comprobación que falta y enlaza evidencia sin datos privados.

## 2026-11-11 · 0.2.2 · Prueba de telemetría desde MGU Store

- **Pantalla de prueba.** El panel izquierdo muestra lecturas brutas de batería, autonomía, Trayecto, temperaturas, altura y estado de vídeo de Android Auto. Distingue espera, falta de muestra y error. La tarjeta Trayecto indica el estado de precalentamiento cuando llega una lectura válida. La franja de energía conserva los números de demostración para la comparación.
- **Integración.** El OAP usa permisos por campo de solo lectura y suscripción. Envía muestras a un socket Unix del renderizador restringido al UID de BMWLauncher. Al salir se desconecta y libera las suscripciones. Se conserva el ID de app y el acceso de iDrive.
- **Verificación.** Pasaron 17 pruebas locales, se revisó la pantalla con datos simulados en Chrome y se validaron los campos contra el catálogo del i4. Se empaquetaron las fuentes y el motor gráfico, se enlazó el OAP con donante sintético y se comprobó la compatibilidad con Node.js 8.16.2.
- **Prueba en la unidad.** Se distribuye con la etiqueta `v0.2.2` del canal **Tags**. La foto de **Lecturas del coche** y los valores del cuadro permiten comprobar las escalas sin ENET. El estado de vídeo indica qué comunica iDrive. La captura del flujo de Android Auto queda pendiente. [Actualizar y probar](README.md#actualizar-desde-mgu-store)
- **Reversión.** Si hace falta restaurar el comportamiento de 0.2.1 desde el canal Tags, empaquetar ese código con un número de versión superior en ambos componentes para que la Store lo ofrezca como actualización.

## 2026-11-11 · Android Auto y precalentamiento HV · Análisis local

- **Android Auto.** Se localizó `NmeAndroidAutoDisplay::OnVideoFrame` antes de componer el HMI. El firmware también documenta una ruta de vídeo Cinemo hacia `wayland-1` y un puente H.264 asociado a pantallas alternativas. Queda por identificar el objeto y la superficie que usan la proyección central en directo. [Evidencia y siguiente comprobación](ANDROID-AUTO-MGU21.md)
- **Encuadre.** La prueba en el simulador colocó una captura de Android Auto solo a la izquierda. La comparación de píxeles confirmó que las tarjetas y la franja de energía eran idénticas. La vista local deja espacio arriba y abajo al mantener el aspecto panorámico de la captura.
- **Precalentamiento.** La MGU aceptó activar la depuración, pero SSH cortó antes de autenticar. Se cerró la depuración y se comprobó el cierre del puerto. El usuario inició el precalentamiento desde el menú original de BMW y confirmó que apareció una batería pequeña en el cuadro. Queda pendiente correlacionar ese cambio con `statusVWM` en directo.

## 2026-11-11 · Telemetría y Android Auto · Capturas del i4

- **Sesión.** Se habilitó SSH temporalmente con autorización. El catálogo leído en la unidad coincide por SHA-256 con el extraído del SWFL. Al terminar, la MGU confirmó el cierre, el indicador de depuración quedó inactivo y el puerto dejó de responder.
- **Trayecto.** `BcPersonal.driveSegment` respondió con una estructura de 107 bytes y valores en los campos de distancia, duración, consumo, velocidad media y carga al inicio y al final. Se vieron ofertas de `KombiIF`, `LSCDataSink` y `PredictiveThermalManagement`. Los getters UDP directos recibieron `EPERM`. Queda pendiente comprobar sus valores a través de un OAP autorizado y validar las escalas de Trayecto.
- **Precalentamiento.** El binario original `Hmi8` usa el bit 0 de `statusVWM` para el icono de actividad y trata 61–63 como valores sin indicador válido. La sonda añade lectura y suscripción de estado térmico. La orden de control `operationMode` queda fuera de la sonda. [Detalle de telemetría](TELEMETRIA-MGU21.md#precalentamiento-hv)
- **Android Auto.** Con el applet `0x32` en primer plano se capturaron la pantalla central y la superficie `100` de `Hmi8`, ambas a 2880 × 960. Android Auto y las barras de iDrive ya están dibujados en la superficie de `Hmi8`. Winston no mostró una superficie de proyección separada en esta escena. Se borró el archivo temporal de captura de la MGU. El vídeo de proyección y el envío de entrada siguen siendo puntos de integración pendientes.
- **Copia local.** Se verificaron dos archivos tar con 149 componentes en total y dos PNG en la carpeta privada `MGU21-036.010.004-analisis`, fuera del repositorio. Incluyen el HMI, Winston, el catálogo, las bibliotecas de vehículo y los componentes de vídeo de proyección.

## 2026-11-11 · Telemetría · Primera comprobación ENET en el i4

- **Comprobación.** Con el coche parado, el gateway y la MGU respondieron a consultas de identificación de solo lectura por ENET. La unidad lleva `SWFL 000056EE 036_010_004`, la misma revisión del catálogo analizado en local.
- **Acceso.** El puerto SSH no respondió en los intentos dirigidos a la dirección que devolvió la MGU. El DTC de depuración activa `B7F8E5` estaba ausente. La sesión se realizó después de recibir autorización para habilitar el acceso temporal.

## 2026-11-11 · Telemetría · Inspección local MGU21

- **Hallazgo.** El catálogo del SWFL `000056EE 036_010_004` expone dos candidatos de carga HV visible, autonomía eléctrica con unidad y validez, consumos medios, un segmento de viaje, altura GNSS y temperaturas. Las bibliotecas proxy ELF del SWFL `000056E7` son x86-64. La disponibilidad real y varias escalas siguen pendientes. Se conservan las referencias y el procedimiento en [Telemetría del i4](TELEMETRIA-MGU21.md).
- **Diferencia con eDrive.** IterioDev eDrive 1.1.0 usa `DDBC` y una estimación de autonomía. El perfil Gen5/i4 del BMWLauncher Android usa `E5CE` para carga del pack. Esta diferencia da una hipótesis para el dato ausente. La respuesta del i4 se verificará con ENET.
- **Preparación y pruebas.** La sonda OAP se prepara en una carpeta temporal a partir del SWFL o del catálogo extraído. Pasaron trece pruebas locales, con casos de cierre de suscripciones y exclusión de coordenadas. Se enlazó la variante con un donante sintético y se ejecutó el módulo de captura con Node.js 8.16.2. La captura en la MGU y la conexión a las tarjetas quedan pendientes.

## 2026-11-11 · 0.2.1 · Mando, red y nombre de la herramienta

- **Mando.** En el i4, desplazar el mando a la izquierda salía de la app y girarlo no recorría las tarjetas. La 0.2.0 solo recibía muestras cuando el renderizador anunciaba captura. El componente comunitario `mgu-inputgate` publicado declara ID7. Se añadió la lectura OAP de FrontCCU para la rotación cuando el renderizador no captura y se desactivó la inclinación lateral en BMWLauncher. Las pruebas locales cubren ambas entradas. Queda por confirmar la recepción en el i4 y cómo mantener la página si el HMI procesa la inclinación por su cuenta.
- **Red.** Tiempo y Noticias fallaban mientras la Store indicaba conexión. Revisando el instalador se reprodujo el caso de una app cuyo permiso de red se declara en una actualización aplicada al reinicio. La sincronización del permiso puede ocurrir antes de que se aplique la cola ID8. El servicio comprueba el paquete instalado, repone su entrada individual de `mgu-uplink` y espera a que la app reciba su conexión. Tiempo y Noticias muestran el motivo si la descarga falla. Se verificó en una instalación simulada. Falta confirmar la causa concreta y la descarga en la unidad.
- **Iconos.** El usuario recordó dos nombres distintos. El paquete conserva un solo acceso OAP, **BMWLauncher**. La herramienta figuraba como **BMWLauncher · interfaz iDrive** y ahora se llama **Motor gráfico de BMWLauncher**. Si ambos accesos aparecen en el menú nativo de iDrive, queda pendiente identificar el segundo en el registro instalado.
- **Verificación de 0.2.1.** Pasaron once pruebas locales. Node.js 8.16.2 cargó los módulos y consultó Open-Meteo y los RSS. El OAP se enlazó con donante sintético y se generó el artefacto de la herramienta. Se comprobó que el paquete mantiene un único acceso y el permiso de internet.
- **Distribución.** La etiqueta `v0.2.1` contiene la app y el motor gráfico para el canal **Tags** de MGU Store. [Pasos de actualización y prueba](README.md#actualizar-desde-mgu-store)

## 2026-11-11 · 0.2.0 · BMWLauncher y tarjetas de DriveHub

### Documentación del proyecto

- **Cambio.** Se fijó en `ARQUITECTURA.md` la responsabilidad de cada lenguaje y componente, con referencias comunitarias y documentación de las bibliotecas. `AGENTS.md` indica qué leer antes de tocar el código y cuándo actualizar la bitácora.
- **Verificación.** Se comprobaron los enlaces locales entre ambos documentos y el README. Las decisiones de mapa y reproducción se registraron como candidatas pendientes de validación en ID8.

### Interfaz y navegación

- **Cambio.** Se retiró la barra izquierda de accesos y se reservó el mapa. La derecha dibuja las tarjetas integradas y una barra fija de energía. Trayecto y Radio son demostraciones. El ID OAP y los UUID se conservaron para actualizar sobre CarLauncher.
- **Cómo.** El estado de foco y los gestos viven en `drivehub-state.js`, el dibujo en `drivehub-view.js` y la conexión al renderizador en `drivehub-session.js`. El simulador utiliza los mismos módulos.
- **Verificación.** En Chrome, con datos de prueba y reales, se comprobó el deslizamiento, el foco, el selector de día de lluvia y el cambio de noticias. La comparación de capturas de 1960 × 520 confirmó que el área del mapa y la barra de energía conservaban sus píxeles al cambiar de tarjeta. La prueba de geometría confirma que ese lienzo ocupa 2880 × 764 en el área ID8 documentada.
- **Pendiente.** Verificar Winston y el mando físico en el i4. Si el toque funciona y la rueda no cambia el foco, comprobar primero si el renderizador anuncia y entrega FrontCCU antes de modificar el estado del carrusel.

### Acentos en la interfaz

- **Síntoma y causa.** En las primeras capturas aparecía `?` en palabras como «precipitación». El atlas base carecía de parte del juego de caracteres español y no se cargaba el atlas latino.
- **Corrección.** Se incluyó el atlas latino de Inter y se seleccionó desde `vendor/i18n.js`.
- **Verificación.** `node --test emulator/split/drivehub.test.js` comprueba la presencia de glifos españoles. Las capturas de Tiempo y Noticias confirmaron su representación.

### Fotos de EL PAÍS

- **Síntoma y causa.** Algunas noticias mantenían la imagen de reserva. Las fotos originales de EL PAÍS superaban el límite de resolución o memoria del decodificador JPEG.
- **Corrección.** Se solicita el ancho de 640 px al servicio de imágenes de EL PAÍS y se recorta al encuadre de la tarjeta. Se mantienen los límites del decodificador y la imagen de reserva ante fallo.
- **Verificación.** Se midieron las respuestas antes y después y se comprobó en Chrome que aparecían fotos reales de EL PAÍS y Xataka. Repetir el mismo cambio de noticia si falla una imagen tras tocar el proveedor o el decodificador.

### Red, caducidad y publicación

- **Qué se hizo.** Open-Meteo actualiza cada 30 minutos y los RSS de EL PAÍS, Xataka y Motorpasión cada 15 minutos mientras la app está abierta. Se conserva la última respuesta válida y se reintenta pasados dos minutos ante error. Tiempo usa Madrid hasta disponer de una fuente de ubicación validada.
- **Cómo.** Se separaron las descargas en un proceso con el UID OAP y DNS de `mgu-uplink` para usar la vía de red de la Store.
- **Verificación.** Se probaron consultas reales y la lectura de RSS en Node.js 8.16.2. Pasaron las siete pruebas de `node --test emulator/split/drivehub.test.js`. Se empaquetaron las fuentes, se enlazó el OAP con un donante simulado y se construyó el artefacto de la herramienta. La inspección de manifiestos confirmó el mismo identificador y UUID de la instalación anterior.
- **Pendiente.** Comprobar descarga y actualización desde la MGU con `mgu-uplink`, además del ciclo de instalación en iDrive 8.

## 0.1.x · Pruebas de composición

- **0.1.0.** CarLauncher y una radio de prueba separada compartían pantalla mediante dos superficies. El simulador confirmó el reparto de entrada. El usuario confirmó que el panel virtual abría en su coche. La integración posterior sustituyó ese diseño para las tarjetas nuevas.
- **0.1.1.** Se publicó un experimento optativo para colocar Android Auto a la izquierda. El simulador permitió probar el cambio de geometría y su restauración. En la MGU queda por identificar la superficie y verificar el toque. [Detalles de la prueba](README.md#experimento-con-android-auto-a-la-izquierda)
