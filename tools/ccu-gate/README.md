# Filtro FrontCCU: modo Android Auto

El filtro actúa únicamente sobre la copia que consume `Hmi8`, notificaciones
`0xb508:1`, eventos `0x8001` (8 bytes) y `0x8002` (7 bytes). No interviene
en el display IC ni en el mapa del cockpit.

`/run/javi-carlab/frontccu.lease` debe ser un archivo regular, de root,
sin escritura para grupo u otros, con edad no negativa e inferior a 700 ms.
Su tamaño selecciona la política sin añadir lecturas de contenido al evento:

| Tamaño | Productor | Efecto en Hmi8 |
| --- | --- | --- |
| 0 bytes | `update(true, 'all')` | Congela giro, suelta pulsación y neutraliza inclinación/botones. |
| 2 bytes (`aa`) | `update(true, 'aa')` | Permite giro y pulsación central; neutraliza inclinación y botones físicos. |
| Otro tamaño, expirado o inválido | — | Devuelve la entrada a iDrive. |

El modo AA solo se debe renovar mientras BMWLauncher confirma la capa propia,
el contexto original AA y el foco del mando en AA. El propietario de la lease
es el servicio; no se renueva desde el filtro. La compensación del contador
se mantiene al pasar de captura completa a AA y al devolver el mando a iDrive.

La visibilidad auxiliar del OAP usa otra lease independiente,
`/run/javi-carlab/aa-visible.lease`. El OAP la observa asíncronamente cada 250 ms
con las mismas condiciones de propietario, permisos y edad. Mantiene sus
lecturas/audio y registro de actividad, pero no registra visibilidad HMI por
esa lease. No crea ni renueva el archivo. Su plazo de caducidad sigue corriendo
si una operación `lstat` tarda y se retiran temporizadores al cerrar.

Al ocultarse la página HMI antes del siguiente sondeo, OAP retira su registro
de visibilidad real y solicita una lectura puntual de la lease. Esa lectura
asíncrona dispone de 50 ms y no acepta una respuesta iniciada antes de la
ocultación. Evita cerrar/reabrir mando, datos y audio si la lease de AA acaba
de crearse. Error, caducidad o falta de respuesta retiran la actividad efectiva;
un resultado tardío no la reactiva. La lectura conserva el vencimiento desde
el mtime original: nunca añade otros 700 ms. El registro HMI tiene una cola
independiente, para que un `registerActive` lento no retrase su retirada.

## Verificación local, 15-11-2026

`Build-CcuGate.ps1` compila con Clang/LLD de NDK 28.2.13676358,
sysroot GCC 7/glibc 2.27 y `-Wall -Wextra -Werror`. La biblioteca es ELF64
x86-64, con pila RW, RELRO/NOW y dependencias `libc.so.6`, `libdl.so.2`,
`libpthread.so.0`; versión máxima requerida GLIBC 2.17. Al ser una biblioteca
preload no lleva intérprete ELF propio. No requiere GLIBCXX.

SHA-256 del binario compilado:
`877a1b9d5fb47844dda549758e39fa10b7f3e2130ed54ffe1f2ee93827c7180c`.

El ELF exporta `BMWLauncherAAKnobGate1`, objeto inmutable de 23 bytes en
`.rodata`. `await inspectGate()` conserva el resultado booleano de carga;
`inspectGate.aaReady()` consulta la capacidad AA de esa inspección. Para
aceptarla exige que el inode de `/proc/PID/maps` coincida con el archivo
realmente abierto, que sea ELF64 x86-64 con el marcador y que no figure
`(deleted)`. Rechaza mapas ambiguos o ficheros ilegibles. Cachea la lectura
binaria por PID, ruta, inode y metadatos; comprueba comm/maps/stat en cada
consulta. Una versión nueva instalada sobre el disco no habilita el mando
AA si Hmi8 conserva el preload anterior.

La capacidad se publica al terminar la inspección completa. Durante la siguiente
consulta asíncrona conserva la última instantánea hasta un máximo de 3 segundos;
no desactiva AA transitoriamente en cada sondeo. Si la lectura no termina en
1 segundo, publica indisponibilidad, descarta el resultado tardío y no acumula
consultas bloqueadas. Los tests usan inodes Linux sintéticos porque los IDs de
archivo NTFS pueden superar la precisión entera de JavaScript; producción sigue
rechazando inodes que no pueden compararse exactamente.

`frontccu-filter.test.cpp` cubre las ocho inclinaciones, botones, pulsación,
contador, transición all→AA, vencimiento y permiso inválido. Las pruebas JS
cubren propietario/permisos, expiración, respuestas tardías y separación entre
visibilidad real y efectiva. La prueba C++ ha pasado en Windows con Zig 0.14.1,
también con avisos como errores. La prueba de Hmi8 con este nuevo preload requiere
cargarlo tras un reinicio autorizado; compilar y ejecutar unidades en PC no
demuestra todavía su comportamiento físico en el coche.
