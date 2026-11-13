# Navegación de BMWLauncher · MGU21

## Estado de la implementación

La versión **0.2.10 se distribuye como prueba mediante la etiqueta `v0.2.10`**. La interfaz y los adaptadores están implementados; las llamadas SOME/IP de búsqueda, cálculo e inicio de guiado necesitan comprobarse en el i4. Los ensayos locales usan respuestas simuladas con el contrato del firmware, no un NavController en ejecución.

| Función | Implementación | Límite actual |
| --- | --- | --- |
| Mapa, GPS, arrastre, zoom y centrado | Teselas OpenStreetMap en el compositor existente | No es la cartografía instalada de BMW; necesita internet para zonas no cacheadas |
| Dirección, ciudad y POI | `FreeTextSearch`, sesión privada y lista de resultados | Disponibilidad y permisos por validar en MGU; no se sustituye un fallo por resultados inventados |
| Cargadores cercanos | `POISearch` y categoría `CHARGING_STATION` obtenida de `POICategoryTree` | La disponibilidad dinámica depende de lo que devuelva BMW |
| Ficha de destino y favoritos | Localización validada de BMW; favoritos locales privados | Hasta 12 destinos; no sincroniza favoritos con BMW ID |
| Rutas y paradas | `Routing`, opciones propias por ruta, recargas automáticas, mínimo de llegada, peajes y autopistas | BMW puede rechazar el cálculo por servicios, configuración o permisos |
| Vista previa | Resumen, duración/distancia y paradas del cálculo BMW | El trazado se exporta con la ruta **activa**, después de Iniciar |
| Guiado | `Guidance.startGuidance` y observación de ruta, destino y maniobra | Voz y recálculo pertenecen a BMW; sonido y continuidad al ocultar por comprobar en el coche |
| Tema | Día/noche manual o señal del coche en automático | El mapa ráster se atenúa de noche; no tiene el estilo vectorial de Google |
| Entrada | Toque, teclado español y FrontCCU | La exclusividad frente a Hmi8 exige que el filtro del mando esté instalado y cargado |

La alternativa cartográfica se ofreció mientras se investigaba el motor original. Se implementó identificada como OpenStreetMap para poder continuar sin conectar la MGU. No se anuncia como mapa BMW ni como réplica completa del motor Google Navigation.

## Referencia visual y manejo

Referencia de solo lectura: BMWLauncher Android de Carlinkit, `view_navigation_search_panel.xml`, `view_navigation_poi_results_panel.xml`, `view_navigation_poi_details.xml`, `view_navigation_route_panel.xml`, `view_navigation_settings_panel.xml`, `dimens_navigation.xml`, `colors_navigation_design.xml` y `navigation-with-stop-redesign.png`.

Se conserva el reparto del proyecto: izquierda de 1038 × 468 píxeles lógicos, energía debajo y DriveHub a la derecha. La barra estrecha del mapa contiene ajustes, guardados, cargadores, vista de ruta, centrado y zoom; no es la antigua barra para lanzar aplicaciones. El buscador superior abre teclado/resultados. Las fichas y los ajustes comparten panel. El guiado usa cabecera turquesa y progreso inferior con tiempo, distancia y destino. Se conserva la casita y el acceso Datos/Mapa.

- Tocar el mapa le da el foco; arrastrar desplaza la cámara y el botón de centrado recupera el seguimiento del GPS.
- Desde la primera tarjeta de DriveHub, inclinar a la izquierda da el foco al mapa. Girar selecciona un control y pulsar/soltar lo activa. El teclado conserva la tecla enfocada al pulsar.
- Inclinar a la izquierda retrocede en los paneles. Inclinar a la derecha con el mapa sin panel devuelve el foco a DriveHub. Tocar una tarjeta también devuelve el foco.
- Las inclinaciones verticales cambian la página de resultados. No se ejecuta una pulsación que empezó antes de que otra capa cubriera la app.
- **Calcular ruta** no inicia el guiado. **Iniciar** lo solicita explícitamente. **Finalizar** pide confirmación en la propia interfaz porque detiene el guiado BMW vigente.
- Las previsiones de batería de parada/destino quedan en guiones. No se conservan números de demostración junto a una ruta real, ni se convierte un objetivo de llegada en una predicción.

## Fronteras de implementación

| Módulo | Responsabilidad |
| --- | --- |
| `apps/javi_carlauncher/navegacion-bmw.js` | Observador de ruta/tema, exportación de geometría y transporte visible OAP |
| `navegacion-acciones.js` | Búsquedas propias, detalle, favoritos restaurados, sesiones de cálculo y órdenes explícitas de guiado |
| `navegacion-indicaciones.js` | Normalización de maniobras BMW, sin inferir giros a partir de la polilínea |
| `native/javi-carlab/navigation-model.js` | Validación del canal, caducidad, decodificación E5 y comprobación del destino |
| `navigation-ui.js` | Estado de paneles, teclado, foco, gestos y persistencia de destinos |
| `navigation-panels.js`, `navigation-view.js` | Dibujo y áreas de interacción |
| `navigation-map.js` | Cámara Mercator, teselas visibles, caché y decodificación en auxiliar |

No se añade un motor web ni otro runtime. JavaScript Node 8 coordina las API y las entradas. El C/EGL/GLES ya instalado compone mapas y controles. PNG se decodifica en el auxiliar de fotografías; no bloquea el hilo de interacción. La exportación se conserva completa hasta 12 000 puntos y el dibujo recorta los segmentos al área visible; no se diezma por índices, para no perder curvas al acercar.

El socket `/run/javi-carlab/navigation.sock` es bidireccional, privado del UID OAP y con un único cliente. Tiene JSON UTF-8 delimitado por línea: 128 KiB para muestras, 64 KiB para órdenes y contrapresión de escritura. Las órdenes usan identificador monotónico y solo una operación está en curso. Los resultados de otras sesiones se descartan. Los campos ajenos no habilitan métodos arbitrarios.

El cierre elimina vistas y sesiones de búsqueda. El cálculo caduca y se elimina si no se inició. **No se elimina una sesión cuyo guiado se inició ni se llama a stopGuidance por ocultar BMWLauncher.** El destino conserva el `NaviContainer` devuelto por BMW, incluidos sus bytes; no se reconstruye un destino únicamente con latitud/longitud. Los favoritos preservan esos bytes al cruzar JSON.

`/var/opt/javi-carlab/navigation.json` conserva búsquedas, favoritos y tema, con permiso 0600, escritura temporal y renombrado. No se añaden ubicaciones personales a Git ni a registros. Los favoritos de más de 24 KiB se rechazan; el archivo leído está limitado a 512 KiB.

## Evidencia del firmware y contratos

Se han utilizado los binarios obtenidos previamente del i4 y el catálogo local coincidente con el firmware. Permanecen fuera del repositorio. REA abrió NavController; al no haber un proveedor de pseudocódigo compatible, se usaron símbolos LLVM y desensamblado Capstone. No se presenta ese trabajo como una decompilación completa.

- `NavController`: SHA-256 `f504557e86b7dbe49527008cf23ca4e7e834afb0027f2689cc22515299f7f400`.
- El camino de exportación llama al codificador de polilínea en `0xbb3c40`; `0xbb3a40` multiplica por 100 000, codifica deltas con signo y grupos de cinco bits más 63. Coincide con [Encoded Polyline](https://developers.google.com/maps/documentation/utilities/polylinealgorithm). Se verifica el extremo con el destino independiente de BMW, incluyendo el orden de ejes.
- En Hmi8, el getter de nombre de lista de `CNaviSearchSession` en `0x5bbea80` usa `%u` y el campo de sesión; el constructor `0x5bd5b40` escribe ese identificador. La factoría de lista FTS utiliza ese getter. La lista es la sesión decimal, sin prefijos supuestos.
- `createViewByIndex` y `destroyView` son métodos heredados de `ListViewBase` dentro del proxy de búsqueda; no hay que crear una instancia independiente del interfaz base.
- `currentTrips` usa el campo real **`routeIdentifer`**, con esa errata. Se compara con la ruta activa antes de usar sus segmentos.
- `NaviCommonTypes.Distance` es `{unit, displayLength, rawLengthMeter}`. `NavigationDataTypes.Duration` es `{timebase, duration}`, con milisegundos/segundos/minutos/horas. No se tratan como números sin unidad.
- El mínimo de llegada de `ERoutePreference` es una preferencia UInt8. Los campos `arrivalStateOfEnergy`/`targetStateOfEnergy` de carga son UInt16 y su escala sigue sin validar: no se muestran como porcentajes.
- El tema automático observa `Vehicle.statusDayNightChangeOver`: TAG=1, NACHT=2, KEINE_AENDERUNG=0; un valor inválido elimina la suposición anterior. La elección explícita de MapSettings tiene prioridad.

`tools/Verificar-Navegacion-MGU.js` valida interfaces, instancias, métodos heredados, campos y permisos contra el catálogo privado. El manifiesto concede operaciones concretas; no se permite un proxy genérico de escritura para todo el navegador.

## Qué falta para usar el mapa original

BMW publica su cartografía mediante escenas RAMSES. `MapCoreContent` expone contenidos especializados, no un servidor general de teselas; `MapApiLinksSD` expone topología, no el mapa completo con geometría y etiquetas. Una escena RAMSES tampoco equivale a teselas que podamos recolorear: el cliente propietario construye la escena. [Modelo de RAMSES](https://ramses-sdk.readthedocs.io/en/latest/core.html).

Por debajo se ha localizado `org.genivi.navigation.mapviewercontrolext.MapViewerControlExt:v30_11`, con creación de instancias y salidas IVI/RAMSES. El NavController del i4 depende de `liborg.genivi.navigation.proxy.someip.so.3.1.12-21.47`. Esa biblioteca **no está en la copia descargada**. La única extraída del PSdZData local es `19.48`, con `MapViewerControlExt:v26_1` y otros tipos: no se utiliza su ABI/protocolo como si fuese la revisión actual.

Para cerrar esa vía falta obtener, en una futura sesión de lectura autorizada, la biblioteca proxy 21.47, su stub y la configuración del servicio de MapViewer de esa misma unidad. Primero localizar sus rutas; después copiar solo esos componentes al directorio privado. No hace falta reflashear ni modificar la navegación original. La siguiente prueba debe crear una instancia propia y verificar su liberación, salida gráfica e independencia de la escena de Hmi8. Hasta entonces no se promete mapa BMW integrado, colores propios para sus calles ni funcionamiento offline con sus datos.

## Proveedor alternativo y caché

El proveedor ráster predeterminado es `https://tile.openstreetmap.org/{z}/{x}/{y}.png`. La atribución permanece visible incluso al abrir paneles. Se envía un User-Agent de BMWLauncher con la URL del proyecto. Solo se descargan las teselas de la vista actual, sin precarga de ciudades, rutas o niveles de zoom; las visitas se conservan durante siete días. [Política de teselas OSM](https://operations.osmfoundation.org/policies/tiles/).

Hay una descarga/decodificación activa, 40 imágenes en memoria y caché persistente de hasta 128 MiB/4096 ficheros por proveedor. Al llenarse no se borran teselas vigentes para volver a descargarlas. Se eliminan entradas caducadas al abrir y no se ofrecen descargas offline. Se puede configurar `BMWLAUNCHER_MAP_TILES` para otro endpoint compatible; la atribución debe adaptarse también si cambia la fuente de datos. Las coordenadas de las teselas solicitadas se envían a ese proveedor; las búsquedas y el cálculo continúan en BMW.

## Comprobación reproducible

Desde PowerShell en la raíz:

```powershell
node --test emulator/split/*.test.js
node tools/Verificar-Navegacion-MGU.js "$env:TEMP/bmw-mgu21-knob/someip-interfaces.json"
node tools/Previsualizar-Navegacion.js --online
```

La última orden solicita un único encuadre público de Madrid y reutiliza la caché. Genera nueve PNG en `dist/navigation-preview/`; las lecturas, resultados y maniobras son de prueba. Compara por píxeles que DriveHub y la franja inferior no cambien entre paneles. El adaptador de captura emula el recorte que el reproductor software del kit omite; no modifica el renderer instalado.

La instalación de prueba debe comprobar: búsqueda con tildes, cero resultados, cargadores, detalle, guardar/reabrir favorito, calcular sin iniciar, recargas de una ruta larga, Iniciar, maniobras, vuelta a BMW Maps, ocultación de BMWLauncher y Finalizar. Repetir toque y mando con la captura de Hmi8 activa. Comprobar aparte conectividad online BMW y Uplink: que la Store tenga internet no garantiza ConnectedDrive.

## Reversión

Los cambios no parchean NavController ni el motor de mapa. Para volver, restaurar la app y el motor gráfico publicados anteriormente mediante una versión de paquete superior; conservar sus IDs y UUID. La función no modifica las preferencias globales de rutas y no se debe borrar una ruta activa como parte de la reversión. Los favoritos/caché propios pueden conservarse. La prueba de esta versión no autoriza una conexión SSH o instalación automática.
