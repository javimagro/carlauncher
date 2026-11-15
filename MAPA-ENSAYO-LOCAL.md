# Mapa BMW: análisis del ensayo sin fotogramas

## Ensayo actualizado sin ENET · 14-11-2026

El ejecutor manual todavía añadía la capa propia con opacidad 1. Se ha incorporado la conclusión del ensayo físico: añadir la capa vacía produjo un pantallazo negro, mientras la misma capa transparente no lo produjo. `composeCommands` establece ahora **opacidad 0 antes de añadirla a screen 4**. Solo la revela tras dos observaciones con contador de cuadros creciente, tamaño 1038×468, productor NavigationBasic y pertenencia exclusiva a la pantalla central. Cada observación vuelve a comprobar propiedad; los objetos existentes y el cockpit no se modifican.

Las regresiones comprueban que cero cuadros, contador desconocido/estático, tamaño inválido o capa compartida no permiten mostrarla. Esto prepara una prueba menos intrusiva; **no resuelve ni demuestra el origen de los cero cuadros**. Si el compositor limita el dibujo de capas transparentes, habrá que observar los eventos del productor antes de cambiar esa condición, sin presentar una capa vacía opaca como solución.

La siguiente conexión sigue requiriendo IDs nuevos y autorización de ensayo temporal. No se ha abierto SSH, ejecutado el helper ni instalado ningún componente durante esta revisión local.

13-11-2026. Continuación **en local**, con ENET desconectado. No se ha instalado ni ejecutado otra sonda en el coche. Se conserva el panel «Mapa BMW no disponible»: este análisis no convierte las superficies vacías del ensayo en un mapa funcional.

## Resultado

Se ha resuelto una duda del protocolo: **VISIBLE es 67 (`0x43`)**, también en el valor que entrega el puente CommonAPI al receptor. El valor 1 usado inicialmente era inválido; una respuesta vacía a esa orden no certificaba que el mapa se hubiese activado.

Además, el renderer de NavigationBasic crea su **propia capa IVI con el mismo ID que la superficie**. En la instantánea guardada del ensayo esa capa estaba oculta, tenía tamaño 0 × 0 y no estaba incluida en la pantalla. La superficie se añadió a una segunda capa distinta. Esa es una diferencia concreta que corregir en el siguiente ensayo; **todavía no está demostrado que explique por sí sola la ausencia de fotogramas**.

La orden VISIBLE válida se convierte en una transacción que configura el renderizado y espera su terminación. Que haya expirado mientras la superficie sigue a cero cuadros es compatible con un problema de activación/renderizado. No prueba un error de red ni autoriza enviar repetidamente más órdenes.

## Evidencia estática

Se han leído exclusivamente los componentes extraídos previamente. Análisis con Capstone/LLVM, no pseudocódigo de un decompilador. Direcciones virtuales del ELF, no offsets de fichero:

| Componente | SHA-256 |
| --- | --- |
| GeniviAdapter | `ab56e8f82711586aee837ad044413965debc212143d34ff1944db8042ac6e3a9` |
| NavigationBasic | `6c58158c13a7d6fe641319a46550b29553209c03572b7c45a52c1be12c8490f5` |
| Proxy GENIVI 21.47 | `e6d41bd2a16bc7b24328c80a081ca69c67bc34146d3febeb6937d5037d5ae943` |

- **Visibilidad.** En GeniviAdapter `0x527870`, `setMapViewVisibilityMode` extrae el valor del enum (`+8`) y lo pasa sin remapeo a `0x6934d6`. La función `0x828e0c` reconoce únicamente `0x43/0x44/0x45`: VISIBLE produce `float(-1)` y modo 2; INVISIBLE produce `float(0,2)` y modo 0; FROZEN produce `float(0)` y modo 0. El resto devuelve falso. `CSetMapViewVisibilityModeRequestJob`, `0x8fac32`, consume esa conversión; la rama válida configura y confirma una transacción y la inválida llama a abortar en `0x8fae8a`. La ruta CommonAPI `0x527820` y la serialización del proxy `0x42a850` descartan tratar ese enum como un bool.
- **Render settings.** `0x828e46` acepta los valores `0x42…0x4a` y los convierte a frecuencia/modo. No hay motivo para cambiar globalmente parámetros ni añadir un valor arbitrario de FPS; la visibilidad válida ya configura ese camino.
- **Capa propia.** En NavigationBasic `0x15ce9ec`, la construcción de `DisplayConfig` llama a `setWaylandIviSurfaceID`. En `0x15cea25` vuelve a cargar **el mismo campo** (`this+0x2304`) antes de llamar a `setWaylandIviLayerID` (`PLT 0x340300`). El renderer no usa la segunda capa que añadía la sonda anterior para su propio `DisplayConfig`.
- **Último campo del destino.** El serializador CommonAPI `0x2eac1a` del proxy escribe 16 bytes RAMSES, 8 bytes IVI y un UInt32 adicional; el formateador de trazas de GeniviAdapter lo denomina explícitamente `iviLayerId`. El visitor `0x4f65ad` conserva ese campo en la estructura interna, pero `CMapCanvasSession` en `0x818e51` forma el identificador de NavigationBasic con solo cuatro valores (`%llu %llu %u wayland-%u`). La capa pedida por separado no llega a ese parser. Por eso el ensayo siguiente envía el mismo ID para capa y superficie, y configura la capa que realmente creó NavigationBasic.
- **Escena y display.** `0x15cea7a` crea display; `0x15ceab3` llama a `RendererSceneControl::setSceneMapping`; `0x15ceadb` solicita estado 3; `0x15ceaff` y `0x15ceb1a` vacían las órdenes de control de escenas y renderer. La existencia de esta ruta no demuestra que esos pasos acabaran correctamente en el ensayo: falta registrar sus eventos/errores.
- **Conexión RAMSES.** El parser de identificador `0x15cfd36` reduce el primer valor a UInt32 y `0x15cf9dc` valida 1–3. No es correcto interpretar cualquier identificador UInt64 inventado como una nueva conexión aislada: los valores del ensayo tenían parte baja 1. El contexto usa una factoría de conexión compartida (`0x15cd3d1…0x15cd48b`). Crear una escena propia sigue siendo obligatorio; no se debe intentar reiniciar esa conexión para arreglar una escena.

La documentación/código público de [RAMSES](https://github.com/bmwcarit/ramses) ayuda a identificar las funciones exportadas y el modelo escena/display. El [cliente Wayland IVI público](https://github.com/bmwcarit/ramses/blob/master/src/renderer/internal/Platform/Wayland/IVI/Window_Wayland_IVI.cpp) recibe cambios de tamaño mediante el listener de superficie. Es una referencia de implementación; **no sustituye la ABI 27.0 del i4**, ni demuestra el comportamiento de todas sus extensiones.

## Contraste con la captura real guardada

Archivo privado `trial-map59-late.txt`, superficie propia `1296125955`:

- NavigationBasic anunció contenido y tamaño 1038 × 468; `frames=0`, formato `R_8`.
- Capa nativa `1296125955`: `visibility=0`, tamaño 0 × 0, rectángulos a cero, no incluida en screen 4.
- La misma superficie aparece también en la capa añadida `1296126209`, visible, con el rectángulo del panel izquierdo.
- La imagen BMW no llegó. El cockpit permaneció igual según la comprobación del usuario del ensayo anterior.

**Hipótesis prioritaria:** la combinación de capa nativa sin configurar y transacción de renderizado pendiente impide completar el arranque de esta salida. Un contador de cero cuadros no permite distinguirlo todavía de un fallo RAMSES/EGL o de recursos de la escena. El siguiente ensayo debe observar ambas etapas y cambiar solo la composición de la capa propia.

## Herramienta preparada y verificación local

`tools/map-runtime/Diagnosticar-Escena-Mapa.js` lee una instantánea de `ivi-control scene` y emite un informe sin nombres de procesos, rutas ni información de ubicación. Con `--plan` prepara la secuencia de un ensayo nuevo. **No ejecuta comandos, no abre SSH y no envía SOME/IP.** Rechaza IDs ocupados y capturas concatenadas; usa el mismo ID para capa y superficie, exige un handle recién creado y conserva liberación/restauración como parte de la secuencia.

```powershell
node tools/map-runtime/Diagnosticar-Escena-Mapa.js 'RUTA_PRIVADA\escena.txt' 1296125955
node tools/map-runtime/Diagnosticar-Escena-Mapa.js 'RUTA_PRIVADA\escena-antes.txt' 1296125960 --plan 1112364801
node --test emulator/split/map-probe-plan.test.js
```

Se ejecutó además sobre `trial-map59-late.txt`: reprodujo cero cuadros, capa nativa oculta/sin tamaño y doble pertenencia. Sobre `trial-cleanup-final.txt` generó un plan de IDs nuevos sin ejecutar ninguna operación. Los números del ejemplo no están reservados para una sesión futura: hay que capturar de nuevo el estado antes de reutilizarlos.

## Preparación del ejecutor antes del ensayo del 14-11

Se ha añadido una prueba ejecutable **fuera de la app y del paquete Store**:

- `tools/map-runtime/map-own-instance.cpp`: cliente SOME/IP de las interfaces FA94 v30.11 y FA95 v5.2. Crea una instancia propia, guarda su handle antes de anunciarla, espera `SHOW`, solicita tema 1000/seguimiento del coche/visibilidad 67 únicamente sobre ese handle y finalmente lo libera. No inicia ni modifica guiado. Correlaciona cada respuesta por servicio, método, client y session; no interpreta un timeout como éxito ni repite el setter de visibilidad.
- `tools/map-runtime/Ensayar-Mapa-Propio.js`: ejecutor manual compatible con Node 8. Captura la escena inicial; rechaza IDs existentes; verifica productor NavigationBasic y pertenencia exclusiva; configura la capa nativa y la añade a **screen 4**, sin reescribir el orden completo. Observa contadores durante unos 20 s y conserva las capturas de estado en un directorio privado temporal. El contador positivo se sigue etiquetando como pendiente de confirmación visual.
- El helper tiene un límite monotónico de 45 s para la sesión, más el cierre RPC. El supervisor independiente inicia recuperación a los 55 s; la limpieza se serializa con un archivo de bloqueo. Solo libera el handle registrado y retira los IDs nuevos del ensayo. Si aparecen objetos ajenos, otra pantalla o un productor distinto, aborta su eliminación. Los registros caducan a los cinco minutos para evitar reutilizar handles antiguos.
- `Compilar-Sonda-Mapa.ps1` genera el ELF y un manifiesto de compilación en `dist/map-manual`, ignorado por Git. No copia las bibliotecas propietarias ni instala nada.

Verificación hecha en el PC:

```powershell
./tools/map-runtime/Compilar-Sonda-Mapa.ps1 -MguFiles D:/Usuarios/javie/BMW/MGU21-20261113-mapas-video/files
node --test emulator/split/map-probe-plan.test.js emulator/split/map-manual-runner.test.js
& "$env:TEMP/bmwlauncher-node-v8.16.2/node.exe" --check tools/map-runtime/Ensayar-Mapa-Propio.js
& "$env:TEMP/bmwlauncher-node-v8.16.2/node.exe" -e "require('./tools/map-runtime/Ensayar-Mapa-Propio'); require('./tools/map-runtime/Diagnosticar-Escena-Mapa')"
```

**7 pruebas pasan**: diagnóstico de cero cuadros, ID ocupado, productor/pertenencia, aislamiento de comandos y rechazo de retirar objetos compartidos o de otra pantalla. Ambos módulos cargan con Node 8.16.2. El nativo compila con Clang 19.0.1, C++14 y `-Wall -Wextra -Werror`; ELF64 x86-64, intérprete `/lib/ld-linux-x86-64.so.2`, dependencias vsomeip/stdC++/gcc/libc/pthread. Máximos requeridos: GLIBC 2.14 y GLIBCXX 3.4.22. **Compilado, no ejecutado en Linux ni en MGU.**

- SHA-256 del fuente nativo: `504e6aea6549f3d62c9234c32d7cad9f2aad4ef7a86c7b3bcb12b6a8b507db89`.
- SHA-256 del ELF local: `492fe2309d91cd80810c424411eb9afbf6e87c10319c98ebf602faeec81a52f6`.

Para el futuro ensayo hay que preparar una configuración **temporal** de vsomeip que permita el cliente `BMWLauncherMapProbe` bajo el UID autorizado, y copiar el ELF y ambos JS a un directorio temporal. La herramienta no prepara ni cambia políticas globales. Un comando de ejemplo, **solo tras comprobar escena/IDs/rectángulo y autorización en esa sesión**, sería:

```sh
BMWLAUNCHER_MAP_TRIAL=1 VSOMEIP_CONFIGURATION=/tmp/CONFIGURACION_PRIVADA \
node Ensayar-Mapa-Propio.js --run /tmp/RUTA_SONDA/map-own-instance 1296105480 424d574c00000008 0,0,1038,468
```

El rectángulo es un argumento deliberadamente explícito: hay que sustituirlo por la ubicación real del panel izquierdo, sin cubrir barras. Los IDs del ejemplo no están reservados; usar IDs nuevos y comprobar también la escena RAMSES, que IVI no enumera. `--cleanup /tmp/bmwlauncher-map-trial-XXXXXX` permite repetir la limpieza del registro propio reciente si el ejecutor principal se interrumpió.

Limitaciones del ejecutor: todavía falta probar el contrato runtime de vSomeIP y la limpieza real del compositor; los tests cubren planificación y validación, no sustituyen esa prueba. Un timeout de creación puede dejar una instancia cuyo handle no llegó al cliente: se conserva la evidencia y no se intenta liberarla adivinando handles. La expiración, un bloqueo nativo o una liberación sin ACK requieren revisar los archivos privados antes de repetir. No se afirma restauración comprobada, imagen ni cockpit intacto para este ensayo todavía no realizado.

## Siguiente prueba necesaria en el coche

1. Con autorización vigente, coche parado, BMWLauncher y mapa del cockpit visibles, capturar escena y procesos; reservar IDs nuevos, verificar también sceneId RAMSES y preparar limpieza independiente con límite de 45 s.
2. Crear una sola instancia y guardar su handle de respuesta. Esperar sus objetos IVI y comprobar su productor. Configurar **la capa nativa recién creada**, tamaño/rectángulos y orden de screen 4, sin crear una segunda capa ni cambiar las existentes.
3. Enviar VISIBLE 67 al handle propio, correlacionando respuesta por sesión además de servicio/método. Obtener errores/eventos de la transacción, RAMSES y EGL. No enviar más setters si queda pendiente.
4. Exigir incremento de `frames`, contenido/formato válido y captura real del panel. Si sigue a cero, recoger estado/eventos antes de concluir; no ocultarlo con un proveedor alternativo.
5. Liberar el handle, retirar solo objetos propios y verificar la escena previa y el cockpit. No detener ni borrar guiado y no reiniciar NavigationBasic/GeniviAdapter/Hmi8.

Solo tras obtener imagen y ciclo de vida comprobados procede integrar el puente de mapas en BMWLauncher. Toque, zoom, escala y colores por instancia siguen pendientes de esa validación.

## Ensayo real del 14-11-2026

El usuario confirmó coche parado, BMWLauncher y mapa del cockpit visibles. Se ejecutó la sonda manual con el motor 0.2.11 y OAP recuperado 0.2.10. No se instalaron componentes ni se cambió el guiado.

- La inspección original quedó detenida esperando `FA95:32`; se terminó únicamente ese proceso de prueba. La versión con trazas también alcanzó su límite independiente de 25 s. No habían creado instancias. La espera de `condition_variable` no expiró como se esperaba; su causa interna no está establecida.
- Las sondas usan ahora un plazo de `steady_clock`, liberando el mutex entre pausas de 10 ms. Se verificó en la unidad: el getter sin respuesta expiró y `FA95:40` devolvió 176 bytes. Se conservan correlación de respuestas, límites y limpieza. Es una herramienta manual, no una política de sondeo para producción.
- Una única creación `FA94:02` devolvió handle **5** para superficie/capa **1296105492** y escena propia **424d574c26111402**. Se comprobó ausencia del ID IVI antes; IVI no enumera escenas RAMSES y no se afirma haber inventariado todas ellas. Productor NavigationBasic y pertenencia exclusiva confirmados. Capa nativa configurada en `6,180,1525,590`, sin cubrir casita, DriveHub ni energía.
- Tema 1000 y seguimiento recibieron respuesta. VISIBLE **67** no respondió en cinco segundos. Durante veinte segundos la capa permaneció visible, sin imagen de cartografía en la captura. Por tanto, configurar su capa nativa **no resolvió el bloqueo**. No se repitió el setter ni se ensayó sobre mapas existentes.
- Los contadores IVI también son cero para superficies que sí muestran imagen, incluidas Hmi8/mgu-render. El estado `NO_FRAMES` del diagnóstico describe el contador, **no demuestra por sí solo ausencia de renderizado**. En este ensayo la conclusión se apoya en la captura real.
- Liberación `FA95:03` confirmada; retirados exclusivamente los objetos propios. El registro termina `created=true, done=true`, sin error de limpieza. Las 30 capas, 9 superficies y pantalla coinciden antes/después en todas las propiedades que analiza la herramienta. El usuario confirmó que el cockpit siguió igual. Temporales retirados después de copiar evidencias.

Compilación final: Clang 19.0.1, C++14, `-Wall -Wextra -Werror`; ELF x86-64, intérprete `/lib/ld-linux-x86-64.so.2`, máximos GLIBC 2.14 y GLIBCXX 3.4.22. SHA-256 fuente `611072e7e55003e1e887b36e863bde1918521fb634346686d484e4004bdd30ab`; ELF **`9ca384f9c601bbef5f9f50b419c325f91a879d61db51db0564863dc5337d10b4`**. Este ELF sí se ejecutó en la MGU. Las 192 pruebas del repositorio pasan; no acreditan mapa funcional.

Evidencias privadas: carpeta `MGU21-20261114-audio-mapa`, `map-evidence.tar`, `map-bounded.txt`, `map-result.txt`, capturas antes/durante y comprobación de limpieza. No se publican. Siguiente investigación: seguir la transacción de visibilidad y la asociación RAMSES/display hasta el renderer; obtener trazas del consumidor antes de otra creación. No integrar todavía esta salida en producción ni atribuir el fallo a falta de cartografía/licencia.

## Contraste local con NavController del 14-11-2026

Se extrajo NavController de `componentes-lectura.tar`, descargado previamente. SHA-256 del ELF: `f504557e86b7dbe49527008cf23ca4e7e834afb0027f2689cc22515299f7f400`. No se ha vuelto a conectar al coche para este análisis. Se conservan binarios, proyectos y pseudocódigo fuera del repositorio.

REA no tenía proveedor de decompilación nativa operativo para este objetivo. Como alternativa se usó directamente Ghidra **12.1.4**, distribución oficial `ghidra_12.1.4_PUBLIC_20260921.zip`, SHA-256 verificado `ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db`. Importación ELF x86-64, base cero, sin análisis global; decompilación enfocada y contraste con LLVM. Los tipos inferidos no equivalen a cabeceras originales y esta evidencia estática no acredita ejecución en la MGU.

Hallazgos:

- **Sesión frente a propiedad local.** `MapGeniviAdapter::createMapViewInstance`, entrada `0x25a9570`, pasa la dirección `0x34869e4` como primer argumento de datos a la llamada del proxy en `0x25a9a18`. Los cuatro bytes son cero. La llamada de renderizado descrita abajo usa la misma constante. El valor `0x424d5701` de nuestra sonda es una marca elegida por nosotros; no está justificado tratarla como una sesión creada por BMW. El registro local de propiedad y el `sessionHandle` del protocolo deben distinguirse. La creación y otros setters de la sonda sí habían respondido: esta diferencia **no prueba** que la sesión explique el bloqueo.
- **Llamada original de renderizado.** `MapGeniviAdapter::setMapViewRenderingSettings`, entrada `0x257d6e0`, convierte el modo en `0x25ce9b0` y llama al proxy en `0x257dc47`, con sesión, handle de mapa, modo y vector de UInt64. En el proxy 21.47, el RTTI de su callback enlaza con el gestor `0x29a2d0` y con la función `0x2a2500`. Esta crea el método **`0x3b`** y serializa esos cuatro argumentos. No confundir esta función con `0x29e6d0`, que corresponde al método `0x3c`; el desplazamiento de la tabla virtual del wrapper de NavController no se puede aplicar directamente al proxy concreto.
- **Modo.** El valor interno 0 se convierte en `0x43` y el 2 en `0x42`. En GeniviAdapter, `0x828f22` identifica `0x43` como VISIBLE y `0x42` como INITIALIZATION; `0x828e46` los convierte respectivamente en frecuencia -1/modo 2 y frecuencia 0,2/modo 2. Los valores `0x44/0x45` son INVISIBLE/FROZEN. No hace falta inventar un valor de FPS. Falta reconstruir qué secuencia de inicialización y qué vector envía el controlador para una salida nueva antes de usar esta llamada en otro ensayo.
- **Creación no equivale a mapa listo.** El callback `0x23e9c00` guarda el handle recibido y continúa por `0x23e8510`, donde registra observadores. Todavía no se ha reconstruido toda la secuencia posterior, ni se ha demostrado que sustituir visibilidad por render settings resuelva la transacción pendiente.

Las consultas DLT de solo lectura no aportaron eventos: el receptor TCP local rechazó la conexión y el cliente de control Unix no respondió dentro del límite externo; se terminó solo ese cliente de prueba. No se cambió configuración ni nivel de registro. No interpretar ausencia de trazas como ausencia de errores.

**Siguiente paso:** completar el contrato del controlador y preparar una variante manual con sesión y modo explícitos, conservando registro propio, IDs nuevos, plazos y retirada. Para su validación real hará falta ENET de nuevo, con el coche parado y ambas vistas visibles. No actuar sobre handles, escenas o superficies del cockpit, ni reiniciar conexiones RAMSES compartidas. No hay un ensayo activo que requiera mantener el cable conectado.

## Ensayos con sesion cero y aislamiento del pantallazo

El usuario volvió a autorizar ENET/SSH y confirmó coche parado y ambas vistas abiertas. Se realizaron estos ensayos nuevos del 14-11-2026:

| Ensayo | Resultado |
| --- | --- |
| Sesión 0 + `FA94:3B`, modo VISIBLE y vector vacío | Handle 5 propio; tema y seguimiento responden. Render settings sin respuesta en 5 s; captura central sin cartografía. Liberación confirmada. |
| Añadir nivel de rendimiento por instancia | Handle 6 propio; `FA95:33` con `0x53` responde. Render settings sigue sin respuesta; captura central sin cartografía. Liberación confirmada. |
| Captura central aislada, sin crear mapa | Primera observación inconcluyente; repetición coordinada: el usuario no ve pantallazo. |
| Crear y retirar sin componer ni activar dibujo | Primera observación inconcluyente; repetición coordinada: no aparece pantallazo. Solo RPC de creación/liberación. |
| Componer la capa vacía con opacidad 1, sin activar dibujo | El usuario confirma pantallazo. Solo RPC de creación/liberación; no se toma captura durante el ensayo. |
| Misma composición con opacidad 0 | El usuario confirma ausencia de pantallazo. |
| Activación completa manteniendo opacidad 0 y captura de la superficie propia | Handle 11; nivel/tema/seguimiento responden, render settings no. Captura directa correcta: 485.784 píxeles, todos RGBA `(0,0,0,255)`. No contiene mapa. Liberación confirmada. |

La comparación descarta la captura o la creación aisladas como reproducción del destello en estos escenarios. Localiza la reproducción en la fase de composición opaca, pero **no identifica todavía qué operación interna de Winston produce el negro breve**. `ivi-control` en `0x60d0` añade una capa mediante la petición de pantalla 2; la instantánea durante el ensayo conserva el orden previo y añade solo nuestro ID. No se ha demostrado un borrado del orden completo. La protección consiste en no exponer una superficie sin contenido, no en dar por reparado Winston.

El nivel se contrastó con el código original: el callback de creación lleva a `MapInstance` en `0x23e8510`; su interfaz secundaria invoca el thunk `0x2594f30` y `MapGeniviAdapter::setMapViewPerformanceLevel` en `0x25948f0`. El conversor `0x25cff90` traduce nivel 4 a `0x53`. En el proxy, `0x429f50` crea el método `FA95:33`. La prueba confirma su aceptación, **no una mejora de rendimiento medida**.

El decompilado del job extendido, `GeniviAdapter:0xeadc12`, solicita el cambio de frecuencia y la confirmación de la transacción por callbacks independientes. El vector opcional vacío no evita ejecutar esas dos operaciones. El callback `0xead95e` informa de transacción finalizada/no finalizada y pasa a la finalización del job; no se han observado esos callbacks en runtime. Pendiente seguir el consumidor en NavigationBasic/RAMSES y su producción de imagen, en lugar de acumular setters o volver a ajustar el compositor.

Cambios en las herramientas manuales:

- Marcador local de registro `0x424d5702`, separado de la sesión wire 0; se rechaza el registro de revisión anterior para no liberar un handle con una sesión diferente por error.
- El plan usa `FA94:3B` y nivel por instancia, conserva IDs nuevos y no nombra escenas del cockpit en su vector.
- `--create-only` no configura el compositor ni envía `SHOW`. `--compose-only` configura exclusivamente los objetos propios, sin `SHOW`. El modo `--run` activa además el dibujo. Todos mantienen supervisión y retirada.
- La capa propia queda ahora con opacidad **0** en los ensayos. Una captura de la pantalla central ya no sirve para decidir si ese mapa oculto se ha generado: se necesita capturar su superficie y validar contenido. No se hace visible automáticamente por un ACK o por el contador IVI.

Nativo final: Clang 19.0.1/C++14, `-Wall -Wextra -Werror`; ELF x86-64, intérprete `/lib/ld-linux-x86-64.so.2`, máximos GLIBC 2.14 y GLIBCXX 3.4.22. Fuente SHA-256 `2390be561c094a1686ae8d67f87515b9c0253705752fb9e44065249dda665b41`; ELF **`b666f2e4c57cc4562e7c825ec1d06a5ddbde56a8af2081aaeedec5c0932f692f`**. Compilado y ejecutado en la MGU. La variante anterior con sesión cero y sin nivel tiene SHA `2b01061e64227d1f7d772d858666613c0ce22de23524aa37cc07b6c79997642e`. Las 192 pruebas locales pasan y las herramientas JS conservan Node 8.16.2.

Evidencia privada: `session0-evidence.tar`, `performance-evidence.tar`, `isolation-evidence.tar`, `capture-only-evidence.tar`, `hidden-evidence.tar` y `hidden-render-surface.png`, junto a las respuestas del usuario. Todos los handles se liberaron con ACK. La comparación de estado tras los ensayos conserva las capas/superficies originales; el usuario confirmó cockpit intacto. Sin instalación, reinicio ni publicación; SSH permanece abierto.

### Seguimiento de la confirmación en NavigationBasic

Análisis local posterior sobre el mismo ELF, con Ghidra 12.1.4 y contraste LLVM. El pseudocódigo infiere tipos; en particular, se contrastaron en ensamblador los argumentos flotantes que el análisis sin firmas no reconstruye correctamente. No se ha instrumentado ni detenido NavigationBasic.

- `0xe538bc` (`requestSetMaximumFramerate`) encola `CCmdSetMaximumFramerate`, construido en `0x12636e6`. Su método de ejecución `0x126366c` busca la vista por **sesión de canvas interna**; si no la obtiene, retorna sin ejecutar el cambio. Si la obtiene, llega a `0x127f586` y a la transición de visibilidad `0x127f2ec`. Esta sesión interna no es el cero del argumento GENIVI ni el marcador local de propiedad: no sustituir ninguno de ellos por un número adivinado.
- `0xe23f22` confirma de inmediato una transacción vacía; una con órdenes se envía a ejecución mediante `0xe5898c`. La respuesta extendida pasa por `0xe2b690`, que comprueba visibilidad del servicio y tiene una rama de fallo si no está visible. Esa comprobación es de servicio, no demuestra que dependa de la opacidad de la capa IVI.
- `0x15cec2e` crea una escena RAMSES con el identificador del destino antes de construir la salida. El constructor `0x15ce614` publica la escena, crea display, la asocia y solicita estado 3. El paso de actualización `0x15cf09a` hace otro `Scene::flush` cuando sus componentes comunican cambios. No confundir haber llegado a la creación de la superficie con haber recorrido esa actualización y recibido su confirmación.

Estas rutas ofrecen puntos concretos para una traza futura: resolución de la sesión de canvas, respuesta de frecuencia, ejecución/confirmación de transacción y actualización RAMSES. **Ninguna de esas ramas de fallo se ha observado todavía en el coche.** La captura negra describe el resultado obtenido con la capa oculta; no permite por sí sola localizar qué etapa del motor dejó de producir o entregar contenido. No añadir más órdenes ni integrar el puente basándose solo en estas hipótesis.

Comprobación final de retirada: `final-map-after.txt` coincide con `resume-read.txt` en todas las propiedades de `parseScene` (30 capas, 9 superficies). Tras verificar los archivos de evidencia, se eliminaron únicamente los diez directorios propios restantes de estas pruebas; `cleanup-isolation-hidden.txt` confirma la retirada. Los permisos y la configuración de SSH se conservan.

### Estado interno observado en la MGU

Continuación autorizada del 14-11-2026, antes de que el usuario desconectase ENET. Cinco ensayos adicionales con el mismo ELF de sonda y opacidad 0. No se instaló código ni se modificó una instancia original. Se inspeccionó memoria **solo mediante lectura**, sin detener los procesos. Son instantáneas no atómicas; las búsquedas están acotadas y no equivalen a un volcado completo ni a una traza de todos los callbacks.

| Comprobación | Resultado |
| --- | --- |
| Registro del servicio | La sesión propia aparece en el servidor de canvas de NavigationBasic y apunta a una vista del motor con el mismo identificador interno. |
| Tamaño/activación | Viewport `[0,0,1038,468]`, visibilidad interna 0 (VISIBLE), frecuencia configurada 30 fps; confirmación de frecuencia pendiente. La existencia de estos campos no prueba presentación de cuadros. |
| Estado de carga | Propia: 1, `DLS_LOADING_CURRENT_VIEW`; originales observadas: 4. No es un nivel de calidad ni un modo de visibilidad. |
| Recursos | Los indicadores de disponibilidad leídos, incluidos los requisitos anidados en `CResourceStorage + 0x1038`, coinciden con los originales. No se ejecutaron todas las funciones de disponibilidad: no afirmar que todos los recursos estén completos. |
| Colector de carga | La categoría 1 no registra disponibilidad en nuestra vista y la categoría 2 conserva estado 0; las originales tienen disponibilidad/estado 4. El visitor de categoría 1 consulta `CTerrainModelSurface`. Su ausencia no prueba por sí sola que falte el mapa base: hay que contrastar las funciones habilitadas y la categoría 2. |
| Respuesta extendida | Los objetos de job inspeccionados conservan dos respuestas pendientes: frecuencia y transacción. También se localizan objetos de ensayos anteriores; no se ha comprobado si siguen vivos para el asignador, por lo que no se declara una fuga. |
| Retirada | Los cinco runners concluyen con código 0 después de retirar sus propios objetos. Sin captura nueva ni confirmación visual adicional del cockpit en esta serie. |

Puntos del ELF NavigationBasic usados para interpretar las lecturas (misma revisión y hash anteriores):

- `MapViewerInterface`: vtable secundaria `0x25aa420`, desplazamiento de base `0x380`; vector de sesiones en `+0x108/+0x110`. `MapCanvasSessionServer` obtiene el ID interno en `0xe4bc20`. La búsqueda de vista pasa por `0x12744c4`/`0x1273f32`.
- `CMapView`: tipo `+0x30`, visibilidad **`+0x5c`**, frecuencia `+0x64`, solicitud pendiente `+0x68`, estado de carga **`+0x6c`**, copia previa `+0x70`, viewport `+0x250..+0x25c`. Las primeras salidas privadas de los inspectores usaban los rótulos provisionales `visibility` para `+0x30` y `requestedQuality` para `+0x70`: fueron corregidos; no reutilizar esos nombres como semántica del firmware.
- `0x12839ac` actualiza la vista. `0x12b58b8` calcula disponibilidad de recursos. Los requisitos anidados se comprueban en `0x1298e02`, `0x129a5ba` y `0x129a450`; los punteros opcionales nulos no son un error si sus indicadores de necesidad están apagados.
- `0x127c0c0` consulta el colector en `CMapView + 0x158`; `0x12f7aba` agrega los estados de proveedores, y `0x12f739a` los clasifica por categoría. `0x127bf92` puede mantener la carga en estado 1 por movimiento pendiente. En la última muestra el modo es 2 y no hay objetivo de desplazamiento en el objeto observado; no se ha demostrado que sea esa rama la que bloquee.

Evidencia privada: `observed-map-trial.txt`, `viewport-map-trial.txt`, `readiness-map-trial.txt`, `resources-map-trial.txt` y `loading-map-trial.txt`. Los inspectores leen un máximo de 8 MiB para jobs y 64 MiB para el registro; el segundo escaneo es parcial, no contiene todo el heap. En estas muestras tardaron aproximadamente 36 ms y 150 ms respectivamente; son tiempos de diagnóstico, **no medidas del rendimiento de BMWLauncher**.

Al desconectar, la copia adicional de los `state.json`/`rpc.log` completos falló con SSH 255. Las carpetas propias `bmwlauncher-map-probe-20261114-08` a `-12` y sus cinco directorios de resultados pueden permanecer en `/tmp`; la lista exacta está en `read-only-trial-dirs.json` de la carpeta privada. Recoger y comprobar esos archivos antes de retirarlos, sin tocar otras carpetas. Se conservan los resultados ya descargados y los cinco cierres correctos del runner. SSH no se ha cerrado ni reconfigurado.

Siguiente paso local: contrastar la inicialización del contenido y sus proveedores con NavController/GeniviAdapter. `createCoreContent` no debe asumirse como mapa general: los tipos observados incluyen contenidos especializados (CTT, SAPA, señales, país, POI y autopista). No añadir setters o contenidos al ensayo solo por sus nombres. La próxima prueba conectada deberá observar qué proveedor pasa a preparado y capturar cartografía en la superficie propia antes de hacerla visible.

Contraste posterior sin ENET: `GeniviAdapter:0x817174` omite un cambio de tema si coincide con el almacenado; `0x816f72` resuelve el tema a un estilo del motor. La base de la sesión se inicializa con tema 0 en `0x84f706`, por lo que **no hay fundamento para afirmar que pedir tema 1000 se esté omitiendo por defecto**. La creación extendida `0x100b336` configura viewport/escala y habilita dos categorías de objetos internas (20000 y 2010). No se presupone que sean la cartografía completa. En NavigationBasic, `0x127f0f2` filtra la creación de proveedores mediante `CFeatureState::isSurfaceEnabled` (`0x130f242`). Leer la lista de nodos, sus tipos y funciones habilitadas en una futura instancia propia permitirá distinguir contenido no habilitado de contenido habilitado pero pendiente. No se ha aplicado una corrección de producción basada en estas hipótesis.

### Corrección candidata local: habilitar los objetos cartográficos

El análisis del mismo firmware encuentra una omisión concreta en la sonda: nunca enviaba `setMapViewObjectVisibility`. Crear la salida y seleccionar tema no sustituye esa orden. Se ha preparado **solo en la sonda manual**, pendiente de imagen real; no se declara resuelta la carga ni se integra todavía en Store.

Trazabilidad con Ghidra 12.1.4 y contraste LLVM/bytes, sobre los hashes documentados:

- NavController `0x25a24a0` convierte los elementos de dibujo y llama al proxy con sesión 0 y el handle de vista. El wrapper `0x25bcc20` reenvía a la ranura `0x260` de `MapViewerControlSomeIPProxy`; `0x43f610` de la biblioteca proxy crea **FA95:20**. No confundir las ranuras del wrapper con las de la implementación SOME/IP.
- Ese proxy serializa sesión y handle UInt32, después un diccionario con longitud de **bytes** UInt32. Cada entrada contiene enum UInt32 y bool de un byte, sin padding. La variante de prueba habilita únicamente el objeto **15**: payload de 17 bytes, longitud del diccionario 5. El helper y la regresión compilada están en `map-base-content.h`/`map-base-content.test.cpp`.
- GeniviAdapter `0x902452` actualiza la visibilidad **de esa sesión**, separa altas y bajas y llama a `0x65e62e` para habilitar. `0x829e7a` convierte objeto 15 en grupos internos **11000, 11001, 11002, 100001, 100000 y 100002**. No se añade ningún ID de otra escena ni se modifica una ruta.
- NavigationBasic `0x130d027` traduce esos grupos a funciones del mapa. Entre ellas están la función **0** (grupo 11000) y **41** (grupo 11002). `0x130f242` permite crear la superficie de categoría 1 si está habilitada 0, 79 o 41; la categoría 2 consulta su propia lista, que también contiene 0 y 41. `0x127f0f2` usa esa decisión al instanciar proveedores. Los únicos grupos que habilitaba la creación extendida (20000 y 2010) corresponden a funciones **94 y 8**, no a esas funciones del mapa base.

Esto conecta la orden ausente con los proveedores que faltaban en la observación, pero **aún no mide los flags finales ni demuestra que sea el único bloqueo**: otras órdenes/estilos pueden modificar estado. La siguiente prueba debe contrastar carga, proveedores y píxeles, no solo el ACK.

La secuencia nueva es crear → componer transparente → rendimiento → tema → objeto 15 visible → seguimiento → render settings → observar → liberar. Si falla la configuración, no se activa el dibujo y la sonda sale con código 7 tras liberar su handle; el runner propaga el fallo sin confundir retirada correcta con ensayo correcto. El estado final conserva `nativeExitCode`.

Preparación local:

```powershell
& tools/map-runtime/Compilar-Sonda-Mapa.ps1 -MguFiles 'RUTA_PRIVADA_MGU/files' -Output 'dist/map-manual-base-content'
node --test emulator/split/map-probe-plan.test.js emulator/split/map-manual-runner.test.js
```

El directorio contiene ELF, scripts Node 8, informe ELF y hashes. Compilación con `-Wall -Wextra -Werror` y regresión de serialización comprobadas en el PC; **no ejecutado en Linux/MGU**. No hay WSL disponible en este PC. No incorpora bibliotecas ni firmware BMW.

ELF final de esta variante: **`62ef402db58c5a68b41165c6a835f4e5e452c602e2ca836fb9c767e20e0c8437`**. Comprobados arquitectura x86-64, intérprete `/lib/ld-linux-x86-64.so.2`, GLIBC máximo 2.14 y GLIBCXX 3.4.22. Los ocho casos de diagnóstico/propiedad/plan pasan; los dos scripts se cargan con Node 8.16.2. El hash de la fuente y del helper de serialización queda en `build.json`.

Próxima sesión ENET, con autorización vigente y ambas vistas abiertas:

1. Recoger primero los resultados pendientes en `/tmp`, sin crear mapas para ello. Reservar IDs nuevos y confirmar escena/pantalla de referencia.
2. Ejecutar `--run` con este ELF, conservando opacidad 0. Recoger `base_content`, respuesta de rendering, estado de carga y captura de **su superficie**. Nunca revelar por ACK o contador IVI.
3. Si hace falta comparar, `--run-baseline` usa el mismo ELF y omite únicamente el objeto 15 mediante `SHOW_BASELINE`, siempre en otra instancia nueva. `--create-only` y `--compose-only` siguen sin enviar ninguna activación.
4. Exigir cartografía reconocible en la captura y confirmar que el mapa del cockpit sigue igual antes de preparar una presentación visible. Si continúa negro, comprobar las funciones 0/41, proveedores y actualización RAMSES; no acumular reintentos del setter pendiente.

La reversión del experimento es `--run-baseline`; ambos modos liberan solo su handle y retiran únicamente sus objetos. Ninguna instalación, reinicio, conexión al coche ni publicación durante este trabajo local.
