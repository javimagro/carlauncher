# Verificación del capturador

## Referencia y compilación local

Windows x86-64, Clang/LLD de Android NDK 28.2.13676358, sysroot glibc 2.27;
tests portables con Zig 0.14.1. No se instaló software ni se usó SSH desde
esta subtarea. La prueba de la unidad la realiza el proceso de integración.

`Build-AaCapture.ps1` pasó con avisos como errores. Los 342 checks nativos
portables pasaron (incluyen las 274 ventanas del caso de 256 KiB). ELF final
PIE x86-64, intérprete `/lib/ld-linux-x86-64.so.2`, pila RW, RELRO/NOW, única
dependencia `libc.so.6`, versión máxima requerida GLIBC 2.17.

## Primer candidato: prueba MGU comunicada por integración

SHA-256 `71744bd913e1abb3923866293f5aeafd2e1e6856e4bdf22ee9373321bc2bb7ce`.
No corresponde al candidato posterior que endurece el permiso del lock y
reduce la caducidad del guardián a leaseMs + 500 ms.

- `--self-test`: 342 checks, cero fallos en Linux/MGU.
- `--check`: descubrió y validó el PID/starttime de aapd y los hashes esperados.
- Captura pasiva de diez segundos con AA original visible: 451 unidades
  emitidas, 452 completas y 994 registros perf recibidos.
- Cero pérdidas, registros malformados, ensamblados incompletos, unidades
  sobredimensionadas y llegadas tardías declaradas.
- Máximo retraso observado del lector: 8,46 ms.
- Código de salida 0 y cero eventos propios restantes tras cerrar.

La unidad completa pendiente al terminar no se presenta como unidad emitida.
Esta prueba no mide CPU/RSS, no comprueba todos los cierres anómalos ni
demuestra duración prolongada, interacción AA o coste despreciable.

## Candidato posterior

SHA-256 `b5a6a197ec1c6685580e39101bce155ee0b0b68ccb202f6d9a43ea7e115c55ad`.
342 checks portables correctos y ELF revisado después de esos dos cambios
de propietario/guardián. Integración verificó en MGU estos cierres, todos con
cero eventos propios restantes:

| Escenario | Armado | Tiempo total del ensayo |
| --- | ---: | ---: |
| EOF | 534 ms | 2935 ms |
| Caducidad de lease | 485 ms | 3666 ms |
| SIGKILL del capturador | 421 ms | 2759 ms |

Los tiempos totales incluyen el ensayo; no son latencias aisladas de limpieza.
El FFmpeg final identificado por integración como `5e2789…` también decodificó
una muestra TS a 54.028.800 bytes, 134 cuadros de 960×280, salida 0 y sin errores.
Esa prueba valida el decodificador, no mide el coste de captura. CPU/RSS y
captura sostenida siguen pendientes. No se mezclan estos resultados con los
del primer candidato.

La publicación se decide en la tarea de integración, tras sus verificaciones
y las del resto de componentes; este archivo no anuncia una release.
