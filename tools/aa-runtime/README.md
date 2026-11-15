# Capturador MAIN de Android Auto

`aa-capture` es un auxiliar C separado de la interfaz. Su único perfil admitido
es `mgu21-aa-20261115`: valida SHA-256 de aapd y de
`/usr/lib/cinemo/libNmeAndroidAuto.so`, el PID/starttime, la identidad de los
archivos y el mapeo ejecutable que contiene el offset `0x960b0`. Los hashes
están en `aa-capture.h`. No distribuye firmware ni bibliotecas propietarias.

Esta integración deriva del ensayo de captura síncrona. La compilación y los
tests portables no sustituyen el ensayo del ciclo de vida, CPU/RSS y cadencia
en la MGU. La copia dentro de handlers impide que avance el hilo llamante;
no garantiza atomicidad global frente a escrituras de otros hilos.

## CLI y supervisión

```sh
aa-capture --self-test
aa-capture --check
aa-capture --check --pid PID
aa-capture --pid PID --starttime STARTTIME --profile mgu21-aa-20261115 \
  --initial-bytes 61440 --lease-ms 1000 --max-seconds 10
```

`--check` es de lectura: descubre un único `comm=aapd`, valida sus dos hashes,
identidad y mapeo y comprueba disponibilidad de tracefs. No registra probes.
Devuelve una línea JSON por stdout con `type=checked`, `pid`, `starttime`
(cadena decimal), `profile`, `backend=perf-scalar`, `initialBytes` y `maxFrame`.
Comprobar tracefs no prueba que se vaya a aceptar toda la sesión perf.

La captura exige PID y starttime obtenidos del check. Vuelve a comprobarlos
después de los hashes, antes de armar y cada segundo junto con los inodos.
No adquiere foco, modifica la geometría ni accede al segundo display.

stdin acepta exclusivamente líneas `lease\n` o `stop\n`. El supervisor debe
renovar cada 250 ms. Espera la primera concesión antes de registrar recursos;
caduca a los 1000 ms por defecto, con rango permitido de 500 a 1000 ms.
Una renovación leída después del vencimiento no revive la sesión. EOF,
stop, SIGINT/SIGTERM/SIGHUP o duración agotada cierran la captura. Sin
`--max-seconds`, dura mientras la concesión siga vigente.

stderr emite JSONL acotado, sin direcciones del búfer ni contenido capturado:

- `armed`: PID/starttime, perfil, ventanas, capacidad, máximo y leaseMs.
- `stats`: frames, samples, complete, outputBytes, payloadBytes, lost,
  malformed, incomplete, oversized, late, queueHigh, maxLength, maxLagNs,
  maxSpanNs. Cada segundo y al cerrar.
- `recovery-needed`: code, requiredBytes y maxFrame. Una discontinuidad
  detiene la sesión; no entrega posteriores P-frames como si faltara nada.
- `error` / `closed`: code y errno. Los códigos no incluyen entradas privadas.

Salida 0: cierre solicitado/caducidad/duración; 64: argumentos; 65: identidad
o firmware; 69: backend/armado; 74: E/S; 75: recuperación. El supervisor debe
esperar `close` para conservar los últimos mensajes stderr y limitar sus
reintentos. No publica ni instala nada por sí mismo.

## Recursos y recuperación

Registra un grupo privado `bmwl_aa_PID_STARTTIME_NONCE`, con nombres `vNNN`,
sin tocar tracing global, otras probes, filtros de otros clientes ni bpffs.
Usa un bloqueo exclusivo `/run/bmwlauncher-aa-capture.lock` (0600, dueño e
identidad de archivo comprobados), sin seguir enlaces. Una sesión nueva
solo retira el grupo derivado del registro de su propio dueño anterior si
el PID/starttime ya no está vivo. No recorre ni borra grupos de otros dueños.

Un guardián se crea antes de registrar eventos y no hereda los descriptores
perf, porque todavía no existen. Conserva el bloqueo, supervisa un pipe
interno y retira exactamente el grupo planificado tras EOF. Si el capturador
se bloquea durante leaseMs + 500 ms, envía TERM/KILL únicamente al PID de
ese auxiliar, verificando su starttime, y retira el grupo. Nunca señala aapd.
El cierre normal desactiva/cierra perf, unmaps, retira eventos y espera al
guardián. Si ambos auxiliares mueren, la próxima sesión limpia ese registro
propio; tras reiniciar, `/run` y tracefs vuelven a su estado de arranque.

Linux 4.14.300 upstream no acepta fetcharrays; el ensayo de la MGU rechazó
`x64[8]` con EINVAL. El backend copia 120 u64 por evento (960 bytes), con cinco
metadatos: 125 fetchargs, aceptados por la unidad probada. El formato RAW
BMW se valida al registrar: common_tgid@8, buf@24, len@32, ts@40, flags@48,
display@56, w0@60 y w119@1012. Un formato distinto impide activar la sesión.

El filtro kernel exige TGID y display 0. Las ventanas posteriores a la primera
exigen además longitud dentro de su intervalo/capacidad. La entrada se vuelve
a validar antes de copiar; se ignoran las palabras sobrantes de la ventana
final y nunca se escriben a stdout/log. El kernel puede haberlas leído
temporalmente en su registro perf. Los filtros pueden aplicarse después de
fetchargs; no se presenta su uso como una reducción de coste medida.

La capacidad inicial es 61.440 bytes (64 eventos). Si una unidad supera ese
límite, se comunica su tamaño y se termina con código 75. El supervisor puede
reiniciar con `--initial-bytes requiredBytes`, redondeado a ventanas, hasta
256 KiB (274 eventos), y recuperar foco/decoder de forma acotada. Por encima
de 256 KiB no existe una ruta de captura completa: debe mostrarse
indisponibilidad, sin reintentos infinitos. Nunca se activan 274 ventanas sin
pedir esa capacidad. Registrar más eventos aumenta el coste y exige medida.

Límites internos: hasta 16 CPU, un anillo de 128 páginas por CPU, 12 slots de
256 KiB, margen de reordenación de 10 ms, ensamblado máximo de 100 ms y salida
no bloqueante con 250 ms máximos por buffer pendiente. Con páginas de 4 KiB,
los anillos ocupan 2 MiB en la MGU de cuatro CPU y los slots unos 3 MiB.
El guardián hereda páginas COW; no se ha presentado ese cálculo como RSS medido.
Puede elevar el límite de descriptores de su propio proceso para la capacidad
solicitada; no cambia sysctls ni configuración global de memoria/perf.

La salida elige el buffer completo más antiguo, espera el margen de orden y
no adelanta un ensamblado anterior incompleto. Una llegada anterior a lo ya
emitido, pérdida, duplicado, ensamblado vencido o cola llena exige recuperación.
`maxSpanNs` mide intervalo entre ventanas recibidas, no toda la sobrecarga de
las probes ni la latencia de la función instrumentada.

## AAF1

stdout contiene únicamente unidades completas: cabecera little-endian de
64 bytes y `total_size` bytes Annex B. Sin cabecera global, JSON ni base64.

```text
u32 magic=0x31464141, header_size=64
u64 frame_id, timestamp, flags
u32 total_size, chunk_size=total_size, offset=0, cpu, tgid, tid, display=0, reserved=0
```

`frame_id` es tiempo monotónico del primer handler de la unidad y se emite
estrictamente creciente. `timestamp` y `flags` conservan RCX/R8 del productor;
no se presume la unidad de ese timestamp. El campo reserved siempre es cero.
Un cierre de pipe durante una escritura puede dejar el último registro
truncado: el consumidor debe descartarlo y cerrar su generación/decoder.

## Build y pruebas

`Build-AaCapture.ps1` usa el NDK/Clang/LLD ya existente, sysroot glibc 2.27 y
Zig existente para ejecutar tests portables nativos en Windows. No descarga
ni instala nada. Admite parámetros `-Ndk`, `-GnuSysroot` y `-Zig` para otras
rutas. Compila con `-Wall -Wextra -Werror`, PIE, protector de pila, RELRO/NOW
y pila no ejecutable. Deja el ELF en `native/javi-carlab/bin/aa-capture` y
registra `ELF-CHECK.txt` y `SHA256SUMS.txt`.

Los tests cubren vectores SHA-256, concesión parcial/vencida/desconocida,
256 KiB con ventanas invertidas y contenido exacto, orden entre CPU, bloqueo
por una unidad anterior incompleta, sobredimensión, PID/display ajenos,
duplicados, pérdidas y cola llena. `--self-test` ejecuta los mismos tests en
Linux sin registrar probes ni acceder a la MGU.

Antes de publicar se deben verificar en la unidad: hash/check, armado,
EOF/stop/lease, SIGKILL del capturador y limpieza del guardián, exclusión
mutua, recuperación por capacidad/discontinuidad, CPU/RSS/cadencia, ocultación
y desconexión. La documentación raíz y la publicación pertenecen a la tarea
de integración.

## Procedencia

Fuentes propias bajo MIT; SHA-256 implementado a partir de las operaciones
y constantes de FIPS 180-4. No se copia código GPL del kernel. Se incluyen
únicamente cabeceras UAPI durante la compilación (excepción Linux syscall);
el ELF depende dinámicamente de libc del sistema. No incorpora libbpf ni
add-ons Node, y no cambia el requisito Node 8 de la app.

Referencias: [Linux 4.14.300 trace_probe.c](https://raw.githubusercontent.com/gregkh/linux/v4.14.300/kernel/trace/trace_probe.c),
[perf set_output](https://raw.githubusercontent.com/gregkh/linux/v4.14.300/kernel/events/core.c),
[FIPS 180-4](https://csrc.nist.gov/pubs/fips/180-4/upd1/final).
