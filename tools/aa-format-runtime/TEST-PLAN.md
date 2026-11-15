# Ensayo físico v3 y reversión

Plan para el operador con autorización vigente de instalación y arranque completo. Preparado en local; no ejecutado. Candidato SHA-256 `f0f863bdfac6bf8746fb06f0b822017f5b30afd9bcb319b449b6e3cb50f236c8`.

## Antes de cargar

1. Confirmar que toque y rueda funcionan en AA original, cockpit normal y ausencia de cualquier prueba anterior. No usar los antiguos scripts temporales que reinician `aapd`.
2. Comprobar el sistema de archivos, sin corregir permisos para forzar la carga:

```sh
test ! -L /tmp && test -d /tmp
test "$(stat -c '%u:%g:%a' /tmp)" = '0:0:1777'
systemctl show aapd.service -p MainPID -p ActiveState -p SubState -p DropInPaths
```

3. Comprobar el hash del ZIP y de su `.so`, y revisar que la instalación añade únicamente el preload dirigido a `aapd.service`, conserva `/usr/lib/libschedconfig.so.1` y no declara reinicios de servicios. No precrear la base del socket ni cambiar User/Group.
4. Dejar el componente preparado para el **siguiente arranque completo**. No ejecutar `systemctl restart/stop/start aapd.service`, ni matar aapd, ni usarlo para rearmar. Antes del arranque, verificar que el proceso actual sigue con su identidad y preload anteriores.

## Ensayo corto después del arranque completo

Comprobar primero AA original: vídeo, toque y rueda. Verificar una sola biblioteca propia mapeada, identidad del proceso y socket `<pid>-<starttime>`. El hello/GET debe declarar v3, marker exacto, writes1, rearm1, misma identidad y baseline248/248/0/0 después de arrancar MAIN. No registrar memoria, direcciones ni identificadores del teléfono.

Hacer dos adquisiciones de5–8s con una conexión independiente cada vez. El cliente de producto realiza la secuencia y mantiene lease cada250ms:

1. Primera: READY→SET normal o alto→ACTIVE, retorno observado en plazo≤2s y setStartedNs>0. La captura armada antes de SET puede conservar el GOP posterior a esa frontera. Verificar imagen recompuesta, un toque visible, giro/pulsación y cockpit sin cambios.
2. RESTORE→DONE con dirty0/uncertain0. Comprobar retorno geométrico original y cerrar la conexión. `accepted` o retorno0 no sustituyen esa comprobación.
3. Segunda: conexión nueva, GET DONE→REARM con epoch/generation/updateSeq exactos→READY con generation+1→GET fresco→SET. Repetir imagen/entrada y restauración. No reconectar el teléfono entre ambos ciclos: debe mantenerse el mismo epoch.

Si lo anterior pasa, ejecutar una adquisición adicional de3–5s y terminar su **cliente propio** para probar EOF; observar desde otra conexión que llega a DONE limpio, sin mandar RESTORE desde el observador. En otro ciclo omitir LEASE y observar el mismo retorno después de1s más el plazo de actualización. No detener aapd ni interrumpir la MGU para simular el fallo. Una observación dudosa/blocked termina el ensayo; no se reintenta REARM ni se publicita éxito.

Al terminar, volver a AA original y verificar otra vez toque/rueda. Guardar únicamente contadores/fases, identidad local, generaciones, tiempos y capturas consentidas necesarias. El paso físico pendiente es conjunto: un modelo correcto, formato recompuesto o UDP ACK aislado no acreditan entrada operativa.

## Reversión

Cerrar el cliente propietario y esperar DONE limpio antes de retirar visibilidad. Si el cliente desaparece, dejar vencer lease y observar restauración; si hay incertidumbre, dejar de enviar SET/REARM y conservar el diagnóstico.

Deshabilitar el componente mediante su mecanismo de instalación para que no se cargue en el siguiente arranque completo, conservando el preload original. No descargar una biblioteca NODELETE del proceso vivo, no borrar su archivo mientras esté cargado y no reiniciar aapd aisladamente. El paquete generado determina la ruta del drop-in/guard: retirar solo esos elementos propios comprobados, nunca un directorio completo ni `/etc/ld.so.preload` global.

En el siguiente arranque completo autorizado, verificar ausencia del mapeo propio, aapd activo con identidad nueva, preload original y funcionamiento de toque/rueda AA original y cockpit. Si ENET se pierde, no inferir que la reversión terminó: queda pendiente esa comprobación.
