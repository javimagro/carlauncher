# Cierre del foco MAIN: revisión posterior

La corrección afecta a `aa-focus.js`, `aa-focus-process.js` y al nuevo
`aa-focus-lock.js`. No modifica el contrato SOME/IP, la política de
`restoreFocus` ni la integración de la UI.

`stop()` tiene plazo externo: TERM a los 10 s, KILL a los 13 s y rechazo a
los 14 s si el auxiliar propio sigue sin terminar. Espera `close`, no solo
`exit`, para consumir la confirmación final. Resuelve `{ restoration }`
únicamente con restauración admitida, `safe: true` y salida 0; los fallos y
las salidas sin confirmación rechazan. El consumidor debe conservar ese
rechazo e impedir otra generación, sin convertirlo en éxito mediante catch.

Un mkdir exclusivo crea `/run/bmwlauncher-aa-focus.lock`. El registro privado
0600 contiene token aleatorio y PID/starttime de supervisor y propietario.
El supervisor registra al propietario y autoriza la adquisición antes de
que este pueda pedir PROJECTED. Solo el propietario registrado puede actuar;
un propietario huérfano conserva el bloqueo durante su restauración.

El propietario también exige concesiones del supervisor cada 250 ms, con
caducidad a 1500 ms. Puede devolver el foco si el supervisor deja de responder,
pero no libera el bloqueo mientras siga vivo. El supervisor espera a que el
propietario termine antes de restaurar y liberar. Una adquisición enviada
sin ACK se considera incierta: matar al emisor no cancela una petición ya
entregada a BMW, y no permite abrir otra generación.

Si la restauración falla o ambos procesos mueren sin confirmarla, el bloqueo
permanece. No se roban bloqueos antiguos ni se borran por la mera ausencia
de PID; se requiere recuperación explícita del estado. Esto favorece la
indisponibilidad conocida frente a otra adquisición que pueda recibir una
restauración tardía de la sesión anterior.

Se mantiene el caso de AA original (`state=1`, `applet=50`): al cerrar no se
envía NATIVE y se informa `native-aa-retained`. Si el contexto cambia antes
de autorizar la adquisición, no se restaura algo que no llegó a adquirirse.

Verificación local: 14 tests dedicados de cierre, ACK tardío, huérfano,
supervisor bloqueado, adquisición sin ACK, exclusión, restauración fallida,
mensajes finales tras exit y conservación de AA original. La suite completa
`node --test emulator/split/*.test.js` pasó 336/336. Sintaxis y carga
comprobadas con Node 8.16.2. No se ha probado esta corrección de foco en MGU
desde esta subtarea; no se usó SSH.
