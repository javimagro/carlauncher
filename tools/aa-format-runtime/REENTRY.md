# Reentrada por convergencia observada

El protocolo3 permite otra adquisición en el mismo epoch después de restaurar. No utiliza un ACK como identificador de transacción: confirma el último estado MAIN observado y lo invalida ante cambios incompatibles. El candidato anterior v2 mantenía una adquisición por epoch como límite del prototipo; no se ha encontrado una prohibición de reentrada en la API nativa.

## Evidencia y decisión

El ELF fijado tiene un Reader del transporte, creado en0x1346f0 y ejecutado en0x1349f0. Lee una trama, llama0xaa4b0 y termina su procesamiento antes de leer la siguiente. Ruta de un UpdateUiConfig0x800a:

`1349f0 → aa4b0 → a26d0 → ae600 → ad990 → 132ec0 → 82c30 → 82e90 → callback original`

`ae600` invoca directamente el endpoint; `ad990` parsea0x800a e invoca su slot0x80; `132ec0` pasa el UiConfig al adaptador; `82c30` reenvía al VI. No se introduce una cola asíncrona en esa cadena. El VI invoca nuestro callback y después mezcla el UiConfig en0x82fac. El setter construye un mensaje independiente y lo encola, sin leer ese caché.

Por tanto no se usa GetMargins desde el worker como barrera: su mutex del display no está demostrado compartido con el merge del Reader. El puente conserva únicamente escalares copiados en el callback, con orden y contador propios.

La [auditoría primaria del protocolo17.3](https://github.com/mrmees/open-android-auto/blob/61eab61c5f9968154ff1a80faa8c0a427b208479/oaa/video/UpdateUiConfigRequestMessage.audit.yaml) documenta las direcciones0x8009/0x800a y esquema compartido, sin acreditar un par transaccional. El [análisis del consumidor](https://github.com/mrmees/open-android-auto/blob/61eab61c5f9968154ff1a80faa8c0a427b208479/analysis/reports/multi-display/android-auto-17.3-runtime-cluster-policy.md#supported-same-channel-ui-updates-are-a-different-message) sitúa merge y reconstrucción de parámetros dentro del endpoint existente. No acredita la versión del teléfono del usuario.

Si un update objetivo llega después de la nueva llamada, se acepta como observación coincidente, aunque no se pueda atribuir causalmente a esa petición. El setter nuevo pide el mismo estado y el siguiente update incompatible lo invalida. Este es el mismo límite de convergencia que la primera adquisición. Una secuencia de estados `A → baseline → A` no es por sí sola un fallo de reentrada.

## Contrato mínimo

Cada Begin inicia `generation=1` y `updateSeq=0`. Cada callback MAIN con algún margen presente incrementa updateSeq. Tema solo, IC y grupos vacíos no avanzan ese contador. La baseline original se conserva durante todo el epoch.

Una nueva conexión root consulta DONE limpio y envía `REARM epoch generation updateSeq`. El servidor exige coincidencia exacta de los tres valores, baseline válida, sesión aceptada, sin incertidumbre ni dirty y sin llamada pendiente. Además, esa conexión no puede haber adquirido formato antes. Un cambio entre consulta y REARM lo rechaza sin mutación. Al aceptar, pasa a READY, incrementa generation, borra petición/lease/confirmación anterior y conserva baseline y contador.

Cada SET posterior vuelve a exigir su propio retorno0 y un callback coincidente con secuencia posterior al comienzo de la acción nativa. Nunca reutiliza `ack_seen`. RESTORE sigue necesitando retorno0 y actualización completa coincidente. Restauración dudosa, timeout, configuración de vídeo distinta o márgenes contradictorios bloquean el epoch; REARM no ofrece una salida de ese bloqueo.

El estado se mantiene durante el cierre del socket. El nuevo cliente no hereda propiedad. EOF del dueño solicita restaurar; EOF de un consultante no altera una restauración anterior. No hay reinicio ni recreación de InputRelay para rearmar.

## Carrera concreta corregida

Antes, SET aceptado sin ejecutar podía recibir un update MAIN contradictorio, ignorarlo y después recibir EOF: se cancelaba sin llamada y quedaba DONE limpio con baseline obsoleta. Protocolo3 bloquea cualquier update incompatible antes de iniciar el setter, incluidas actualizaciones parciales. No envía SET ni restaura sobre esa configuración nueva. Hay regresión del orden update→EOF→rearm.

## Vídeo y tiempo

`setStartedNs` es un decimal string CLOCK_MONOTONIC tomado al comenzar la acción que invoca SetMargins. AAF1 usa PERF_SAMPLE_TIME con `use_clockid=1, clockid=CLOCK_MONOTONIC`; es comparable con frame_id, no con PTS/timestamp del teléfono. Se conserva hasta DONE y se borra al rearmar. Permite retener un GOP que empezó durante la espera del update; no demuestra por sí solo que cada frame posterior ya tenga la nueva geometría.

El modelo cubre varias adquisiciones, tokens/updates antiguos, callback antes del retorno, cancelación/EOF, lease, contradicciones y cierre sin propiedad. La prueba física conjunta y la entrada con formato cambiado siguen pendientes; reentrada probada en modelo no equivale a validación en MGU.
