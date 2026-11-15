# Perfil ABI derivado

Observación propia de ELF Linux x86-64 SysV, revisión2026-11-15. No es una interfaz pública garantizada por Cinemo. Cualquier hash, UID/GID o disposición distinta deja el puente deshabilitado y conserva el resultado original de la fábrica.

| Archivo observado | SHA-256 |
| --- | --- |
| aapd | a7971d64fc0feb4e48942441dc76a67d6df282b56cb5d64e92248ff83f18d62e |
| libNmeAndroidAuto.so | 10446b6de0d99272cc28d0e51e9afa0e2bbcbb40eef6c7ad688f1544857ef1ac |
| libNmeSDK.so | 0fa7e320d7bf223a3a8c9680c4a7c15a3a462e565f3774fee6c94a07b03bd4aa |
| libNmeBaseClasses.so | b4fd26751d34e5eff5d14f773bbcb4535b849dba88d549f54c889d96961c7e60 |

Los números siguientes son RVA antes de sumar la base de carga. Las firmas mínimas y aserciones de tamaño están en [bridge-abi.h](bridge-abi.h).

- Fábrica SDK0x9d560: RDI=puntero a salida, resultadoEAX. Interposición vía RTLD_NEXT, llamada original una vez, resultado y errno conservados.
- Vptr AndroidAuto0x3daf38,55 slots y2 palabras de prefijo. GetDisplay slot18: this,out**,displayIndex; SetCallbacks slot6: this,audio,core,video.
- Wrapper MAIN vptr0x3d81f8. AddRef slot0→0x65180; SetMargins slot15→0x6abd0; GetMargins slot19→0x6c3c0. Solo se retiene el GetDisplay(0) original satisfactorio.
- Insets ocupa32 bytes: cuatro pares `{uint32 present,uint32 value}` en orden top,bottom,left,right. No son bool C++.
- SetCallbacks original del constructor retorna a aapd0x354c27. Core vptr aapd0xa8fdd8 tiene12 slots; video0xa8feb0 tiene6. Begin core+3, End core+5, OnVideoConfig video+2, OnUiConfigChange video+5. Se conservan los2 prefijos ABI.
- OnVideoConfig obtiene el registro inicial a través de wrapper+0x20→raw+0x70→VI; VI+0x68→endpoint; endpoint+0x58→adapter; vector endpoint+0x60/+0x68. Se validan vptr, vínculos, display0, índice y presencia de campos antes de copiar escalares. El vector vive desde antes del Reader hasta después de su drenaje.
- Observación física del registro seleccionado: config0, mask0x7df, resolución3(1920×1080), marginW0,marginH496, uiFlags9 e Insets completos248/248/0/0. No se usa el GetMargins inicialmente vacío del VI como una supuesta baseline0.
- MAIN SetMargins0x6abd0→0x968e0→0x85610→0x853a0→0x133ac0 envía UpdateUiConfig0x8009. Solo crea grupo margins. Merge0xef8d0 conserva grupos ausentes; el merge de Insets0xd6d10 conserva campos ausentes. Una actualización parcial contradictoria sí invalida nuestro estado; una actualización solo de tema no borra márgenes.
- La recepción0x82e90 notifica el callback antes de mezclar el UiConfig completo en caché0x82fac. Una observación coincidente expresa el estado recibido, no un identificador de transacción.
- El envío virtual del receptor+0x10 resuelve a0xae2b0→0xa2180→0xa1100→0xa0d60→0x9d250/0x132dc0: retiene canal, encola fragmentos y señaliza. No contiene espera de ACK/Reader/Writer; las esperas de mutex y allocator no tienen plazo duro.
- ThreadEndSession limpia displays mediante0x971b0 antes de desconectar el manager0xaa2c0→0xae3d0. Setter y desconexión del display comparten mutex; el setter posterior devuelve13. Begin/End y el mutex propio impiden que una operación vieja sobreviva al cambio de sesión.

Se conserva un wrapper, sin retener el dueño AndroidAuto. NODELETE mantiene código y tablas hasta la salida del proceso. La exposición sigue limitada a los dos perfiles MAIN; no hay endpoint IC, comandos de entrada, lectura arbitraria ni acceso a `/proc/PID/mem`.
