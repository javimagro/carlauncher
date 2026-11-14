# Navegación: referencia Carlinkit y adaptación MGU

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
| `ui/NavigationMapPanelStack.java`, `NavigationNavigationController.java` | Pila de paneles; cierre distinto de retroceso; volver del resumen a resultados; no mezclar una ficha antigua con un destino recién seleccionado. |
| `res/layout/view_navigation_keyboard.xml` | Teclado, símbolos, espacio, borrado, vaciado y movimiento de cursor. Envío explícito con Buscar/Listo. |
| `res/values/colors_navigation_design.xml`, `dimens_navigation*.xml` | Paletas Porcelain/Azure y proporciones adaptadas a 1038 × 468. No se copia el tamaño en dp de la pantalla Android de otra resolución. |

Los 15 vectores originales se convierten en PC con WPF y Pillow; hashes individuales y procedencia en `native/javi-carlab/navigation-icons.SOURCES.json`. Generación: `python tools/Preparar-IconosNavegacion.py RUTA_BMWLAUNCHER_ANDROID`. El atlas contiene 165 variantes de tinta (89.880 bytes comprimidos), se carga una vez de forma asíncrona y reutiliza el protocolo de imágenes existente. La MGU no convierte SVG/XML ni incorpora un runtime nuevo. Geometría de respaldo y primitivas de mapa siguen siendo código.

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
- `node tools/Previsualizar-Navegacion.js`: 18 capturas en `dist/navigation-preview`. Dieciséis con el proveedor instalado indisponible y dos ensayos rotulados «SIN CARTOGRAFÍA» para revisar encuadre y marcadores. Datos sintéticos, sin teselas ni rutas reales. Comprueba DriveHub y barra inferior idénticos píxel a píxel.
- Referencia previa conservada en `dist/navigation-before-carlinkit`; no se publica como recurso.
- Sintaxis y carga de los nueve módulos instalados modificados con Node 8.16.2, comprobación de permisos y de archivos del paquete.

En la MGU queda comprobar lista real, coordenadas, ficha, cálculo/recargas, salida de mapa propio, encuadre y entrada táctil con el compositor. No se ha abierto SSH ni escrito en el coche durante esta revisión. No se toca el mapa del cockpit.
