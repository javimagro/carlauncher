# Radares y servicios de tráfico BMW · MGU21

Investigación local de 14-11-2026 sobre el catálogo del firmware 036.010.004. Este documento describe interfaces candidatas y comprobaciones pendientes; no acredita recepción de radares en BMWLauncher.

## Resultado y suscripción

El usuario confirma que Traffic Camera Information (TCI) está activo en su i4 y que ve sus avisos en el cuadro/HUD. La vía prioritaria es consumir la información que ya recibe esa MGU. Todavía no está demostrado que el servicio la exponga a otra aplicación, ni que los eventos `SpeedCamera` de navegación procedan de TCI.

BMW ofrece TCI como un servicio activable para vehículos compatibles. No se ha encontrado ni verificado un endpoint público que permita descargar sus datos sin contratación. Un método local accesible, una caché o un evento de navegación no prueban acceso al backend sin suscripción. Una respuesta satisfactoria del i4 actual solo demostraría el caso **con servicio activo**. No se desactivará su suscripción para ensayar el caso contrario.

Fuentes primarias consultadas:

- [TCI en BMW España](https://www.bmw.es/es/shop/ls/dp/Base_Safetycam_es): oferta del servicio y avisos de cámaras fijas y semáforos; disponibilidad según vehículo/mercado.
- [Condiciones ConnectedDrive de BMW](https://customer.bmwgroup.com/pm2/pm-document-service/api/v1link/documents/policyName/BMW_CONNECTED_DRIVE_TAC/GB/PDF?KeyId=f195e93a-6bbd-46f3-b762-6cf0bea480b0&language=en): descripción de TCI y activación; documento británico, no prueba de todas las condiciones comerciales españolas.
- [Anuncio original de HERE y BMW, 2020](https://assets.here.com/x7rx8ayph7ee/4fe634fc-8ded-4a43-8568-cbbc47f452c0/2d14631f96656ce441c6f0a99496cea7/20201014_BMW_Selects_HERE_and_Cedar_Electronics_to_Deliver_Traffic_Camera_Information_Service_FINAL.pdf): integración histórica de HERE Safety Cameras y datos de Cedar en EE. UU. No demuestra el proveedor actual en España ni una API pública de BMWLauncher.
- [RTTI en BMW España](https://www.bmw.es/es/shop/ls/dp/Base_RTTIOffer_es): información de tráfico y cálculo de alternativas. Es un servicio distinto de TCI.

## Interfaces locales identificadas

Los nombres siguientes pertenecen al espacio `de.bmw.infotainment.navigation`, salvo Privacidad. Se contrastaron con el catálogo privado del i4. Los contratos del catálogo no acreditan permisos OAP, disponibilidad en ejecución ni procedencia online.

| Interfaz | Servicio / versión / instancia | Lectura candidata | Alcance y límite |
| --- | --- | --- | --- |
| `guiding.GuidanceEventList` | 64283 / 5.1 / Main_Instance=128 | `queryContent`, método 4 | Consulta puntual con filtros de radares, incidencias y flujo. No registrar ni modificar vistas del HMI. |
| `traffic2.TrafficInformation2` | 64313 / 4.0 / Main_Instance=128 | `currentServiceStatus`, `receptionStatus`, `tiSwitch` | Estado del receptor; `tiSwitch` solo se lee. TPEG no demuestra por sí solo conexión RTTI por internet. |
| `configuration.Configuration` | 64292 / 2.0 / Main_Instance=128 | `features` | Disponibilidad de funciones; no equivale a un comprobante de suscripción vigente. |
| `dataprofile.DataProfile` | 64307 / 1.2 | `getTrafficFlows` | Perfil de flujo y retrasos. Escalas y relación con la geometría todavía pendientes. |
| `de.bmw.infotainment.dataprivacy.privacysettings.PrivacySettings` | Por verificar en el cliente elegido | `onlineTraffic`, `onlineRoutes`, `onlineDestinationAndDynamicPOI`, `onlineNavigation` | Consultar permisos; no aceptar términos ni modificar preferencias automáticamente. |

### Consulta de eventos

`queryContent` recibe `viewConfigs[]` y devuelve `GuidanceEventListError`, `viewContent[]` y `currentDistances`. La configuración contiene `viewport`, `options[]`, `minimumUpdateIntervalMs` y `segmentItemRasterLength`. El viewport contiene `startPoint`, `endPoints[]`, `maxElementCount`, `includedTypes[]` e `includedActiveTypes[]`.

- Punto de referencia `CCP=1`: posición actual del coche. Los desplazamientos por distancia se expresan mediante `shiftByDistance.meters`. El sentido y los límites efectivos de la ventana deben confirmarse con el consumidor original o una respuesta real.
- Filtros: `INCLUDE_SPEED_CAMERA=12`, `INCLUDE_TRAFFIC_EVENTS=8`, `INCLUDE_TRAFFIC_FLOW_ITEMS=9`.
- Errores: `NO_ERROR=0`, `UNKNOWN_VIEW_ID=1`, `INVALID_VIEW_PARAMS=2`. Una configuración inválida no significa falta de licencia.
- `ViewContent.eventsInView` contiene una unión tipada, con variantes `speedCamera`, `speedSectionCamera`, `trafficEvent` y `trafficFlowItem`, entre otras.
- Los radares incluyen información heredada de panel y recursos de icono. No hay un campo explícito común que garantice coordenadas, límite de velocidad o clasificación fijo/móvil/semáforo. No deducirlo de un identificador opaco ni descargar automáticamente la URL del icono.
- Hmi8 tiene accesores para `SpeedCamera` y `SpeedSectionCamera`. Es evidencia de capacidad del navegador, no de que TCI publique aquí sus avisos.

Para la primera prueba: consulta única y acotada, como máximo 32 eventos, sin temporizadores residentes ni cambios de configuración. Registrar aceptación/error, cantidad y variantes de eventos, con datos personales fuera del repositorio. No iniciar guiado para provocar un resultado sin una petición expresa del usuario.

### Estado de tráfico

`currentServiceStatus`: OFF=1, ON_GENERIC=2, TMC=3, TPEG=4. `receptionStatus`: SWITCHED_OFF=1, MESSAGES_REQUESTED=2, RECEPTION_NOT_POSSIBLE=3, NO_MESSAGES_AVAILABLE=4, MESSAGES_AVAILABLE=5, INVALID=255.

Los eventos selectivos `trafficMessageIdList` y `trafficMessage` permiten investigar mensajes individuales con `requestTrafficMessage`. Una implementación posterior debe limitar lista, concurrencia y duración; no descargar indefinidamente todos los mensajes. Las funciones online de `Configuration.features` incluyen ONLINE_TRAFFIC=20, ONLINE_ROUTES=21 y ONLINE_DESTINATIONS_AND_DYNAMIC_POI=60. Sus valores son NOT_AVAILABLE=1, DEACTIVATED=2 y ACTIVATED=3.

## Qué falta para identificar TCI

Las copias privadas actuales contienen Hmi8, bibliotecas y catálogo SOME/IP; no se ha localizado el paquete instalado de TCI. Antes de atribuirle una señal:

1. Con ENET/SSH autorizado, inventariar en lectura el componente de TCI instalado y su versión, permisos y dependencias.
2. Copiar a la carpeta privada únicamente sus recursos necesarios, sin publicar firmware, credenciales, VIN ni registros personales. Priorizar lectura por stdout, sin temporales remotos.
3. Seguir su consumidor de datos y distinguir backend, caché, entrega de avisos y dibujo del cuadro. Si usa una sesión autenticada, no reutilizar credenciales ni inventar endpoints para otra aplicación.
4. Comparar las respuestas del adaptador candidato con los avisos originales que observe el usuario. La ausencia de radares cercanos o de una ruta no es un rechazo de suscripción.

REA pudo abrir el ELF de Hmi8, pero el proveedor de análisis no estaba disponible para este entorno. Los hallazgos estáticos proceden del catálogo, símbolos y desensamblado local; no de pseudocódigo recuperado. Hmi8 SHA-256: `7aa4f8d007ce505fada5572a9643f542e8f8056e7d0ac3d25acc524607d30e20`.

## Intento de conexión del 14-11-2026

El usuario autorizó probar una petición de datos. Se intentó una conexión TCP al SSH guardado, vinculada a la dirección de Ethernet existente y con tiempo máximo de cuatro segundos. Resultado: `WinError 10065`, host no accesible. Windows confirmó `Ethernet: Disconnected`, enlace 0 bps; después el usuario confirmó que ENET no estaba conectado.

No se abrió SSH ni se envió ninguna consulta SOME/IP o petición al backend BMW. No hay una respuesta de datos, lista vacía ni rechazo de licencia que interpretar. No se modificaron red, permisos, suscripción, servicios ni archivos del coche.

## Referencia Carlinkit y criterio de integración

La base de referencia de Carlinkit contiene 2721 radares y contexto de vías con licencia/procedencia documentada en su catálogo. Se ha inspeccionado en una copia temporal privada; no se ha importado a BMWLauncher. Por petición del usuario, primero se investiga TCI.

La réplica visual y los avisos deben consumir un modelo con fuente, identidad, vigencia y unidades verificadas. Un límite desconocido no genera una alerta de exceso de velocidad. No llamar «TCI» a datos de BMW Maps sin confirmar su origen ni sustituir silenciosamente una fuente ausente. Los sonidos deberán utilizar una ruta multimedia legítima de la app y verificarse en los altavoces; no emplear canales de llamadas o seguridad.
