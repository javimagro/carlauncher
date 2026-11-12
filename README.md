# BMWLauncher para iDrive 8

[Arquitectura de desarrollo](ARQUITECTURA.md) · [Bitácora técnica](BITACORA.md)

## Pantalla principal de BMWLauncher

El lado izquierdo reserva espacio para el mapa o Android Auto, con la franja de energía debajo. En la vista de diagnóstico, las lecturas del coche ocupan el área de proyección. El carrusel de DriveHub ocupa toda la altura del lado derecho. Los números de la franja y los ejemplos de Trayecto y Radio son de demostración. El estado de precalentamiento en Trayecto procede de la señal de la MGU cuando hay una lectura válida.

### Actualizar desde MGU Store

En la fuente `javimagro/carlauncher`, selecciona el canal **Tags**. Pulsa **Ajustes → Comprobar ahora**, abre **Instaladas** y actualiza **BMWLauncher** a la versión de prueba **0.2.4**. La actualización conserva el acceso de BMWLauncher e instala el **Motor gráfico de BMWLauncher** de la misma versión con FFmpeg incluido. Para probar el mando, instala también **Captura del mando de BMWLauncher** desde esa fuente. Reinicia iDrive tras instalar ambos componentes.

Con el coche parado y `mgu-uplink` conectado, abre BMWLauncher, entra en **TDTWorld** y prueba **La 2** o **24h** con **Ver en directo**. Comprueba imagen, sonido y cambio de canal con la rueda. Si aparece **Audio no disponible**, la imagen puede seguir reproduciéndose. Anota el canal y el mensaje si falla una emisión.

Con el coche parado, abre **BMWLauncher** y espera unos segundos. En **Lecturas del coche**, compara **Batería del cuadro** y **Autonomía del cuadro** con el cuadro y haz una foto de la pantalla. Los campos muestran valores de diagnóstico, incluidos los códigos que la MGU devuelve cuando falta un dato. Después inicia el precalentamiento en **Vehículo → Carga → Preacondicionar batería**, comprueba que aparece el icono en el cuadro y vuelve a BMWLauncher para mirar **Precalentamiento HV**. Si puedes, abre Android Auto y vuelve a BMWLauncher para mirar **Android Auto · vídeo**. Esa fila indica el estado que comunica iDrive al abrir BMWLauncher.

Con el coche parado, abre **BMWLauncher**, gira la rueda en ambos sentidos y comprueba que cambia la tarjeta. Con la herramienta de captura instalada, inclina el mando a la izquierda y hacia arriba. Comprueba que BMWLauncher mantiene el foco y usa la casita para volver a iDrive. Abre Tiempo y Noticias y, si alguna tarjeta falla, anota el mensaje que aparece debajo del título de error.

Con `mgu-uplink` conectado, Tiempo consulta Open-Meteo cada 30 minutos y Noticias consulta los RSS cada 15 minutos mientras la app está abierta. Si falla la conexión, muestran la última respuesta disponible y reintentan pasados dos minutos.

### Probar el mando con 0.2.4 desde USB

Extrae el ZIP de prueba en la raíz del USB. MGU Store detecta la fuente en `mgu-repo/BMWLauncher`. Con el coche parado, abre la sección **USB** de MGU Store, actualiza **BMWLauncher** a **0.2.4** e instala **Captura del mando de BMWLauncher**. Reinicia iDrive para que cargue el filtro. La herramienta utiliza la protección de arranque de la Store y requiere `mgu-deploy` 0.3.2 o posterior. [Descargar el ZIP de prueba](https://github.com/javimagro/carlauncher/releases/tag/v0.2.4)

Abre BMWLauncher desde la pantalla de iDrive a la que quieras volver. Gira la rueda, inclínala a izquierda y derecha para cambiar de tarjeta y prueba arriba en Noticias o TDTWorld. Comprueba que Atrás y Menú físicos no abren otra pantalla mientras la app tiene el mando. Toca la casita del panel izquierdo para volver. Si la casita aparece atenuada, sal con los controles normales de iDrive y vuelve a abrir BMWLauncher. Para quitar la captura, desinstala su herramienta desde la Store y reinicia iDrive.

### Plan y arquitectura

1. Reproducir el encuadre de CarLauncher para Carlinkit y medir las tarjetas originales de DriveHub. El carrusel tiene cuatro posiciones. Trayecto y Radio, Radio y Tiempo, Noticias y TDTWorld. Las dos últimas ocupan todo el ancho de DriveHub. La trama diagonal es común al panel y se aclara dentro de la tarjeta enfocada.
2. Compartir estado de selección, gestos, geometría y dibujo entre el servicio iDrive y el simulador de Windows. `drivehub-state.js` gestiona el desplazamiento, el toque y FrontCCU. `drivehub-view.js` dibuja el mapa reservado, el carrusel y la franja de energía. `drivehub-session.js` conecta ambos con `mgu-render`. El OAP mantiene su identificador y proporciona el acceso desde el menú de iDrive.
3. Separar las fuentes de datos de la pantalla. Tiempo utiliza Open-Meteo con tres horas de previsión, precipitación por hora y siete días seleccionables. Noticias usa las portadas RSS de EL PAÍS, Xataka y Motorpasión, con titular, resumen del medio, imagen y contador. El servicio conserva la última respuesta válida. En iDrive las descargas se ejecutan con el UID de BMWLauncher y necesitan `mgu-uplink` conectado.
4. Comparar con capturas de Carlinkit y probar en Chrome el desplazamiento, foco, lluvia, cambio de día, anterior y siguiente. En el coche queda por comprobar el área real de Winston, el acceso a internet y los eventos del mando físico.

Las coordenadas de Tiempo usan Madrid por defecto. Para cambiar la ubicación en una futura instalación, `/var/opt/javi-carlab/drivehub.json` admite un objeto `location` con `name`, `latitude` y `longitude`. La posición del vehículo para Tiempo, la integración de las lecturas verificadas en la franja de energía y la búsqueda de noticias mediante asistente quedan pendientes.

Los fondos e iconos del tiempo, la imagen de reserva de Noticias y el ejemplo de Radio proceden de los recursos locales de DriveHub. Los iconos de energía proceden de los recursos locales de BMWLauncher para Carlinkit. `drivehub-art.rgba.gz` contiene versiones redimensionadas para el renderizador. Se regenera con `python tools/Preparar-ArteDriveHub.py <DriveHub> <BMWLauncher-Android>` y Pillow. Las licencias de Inter, jpeg-js y SAX se incluyen en `native/javi-carlab/vendor`.

### Vista local

Ejecuta desde la raíz del proyecto en PowerShell y abre [BMWLauncher en el navegador](http://127.0.0.1:18078/).

```powershell
node emulator/split/server.js --drivehub
```

El simulador arranca con contenido reproducible. Añade `--telemetry` para ver la pantalla de diagnóstico con lecturas simuladas o `--live` para consultar Tiempo, Noticias y TDTWorld reales. Haz clic en la pantalla para darle foco. La rueda del ratón simula el giro y las flechas simulan las inclinaciones del mando. Desliza en horizontal para cambiar de tarjeta o en vertical para alternar Tiempo y lluvia o recorrer Noticias. En lluvia, toca un día para ver su previsión por horas. Toca la casita para cerrar la vista.

### TDTWorld en DriveHub

Gira el mando para elegir un canal e inclínalo arriba o abajo para recorrer su programación. La ficha y el fanart siguen al programa seleccionado. Pulsa el mando o toca **Ver en directo** para abrir la emisión dentro de la tarjeta. Toca **Menú** para abrir la guía, gestionar favoritos y configurar país, categorías, orden, último canal y duración de la información. El deslizamiento horizontal vuelve a Noticias y cierra la emisión.

Para probar emisiones en Windows, instala FFmpeg o indica la ruta a su ejecutable con `JAVI_TDT_FFMPEG` y arranca el simulador con `--live`. El paquete de iDrive 8 lleva su propio FFmpeg para Linux x86-64 y un auxiliar PCM que intenta abrir la salida SmartX de la MGU. Se puede indicar otra salida con `JAVI_TDT_PCM` o usar `off` para silenciar la prueba. Las emisiones que requieren cuenta, DRM o reproductor web del proveedor dependen de una integración específica. [Código fuente y compilación de FFmpeg](native/javi-carlab/bin/SOURCES.txt)

## Versiones anteriores (0.1.x)

### Fuente experimental para MGU Store

La fuente publica dos apps OAP separadas para ID8 y una herramienta auxiliar. **CarLauncher** abre la pantalla de prueba. **Radio de prueba** es una segunda app que se abre en primer plano de iDrive y dibuja su propia superficie solo en el panel derecho. **CarLauncher Lab** mantiene el mapa y las barras en una capa independiente, solicita el cambio de pantalla al HMI y se oculta al salir de la prueba. La radio usa los botones RHMI para recibir el giro y la pulsación del mando. Las emisoras, la ruta y las lecturas son ficticias.

El paquete está pensado para la salida ID8 de 2880 × 960. CarLauncher Lab depende de `mgu-render` 0.6.10 o superior y del `hmictl` de Overlays 0.4.0 o superior, publicado por IterioDev. La Store debe tener disponible la fuente `IterioDev/car-apps`, canal **Tags**, además de la fuente del renderizador. Overlays es una herramienta independiente y puede activar su propia barra de accesos. El marco de CarLauncher usa la capa ordinaria de `mgu-render`, que cede ante las superficies de cámara reconocidas por el renderizador. [Overlays de IterioDev](https://github.com/IterioDev/car-apps#overlays-tool-iteriodev-overlays-idrive-8-only) · [mgu-render](https://github.com/robertnisipeanu/mgu-store/blob/main/native/mgu-render/README.md)

1. En MGU Store, añade `javimagro/carlauncher` en **Ajustes → Añadir fuente** y elige **Tags**.
2. Abre la ficha de **CarLauncher** y comprueba que la Store ofrece la radio y la herramienta auxiliar como dependencias. Instala desde la ficha. En ID8, las apps quedan disponibles tras el siguiente reinicio de la MGU.
3. Con el coche parado, abre **CarLauncher** desde el menú de apps y toca **Radio**. Comprueba que se abre **Radio de prueba** dentro del panel derecho y que se ven el mapa y ambas barras. Toca Radio 2, gira hasta Radio 3 y pulsa la rueda. Los contadores de **Toques**, **Giros** y **Pulsaciones** permiten separar los tres resultados. Toca **Cerrar** o usa **Atrás** para regresar y comprueba que el marco se oculta al abrir otra pantalla de iDrive.
4. Para retirar la prueba, elimina **CarLauncher** y **Radio de prueba** desde **Instaladas**. Después elimina **CarLauncher Lab** desde **Herramientas**. Las retiradas de apps de ID8 también se aplican en el siguiente reinicio.

El empaquetador de MGU Store generó ambos paquetes OAP con un donante simulado y el artefacto de la herramienta. También se comprobó con un HMI simulado la apertura, el retorno, la transparencia del marco y el enrutamiento de toque, foco y pulsación. La carga del SDK de BMW, las dos superficies en Winston y la rueda física quedan pendientes de la prueba en iDrive 8. Los módulos de dibujo reutilizados de MGU Store y los atlas Inter conservan sus licencias en [vendor](native/javi-carlab/vendor).

### Experimento con Android Auto a la izquierda

La etiqueta `v0.1.1` actualiza CarLauncher y CarLauncher Lab. En una instalación existente del canal **Tags**, pulsa **Ajustes → Comprobar ahora** y luego **Instaladas → CarLauncher → Actualizar**. La Store instala la versión requerida de CarLauncher Lab con la app.

Al abrir CarLauncher, la variante experimental puede pedir al HMI que abra Android Auto de serie y ajustar su capa existente al panel izquierdo. El marco deja transparente el rectángulo de la proyección, conserva las barras y mantiene una vista propia a la derecha. Durante esta prueba Android Auto tiene el primer plano y recibe el toque y la rueda a través de iDrive. El reparto de la rueda con la radio independiente queda por verificar.

El arranque automático requiere un perfil de la unidad en `/var/opt/javi-carlab/aa.json`. Se obtienen primero dos lecturas del contexto y la escena de Winston, con Android Auto abierto y cerrado. `tools/Capturar-Capas-AA.ps1` realiza esas consultas por una conexión SSH ya autorizada y disponible. Solo se activa el perfil tras confirmar `state`, `applet`, `layer`, `surface` y `process` y comprobar que la capa pertenece únicamente a la proyección. El perfil usa `enabled: true` para activar la prueba.

El experimento guarda el rectángulo original antes de mover la capa, comprueba que Winston aplicó el destino y restaura la geometría al abandonar el contexto. Si iDrive vuelve a posicionar la capa, el marco se retira y la prueba termina. El siguiente paso en la unidad es comprobar que la imagen se mantiene, que el toque coincide con sus controles y que Atrás restaura el tamaño original. La variante se validó con una escena simulada y queda pendiente de calibración en la MGU.

En el i4 se capturó Android Auto dentro de la superficie `100` de `Hmi8`, junto con las barras nativas. La técnica de mover una capa de proyección propia requiere una superficie independiente. La siguiente prueba debe localizar la salida de vídeo de Android Auto antes de que se componga en `Hmi8`. [Resultado de la captura](BITACORA.md#2026-11-11--telemetría-y-android-auto--capturas-del-i4)

## Primer hito

Abre [la maqueta](carlauncher.html) en un navegador de Windows. El menú del engranaje permite añadir accesos de ejemplo, ampliar el panel de la derecha y cambiar entre día y noche. El mapa, las lecturas y el panel de DriveHub son de demostración.

La distribución parte de `activity_main.xml` de BMWLauncher. La barra izquierda conserva el engranaje azul, los accesos cuadrados y los indicadores de conexión. La vista normal mantiene la ruta a la izquierda y la app seleccionada a la derecha. La barra de estado bajo esa app muestra batería, autonomía, temperatura HV, próxima parada y batería al llegar. Al ampliar el panel se conservan los accesos y la barra de estado. La ocupación se mide dentro del área de la app de iDrive.

## Pruebas en Windows

Desde la carpeta del proyecto en PowerShell:

```powershell
.\Probar-MGU.ps1
```

El script abre el navegador cuando el carlauncher está listo. Si el navegador no se abre, entra en [el simulador local](http://127.0.0.1:8077/). Pulsa **Menu → Pantalla completa → Menu → Vista dividida**. Mantén PowerShell abierto mientras lo uses y pulsa **Ctrl+C** para detenerlo. Si el puerto está ocupado, arranca con `-Port 8078`.

El script busca `..\idrive7-apps` desde su propia ubicación, aunque se ejecute desde otra carpeta. La copia del kit está fijada en `21c65786a6c4d23bd54e706b6c46722ffa24a077`. Si mueves la copia, pasa `-Kit 'ruta a la copia'`. El script aplica una adaptación para Windows a esa revisión y copia los archivos de `emulator/` al directorio de trabajo del kit. Edita el código en `emulator/` y vuelve a ejecutar el script para sincronizarlo. El kit se ejecuta con Node.js y Python, escucha solo en el propio equipo y genera una vista local sin paquete instalable.

La prueba **Hello World** usa el protocolo de dibujo `mgu-render/1` con el simulador gráfico de iDrive 7. Sirve para probar dibujo y entrada con datos ficticios. La maqueta HTML cubre el selector de apps y los dos temas. El simulador sustituye al sistema HMI y a los servicios del coche. La carga OAP, el área real de pantalla y la convivencia con el sistema de iDrive 8 requieren una MGU virtual ID8.

- [Simulador gráfico de idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps/blob/main/docs/emulator.md)

### Prueba local del panel derecho

Desde la carpeta de CarLauncher en Windows, ejecuta `node emulator/split/server.js` y abre [la prueba local](http://127.0.0.1:18078/). Pulsa **Radio** en la barra izquierda. Puedes tocar una emisora, girar la rueda del ratón o usar las flechas y confirmar con **Intro**. **Cerrar** devuelve el panel propio. Para elegir otro puerto, pásalo como primer argumento.

CarLauncher y la radio son dos procesos con conexiones independientes. La radio pide con `PLACE` un rectángulo de 716 × 428 píxeles dentro de la maqueta de 1600 × 520. La prueba reutiliza el cliente de `mgu-render` y el motor gráfico del kit compilado para el navegador. El simulador local mantiene visible la capa de CarLauncher y reparte los toques por zonas y la rueda según la petición de la radio.

En Chrome se verificó que el mapa y las barras conservan sus píxeles al abrir la radio, salvo el acceso que cambia de **Radio** a **Cerrar**. El toque selecciona una emisora, la rueda mueve el foco e **Intro** confirma. Tocar el mapa no afecta a la radio y el acceso lateral permite cerrarla y reabrirla. La gestión real del primer plano y de la entrada, incluida la prioridad de la cámara, quedan pendientes de una MGU virtual iDrive 8.

### Arranque de una MGU21 virtual

El PSdZData 4.58.15 Full disponible en el equipo contiene los paquetes de MGU21 `036_010_004`. En `SWFL 000056EA` se comprobó que la entrada `/usr/bin/winston` contiene un ELF Linux x86-64. El paquete `00005685` contiene referencias a `winston.service` y a las bibliotecas gráficas. Falta un entorno arrancable que monte esos componentes, inicialice la salida gráfica y levante el HMI y los servicios de entrada de iDrive 8.

- **MGU Store** documenta `./emu.py up --unit id8 --systemd` para un proyecto separado llamado `mgu-emulator`. La comprobación de publicación que acompaña al repositorio usa ese proyecto para arrancar iDrive 7, capturar la pantalla e inyectar pulsaciones y toques. Para intentar la variante ID8 en local hace falta acceder al proyecto y a su configuración de arranque, o disponer de una VM preparada que exponga esas funciones. [Flujo de emulación](https://github.com/robertnisipeanu/mgu-store/blob/main/AGENTS.md) · [Comprobación de publicación](https://github.com/robertnisipeanu/mgu-store/blob/main/tools/emu-gate)
- **Emulador público de iDrive 8.5** ejecuta el `Hmi8` original de una MGU22 ARM en Apple Silicon con macOS 26 y usa Weston como compositor principal. Sirve de referencia para reconstruir el entorno gráfico. La prueba de CarLauncher requiere Winston y la pila OAP de la MGU21. [Requisitos del emulador](https://github.com/rishik250809/bmw-idrive8.5-emulator#requirements-and-compatibility) · [Arranque gráfico](https://github.com/rishik250809/bmw-idrive8.5-emulator/blob/main/runtime/launch_guest.sh)

La prueba en el compositor queda pendiente. El entorno debe mostrar la salida de Winston en `wayland-0`, exponer el estado de primer plano `RemoteHmiApplication2` y permitir reproducir el toque y los eventos de giro y pulsación `FrontCCU` por la ruta de entrada. Con la radio en primer plano, hay que comparar capturas con la radio cerrada y abierta, comprobar qué capa recibe cada toque y confirmar que un giro y una pulsación seleccionan y activan una emisora. La prueba de Windows usa un rectángulo fijo y envía la orden de abrir por comunicación entre los procesos locales. La prueba en la MGU virtual requiere colocar la app según el área que indique el renderizador y abrirla a través del HMI. [Composición y entrada en mgu-render](https://github.com/robertnisipeanu/mgu-store/blob/main/native/mgu-render/README.md)

## Qué puede alojar el panel derecho

La primera versión conserva la barra de accesos, la ruta de ejemplo y el panel derecho ampliable. Los paneles integrados conservan la barra de accesos y las lecturas. Los accesos externos se identifican como **Abrir en iDrive** y dejan paso a la pantalla de destino. Al volver, CarLauncher debe recuperar el panel seleccionado y su tamaño.

| Contenido | Vía que encaja con iDrive 8 |
| --- | --- |
| Panel propio | Una app OAP con un único lienzo de `mgu-render` en modo `layer`. La app dibuja sus barras y el panel que corresponda. Es la primera prueba nativa, con texto y datos ficticios. |
| Funciones portadas de DriveHub | Trasladar una función concreta, como radio, a un panel del carlauncher. La versión Android usa vistas, servicios e intents de Android. La API `VirtualDisplay` que emplea BMWLauncher requiere ese entorno. |
| DriveHub Android en otro equipo | Investigar la proyección de vídeo al panel. `mgu-render` admite fotogramas suministrados por un reproductor local. Hay que comprobar por separado transporte, audio, devolución de toques y convivencia con el HMI en ID8. |
| Apps independientes de MGU Store | Accesos externos. Probar la apertura y el regreso entre dos apps OAP en un entorno ID8. El renderizador ordinario muestra la superficie de la app que iDrive tiene en primer plano. |
| Pantallas y apps de BMW | Accesos externos. Overlays de IterioDev documenta accesos probados en un G82 con iDrive 8 mediante un servicio con privilegios que se comunica con el HMI por SOME/IP. La apertura desde CarLauncher y el retorno quedan por validar. |

El modo `embed` documentado por `mgu-render` coloca el dibujo de la propia app en una página HMI con un widget de iDrive 7. La versión revisada no lo ofrece en iDrive 8. En las interfaces revisadas tampoco aparece un equivalente a `VirtualDisplay` que aloje otra app OAP o BMW. Screen share de IterioDev captura la pantalla central compuesta.

Para una app de la Store que use `mgu-render` y se pueda adaptar, hay una vía experimental en ID8. La app dibujaría su propia superficie en el rectángulo derecho con `PLACE`. CarLauncher mantendría el mapa y las barras mediante una capa persistente con privilegios, como la que usa Overlays, dejando libre el panel derecho. Falta validar en ID8 la coexistencia de las capas, los toques, el foco de la rueda y el retorno a CarLauncher. La capa persistente debe ceder ante la cámara. Para pantallas de BMW o apps sin adaptar queda por demostrar cómo aislar y colocar su superficie y dirigirle la entrada.

Los paquetes fuente de la prueba nativa usan `mgu-app.json` y declaran `ID8`. La Store enlaza los módulos de la app con el SDK de una app de serie durante la instalación. La maqueta de Windows sigue disponible para iterar sobre el dibujo y la entrada simulada.

- [Publicar aplicaciones para MGU Store](https://github.com/robertnisipeanu/mgu-store/blob/main/docs/PUBLISHING.md)
- [Renderizador y protocolo gráfico](https://github.com/robertnisipeanu/mgu-store/blob/main/native/mgu-render/README.md)
- [Posicionamiento de capas y entrada en mgu-render](https://github.com/robertnisipeanu/mgu-store/blob/54c656a79f08db3385393417a93b5608778fa571/native/mgu-render/PROTOCOL.md)
- [Aplicaciones iDrive 8 de IterioDev](https://github.com/IterioDev/car-apps)
- [Accesos a pantallas de BMW con Overlays](https://github.com/IterioDev/car-apps#overlays-tool-iteriodev-overlays-idrive-8-only)
- [Captura de la pantalla central con Screen share](https://github.com/IterioDev/car-apps/blob/main/README.md#screen-share-tool-iteriodev-screencast)
- [VirtualDisplay de Android](https://developer.android.com/reference/android/hardware/display/VirtualDisplay)
