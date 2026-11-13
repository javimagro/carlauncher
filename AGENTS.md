# BMWLauncher · instrucciones de desarrollo

## Antes de modificar código

- Lee [ARQUITECTURA.md](ARQUITECTURA.md), las entradas relacionadas de [BITACORA.md](BITACORA.md) y, para rendimiento, [AUDITORIA-RUNTIME.md](AUDITORIA-RUNTIME.md).
- Para mapa, destinos o guiado, lee [NAVEGACION-MGU21.md](NAVEGACION-MGU21.md). Conserva la separación entre cartografía alternativa y cálculo BMW; no llames «mapa BMW» a teselas de otra fuente.
- El código local y sus manifiestos son la fuente de verdad. Comprueba `git status` y conserva los cambios previos. No uses limpiezas destructivas ni incluyas adjuntos del usuario en commits.
- Trabaja desde este proyecto Windows; usa PowerShell o un intérprete explícito. Las rutas de las referencias están en `README.md`. BMWLauncher Android y DriveHub son referencias de solo lectura.
- Reproduce el síntoma y sigue el dato o evento hasta sus consumidores antes de corregirlo. Separa causa demostrada, hipótesis y comprobación pendiente. Una prueba del simulador no demuestra que funcione en el coche.

## Lenguaje según responsabilidad y medición

| Parte | Implementación preferida | Cuándo usar otra |
| --- | --- | --- |
| RHMI/OAP, ciclo de vida, foco, tarjetas, telemetría, unidades, configuración y red | JavaScript compatible con Node.js 8.16.2; XML/JSON RHMI | No migrar lógica de producto por intuición. Aislar primero el trabajo que bloquea y medirlo. |
| Dibujo de paneles | JS emite órdenes a `mgu-render`; el compositor C/EGL/GLES ejecuta el dibujo | Usar GPU para composición. Un motor propio solo con necesidad demostrada y comparación equivalente. |
| Vídeo, conversión de píxeles y audio continuo | FFmpeg en proceso nativo; C para ALSA/API C; C++ cuando la biblioteca o ABI lo exija | VA-API/Media SDK solo tras verificar dispositivo, permisos, perfil, formato y coste de transferencia en MGU21. Mantener una ruta compatible. |
| Presentación de vídeo y coordinación multimedia | Proceso auxiliar separado de la interfaz, reloj monotónico, colas acotadas | Pasar el transporte a C/C++ si el perfil de MGU demuestra que el auxiliar JS no cumple; conservar el protocolo compartido. |
| Fotografías | Cola de un trabajo activo y auxiliar aislado; reutilizar decodificadores existentes | Biblioteca nativa si la medición justifica coste/latencia. No ejecutar JPEG ni bucles de píxeles en el hilo de interacción. |
| Interposición de FrontCCU | C++ con ABI CommonAPI/vSomeIP verificada; JS gobierna el permiso temporal | No copiar estructuras de otra revisión del firmware sin validar tamaños, símbolos y consumidor. |
| Pruebas, recursos y compilación | Node moderno en herramientas, Python para recursos, PowerShell para Windows; compilación cruzada para Linux | Node moderno es para el PC, no cambia el requisito del código instalado. |

- No añadas otro lenguaje, runtime, dependencia o motor por preferencia personal. La elección debe resolver una restricción concreta o una mejora medida.
- Node 8 no dispone de `worker_threads`, `fetch`, `AbortController`, `fs.promises`, optional chaining ni `Promise.allSettled`. No introducir esas API en archivos instalados. Se permiten en herramientas del PC con requisito explícito.
- Evita addons ligados al ABI de Node si basta un proceso auxiliar con entrada/salida acotada.
- No actualices dependencias de producción ni el renderer fuera del alcance necesario. Conserva licencias y procedencia de arte, fuentes y binarios.

## Límites de diseño

- Estado/interacción: `drivehub-state.js`; vistas: `drivehub-view.js`; sesión: `drivehub-session.js`; normalización del coche: `vehicle-readings.js`. No duplicar escalas entre tarjeta, diagnóstico y cockpit.
- El servicio coordina capacidades, entrada y visibilidad. La reproducción continua reside en `tdt-worker.js`; las imágenes se procesan con `photo-loader.js`/`photo-worker.js`. No reenviar fotogramas como JSON/base64: usar la memoria compartida del renderer.
- Cada proceso, temporizador, socket, suscripción y petición tiene propietario y cierre. Cancelar al ocultar, perder la capa o cerrar. Ignorar respuestas de generaciones antiguas **antes** del trabajo costoso.
- Acota descargas, colas, tiempo, concurrencia y memoria. No lanzar una descarga/decodificación por cada tick o foco sin descartar las anteriores. Verifica tamaños antes de reservar memoria.
- Evita E/S síncrona reiterada en callbacks de entrada/dibujo. Descubre instalaciones asíncronamente, cachea con caducidad y vuelve a comprobar tras actualización o reinicio.
- Separa políticas y transporte en módulos cohesionados. No disperses excepciones de proveedores por la vista. Extrae responsabilidades cuando simplifique el estado; evita abstracciones de paso y refactorizaciones ajenas al fallo.
- El primer fotograma no debe esperar a red, EPG, fanart, reproducción ni herramientas opcionales. Carga lo que pertenece a una tarjeta cuando vaya a usarse.

## Contrato del mando

- Recibir FrontCCU en OAP no consume la copia de Hmi8. La exclusividad necesita el filtro **instalado y cargado**. Declara su dependencia en la app y verifica el grafo del paquete.
- Mantén el permiso con una tarea ligera, independiente de escaneos y consultas lentas. Exige contexto reciente, retorno válido, entrada OAP y capa visible con toque.
- Conserva el vencimiento de 700 ms en el filtro y la retirada ante ocultación/cámara/desconexión/error. No prolongues indefinidamente la captura para esconder un bloqueo de JS.
- No bloquear todo SOME/IP ni modificar mensajes fuera del consumidor Hmi8. Solo filtrar servicio, instancia, eventos y tamaños verificados.
- Conserva la salida táctil por la casita. Si no hay retorno fiable, cede el mando a iDrive y explica el motivo en diagnóstico.
- Probar giro, pulsación, inclinación corta/larga en cuatro direcciones, botones físicos, casita y recuperación tras fallo. El emulador valida nuestra lógica; la exclusividad real requiere Hmi8.

## Contrato multimedia

- Separa recepción, decodificación, cola, presentación y dispositivo de audio. Mide cada etapa antes de aumentar búferes, tiempos o reintentos.
- Usa tiempo monotónico para presentación. No uses el temporizador de dibujo como reloj del PCM. Define recuperación de retrasos y descartes y comprueba sincronía A/V.
- Un fallo de audio nunca debe detener el drenaje de FFmpeg ni reiniciar vídeo. Reintenta el auxiliar de audio de forma limitada; cierra procesos antiguos y cancela los reintentos al salir.
- No llames «sonido funcionando» a PCM producido, ALSA abierto, una prueba con `null` o una confirmación SmartX. Distingue esas etapas de sonido realmente oído en el i4.
- Registra contadores acotados: cuadros decodificados/presentados/descartados, cola, vaciados, hueco máximo, reconexiones y código PCM. No registres URL con credenciales ni tokens del proxy.
- Respeta MGVF: escribe píxeles, después ranura y finalmente secuencia. Libera anillos y procesos al retunar/cerrar; conserva el último fotograma durante la reconexión.
- No asumas que `plug:smartx` concede foco o conecta una fuente. Investiga arbitraje y ruta antes de cambiarlos. No uses canales de avisos, llamadas o seguridad para hacer sonar TDT.

## Datos e interfaz

- Mantén estilo BMW, día/noche y referencia Carlinkit. Trayecto muestra sus seis indicadores; el diagnóstico no se vuelca entero a la tarjeta.
- Usa datos reales solo para fuentes y conversiones validadas. Caducidad y «sin dato» son estados propios; no rellenarlos con demos o cero. Las previsiones de ruta siguen siendo demostración hasta validar su fuente.
- En navegación activa, las previsiones de energía sin fuente validada son guiones. Distancia y duración BMW llevan estructuras/unidades. Conserva los bytes de NaviContainer en los destinos y favoritos. Buscar/calcular no autoriza iniciar guiado; ocultar no autoriza detenerlo ni borrar una sesión activa. No uses la ABI de otro firmware para crear un mapa original.
- Para Radio, lee [RADIO-MGU21.md](RADIO-MGU21.md). Usa el sintonizador FM/DAB y los identificadores anunciados por BMW; no sustituyas radio por IP. No conviertas calidad RF ni el espectro decorativo en una medición de audio. Ocultar la tarjeta no detiene la fuente original.
- En cambios visuales, aplica `ui-ux-pro-max` e `impeccable` cuando correspondan y verifica capturas. Conserva los cambios locales del usuario, incluido el centrado del testigo HV.

## Verificación y medición

1. Guarda una referencia antes del cambio: escenario, versión, plataforma y runtime. Mide arranque frío/caliente, primer fotograma, entrada→fotograma, p50/p95/máximo, retraso del bucle y memoria cuando corresponda.
2. Corrige la causa y añade regresiones de comportamiento para fallos relevantes: cancelación, reconexión, pérdida de foco y respuestas tardías.
3. Ejecuta `node --test emulator/split/*.test.js`. Comprueba sintaxis y carga con Node 8.16.2 de los módulos instalados modificados.
4. Imágenes/arranque: `node tools/Medir-Rendimiento.js RUTA_JPEG_LOCAL`. Compara en la misma máquina/runtime. El auxiliar puede tardar más en completar una imagen y mantener la interfaz más fluida: informa ambas medidas.
5. Vídeo: `node tools/Probar-Reproduccion.js RUTA_FFMPEG`. `--inline` al final permite comparar el bloqueo en el hilo de interfaz. No confundas este receptor PCM con altavoces.
6. Si cambia un nativo, compila con avisos como errores y comprueba ELF x86-64, intérprete `/lib/ld-linux-x86-64.so.2`, dependencias y GLIBC/GLIBCXX. Registra fuente, herramienta y hash. Ejecuta pruebas Linux cuando esté disponible; marca si solo se compiló.
7. Comprueba auxiliares en `component.json`, enlace OAP y dependencias Store. No cambies IDs/UUID existentes.
8. Repite el mismo escenario tras el cambio. No presentes tiempo de PC como tiempo MGU ni una estimación como mejora medida. No repitas pruebas sin cambios o dudas nuevas.

## Investigación y entrega

- Parte de interfaces y protocolos públicos; consulta repositorios primarios y anota revisión/archivo. Usa `reverse-engineer-anything` para binarios. Si falta un proveedor, documenta la limitación y usa desensamblado/herramientas locales sin llamarlo pseudocódigo decompilado.
- Referencias: [mgu-render y vídeo](https://github.com/robertnisipeanu/mgu-store/blob/main/native/mgu-render/PROTOCOL.md), [publicación y preloads](https://github.com/robertnisipeanu/mgu-store/blob/main/docs/PUBLISHING.md), [filtro FrontCCU](https://github.com/cauliflowermossgrape/idrive7-apps/blob/main/kit/renderd/inputgate/mgu-inputgate.cpp), [apps ID8 de IterioDev](https://github.com/IterioDev/car-apps), [SmartX de Intel](https://github.com/intel/AVB-AudioModules/blob/master/private/src/alsa_smartx_plugin/IasAlsaSmartXConnector.cpp). Evidencia y límites en [AUDITORIA-RUNTIME.md](AUDITORIA-RUNTIME.md).
- Actualiza BITACORA con síntoma, reproducción, causa, corrección, comandos/resultados y pendientes. Actualiza ARQUITECTURA cuando cambie una decisión. No acumules históricos en este AGENTS.
- Desarrolla y valida en local. Reflashear la MGU queda fuera del alcance. Para conectar, SSH, instalar, reiniciar o escribir en la unidad hace falta autorización explícita vigente. No la deduzcas del permiso para investigar en local.
- No copies al repositorio SDK propietario, firmware, VIN, claves, registros privados o credenciales. Las extracciones permanecen fuera del árbol publicable.
- Entrega qué cambió, por qué, qué se verificó, qué sigue pendiente y si está local o publicado. Antes de publicar, incluye módulos/binarios finales, dependencias y comprobaciones; verifica etiqueta y artefacto. No anuncies una actualización sin comprobar su publicación.
