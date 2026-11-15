# Puente de formato MAIN de Android Auto

Candidato local `javi-aa-format/1.0.0`, protocolo3. Interpone la fábrica original, conserva su resultado y observa exclusivamente el display MAIN que pide `aapd`. El cliente root puede solicitar dos perfiles de márgenes y restaurar los márgenes iniciales observados. No expone llamadas arbitrarias ni configuración de IC/cockpit.

Otra adquisición en la misma sesión requiere restauración limpia, conexión nueva y REARM explícito de la observación exacta. La [reentrada por convergencia](REENTRY.md) está comprobada en modelo; la prueba física conjunta sigue pendiente.

## Compilación y procedencia

Código propio MIT; [bridge-abi.h](bridge-abi.h) contiene únicamente declaraciones y offsets derivados para un perfil comprobado. No se incluyen SDK, firmware ni trazas privadas. SHA-256 reutiliza `../aa-runtime/aa-sha256.c`. Los encabezados del sysroot/NDK se usan al compilar y no se copian al paquete.

```powershell
.\tools\aa-format-runtime\Build-AaFormat.ps1 `
  -Ndk C:\toolchains\android-ndk-r28c `
  -GnuSysroot C:\toolchains\glibc-2.27 `
  -Zig C:\toolchains\zig\zig.exe `
  -EnableWrites
```

Las rutas son parámetros de herramientas ya instaladas. El script no descarga dependencias. Sin `-EnableWrites` compila observación y rechaza SET. `-Output` permite conservar ese artefacto fuera del paquete. Por defecto emite `native/javi-aa-format/javi-aa-format.so` solo después de pasar los tests. Objetos y ejecutable de pruebas quedan en un directorio temporal. Se compila C11 con `-Wall -Wextra -Werror`; se verifica ELF x86-64, GLIBC≤2.17 y NODELETE. Como biblioteca compartida no tiene intérprete ELF propio; usa el cargador de `aapd`.

## Protocolo y propiedad

Socket: `/tmp/bmwlauncher-aa-margins-13006/<pid>-<starttime>/control`. `starttime` es el campo22 de `/proc/<pid>/stat`, conservado como texto decimal por el cliente.

- `/tmp` debe ser directorio real root:root, modo1777. Se abre con O_NOFOLLOW.
- Base y subdirectorio son13006:13006, modo0700; socket0600. El daemon crea la base con mkdirat y valida cualquier base existente. Nunca cambia propietario/permisos para aceptar una ruta ajena.
- El subdirectorio debe ser nuevo. No roba directorios, no limpia sesiones antiguas y no toca otros elementos de `/tmp`. La limpieza normal solo retira socket y subdirectorio propios, comprobando sus inodos.
- Solo se admite un cliente simultáneo y SO_PEERCRED exige UID0. El cliente debe comprobar permisos, identidad PID/starttime e inodos antes y después de conectar.
- Solo un SET aceptado da propiedad de ese epoch a la conexión. LEASE/RESTORE requieren esa propiedad. Cerrar una conexión que solo consultó no restaura otra adquisición.

Entrada ASCII, una orden por línea, máximo127 bytes antes de LF. Sin JSON entrante ni rutas o coordenadas arbitrarias:

| Orden | Efecto |
| --- | --- |
| `GET` | Devuelve el estado observado. |
| `SET <epoch> normal` | Márgenes top/bottom250, left/right312; contenido1296×580. |
| `SET <epoch> alto` | Márgenes top/bottom250, left/right376; contenido1168×580. |
| `LEASE <epoch>` | Renueva1000ms si sigue vigente y pertenece al cliente. |
| `RESTORE <epoch>` | Solicita restauración; `accepted` no acredita que termine. |
| `REARM <epoch> <generation> <updateSeq>` | Solo desde conexión nueva y DONE limpio; coincidencia exacta o rechazo sin mutación. Al aceptar: READY, generation+1. |
| `CLOSE` | Cierra; si era propietario solicita restauración. |

El cliente renueva cada250ms. La conexión tiene2s de inactividad máxima; solo una orden completa la renueva. EOF, sintaxis inválida, respuesta parcial/error o vencimiento cierran la conexión y solicitan restaurar si tenía propiedad. Las colas son acotadas:128 bytes de entrada y una respuesta de menos de768 bytes enviada sin bloqueo; no se conserva una cola de respuestas.

Cada respuesta es una línea JSON con `v:3`, `marker:"javi-aa-format/1.0.0"`, `starttime` string, `pid`, `epoch`, `generation`, `updateSeq`, `setStartedNs` string, `rearm:1`, `leaseMs:1000`, `ackMs:2000`, `result`, `phase`, `writes`, `baseline`, `insets`, `dirty`, `uncertain`, contadores y metadatos escalares de configuración. Se envía `hello` al aceptar y `state` al cambiar fase/epoch. `insets` siempre describe la baseline, no la geometría objetivo actual. El orden es top,bottom,left,right.

Begin inicia generation1; updateSeq cuenta actualizaciones MAIN de márgenes no vacíos. El cliente fija generación hasta restaurar/cerrar y rechaza epoch, identidad o secuencia incoherentes. Después de REARM debe drenar respuestas anteriores y comprobar READY fresco antes de SET. Un rechazo no autoriza un reintento oculto. setStartedNs empieza en0, se toma en CLOCK_MONOTONIC al iniciar el setter y se conserva hasta DONE; REARM lo borra. Puede compararse con frame_id de AAF1 para retener el GOP iniciado durante la espera del update.

Solo `active` con `dirty:1, uncertain:0` acredita retorno local satisfactorio y actualización MAIN coincidente. Solo `done` con `dirty:0, uncertain:0` acredita restauración observada; no basta un retorno0 ni `accepted`. `blocked`, un epoch distinto o transporte perdido invalidan la adquisición. El cliente debe esperar la restauración antes de CLOSE y rechazar versiones/marcadores desconocidos antes de SET.

## Vida útil y límites

El guard verifica hashes y correspondencia del archivo con la imagen cargada, UID/GID reales/efectivos/guardados13006 y disposición ABI. Una referencia extra conserva un wrapper MAIN hasta la salida del proceso. Los vtables propios tienen tamaño fijo; solo se intercambian antes de que el constructor publique callbacks. No se solicita GetDisplay desde el worker. Begin/End delimitan epoch; End drena callbacks nativos y serializa setters para no afectar a otro teléfono. Detalles en [ABI.md](ABI.md).

Baseline se copia del registro de vídeo realmente seleccionado durante su callback, antes de devolver el control original. SetMargins solo envía el grupo de márgenes; el merge conserva tema y demás grupos. La restauración escribe los márgenes originales de forma explícita: es equivalente geométricamente, no un reset exacto de presencia protobuf.

Una operación tiene2s para observar actualización coincidente. Ante actualización contradictoria o configuración externa, bloquea sin restaurar sobre un estado nuevo desconocido. No hay plazo duro demostrado para la llamada Cinemo: usa mutex y asignación de memoria, aunque no espera al Reader/Writer ni al ACK. El worker tiene pila acotada512KiB; ninguna llamada nativa se ejecuta con el mutex de estado retenido.

**No reiniciar `aapd` de forma aislada para cargar, retirar o rearmar.** En el ensayo físico se perdió entrada también en AA original después de reinicios aislados; reconectar el teléfono no bastó y el reinicio completo autorizado recuperó toque/rueda. El mecanismo InputRelay duplicado es una explicación estática compatible, no un error capturado en ese proceso. No se elimina ni recrea ningún servicio de entrada. La instalación/reversión deben quedar diferidas a un arranque completo y conservar el preload original.

Este directorio no instala manifiestos ni reinicia procesos. El candidato v3 no está probado cargado en MGU. Los resultados del prototipo anterior no demuestran arranque ni controles conjuntos del candidato: [VALIDATION.md](VALIDATION.md).
