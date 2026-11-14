# Mapa BMW: análisis del ensayo sin fotogramas

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

## Ejecutor manual preparado, sin ejecutar en la MGU

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
