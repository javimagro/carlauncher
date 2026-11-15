# Asistente de BMWLauncher

Implementación local del 14-11-2026, basada en CarLauncher Android/Carlinkit. No publicada ni instalada en la MGU durante este trabajo.

## Uso

El engranaje abre **Ajustes → Asistente** con proveedor, voz y API key. Los ajustes se guardan al cambiarlos. **Oír voz** reproduce la muestra en ese mismo panel cuando hay salida de audio. **Escribir** abre la alternativa de texto.

El micrófono del mapa inicia y cancela la sesión por voz. El indicador a la derecha muestra conexión y procesamiento en violeta, escucha en naranja y respuesta de voz en azul. La captura se envía por turnos con detección local de pausa. Tras entregar el audio, el asistente vuelve a escuchar. Ocultar la app o perder la superficie cancela la sesión y sus acciones pendientes.

Se conservan los modelos de la referencia (`gpt-realtime-2.1`, `gemini-3.8-live`) y voces iniciales Marin/Kore. Cambiar configuración cierra la sesión anterior. No hay conexión de pago al arrancar: requiere una petición del usuario y una clave configurada.

| Capacidad | Implementación |
| --- | --- |
| Sintonizar emisora | Lista FM/DAB real de BMW; desambiguación, aceptación de la orden y anuncio de emisora activa. Conserva la tarjeta visible. No usa radio IP ni inventa IDs. |
| Emisoras, categorías y favoritos | Lista recibida, filtros de la tarjeta y favoritos propios de BMWLauncher. No modifica favoritos originales BMW. |
| Mostrar tarjeta | Trayecto, Radio, Tiempo, Noticias y TDTWorld. |
| Elegir canal TV | Busca el canal en TDTWorld y solicita reproducción. No declara imagen/sonido confirmado al enviar la orden. |
| Consultar coche y ubicación | Modelo compartido de lecturas vigentes, unidades y GPS disponible; no sustituye ausencias por ceros. |
| Destinos/POI/cargadores | Abre la búsqueda BMW. El usuario selecciona resultado y calcula la ruta desde la interfaz. No inicia guiado automáticamente. |
| Estado de ruta | Estado real, destinos y resultados de BMW disponibles. |
| Tiempo | Pronóstico vigente de la posición actual compartido con DriveHub. |
| Noticias | Búsqueda entre noticias descargadas y selección de coincidencia. No es búsqueda web general. |
| Ajustes | Consulta preferencias y cambia tema auto/día/noche. No altera ajustes del coche ni credenciales. |

La referencia Android también tiene búsqueda web general, tiempo de otra localidad, creación de favoritos de navegación y lanzamiento en pantalla virtual. Esas capacidades no se anuncian al modelo: no tienen aquí el mismo proveedor/contrato, y se descartó la pantalla virtual de apps. Esta entrega no es una réplica completa de esas funciones adicionales.

## Componentes

- `assistant-config.js`: carga asíncrona, escrituras serializadas y atómicas, cifrado y estado público sin secretos. Una clave de cifrado ausente o un almacén corrupto impide sobrescribirlo silenciosamente.
- `assistant.js`: sesión, plazos, cola de herramientas, IDs deduplicados y cancelación por generación. `assistant-tools.js` declara la lista permitida; `assistant-drivehub.js` la conecta a controladores existentes. No hay shell, URL arbitraria, control HVAC ni acceso a claves por herramientas.
- `assistant-client.js`/`assistant-worker.js`: WebSocket aislado del dibujo, con UID OAP/uplink. TLS normal, hosts fijos, sin redirecciones/compresión; mensaje máximo 256 KiB, colas y llamadas limitadas. No hay reintento automático de acciones. Los errores no muestran cuerpos del proveedor ni URL con credenciales.
- `assistant-protocol.js`: OpenAI Realtime/Gemini Live. OpenAI espera `response.done` antes de continuar tras herramientas. Textos de terceros se tratan como datos, no instrucciones.
- `assistant-audio.js`: otro auxiliar con conversión nativa FFmpeg de PCM mono 24 kHz a estéreo 48 kHz y entrega acotada a `tdt-pcm`. Un fallo de salida conserva texto/herramientas y no reabre por cada fragmento.
- `assistant-panel.js`: conversación, ajustes, teclado y voces con paletas, botones, foco e iconos existentes.

Se incorpora `ws@7.5.14` (Node >=8.3.0) como transporte WebSocket, sin addons ni otro runtime. Licencia, procedencia e integridad: `native/javi-carlab/vendor/ws/SOURCES.md`. Todos los archivos de ejecución están enumerados en `component.json`.

## Claves de Carlinkit

`AssistantPreferences` guarda `openai_api_key` y `gemini_api_key` en `assistant_preferences`, cifradas con AES-GCM mediante Android Keystore y el alias `bmwlauncher_conversational_assistant_key`. El XML cifrado requiere el Keystore del dispositivo de origen. La referencia Android incluye `CredentialTransferInstrumentedTool`, que puede exportar solo las claves del asistente desde el contexto de la aplicación de depuración con `credentialTransferScope=assistant`. La exportación se lee en memoria y se elimina de la caché privada de la aplicación tras la transferencia.

BMWLauncher utiliza `/var/opt/javi-carlab/assistant/settings.enc`, AES-256-GCM y una clave aleatoria en `device.key`. En Linux: directorio 0700, archivos 0600. No es un almacén hardware: leer ambos archivos permite descifrarlo. No se distribuyen en paquetes, Git, logs o capturas. El editor muestra asteriscos y el modelo nunca recibe las credenciales.

El simulador `node emulator/split/server.js --drivehub` utiliza el mismo formato de almacén en `%LOCALAPPDATA%\BMWLauncher-Assistant` (o en la carpeta personal si falta `LOCALAPPDATA`). Las claves guardadas desde **Ajustes → Asistente** se recuperan al reiniciar el simulador. Tras una importación externa, reinicia el servidor para cargar el almacén.

El validador admite las claves de autorización de Gemini con prefijo `AQ.` según el formato empleado por Google AI Studio. La versión instalada en la MGU necesita esta revisión para poder leerlas y conectarse. [Tipos de claves de Gemini](https://ai.google.dev/gemini-api/docs/api-key#api-key-types).

`tools/Importar-Asistente.js` acepta una exportación **ya descifrada y autorizada**, con campos `provider`, `keys` y `voices`. Exige origen y destino fuera del repositorio y no imprime valores. En la MGU también se pueden introducir las claves desde **Ajustes → Asistente**. Transferir el almacén al coche por conexión remota requiere autorización vigente.

## Límites de audio y validación real

El micrófono del coche **no está conectado ni validado**. Sin entrada configurada, el botón del micrófono muestra un aviso y evita abrir la sesión de pago. Se admite `arecord` mono 24 kHz con dispositivo explícito mediante `JAVI_ASSISTANT_CAPTURE_DEVICE`, solo después de verificarlo. No se adivina una entrada de llamadas/seguridad.

En Windows, `JAVI_ASSISTANT_FFPLAY` apunta a `ffplay.exe` y `JAVI_TDT_FFMPEG` a `ffmpeg.exe` si no está en el `PATH`. Para el micrófono, `JAVI_ASSISTANT_PC_MIC` debe contener el nombre del dispositivo DirectShow. Estas variables se leen al arrancar el simulador. El indicador se ha comprobado con eventos simulados. Umbral de captura, cancelación de eco y reproducción audible requieren verificación con una entrada y salida reales.

La salida usa la ruta multimedia de la app. La revisión local del 15-11-2026 incorpora el gestor de foco validado previamente para TDT, pero su uso desde el asistente todavía no está probado por los altavoces. Tampoco están validadas convivencia con Radio/TDT ni cancelación acústica de eco. Seleccionar voz y procesar PCM no demuestra conversación audible en el coche. Un fallo mantiene la respuesta escrita.

En el PC se comprobó una respuesta de texto autenticada con Gemini. En la MGU queda pendiente comprobar la conexión con ambos proveedores.

## Revisión local del 15-11-2026 · micrófono pendiente y salida de voz

El aviso descrito por el usuario corresponde a una capacidad que todavía falta: `service.js` deja `assistantAudio.capture=null` sin dispositivo explícito y `arecord` disponible. No es un rechazo de OpenAI/Gemini ni se resuelve cambiando la API key. El aviso deja de atribuirse al proveedor e indica la alternativa «Escribir». No se abre una sesión de pago al pulsar voz sin entrada disponible.

**Salida corregida.** La configuración del asistente omitía `bmwFocus:true`; además, `assistant-audio` trataba `audio-focus-wait` como fallo. Ahora solicita el mismo foco multimedia que TDT y espera antes de abrir PCM. Cierre, pérdida de foco y propiedad siguen en el gestor existente; no se añaden rutas de llamadas/avisos. La regresión reprodujo el rechazo de la espera antes de corregirlo. **Esto no integra la entrada de micrófono.**

**Ruta física observada en los archivos descargados.** `Microphones` (RAM source129) se conecta adicionalmente a `SpeechSink` (sink387) al activar `Ispeech` (source276). `SmartXMGU.decoded.json:192`, `DOMAIN_MGU.decoded.json:2523` y `DOMAIN_RAM.decoded.json:3950` de la copia privada declaran perfiles de micrófonos más referencias de eco, seleccionados por coding10012. `AlsaRoutingAdapters` SHA-256 `fd8ec7b5a95d7cc6d169c30de7d7e1387c709b7fd9a6063f28b65c2f1bcc205b`: desensamblado de la inicialización `0x40f96–0x41116`, tabla `0x2c8420` y consumidor `CreateSinks` `0x65a11–0x65a41`. Formatos3..10: 24kHz con 2,3,3,4,9,10,7,8 canales. Faltan perfil vivo, tipo PCM, orden de canales y propiedad. Los anillos SpeechSink capturados no demuestran que otro cliente pueda leerlos. No configurar mono24k por semejanza ni apropiarse de AndroidAutoSink.

**Alternativa de texto BMW.** ExternalDialogService2 (63920,v1.0,instancia128) registra un cliente con UUID y recurso de nombre; ExternalDialogInstance2 (63918) puede publicar intents con `utterance`. No es PCM ni dictado libre confirmado. Hmi8 SHA-256 `7aa4f8d007ce505fada5572a9643f542e8f8056e7d0ac3d25acc524607d30e20`, `DevExternalDialogInstance::startRecognition` `0x9cf3ce0`: exige instancia activa; `0x9cf444b` resuelve el recurso de texto, `0x9cd7e50–0x9cd7e6f` activa el diálogo y `0x9ce75bb` comprueba el caso eDIALOG. Quedan por validar reglas y convivencia con el asistente original. No llamar al reconocedor global ni inventar un grupo de intents.

**Siguiente prueba preparada.** `tools/assistant-runtime/inspect-microphone.js` es manual y no se empaqueta. `--verify RUTA_CATALOGO` verifica cuatro contratos sin acceso al coche. Con autorización vigente y `--read --sdk RUTA_ABSOLUTA_SOMEIP_BUILDERS` consulta únicamente getters de Recognizer2 (o Recognizer si no está disponible), ExternalDialogService2 y SpeechProjectedMode. Sin setters, registro, start/abort, resultados de voz, nivel de micrófono ni captura PCM. Acota listas a64, omite texto arbitrario y solo informa si hay app activa, sin su nombre. Devuelve los proxies mediante `shutdown()` y limita la ejecución a45s. Catálogo contrastado: SHA-256 `a892d3143d75477fe573718beec33e837f7ac6a64a900dbb122ce20660ab2f61`.

Los getters informan capacidades; `MESSAGE_DICTATION` no acredita permiso para una app. Una prueba posterior que active/capture voz requiere autorización específica.

**Consulta física autorizada del 15-11-2026.** SSH de solo lectura, sin instalar, reiniciar, activar reconocimiento ni capturar audio. Se resolvió la ruta elegida por Windows hacia Npcap ligando solo el cliente SSH a Ethernet; no se cambió la red global. La unidad no tiene `/usr/bin/arecord` ni `aplay`; `/proc/asound/pcm` anuncia únicamente BT Playback1/2 y BT Capture1/2. No expone `hw_params/status` por substream en ese árbol. `natp` tiene mapeado `SpeechSink_CF_2MIC_6REF`, además del servidor AlsaRoutingAdapters; es evidencia del perfil abierto, no de PCM recibido ni de disponibilidad para un segundo cliente. El formato estático corresponde a ocho canales a24kHz; tipo de muestra, orden y exclusividad siguen pendientes.

La sonda usó contratos generados en el PC con el generador original, transportados en memoria por stdin y restringidos por `nativeBuilders` a getters verificados, sin métodos/setters/eventos. Catálogo vivo con el mismo SHA-256 indicado arriba. Resultado repetido: Recognizer2 no disponible en el plazo de consulta; Recognizer v6 sí. `availableUsecases=[NOT_ACTIVE,DIALOG,WAKE_UP_WORD]`, `currentUsecase=WAKE_UP_WORD`, `recognizerState=IDLE`, idioma `SPANISCH`, `intentsForApplications=[]`. ExternalDialogService2 disponible sin app activa. SpeechProjectedMode disponible, `voiceAssistanceActive=false`, `alwaysOnMicAvailable=true`. No se anuncia MESSAGE_DICTATION en ese estado; idioma de dictado anunciado no equivale a capacidad de dictado habilitada. Tampoco la disponibilidad de proyección concede acceso PCM.

Después de `shutdown`, el binding mantuvo vivo el primer proceso de consulta. Se retiró únicamente esa sonda comprobando PID, argumentos y padre. El callback asíncrono de stdout tampoco terminaba en esta unidad; el informe acotado usa ahora `fs.writeSync` y salida explícita tras cerrar proxies. La comprobación posterior de cierre terminó con código0. No quedaron archivos de ensayo en la MGU. Evidencia privada en `MGU21-20261115-microphone`; copia de `natp` SHA-256 `0129f85bb3d5f9877300a938df027b977423b44b5e3f6f2eaacab10f8856bf42` para investigar sin ENET. El micrófono sigue sin integrar.

**Verificación local:** 452/452 pruebas generales; regresión de foco/PCM, aviso local sin conexión a proveedor y sonda limitada a getters con liberación, rechazo de IDs cambiados y cierre si falta servicio. Sintaxis Node8.16.2 en servicio, asistente, audio y sonda; carga de los módulos que no arrancan servicio. PCM de prueba: 96000 bytes mono24k→384000 bytes estéreo48k en receptor local. Captura simulada del aviso revisada. Ni estas pruebas ni las consultas demuestran micrófono/altavoces funcionando en el i4.

## Fuentes y reproducción

Referencia de solo lectura: `D:/Usuarios/javie/StudioProjects/BMWLauncher/app/src/main/java/com/car/bmwlauncher/assistant/`: `AssistantPreferences`, `AssistantVoice`, `AssistantRealtimeTools`, `DriveHubAssistantBridge`, `OpenAiRealtimeSession`, `GeminiLiveSession`; cifrado en `security/ApiKeyCipher.java`.

Documentación primaria: [OpenAI Realtime](https://developers.openai.com/api/docs/guides/realtime-conversations), [Gemini WebSocket](https://aistudio.google.com/docs/live-api/get-started-websocket), [contratos Gemini](https://aistudio.google.com/api-reference/live).

```powershell
node --test emulator/split/assistant.test.js
node --test emulator/split/*.test.js
node tools/Previsualizar-Asistente.js
node tools/Probar-AudioAsistente.js RUTA_COMPLETA_FFMPEG_WINDOWS
```

La prueba PCM exige convertir 96000 bytes mono a 24 kHz en 384000 bytes estéreo a 48 kHz recibidos por un proceso de prueba. No son altavoces. La previsualización genera diez capturas simuladas de día/noche y verifica que DriveHub y la franja inferior permanecen iguales.

Reversión: restaurar el motor anterior mediante el procedimiento habitual de versiones, conservando IDs. No se modificó el coche ni la referencia Android. El almacén privado es independiente del componente: conservarlo o eliminarlo expresamente, nunca incluirlo en una publicación.
