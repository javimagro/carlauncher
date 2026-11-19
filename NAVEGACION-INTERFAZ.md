# Navegación: referencia Carlinkit y adaptación MGU

## Planificación eléctrica de Carlinkit y adaptación al i4 · 19-11-2026

Referencia de solo lectura `BMWLauncher` Android, base `427786f4`. Los dos modos comparten `VehicleTelemetryRepository` con energía disponible y capacidad útil del SME, además de autonomía y temperaturas. El modelo de carga y las reservas pertenecen al cálculo de cada modo.

| Modo | Carlinkit | Correspondencia en MGU21 |
| --- | --- | --- |
| Google Maps proyectado por Android Auto | `headunit-core` posee AAP. `ServiceDiscoveryResponse` anuncia propulsión eléctrica, conectores Type 2 y CCS2, nivel/autonomía (6), modelo energético (23) y el tipo 26 para observar ajustes. `EvEnergyModelPublisher` actualiza el modelo compatible con Wh disponibles, capacidad útil, temperatura y reserva. `AapNavigation` recibe la previsión de Maps en `0x8008`. Maps decide las paradas. | BMWLauncher reutiliza el receptor BMW `aapd`. En la copia `23.16.5`, la ruta de registro de Cinemo acepta 1–22 y por tanto rechaza el anuncio 23 y 26. No se ha validado otro punto de negociación compatible. |
| Google Navigation Android integrado | `GoogleNavigationEngine` toma el perfil energético. `GoogleEvRoutePlanner` y `NavigationEvStopOptimizer` calculan paradas en un corredor con geometría de Google, cargadores compatibles, reserva y curva de carga. Recalculan con telemetría reciente y validan la ruta recalculada antes de sustituirla. | El proveedor de este modo es BMW Maps mediante `Routing2`. Se leen sus previsiones y paradas. En el i4 se observó `NO_EROUTE` con el cálculo local y sus opciones de recarga activas. Reutilizar el optimizador requiere trayectos y desvíos válidos en la cartografía BMW y resultados de cargadores con conectores/potencia verificables. |

**Evidencia del receptor.** REA identificó `libNmeAndroidAuto.so` (`10446b6d…`), pero su proveedor Windows no analiza este ELF. Con LLVM se siguió `SENSORTYPE` hasta la validación en `0xd09c0` que comprueba `uint32(tipo − 1) < 22` y la rama de tipo inválido de `0x81c20`. El binario `aapd` (`a7971d64…`) tiene consultas CommonAPI de energía, autonomía y consumo. Su llamada `FuelDataCollector::reportCurrentFuelState` en `0x438050`–`0x43806f` marca como ausentes nivel y autonomía y envía solo la alerta de reserva si está disponible. La ruta estática no demuestra qué anuncia el receptor del coche en una conexión concreta.

**Entrega local.** Se añade la pareja E5C7 al modelo del i4 para compartir su lectura con futuros consumidores. El contrato de salida para la navegación proyectada requiere que el receptor anuncie la capacidad durante el descubrimiento, responda a suscripciones y permita devolver la previsión. En BMW local se necesita una ruta calculada con paradas por `Routing2` o validar el cálculo y los desvíos del optimizador sobre el mismo itinerario BMW. La prueba de aceptación es una ruta fuera de autonomía que muestre una parada compatible, energía de llegada y actualización cuando cambie la energía disponible. [Lecturas del i4](TELEMETRIA-MGU21.md) · [Estado de eRoute](NAVEGACION-MGU21.md) · [Protocolo de sensores AAP](https://github.com/mrmees/open-android-auto/blob/main/docs/channels/sensor.md).

## Alcance de esta revisión local (13-11-2026)

Implementada la presentación de búsqueda, cargadores, ficha, favoritos, teclado, resumen de ruta, batería de llegada y paradas. Usa los contratos BMW existentes y respeta el inicio explícito del guiado. La integración cartográfica continúa **no disponible**: el proveedor instalado no dibuja ni obtiene mapas externos. La lógica de cámara, marcadores y ruta se prueba de forma aislada; esto no demuestra imagen del mapa original en el i4.

## Referencias de solo lectura

Proyecto Android `BMWLauncher`, revisión base `427786f4bdb1216a0d2e4c7721318320980c747a` y su árbol local. Las rutas completas están en README. En la tabla, los recursos son relativos a `app/src/main/` y las clases a `app/src/main/java/com/car/bmwlauncher/`:

| Referencia | Comportamiento llevado a MGU |
| --- | --- |
| `res/layout/view_navigation_map_controls.xml` | Círculos separados, orden ajustes/voz/cargadores/guardados/cámara/asistente. Se conserva la casita y Datos de la MGU. |
| `res/layout/view_navigation_charging_station_panel.xml`, `item_navigation_charging_station.xml` | Panel lateral, número estable de resultado, nombre, distancia, llegada, potencia y disponibilidad; indicadores desconocidos en guiones. |
| `ui/NavigationChargingStationPanelController.java`, `NavigationScrollableResultList.java` | Publicación de los resultados visibles, scroll sin seleccionar accidentalmente y conservación del listado al volver. |
| `googlemaps/GoogleNavigationEngine.java`: `showDestinationMarkers`, `fitResultMarkers`, `fitCompleteRouteBesidePanel` | Encuadre de marcadores visibles; exclusión del área ocupada por panel; encuadre de origen, trazado completo, recargas y destino. Implementación propia de geometría, sin usar Google SDK. |
| `res/layout/view_navigation_poi_details.xml` | Ficha con información y acciones Cómo llegar, favorito y añadir parada. No se inventan fotos, horarios, conectores, precios ni disponibilidad. |
| `res/layout/view_navigation_route_panel.xml` | Resumen, información detallada, batería, paradas y acción Iniciar. La entrada Añadir parada conserva el destino final. |
| `res/layout/view_navigation_guidance_panel.xml` | ETA de guiado con duración, distancia, reloj de llegada y batería BMW, sobre las paletas Porcelain/Azure. Botones de finalizar, añadir parada y detalles. El panel se desplaza lo necesario para dejar libre la columna del mapa en iDrive. |
| `ui/NavigationMapPanelStack.java`, `NavigationNavigationController.java` | Pila de paneles; cierre distinto de retroceso; volver del resumen a resultados; no mezclar una ficha antigua con un destino recién seleccionado. |
| `res/layout/view_navigation_keyboard.xml` | Teclado, símbolos, espacio, borrado, vaciado y movimiento de cursor. Envío explícito con Buscar/Listo. |
| `res/values/colors_navigation_design.xml`, `dimens_navigation*.xml` | Paletas Porcelain/Azure y proporciones adaptadas a 1038 × 468. No se copia el tamaño en dp de la pantalla Android de otra resolución. |

Los 16 vectores originales se convierten en PC con WPF y Pillow. Los hashes individuales y la procedencia están en `native/javi-carlab/navigation-icons.SOURCES.json`. Se generan con `python tools/Preparar-IconosNavegacion.py RUTA_BMWLAUNCHER_ANDROID`. El atlas tiene 176 variantes de tinta, ocupa 101.304 bytes comprimido y se carga una vez de forma asíncrona mediante el protocolo de imágenes existente. La MGU usa geometría de respaldo y primitivas propias.

## Separación y reglas

- `navigation-layout.js`: límites compartidos de panel, lista, paginación y área libre del mapa. No mover la cámara usando el centro de toda la pantalla cuando un panel tapa la izquierda.
- `navigation-scene.js`: objetivos de cámara, marcadores numerados e identidad de la geometría. Una ruta activa de otra sesión no puede usarse para una previsualización nueva. Al cerrar la previsualización reaparece únicamente la ruta activa.
- `navigation-ui.js`: estado, pila, foco, teclado y traducción de toque/mando. Una respuesta tardía puede actualizar datos, pero no reabrir una ficha que el usuario cerró. Girar alcanza resultados fuera de la página y los desplaza a la zona visible.
- `navigation-panels.js` / `navigation-view.js`: presentación sin peticiones BMW. Un marcador y la fila de su mismo número envían el mismo ID. El mapa recibe los márgenes libres del panel; las calles y el dibujo nativo requieren el proveedor pendiente.
- `navegacion-acciones.js`: coordenadas reales mediante `getPOIDetail` / `getValidatedLocation`, una consulta de fondo simultánea, máximo 32 filas y 64 intentos por sesión. Selección comparte una consulta pendiente. Solo la ficha transmite NaviContainer; nunca copiarlo a todas las filas. Ignorar respuestas de sesiones reemplazadas o cerradas. Reabrir el itinerario conserva las recargas automáticas que devuelve BMW.

## Diferencias y funciones pendientes

No es todavía una réplica funcional completa. Voz/asistente, mapa satélite, tráfico y capas POI de Google no tienen una equivalencia BMW validada; no se añaden interruptores que simulen activarlas. Los ajustes operativos son los ya disponibles: recargas, reserva de llegada, peajes, autopistas y tema. La ficha no sustituye metadatos ausentes por los del proveedor Android. El modo de cálculo previo todavía no proporciona un trazado validado: solo se dibuja geometría cuando corresponde a la misma identidad de ruta. No se unen paradas con líneas rectas como si fueran carreteras.

La cuenta de resultados visibles se adapta a esta pantalla: dos tarjetas de carga o cuatro resultados de texto. El gesto mueve páginas y el mando desplaza una fila al cruzar el borde; no se ha añadido aún la animación inercial exacta de RecyclerView. Los temas de controles no recolorean la cartografía original hasta disponer de su salida. No se replica el arranque automático del guiado de Android: aquí se exige Iniciar.

## Verificación reproducible

- `node --test emulator/split/*.test.js`: pruebas de navegación más resto del producto; no sustituye el ensayo SOME/IP real.
- `node tools/Previsualizar-Navegacion.js` genera 26 capturas en `dist/navigation-preview`. En PowerShell, `$env:JAVI_DRIVEHUB_TALL='1'` selecciona el perfil de 572 píxeles y las guarda en `dist/navigation-preview-tall`. Incluye ETA de día y de noche, ETA sin batería y dos ensayos rotulados «SIN CARTOGRAFÍA». Usa datos sintéticos, comprueba DriveHub píxel a píxel y compara la barra inferior entre capturas con el mismo estado de energía.
- Referencia previa conservada en `dist/navigation-before-carlinkit`; no se publica como recurso.
- Sintaxis y carga de los nueve módulos instalados modificados con Node 8.16.2, comprobación de permisos y de archivos del paquete.

En la MGU queda comprobar lista real, coordenadas, ficha, cálculo/recargas, salida de mapa propio, encuadre y entrada táctil con el compositor. No se ha abierto SSH ni escrito en el coche durante esta revisión. No se toca el mapa del cockpit.
