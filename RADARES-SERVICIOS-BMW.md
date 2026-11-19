# Radares y servicios de tráfico BMW · MGU21

Investigación local de 14-11-2026 sobre el catálogo del firmware 036.010.004. Este documento describe interfaces candidatas y comprobaciones pendientes; no acredita recepción de radares en BMWLauncher.

## Resultado y suscripción

El usuario observó avisos de cámaras en el cuadro/HUD y los atribuyó a Traffic Camera Information (TCI). La captura posterior de **Contratado** no muestra TCI. Queda por identificar el origen de los avisos y comprobar si los eventos `SpeedCamera` del navegador exponen esa información a otra aplicación.

BMW ofrece TCI como un servicio activable para vehículos compatibles. No se ha encontrado ni verificado un endpoint público que permita descargar sus datos sin contratación. Un método local accesible, una caché o un evento de navegación no prueban acceso al backend sin suscripción. Para interpretar una respuesta hay que contrastar su origen con el estado comercial del vehículo en el momento de la prueba.

Fuentes primarias consultadas:

- [TCI en BMW España](https://www.bmw.es/es/shop/ls/dp/Base_Safetycam_es): oferta del servicio y avisos de cámaras fijas y semáforos; disponibilidad según vehículo/mercado.
- [Condiciones ConnectedDrive de BMW](https://customer.bmwgroup.com/pm2/pm-document-service/api/v1link/documents/policyName/BMW_CONNECTED_DRIVE_TAC/GB/PDF?KeyId=f195e93a-6bbd-46f3-b762-6cf0bea480b0&language=en): descripción de TCI y activación; documento británico, no prueba de todas las condiciones comerciales españolas.
- [Anuncio original de HERE y BMW, 2020](https://assets.here.com/x7rx8ayph7ee/4fe634fc-8ded-4a43-8568-cbbc47f452c0/2d14631f96656ce441c6f0a99496cea7/20201014_BMW_Selects_HERE_and_Cedar_Electronics_to_Deliver_Traffic_Camera_Information_Service_FINAL.pdf): integración histórica de HERE Safety Cameras y datos de Cedar en EE. UU. No demuestra el proveedor actual en España ni una API pública de BMWLauncher.
- [RTTI en BMW España](https://www.bmw.es/es/shop/ls/dp/Base_RTTIOffer_es): información de tráfico y cálculo de alternativas. Es un servicio distinto de TCI.

## Vigencia y activación local de RTTI · 15-11-2026

BMW España describe RTTI como un servicio en la nube que se provisiona al vehículo por vía inalámbrica. Puede figurar dentro de un paquete. En la pestaña **Disponible** del i4 aparecen Connected Package Professional (129 €), TCI (24,20 €), RTTI (70 €) y actualización de mapas (90 €). En la captura de **Contratado** aparecen el asistente de luz de carretera, el control de crucero activo y los Servicios Remotos, todos activados con vigencia ilimitada. Ninguna de las cuatro ofertas aparece contratada en esa pantalla. Las capturas no muestran historial de caducidad, duración de las ofertas ni contenido del paquete. [Ficha RTTI](https://www.bmw.es/es/shop/ls/dp/Base_RTTIOffer_es) · [Paquetes digitales](https://www.bmw.es/es/shop/ls/dp/Digital_Packages_es) · [Tienda ConnectedDrive](https://www.bmw.es/es/shop/ls/cp/connected-drive)

El firmware distingue el interruptor local de información de tráfico (`tiSwitch`), la privacidad de tráfico online (`onlineTraffic`) y la disponibilidad local de la función (`Configuration.features[ONLINE_TRAFFIC]`). Hmi8 tiene un controlador de tráfico (`CDevNaviTrafficInfo2::setTrafficInformationOn`, `0x54ff460`) y un controlador separado de privacidad (`CNaviSettingsDataPrivacyActivity::onOnlineTraffic`, `0x5dac630`, actualiza la selección del control). La ruta de actualización de provisión (`CDevProvisioning::updateProvisioning`, `0x69712d0`) llama a `triggerUpdate` y obtiene el proxy de la unidad telemática. Estos hallazgos proceden de símbolos y desensamblado local.

El catálogo declara el evento `SfaFeature.featureStatusChanged` con ID numérico y estado de la función. Falta un mapeo verificado de RTTI a un ID de SFA y la evidencia que vincule ese estado con su vigencia comercial. No se ha encontrado una vía local verificada que conceda una suscripción RTTI caducada o habilite su flujo online. Activar el interruptor del navegador es una prueba pertinente cuando BMW ya concede acceso al servicio. Una prueba comercial, si la ofrece BMW para ese i4, permitiría comparar el estado anterior con la recepción tras la activación.

### Lectura en el i4

Consulta puntual por ENET/SSH autorizada el 15-11-2026. Los clientes se ejecutaron desde stdin y cerraron sus proxies, sin instalar ni cambiar ajustes. Se guardaron solo estados y recuentos.

| Lectura | Resultado en el i4 |
| --- | --- |
| `Configuration.features[ONLINE_TRAFFIC]` | `NOT_AVAILABLE` (1), presente en un mapa de 22 funciones. |
| `PrivacySettings.onlineTraffic` | `available=false`, `enabled=true`, `confirmed=true`. |
| `TrafficInformation2.tiSwitch` | `true`. |
| `TrafficInformation2.currentServiceStatus` | `ON_GENERIC` (2). |
| `TrafficInformation2.receptionStatus` y `NavigationStatus.trafficReceptionStatus` | Ambos `NO_MESSAGES_AVAILABLE` (4). |
| `NavigationStatus.trafficLine` | 0 elementos en la consulta. |

El interruptor ya estaba encendido. En esa lectura el tráfico online figuraba indisponible y no había mensajes, en consonancia con la ausencia de RTTI en la captura de **Contratado**. Sigue sin determinarse si RTTI tuvo vigencia anteriormente. Si se activa desde la tienda, repetir las mismas lecturas y contrastar con una incidencia reciente en BMW Maps. La presencia de `TPEG`, una respuesta vacía o `MESSAGES_AVAILABLE` por sí solos dejan sin determinar la fuente de los datos o el estado del contrato.

Verificado estáticamente contra el catálogo 036.010.004 (SHA-256 `a892d3143d75477fe573718beec33e837f7ac6a64a900dbb122ce20660ab2f61`) mediante aserciones de getters, instancia y método en `Configuration`, `PrivacySettings`, `TrafficInformation2`, `NavigationStatus` y `DataProfile`. REA abrió el ELF del proxy de navegación (SHA-256 `58faa98578a5e85091c661dc9cf6cf13574eeaa8d8c3fae5f31f5fb96ac3a8d7`), sin proveedor de análisis profundo en esa sesión. El contraste de Hmi8 se hizo con Capstone 5.0.9 sobre el ELF indicado más abajo. La unidad tenía definiciones OAP instaladas para Privacidad y `NavigationStatus`. Las otras dos se construyeron en memoria a partir del catálogo y se usaron solo para los getters indicados. El primer esquema de `Configuration` fue rechazado al crear el proxy. Se corrigió el descriptor del valor del mapa (`v`) siguiendo un mapa del OAP instalado y se obtuvo una respuesta válida.

### Viabilidad de activación temporal por ENET

- **RTTI.** `Configuration.features`, `TrafficInformation2.currentServiceStatus` y `receptionStatus` son campos sin setter en 036.010.004. `tiSwitch` sí admite escritura y ya estaba en `true`. `CDevProvisioning::triggerUpdate` (`0x6970ee0`) registra el motivo de actualización y llama al proxy de provisión. `Provisioning.updateProvisioning` recibe una causa y no devuelve una licencia. `Provisioning.setProvisioning` recibe provisión serializada. La firma no especifica validación, persistencia ni alcance en el proveedor. No se ha identificado una orden de prueba temporal de RTTI. BMW suministra los datos en la nube. [Activación oficial de RTTI](https://www.bmw.es/es/shop/ls/dp/Base_RTTIOffer_es)
- **TCI y SFA.** `SfaFeature` publica cambios de estado y permite resincronizar. `SfaSubFeature.triggerAction` necesita un ID de función y subfunción. En Hmi8, `CDevSafeFeatureActivation::NewFeatureEventCalled` (`0x6982c90`) recibe estados de DFAP y los aplica a su modelo. Falta un enlace comprobado de esas interfaces con TCI y RTTI. La tienda pública anuncia una prueba de TCI. Falta comprobar si se ofrece al BMW ID del i4. [Tienda ConnectedDrive](https://www.bmw.es/es/shop/ls/cp/connected-drive) · [Activación de TCI](https://www.bmw.es/es/shop/ls/dp/Base_Safetycam_es)
- **Mapas y Professional.** BMW admite una instalación de cartografía por USB para un vehículo habilitado y un código válido cuando corresponde. Professional agrupa varios servicios. La oferta concreta y sus plazos se verifican en la ficha vinculada al coche. [Actualización de mapas](https://www.bmw.es/es/shop/ls/dp/Base_MapUpdate_es) · [Requisitos de actualización USB](https://www.bmw.es/content/dam/bmw/marketES/bmw_es/footer/BMW_CD_TC_ES-ES_2023.11.pdf) · [Paquetes digitales](https://www.bmw.es/es/shop/ls/dp/Digital_Packages_es)

El firmware de navegación contiene un decodificador de TPEG y el parámetro de ensayo `ti-test-msg-duration`. Los comentarios de `etc/navcore-euusrow/onoff.ini` y `onoff_vdt.ini` describen un cambio en el tiempo de caducidad de mensajes TPEG y reservan el ajuste para pruebas fuera del vehículo. Las cadenas de `NavigationBasic` muestran que el decodificador recibe un flujo de bytes. Eso deja abierta una reproducción controlada con una fuente de ensayo, separada del acceso a datos recientes de RTTI. No se ha ejecutado una reproducción ni se ha probado recepción online sin contrato.

Comprobaciones locales de seis interfaces del catálogo con Node, tres funciones de Hmi8 con Capstone y los dos INI de la extracción privada. No se volvió a conectar al i4 para revisar estas rutas de activación.

### Refresco de provisión por ENET · 15-11-2026

Con autorización del usuario se consultó el estado anterior, se pidió el refresco normal con causa `USER_UPDATE` y se volvieron a consultar los mismos getters. Las sondas Node se ejecutaron desde stdin y cerraron los proxies. Sin compras, instalación, reinicio ni cambios en los ajustes de tráfico o privacidad.

- **Provisión de la MGU.** `Provisioning.updateProvisioning`, servicio 45152, instancia 1 y método 11, respondió. El getter pasó de `UPDATE_SUCCESS` a `UPDATE_ACTIVE` tras la solicitud y volvió a `UPDATE_SUCCESS` a los 1,432 s. La unidad siguió indicando origen `OTA`. `lastUTCTimestamp` devolvió cero antes y después, por lo que no proporciona una fecha de contacto con el backend para esta prueba.
- **Unidad telemática.** El desensamblado de `CDevProvisioning::updateProvisioning` confirma una segunda llamada cuando existe el proxy de la ECU. Se reprodujo una vez con `ProvisioningTelematicECU.updateProvisioning`, servicio 45212, instancia 1 y método 1. El método respondió en 30 ms. Durante los 16 s de observación el estado de provisión de la MGU permaneció en `UPDATE_SUCCESS`.
- **RTTI y TCI.** Después de ambas llamadas se mantuvieron `ONLINE_TRAFFIC=NOT_AVAILABLE`, receptor `ON_GENERIC` sin mensajes e interruptor encendido. El usuario comprobó que TCI seguía sin contratar en la tienda. El catálogo no aportó una señal local específica de vigencia de TCI. El éxito del refresco acredita la operación de provisión observada y en este ensayo no cambió la disponibilidad de RTTI ni el estado comercial visible de TCI.

El 15-11-2026, las fichas públicas españolas de RTTI y Connected Package Professional mostraban contratación y el usuario indicó que no veía ninguna opción de prueba a 0 € para su i4. La prueba pública de Digital Premium corresponde a BMW Operating System 9 y posteriores. Una oferta adicional para ese vehículo queda pendiente de confirmación de BMW ConnectedDrive. [RTTI](https://www.bmw.es/es/shop/ls/dp/Base_RTTIOffer_es) · [Connected Package Professional](https://www.bmw.es/es/shop/ls/dp/bmw_connected_package_professional_es) · [BMW Digital Premium](https://www.bmw.es/es/digital-services/bmw-connecteddrive.html)

## Interfaces locales identificadas

Los nombres siguientes pertenecen al espacio `de.bmw.infotainment.navigation`, salvo Privacidad. Se contrastaron con el catálogo privado del i4. Los contratos del catálogo no acreditan permisos OAP, disponibilidad en ejecución ni procedencia online.

| Interfaz | Servicio / versión / instancia | Lectura candidata | Alcance y límite |
| --- | --- | --- | --- |
| `guiding.GuidanceEventList` | 64283 / 5.1 / Main_Instance=128 | `queryContent`, método 4 | Consulta puntual con filtros de radares, incidencias y flujo. No registrar ni modificar vistas del HMI. |
| `traffic2.TrafficInformation2` | 64313 / 4.0 / Main_Instance=128 | `currentServiceStatus`, `receptionStatus`, `tiSwitch` | Estado del receptor; `tiSwitch` solo se lee. TPEG no demuestra por sí solo conexión RTTI por internet. |
| `configuration.Configuration` | 64292 / 2.0 / Main_Instance=128 | `features` | Disponibilidad de funciones; no equivale a un comprobante de suscripción vigente. |
| `dataprofile.DataProfile` | 64307 / 1.2 | `getTrafficFlows` | Perfil de flujo y retrasos. Escalas y relación con la geometría todavía pendientes. |
| `de.bmw.infotainment.dataprivacy.privacysettings.PrivacySettings` | 45172 / 1.1 / instancia 1 | `onlineTraffic` (getter 11), `onlineRoutes`, `onlineDestinationAndDynamicPOI`, `onlineNavigation` | Permisos de privacidad; comprobar disponibilidad y permiso OAP en ejecución. |
| `navigationstatus.NavigationStatus` | 45215 / 1.0 / instancia 1 | `trafficReceptionStatus` (getter 7), `trafficLine` (getter 6) | Estado y flujo publicados. Confirmar contexto, procedencia y vigencia de la muestra. |

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
