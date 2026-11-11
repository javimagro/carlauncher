# Bitácora técnica de BMWLauncher

Registra aquí los cambios relevantes, las incidencias y las pruebas que ayuden a reproducirlas. La [arquitectura](ARQUITECTURA.md) describe las decisiones vigentes. Lee las entradas relacionadas antes de cambiar el mismo componente. Añade las entradas más recientes arriba y actualiza una incidencia abierta cuando se confirme su causa o se cierre.

## Formato de una entrada

- **Fecha, versión y área.** Añade el commit o la etiqueta cuando esté disponible.
- **Qué se hizo y por qué.** Describe el cambio y dónde se aplica.
- **Síntoma, reproducción y causa.** Para fallos, registra los pasos, lo que se observó y si la causa está confirmada.
- **Corrección y verificación.** Anota el cambio, el comando o prueba, el entorno y el resultado.
- **Pendiente.** Indica la comprobación que falta y enlaza evidencia sin datos privados.

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
