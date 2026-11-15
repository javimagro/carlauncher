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

La salida usa la ruta multimedia de la app, cuya entrega a los altavoces del i4 sigue pendiente. Tampoco están validados foco, convivencia con Radio/TDT ni cancelación acústica de eco. Seleccionar voz y procesar PCM no demuestra conversación audible en el coche. Un fallo mantiene la respuesta escrita.

En el PC se comprobó una respuesta de texto autenticada con Gemini. En la MGU queda pendiente comprobar la conexión con ambos proveedores.

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
