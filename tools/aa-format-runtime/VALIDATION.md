# Validación

## Candidato integrado v3, local2026-11-15

- `javi-aa-format.so`: SHA-256 `f0f863bdfac6bf8746fb06f0b822017f5b30afd9bcb319b449b6e3cb50f236c8`.
- Clang del NDK28.2.13676358, sysroot glibc2.27 existente, C11/O2 con Wall/Wextra/Werror. ELF64 x86-64, SONAME javi-aa-format.so, RELRO/NOW/NODELETE, pila no ejecutable. Dependencias libc,libpthread,libdl; GLIBC máxima2.17. Única función propia exportada: CinemoCreateAndroidAuto.
-406 checks portables ejecutados:282 de estado,22 de selección de baseline,27 de identidad/permisos y75 de protocolo/propiedad. Cero fallos. Cubren EOF antes del setter, lease vencida, ACK antes de retorno, contradicción parcial/tardía, IC ignorado, epoch antiguo, restauración no confirmada, rearme explícito A→baseline→A, tokens antiguos, update previo al setter y cierre de cliente sin propiedad.
- Build genérico sin rutas privadas. No se incluyen artefactos ni logs de firmware. [ELF-CHECK.txt](ELF-CHECK.txt) y [SHA256SUMS.txt](SHA256SUMS.txt) describen la salida local.

Pendiente: cargar este candidato v3 tras un arranque completo, comprobar `/tmp` real root:root1777, descubrimiento/credenciales/socket/limpieza, vídeo+formato+toque+rueda conjuntamente, varias adquisiciones y recuperación al ocultar/perder capa. No se ha ejecutado el servidor Linux de esta revisión; los tests portables no simulan seguridad de filesystem ni reemplazan esa validación.

## Prototipo privado anterior, evidencia física separada

El prototipo v1 observe comprobó carga con UID/GID13006, hooks, socket, epoch y baseline248/248/0/0 después de iniciar MAIN. Rechazó SET con writes0. Su versión write observó aplicación de1168×580, composición del teléfono adaptada y restauración al formato ancho original. El usuario confirmó tamaño y cockpit sin cambios.

Los controles fallaron tanto con formato nuevo como sin preload y en AA original. Reconectar el teléfono no los recuperó. Tras retirar todos los elementos temporales y ejecutar un reinicio completo autorizado, el usuario confirmó toque y rueda originales recuperados. No se atribuye a los márgenes; no se vuelve a reiniciar `aapd` aisladamente.

La relación con InputRelay duplicado es hipótesis localizada: Hmi8 devuelve error3 por UUID existente; aapd acepta solo0 y necesita ambos proxies para construir el consumidor. No se capturó error3 en el proceso afectado. No se implementa una supuesta recuperación destruyendo servicios.

Estos resultados no validan el candidato v3 ni su uso reiterado. El análisis y las pruebas de reentrada están en [REENTRY.md](REENTRY.md). Posteriormente el usuario pidió distribuirlo como versión de prueba0.2.21 para comprobar la integración instalada. Esa autorización no convierte la validación física pendiente en un resultado positivo; se mantiene el ensayo conjunto descrito en TEST-PLAN.
