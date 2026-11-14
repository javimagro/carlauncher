# Navegación de BMWLauncher · MGU21

## Estado de la implementación

El árbol local prepara **0.2.11**, todavía sin publicar. El modo usa exclusivamente BMW: se han retirado teselas, lector/escritor de caché y `BMWLAUNCHER_MAP_TILES`. No hay sustitución por un proveedor externo ni descarga de mapas BMW.

**La vista cartográfica original aún no está integrada.** El panel indica «Mapa BMW no disponible», conserva búsqueda, destinos y ruta BMW y deshabilita zoom/centrado sin un mapa. No muestra una polilínea sobre un fondo vacío como si fuese cartografía. Las cachés externas antiguas permanecen sin abrir; no se necesitan para este modo.

| Función | Implementación | Verificación pendiente |
| --- | --- | --- |
| Cartografía local BMW | Estado explícito `BMW_MAP_INSTANCE_UNAVAILABLE` | Instancia propia, salida gráfica y perfil del firmware |
| Dirección, POI y cargadores | Adaptadores FreeTextSearch / POISearch / POICategoryTree existentes | Respuesta y cobertura offline de la unidad |
| Destinos/favoritos | NaviContainer íntegro y almacenamiento privado | Restauración real BMW |
| Rutas y recargas | Routing / Routing2, preferencias por ruta | Cálculo local y disponibilidad de recarga sin ConnectedDrive |
| Guiado | Inicio explícito, maniobras BMW y geometría activa | Voz, recálculo y continuidad real al ocultar |
| HUD y cuadro | Observación de vistas originales y cinco ajustes BMW con confirmación de lectura | Maniobras, cruces, carriles y destino real de carteles en el i4; [detalle](HUD-NAVEGACION-MGU21.md) |
| Día/noche | Paleta de los controles BMWLauncher | No se aplica a vías/agua/vegetación mientras no haya motor integrado |
| Toque/mando | Paneles existentes; no modifica mapas originales | Convivencia de ambas pantallas y exclusividad física del mando |

La publicada `v0.2.10` conserva el comportamiento anterior con OSM. Esta revisión local lo elimina: no se presenta una prueba de UI como navegación BMW offline funcionando.

## Referencia visual y manejo

Referencia de solo lectura: BMWLauncher Android de Carlinkit, `view_navigation_search_panel.xml`, `view_navigation_poi_results_panel.xml`, `view_navigation_poi_details.xml`, `view_navigation_route_panel.xml`, `view_navigation_settings_panel.xml`, `dimens_navigation.xml`, `colors_navigation_design.xml` y `navigation-with-stop-redesign.png`.

Se conserva el reparto del proyecto: izquierda de 1038 × 468 píxeles lógicos, energía debajo y DriveHub a la derecha. Los controles del mapa son círculos separados en el orden de Carlinkit; no son la antigua barra para lanzar aplicaciones. El buscador abre teclado/resultados. La lista estrecha, ficha amplia y resumen de ruta con subpáginas tienen geometrías propias; el encuadre usa la parte libre. El guiado usa cabecera turquesa y progreso inferior. Se conserva la casita y el acceso Datos/Mapa. Los controles de voz/asistente permanecen deshabilitados hasta validar su proveedor. [Referencia exacta, adaptación y limitaciones](NAVEGACION-INTERFAZ.md).

- Tocar el panel da el foco a navegación. Arrastre, zoom y centrado quedan deshabilitados mientras la salida de mapa no esté integrada.
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
| `navegacion-pantallas.js` | Observación de contenido nativo HUD/IC, preferencias originales y estado del HUD |
| `native/javi-carlab/navigation-model.js` | Validación del canal, caducidad, decodificación E5 y comprobación del destino |
| `navigation-ui.js` | Estado de paneles, teclado, foco, gestos y persistencia de destinos |
| `navigation-panels.js`, `navigation-view.js` | Dibujo y áreas de interacción |
| `navigation-map.js` | Estado de capacidad local BMW; utilidades de proyección sin proveedor de teselas |

No se añade un motor web, runtime, biblioteca nativa ni ABI supuesta. Node 8 coordina las API y controles; C/EGL/GLES compone la interfaz. Las utilidades de geometría BMW se conservan, sin confundirse con una base cartográfica.

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

## Contraste de búsqueda con la aplicación BMW · 13-11-2026

El usuario confirmó que «Cargadores» abre el panel sin resultados. Se contrastó el flujo con el catálogo de su MGU y con **Hmi8 original**, SHA-256 `7aa4f8d007ce505fada5572a9643f542e8f8056e7d0ac3d25acc524607d30e20`. Son observaciones de símbolos y desensamblado del binario local; no una captura de la búsqueda fallida ni una decompilación completa.

| Paso | Evidencia de BMW | Aplicación en BMWLauncher |
| --- | --- | --- |
| Categorías de cargadores | `CDevNaviPoiCategoryBase::onSpecialCategoriesChanged` `0x5c943f0`, comparación de tipo 3 en `0x5c946a3`; getter `0x5c8c640` | Usar los IDs anunciados en CHARGING_STATION, sin sustituir por palabras ni servicios externos |
| Preparación e inicio | `CNaviPOISearchSession::performSearchInternal` `0x5be7b60` espera las respuestas de `setCategories` | Mantener la espera de categorías antes de iniciar |
| Enlace de vista | `CNaviPOIResultActivity::onStart` `0x5ccf630`: inicia en `0x5ccf8a9` y enlaza la lista en `0x5ccf8ba` | Mantener creación de vista tras inicio; no es una causa demostrada del vacío |
| Suscripciones y resultados | `CDevCAListHelper<POISearchProxy>::createListView` `0x5d7e550` suscribe `changedViewInfo` y `resultList`; `onResultListStatus` `0x5d793d0` filtra nombre/ID y llama `fillResultList` `0x5d70210` | Suscribirse antes de crear la vista; conservar reemplazo completo y filtro por sesión/vista. Añadido tamaño/destrucción de lista |
| Finalización | El catálogo declara POI `SearchState.searchStatus`, frente al enum directo de FTS | **Corregido:** ya no se compara una estructura con FINISHED. Prueba de regresión falló antes y pasa después |
| Validación de destino | Hmi8 `CNaviFTSBaseSearchSession::requestValidatedLocation` `0x5bc3b40` pasa sesión/clave a su backend `0x5b90ce0`; catálogo `getValidatedLocation` | Conservar el destino validado con su NaviContainer para cálculo/favoritos; no reconstruirlo solo con coordenadas |

Hmi8 `setSearchConfiguration` `0x5baf3d0` y NavController `PoiSearchHMIAdapter` `0x16b4690` transmiten radio y máximo como Int32 sin conversión visible. No se cambian los valores existentes (50000/32) ni se anuncia «50 km» como dato validado: la unidad efectiva/rango del motor sigue pendiente.

La lista distingue búsqueda inicial vacía, final sin coincidencias, error, vista destruida y tamaño positivo sin entrega de filas. Este último caso muestra `BMW_LIST_NOT_RECEIVED` tras cinco segundos desde FINISHED, en vez de afirmar que no hay cargadores. `changedViewInfo` aporta diagnóstico; su ausencia anterior **no está demostrada** como causa de pérdida de resultados. Los mensajes tardíos ya no sustituyen destino/previsualización y un recálculo fallido borra el plan eliminado. Los servicios de observación que no están disponibles al abrir se reintentan cada cinco segundos mientras la app está visible.

**Pendiente para cerrar el fallo real:** capturar la misma búsqueda en BMWLauncher y BMW con ENET, observar categorías, aceptación de órdenes, nombre/ID/tamaño de vista, estados y entrega de filas; elegir un resultado, calcular y comprobar el guiado solo tras pulsar Iniciar. Las pruebas locales y el contraste estático no acreditan todavía búsqueda/ruta real ni imagen de mapa propia.

## Qué falta para usar el mapa original

BMW publica su cartografía mediante escenas RAMSES. `MapCoreContent` expone contenidos especializados, no un servidor general de teselas; `MapApiLinksSD` expone topología, no el mapa completo con geometría y etiquetas. Una escena RAMSES tampoco equivale a teselas que podamos recolorear: el cliente propietario construye la escena. [Modelo de RAMSES](https://ramses-sdk.readthedocs.io/en/latest/core.html).

Por debajo se ha localizado `org.genivi.navigation.mapviewercontrolext.MapViewerControlExt:v30_11`, con creación de instancias y salidas IVI/RAMSES. El NavController del i4 depende de `liborg.genivi.navigation.proxy.someip.so.3.1.12-21.47`. **Proxy y stub 21.47 se recuperaron de la unidad el 13-11-2026**, junto con GeniviAdapter, motores y estilos. La copia `19.48` del PSdZData, con `MapViewerControlExt:v26_1`, no se utiliza como sustituta de la revisión actual.

La falta de binarios ya no bloquea el análisis. La prueba temporal autorizada del 13-11-2026 consiguió crear vistas y registrar superficies propias de NavigationBasic, pero no obtener fotogramas. Quedan por verificar activación del renderizado, ciclo de vida completo, entrada y composición con imagen. No se promete mapa BMW integrado, colores propios para sus calles ni funcionamiento offline con sus datos.

## Investigación de las dos pantallas · 13-11-2026

La primera fase usó únicamente extracciones previas porque ENET no respondía. En la sesión posterior se comprobó que la ruta automática del PC elegía Npcap; vinculando los sockets a Ethernet respondió el gateway, sin alterar rutas ni adaptadores globales. Se habilitó SSH con autorización explícita y sin ejecutar la rama de reinicio de la herramienta. Se reconfirmaron SWFL `036.010.004`, Node `8.16.2` y x86-64. El usuario pidió después mantener SSH habilitado hasta que avise; no cerrar automáticamente al terminar una descarga. Las operaciones de investigación siguen siendo de lectura, sin instalar ni reiniciar.

- **Central:** Hmi8 contiene `CDevNaviMap::allocateMap` (0x54dad30), accesos MAIN/SPLIT/PREVIEW/PAD y `CDevNaviMapBase::setInstance` (0x5756de0). `CNaviMapSizeHelper::setTextureRectangle` (0x572b680) calcula relaciones X/Y y configura el modelo gráfico. El catálogo MapControl ofrece viewport, escala, posición, tipo, habilitación y gestos. Es control de instancias BMW existentes, no una factoría privada OAP; no se reutiliza MAIN para ocuparlo.
- **Motor:** NavController contiene `MapInstance`, `MapStyles`, `MapGeniviAdapter::createMapViewInstance(size, renderSink, dpi, callback)`, `releaseMapViewInstance`, `setMapViewTheme(instance, style)` y `setStyleVariant(instance, drawingElements, properties)`. Los destinos internos incluyen IVI, RAMSES y Stream. Las firmas RTTI/cadenas prueban la existencia de esas rutas, no sus IDs SOME/IP, permisos ni valores admitidos.
- **Estilo:** aparecen `generalStyleVariants`, `annotationStyleVariants`, `annotationStyleProperties`, modo día/noche, foco, HAD e indoor. En la interfaz OAP, MapAppearance contiene interruptores (POI, landmarks, tráfico, satélite…), no colores RGB. `standardColorSetOn` es global; no se escribe para intentar recolorear una vista propia. La existencia de `StyleProperty` no prueba que acepte una paleta arbitraria para agua, vías y vegetación.
- **Cuadro:** hay `GuidingDispatcher::createInstance(GuidingInstance, Ramses/Stream, size, callback)`, `createGuidanceViewInstanceAsync` y opciones de cruces/visualización en Kombi. Esto permite distinguir contenido de guiado del mapa MAIN. **No se ha trazado el mapa completo del cuadro hasta su proceso/escena final**: no demuestra que comparta MapViewer ni que use otro renderer. La diferencia visual observada por el usuario sigue siendo evidencia del coche, no un perfil identificado por esta investigación.
- **Geometría alternativa local:** MapCoreContent crea gráficos especializados (CTT, POI de tenant, city/highway, SAPA, país); sus render sinks RAMSES llevan applicationId/sceneId UInt64. MapApiLinksSD solo anuncia eventos de enlaces/nodos/regiones, proyección, atributos y posición MPP; no ofrece consulta de un viewport arbitrario con polígonos de suelo/agua, etiquetas y POI completos. No basta para afirmar que podemos reconstruir toda la cartografía.

Por tanto, la prioridad sigue siendo una **instancia propia de MapViewer**, con perfil/paleta comprobados y composición independiente. No se ha seleccionado la vía 2 ni se ha declarado integrada la vía 3. [RAMSES: escenas, displays y buffers offscreen](https://ramses-sdk.readthedocs.io/en/latest/core.html), [referencias entre escenas](https://bmwcarit.github.io/ramses/SceneReferencing.html). Estas API generales no acreditan la revisión ni el renderer instalado de BMW.

### Componentes recuperados y contratos pendientes

Copia privada fuera del repositorio: `D:/Usuarios/javie/BMW/MGU21-20261113-mapas-video`. Contiene 259 ficheros (158.354.603 bytes), inventariados en `files-sha256.json`. Se transmitieron con tar por stdout de SSH, sin temporales remotos. Se comprobaron contra hashes calculados en la MGU los dos binarios GENIVI principales, GeniviAdapter, NavigationBasic y el mapeo de estilos. Un primer tar de estilos señaló una biblioteca RAMSES cuyo nombre no existía; los miembros presentes se verificaron y las bibliotecas reales se recuperaron en un tar posterior. No se presenta ese primer comando como una copia completa sin errores.

| Componente | Evidencia |
| --- | --- |
| Proxy GENIVI 21.47 | SHA-256 `e6d41bd2a16bc7b24328c80a081ca69c67bc34146d3febeb6937d5037d5ae943`; RTTI/cadenas confirman MapViewerControlExt v30_11, Dimension v9 y DisplayDPI/RenderSink v28 |
| Stub GENIVI 21.47 | SHA-256 `680fcc7c6502111e52adec1dba9fb549c3a58ff9e68e9c648eafe5506830fc90` |
| GeniviAdapter | SHA-256 `ab56e8f82711586aee837ad044413965debc212143d34ff1944db8042ac6e3a9`; proceso vivo con UID 6055, carga proxy/stub 21.47; contiene el servidor MapViewerControlExt y sus respuestas de creación/estilo |
| NavigationBasic / NavigationFully | Ambos procesos vivos, UID 6058, RAMSES 27.0; NavigationBasic contiene mensajes internos MapViewer y construcción de cliente/renderer RAMSES. Aún falta trazar una instancia concreta hasta la pantalla |
| RAMSES | Bibliotecas 19.0 y 27.0 copiadas; procesos de navegación y Hmi8 observados con 27.0. Copiados proxy/stub ramsesservice 42.2.3 |
| Configuración | HBGeniviAdapter/NVNavigation/navcontroller, navcore, coding efectivo, commonapi y vsomeip; solo lectura, sin arrancar servicios |
| Cartografía | `nav_db.ini` apunta al conjunto local `AMD_ECE_101072139_3_00`. Solo se copió ROOT.NDS (65.536 bytes), con cabecera ZV-zstd, para estudiar metadatos; no la base geográfica completa. El nombre comercial/año de mapa sigue sin verificarse |

Los recursos `mapStyleDB_ID8_BMW_ECE_204dpi` y `guidStyleDB_ID8_BMW_BMW-M_ECE_204dpi` confirman perfiles propios de central, cuadro y HUD. `style_uri_mapping.cfg` (SHA-256 `8f8061be03e2001099afa7260b2f5bf6f85c2d6369d5beddc418a8230c47293c`) mapea 1000/1010 a Full día/noche; 1180 a High Guiding IC y 1200 a EGO Map IC. Los temas Alternative 1040/1050 apuntan al mismo Full día/noche, por lo que no prueban una paleta distinta. Los perfiles Focus permiten Full/Default/Dynamic/Reduced. Esto acredita recursos disponibles, no cuál está seleccionado en ese instante en el cuadro.

DynamicStyleDB.sqlite contiene esquema 6.0, clientes GeniviAdapterStyleImport y GeniviParkingSpotsClient y tablas de colores/anchos de líneas y polígonos. Ambas tablas están vacías en la copia. La interfaz StyleImportControlExt existe, pero todavía no se ha demostrado que pueda cambiar los colores de la cartografía base por instancia; no se escribe la base ni se cambia el estilo global. El ejecutable cluster-controller no contiene las referencias MapViewer/RAMSES buscadas: su nombre por sí solo no acredita que dibuje el mapa del cuadro.

Con esa evidencia hay que validar acceso a imagen/textura, formatos, eventos de entrada y ciclo de vida completo. Crear instancias es una operación activa: el usuario autorizó expresamente el ensayo temporal descrito debajo, sin instalar una versión ni reiniciar. No se usa la biblioteca 19.48 de PSdZData como sustituta del protocolo 30.11 actual.

### Ensayo temporal con BMWLauncher y cockpit visibles

El usuario confirmó ambas vistas y coche parado. Se compiló una sonda C++14 aislada, x86-64 Linux, con avisos como errores, intérprete `/lib/ld-linux-x86-64.so.2`, dependencias y versiones de símbolos comprobadas. Fuente, ejecutable, scripts y capturas quedan en la carpeta privada, fuera del paquete. La configuración vSomeIP fue una copia temporal aplicada solo a ese proceso; no se alteró la configuración global.

- **Contratos observados:** MapViewerControlExt `FA94/1`, versión `30.11`; MapViewerControl `FA95/1`, versión `5.2`. `getSupportedMapViewThemes` (`FA95:40`) respondió con 43 temas. `getVersion` y getters de visibilidad agotaron el plazo: eso no demuestra falta de conectividad.
- **Creación:** `FA94:02` devolvió handles propios 53–59 para 1038 × 468 y 204 dpi. El cuerpo contiene propietario UInt32, dimensiones/dpi UInt16 y variante con longitud/tipo UInt32. Con la variante de 28 bytes del ensayo RAMSES→IVI se observaron superficies nuevas `1296125953`–`1296125955`, propiedad de NavigationBasic. Los IDs no estaban en la escena inicial. La salida IVI sencilla no apareció en `wayland-0`; el formateador de CMapCanvasSession en `0x818e02` fuerza los valores 0/1 a `wayland-1` en esa rama.
- **Composición:** una capa temporal propia se añadió a screen 4 y se limitó a la izquierda, dejando casita, DriveHub y energía accesibles. Las superficies anunciaron 1038 × 468, pero cero cuadros y formato predeterminado R_8. Las capturas siguen mostrando el OSM de la versión 0.2.10 instalada: **no son evidencia de mapa BMW**.
- **Visibilidad:** las funciones de nombres internos `0x109f4c0` y `0x10de6da` asocian VISIBLE a `0x43`, INVISIBLE a `0x44` y FROZEN a `0x45`. Enviar 67 por SOME/IP no produjo respuesta ni fotogramas. El valor 1 había recibido respuesta vacía. El análisis posterior confirmó que el puente CommonAPI entrega el enum sin remapeo y que el receptor solo acepta 67/68/69: el valor 1 era inválido. Una respuesta vacía no confirmaba un efecto gráfico.
- **Cierre:** se recibió respuesta de `FA95:03` al solicitar liberar cada handle. Algunas superficies persistieron, por lo que la respuesta no acredita por sí sola la destrucción inmediata del renderer. Se retiraron explícitamente solo las capas/superficies reservadas para la sonda. Comparación final: los mismos 40 objetos y las mismas propiedades de escena que antes, excluyendo contadores de fotogramas. Se borró el directorio temporal de la sonda. NavigationBasic y GeniviAdapter conservaron sus PID; no se reinició nada.
- **Cockpit:** el usuario confirmó que su mapa siguió igual durante el ensayo. No se enviaron setters a MAIN, a escenas existentes ni a mapas del cuadro. SSH se mantiene habilitado por su instrucción; ENET ya no se necesitaba para esta prueba de mapa al terminar.

Reproducción privada: `build-map-probe.ps1`, `read_mgu.py`, `map-probe-visible67.txt`, `trial-map58-late.txt`, `scene-comparison.json` y `trial-cleanup-final.txt`. No volver a ejecutar sin reservar IDs nuevos, verificar la escena y acotar cierre/tiempo. Antes de integrar un puente hay que conseguir fotogramas; no parchear el motor ni reutilizar una escena del cockpit.

### Continuación local tras desconectar ENET

NavigationBasic configura su renderer con una capa IVI cuyo ID coincide con el de la superficie. La captura del ensayo muestra esa capa nativa oculta, a 0×0, mientras la superficie estaba en otra capa añadida por la sonda. Es una hipótesis concreta para la siguiente prueba, todavía no la causa demostrada de cero fotogramas. También se confirmó que la conexión RAMSES se comparte y que el parser limita su identificador: no reiniciarla ni tratar un UInt64 arbitrario como conexión propia. [Direcciones, contraste con escena real y prueba preparada](MAPA-ENSAYO-LOCAL.md).

`tools/map-runtime/Diagnosticar-Escena-Mapa.js` analiza las capturas y genera un plan de IDs/visibilidad/cierre; no conecta al coche ni ejecuta órdenes. Se mantiene el estado de mapa no disponible hasta observar imagen y liberación propias, preservando el cockpit.

## Comprobación reproducible

Desde PowerShell en la raíz:

```powershell
node --test emulator/split/*.test.js
node tools/Verificar-Navegacion-MGU.js "$env:TEMP/bmw-mgu21-knob/someip-interfaces.json"
node tools/Previsualizar-Navegacion.js
```

La última orden no accede a red ni cachés externas. Genera nueve PNG de UI con datos simulados, incluidos estados de mapa no disponible diurno/nocturno. DriveHub y franja inferior se comparan por píxeles. No son capturas de cartografía BMW.

Faltan las pruebas offline solicitadas: zona nueva cubierta, versión/procedencia del mapa, búsqueda de dirección/POI/cargador, ruta/recálculo y ambas pantallas coexistentes. No se pueden ejecutar sin acceso y sin integrar la salida del motor. La aprobación de lectura no autoriza instalación, reinicio ni publicación.

La instalación de prueba debe comprobar: búsqueda con tildes, cero resultados, cargadores, detalle, guardar/reabrir favorito, calcular sin iniciar, recargas de una ruta larga, Iniciar, maniobras, vuelta a BMW Maps, ocultación de BMWLauncher y Finalizar. Repetir toque y mando con la captura de Hmi8 activa. Comprobar aparte conectividad online BMW y Uplink: que la Store tenga internet no garantiza ConnectedDrive.

## Reversión

Los cambios no parchean NavController ni el motor de mapa. Para volver, restaurar la app y el motor gráfico publicados anteriormente mediante una versión de paquete superior; conservar sus IDs y UUID. La función no modifica las preferencias globales de rutas y no se debe borrar una ruta activa como parte de la reversión. Los favoritos propios pueden conservarse. La prueba de esta versión no autoriza una conexión SSH o instalación automática.
