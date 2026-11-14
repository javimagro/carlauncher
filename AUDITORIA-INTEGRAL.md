# Auditoría integral · 14 de noviembre de 2026

La auditoría se realizó en local. La publicación posterior solicitada por el usuario se documenta en [BITACORA.md](BITACORA.md) y corresponde a la [0.2.11 de prueba](https://github.com/javimagro/carlauncher/releases/tag/v0.2.11).

## Resultado y alcance

Revisión de la versión local **0.2.11**, sobre `22eae2a` más los cambios previos sin publicar. Se conservaron estos cambios y se guardó una copia anterior a las correcciones fuera del repositorio. No se accedió a la MGU, no se instaló ni publicó una versión.

Se revisaron integración OAP/servicio/sesión, navegación y HUD, radio, telemetría/HV, tiempo/noticias, asistente, transporte multimedia y empaquetado. Dos revisiones independientes de corrección y mantenibilidad complementaron el análisis de integración, las medidas y la inspección visual. No es una garantía de ausencia de errores: algunas capacidades siguen sin proveedor gráfico o sin validación física.

La arquitectura general se conserva: JS Node 8 para producto y coordinación, auxiliares para CPU y audio/vídeo, compositor nativo existente. Los costes demostrados se resolvieron evitando trabajo repetido; no hay una medición que justifique migrar la interfaz completa a C++.

## Hallazgos corregidos

| Prioridad | Causa y efecto | Corrección y evidencia |
| --- | --- | --- |
| P1 | `drivehub-session.js` aceptaba CCU del renderer con la app abierta aunque otra capa la cubriera. Podía cambiar una tarjeta sin verla. | Exige también `onScreen`, igual que la entrada OAP. Regresión con cobertura, cinco giros y retorno: DriveHub conserva sus píxeles. La exclusividad frente a Hmi8 es otro requisito. |
| P2 | `navigation-ui.js` serializaba todos los puntos de ruta en cada actualización estable. | Identidad de geometría más firma pequeña de coordenadas de resultados/paradas/ubicación. Reencuadra al cambiar esos datos y conserva el encuadre manual cuando no cambian. |
| P2 | `radio-ui.js` buscaba favoritos nativos recorriendo toda la lista por cada emisora y reconstruía filas reiteradamente. | Índices por `memoryKey`; filas cacheadas por lista, filtros y revisión de favoritos locales. Verificados cambios de filtros, favoritos nativos/locales, sustitución y caducidad. |
| P2 | Pedir TDT al asistente antes de visitar su tarjeta devolvía una lista vacía o «no encontrado» sin cargar el catálogo. | Carga bajo demanda en el controlador TDT, compartida con el refresco, sin cargar la guía para una consulta de canales. Espera máxima de 12 s, cancelación y estados de carga/desconexión distintos de ausencia de coincidencias. No cambia de tarjeta al listar. |
| P2 | Una foto de Noticias pendiente seguía vigente al ocultarse y podía decodificarse/publicarse después. El dibujo oculto podía solicitarla otra vez. | Invalidación por generación al suspender, comprobación antes de CPU y nueva petición al volver. La sesión solo solicita fotos visible. No se elimina una foto ya válida por ocultar. |
| P2 | Guardar una clave cerraba el editor y destruía el borrador antes de confirmar la escritura; el rechazo de un texto también lo perdía. | Valida formato, conserva borrador enmascarado ante fallo y muestra error junto al campo. Cierra solo con éxito. Si se sale mientras guarda, la respuesta no reabre el panel. |
| P2 | La muerte del auxiliar de audio durante escucha dejaba `busy/listening` indefinidamente. | Error terminal distinguido de aviso de salida, timeout de 35 s en el propietario, descarte de eventos de auxiliares antiguos. El fallo de salida durante respuesta conserva el texto. Afecta al micrófono cuando se habilite, no demuestra micrófono operativo en MGU. |
| P2 | Un bloque de micrófono de 65.536 bytes superaba el límite IPC de 64.000 caracteres base64 y se descartaba en el receptor. | Bloques de hasta 48.000 bytes, alineados a PCM16; conserva el byte impar para la siguiente entrega y cuenta muestras realmente emitidas. Regresión de conservación byte a byte. |
| P2 | El aviso del mapa se dibujaba parcialmente detrás del panel ancho HUD/asistente y podía salir del espacio libre. | No dibuja el aviso grande cuando no cabe; conserva el estado en el pie. Recorta al área libre cuando sí cabe. Capturas día/noche revisadas. |
| P3 | Ramas `fit/zoom` inalcanzables en sesión, estado `mapZoom` sin efecto en la UI actual, `nextVoice` y `configFile` sin consumidores. | Eliminados esos restos y la importación que solo usaba `nextVoice`. Se conservan las primitivas geométricas y herramientas de ensayo que sí tienen consumidores. |

## Medidas antes/después

Windows x86-64, **Node 8.16.2**, misma máquina, `tools/Medir-Interaccion.js`, 30 iteraciones de calentamiento y 300 muestras. Son operaciones CPU locales con datos sintéticos del tamaño máximo admitido; **no son milisegundos de la MGU ni una medida del arranque del coche**.

| Escenario estable | p50 antes | p50 después | p95 antes | p95 después |
| --- | ---: | ---: | ---: | ---: |
| Actualizar panel de ruta de 12.000 puntos | 7,1103 ms | 0,0039 ms | 8,4776 ms | 0,0040 ms |
| Consultar favoritos entre 1.500 emisoras | 17,6279 ms | 0,0004 ms | 23,3983 ms | 0,0005 ms |

La ganancia corresponde a datos estables: las listas y el encuadre se reconstruyen cuando cambian. No se elimina la lectura de señales ni su caducidad. El coste de cambios reales de ruta/lista sigue siendo mayor que el de una consulta cacheada.

`Medir-Rendimiento.js` se ejecutó antes y después. La medición final de dibujo fue p50 0,624 ms / p95 2,776 ms, carga de módulos 62,95 ms y arte 51,31 ms. La primera ejecución fue más lenta (módulos 126,51 ms, arte 69,80 ms), pero no se hizo un ensayo controlado de caché fría/caliente: **no se atribuye esa diferencia a una mejora de arranque**. No se cambiaron bibliotecas de dibujo ni el artwork.

## Revisión por áreas

| Área | Comprobación local | Límite que permanece |
| --- | --- | --- |
| Navegación/HUD | Búsqueda y lista, restauración de destinos, cálculo frente a inicio explícito, respuestas tardías, opciones permitidas y metadatos de pantalla. | Cartografía original no integrada; confirmar rutas/carriles/carteles y servicios ConnectedDrive en el i4. |
| Radio/tiempo | Deduplícación, favoritos, categorías, selección confirmada, logos, GPS/caducidad y proveedor compartido con cockpit. | Emisoras y metadatos emitidos por la MGU, altavoces y recepción real. |
| Telemetría/HV | Unidades compartidas, muestras inválidas/caducadas y órdenes explícitas con feedback. No se alteraron conversiones en esta auditoría. | Fuentes aún no validadas, especialmente potencia de batería en la instalación del usuario. |
| Asistente | Credenciales fuera de snapshots/paquetes, lista de herramientas, cancelación, voces, borradores y errores de auxiliares. | Claves reales, proveedor real y micrófono/altavoces de MGU. |
| TDT | Transporte, cola y proceso aislado; carga diferida del catálogo. Prueba HLS local con fallo de red y bloqueo UI deliberados. | Fluidez del paquete final en MGU y sonido real SmartX. No se anuncia reparación del audio del coche. |
| Interfaz | 22 capturas de navegación, 14 del asistente, 6 de radio, 6 de tiempo y 12 de HV generadas con fixtures; inspección representativa día/noche, error y foco. Las herramientas comprueban regiones invariantes. | Tamaño físico, legibilidad en el coche y eventos de mando reales. No es una certificación de accesibilidad ni de WCAG. |
| Arquitectura/instalación | Responsabilidades, cierre y cachés, sintaxis Node 8, manifiestos, dependencias locales y enlace sintético. | SDK, carga real del filtro en Hmi8 y primer fotograma en el i4. |

Las partes de dibujo/servicios siguen separadas. No se añadieron dependencias, lenguajes, capas de paso ni un segundo motor gráfico. Las funciones con responsabilidad real permanecen aunque el proveedor BMW todavía no esté integrado.

## Pruebas y artefactos

- Referencia inicial: **175 pruebas correctas**. Resultado final: **192 correctas**, sin omisiones ni fallos. Las primeras doce regresiones se ejecutaron también contra la copia previa: diez fallaban; las otras dos protegen el comportamiento durante las optimizaciones. Después se añadieron cinco regresiones de límites, fallo de salida, guardado con cambio de panel y reintento de catálogo.
- Sintaxis de **69 módulos instalados propios/OAP con Node 8.16.2**; carga directa de los **11 módulos de biblioteca modificados**. `service.js` pasa sintaxis; ejecutarlo requiere el entorno MGU.
- **153 dependencias relativas** de los scripts del motor resueltas dentro del manifiesto; 99 archivos declarados presentes.
- HLS local con FFmpeg 9.0.2: **250 fotogramas**, 2.361.600 bytes PCM recibidos por el proceso de prueba, 12 avances durante 650 ms de bloqueo deliberado de UI. Estadística del productor: hueco máximo 65 ms, cero vaciados y cero reconexiones en la muestra. El observador en el hilo bloqueado registró 701 ms; no es una parada equivalente del productor. No se midió sincronía labial ni sonido en altavoces.
- Motor y fuente en `dist/local-0.2.11/audit`, comparados byte a byte con el árbol final. Enlace con donante sintético de 17 módulos correcto; ese enlace no contiene un SDK BMW operativo ni se distribuye como paquete instalable.

| Artefacto local | SHA-256 |
| --- | --- |
| `app-source.tgz` | `06b61a62fa94363a540e69c98a4a5be279339450ab7a11006758307515c2ae2a` |
| `javi-carlab@0.2.11.tgz` | `a2bd26669037879faa662a40274df06ae6b1992ede58a74205d26023b8756f60` |

Comandos desde la raíz del repositorio en PowerShell:

```powershell
node --test emulator/split/*.test.js
& "$env:TEMP/bmwlauncher-node-v8.16.2/node.exe" tools/Medir-Interaccion.js
& "$env:TEMP/bmwlauncher-node-v8.16.2/node.exe" tools/Medir-Rendimiento.js
node tools/Previsualizar-Navegacion.js
node tools/Previsualizar-Asistente.js
node tools/Previsualizar-Radio.js
& "$env:TEMP/bmwlauncher-node-v8.16.2/node.exe" tools/Probar-Reproduccion.js "$env:TEMP/bmwlauncher-tdt-ffmpeg/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v9.0.2.exe"
```

## Pendientes y reversión

Prioridad de validación en el coche: 1) entrada/recuperación al cubrirse por otra capa; 2) TDT con contadores y ruta de audio; 3) radio/telemetría; 4) mapa BMW/HUD; 5) asistente con proveedor y audio reales. Los problemas externos ya documentados no se resuelven cambiando búferes, permisos o umbrales sin evidencia nueva.

No hay cambio instalado que revertir. Para retirar solamente esta auditoría local, usar la copia anterior `bmw-audit-20261114-baseline` en el directorio temporal del usuario y comparar/restaurar exclusivamente sus módulos afectados. **No restaurar el checkout completo:** contiene trabajo previo ajeno a esta auditoría. La copia temporal no es un respaldo permanente. No se creó commit, tag ni release.
