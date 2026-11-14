# Radio original de BMW en DriveHub

## Estado de la implementación

La versión **0.2.10 de prueba** sustituye la tarjeta de demostración por un cliente del sintonizador **FM/DAB del coche**. No descarga emisoras de radio IP, no usa FFmpeg ni abre una salida PCM. La fuente se activa mediante MediaSource y la emisora mediante TunerFmAmDab. BMW conserva el audio, el volumen, los avisos y la política de interrupciones. **Todavía falta verificar estas llamadas y el sonido en el i4**; las pruebas locales verifican contratos y comportamiento, no recepción ni altavoces.

Se mantiene la tarjeta estrecha, el fondo diagonal del carrusel y la referencia visual de DriveHub Android. Tiene vista de reproducción, lista desplazable, foco, filtros, favoritos, logo, metadatos y animación de espectro. No se altera el espacio del mapa ni la franja inferior.

## Evidencia y límites

**Corrección local 0.2.11, aún sin publicar:** se procesan las listas completas e incrementales de `dataStationList` y se solicita su difusión después de suscribirse. Cada lista tiene su propia revisión; una notificación de favoritos no descarta la consulta FM/DAB. Un fallo de una lista no impide consultar las demás. Los logos se extraen de `ByteBufferData.data`, con comprobación de firma y tamaño, y se consulta primero la caché BMW `TunerFmAmDabMetadata` (45118, mayor 2, instancia 1) con retorno al sintonizador. Este servicio es opcional; no puede impedir la lectura ni la sintonización.

La investigación local confirmó en Hmi8 que `onStationListChanged` (`0x67aff00`) distingue la actualización incremental (ON) de la completa: llama a `updateExistingList` (`0x67af3f0`) o a `replaceExistingList` (`0x67ae3e0`). `requestStationList` está en `0x67a7200`. Son observaciones de desensamblado Capstone y símbolos de la copia con el hash indicado abajo. REA identificó el ELF, pero volvió a indicar `provider_unavailable` para pseudocódigo; no se ha decompilado por completo ni conectado al coche en esta revisión.

- Catálogo SOME/IP de la copia MGU21 **036.010.004**: `TunerFmAmDab`, servicio **45108**, versión mayor **2**, instancia **1**. Hereda `TunerGeneric`; sus métodos no aparecen en el nodo derivado y hay que resolver `extends` al verificar permisos.
- `getStationListMetaData(listType, pictures, epgDataScope, startPosition, length)` devuelve las filas; `selectStation(listType, dataBaseIdentifier, positionIndex)` selecciona una fila. Se conservan el identificador y la posición de BMW, sin sustituirlos por el índice de nuestra lista filtrada.
- Listas: **2** FM/DAB recibibles, **7** presintonías de radio, **10** emisoras destacadas por BMW. No se seleccionan AM, tráfico, televisión, satélite ni fuentes IP desde esta tarjeta.
- `currentStationFmDab` proporciona la emisora, radio text, imágenes y calidad de recepción. `fieldStrengthDbuv` mide radiofrecuencia: **no es amplitud del audio**.
- `MediaSource`, servicio **45249**, versión **1**, instancia **1**, publica `sources` y `activeSourceId`. Se elige un identificador anunciado y seleccionable de tipo `TUNER_RADIO` o `TUNER_FM`; no se adivina una cadena de origen. `selectSource` acepta resultados 0 (sin error) y 2 (ya seleccionada). Solo después se solicita la emisora. Una confirmación del método no significa que se haya oído sonido.
- Binario **Hmi8**, SHA-256 `7aa4f8d007ce505fada5572a9643f542e8f8056e7d0ac3d25acc524607d30e20`: símbolos y desensamblado de `CDevEntTunerAmFmDab::selectStation` en `0x62cb470`, sobrecarga en `0x62cb4c0`, implementación genérica en `0x67a4a00`, stub `CEntMediaSourceStub::selectSource` en `0x6202a90`. La ruta de Hmi8 conserva tipo de lista, identificador y posición hasta la implementación genérica.
- La activación se ha seguido un paso más: `onMediaSourceSelected` (`0x61fb2e0`) pasa la fuente de radio a `openRadioSelectionBarMediaSource` (`0x61f6c90`), que llama a `executeNoOpenStateOrICPlaylist` (`0x61efad0`). Esto respalda el uso de MediaSource para activar audio sin abrir su pantalla; la permanencia de BMWLauncher debe comprobarse en la MGU.
- REA identificó el ELF x86-64. La solicitud de pseudocódigo devolvió `provider_unavailable`: no hay proveedor compatible configurado para ese ELF en Windows. La investigación usa el catálogo, símbolos LLVM y desensamblado Capstone local; **no se presenta como código fuente original ni como decompilación completa**. El firmware y las extracciones permanecen fuera del repositorio.

## Referencia visual y funciones

La referencia de solo lectura es `D:/Usuarios/javie/StudioProjects/DriveHub`: `content_radio.xml`, `overlay_card_radio.xml`, `item_radio_station.xml`, `RadioFragment.java`, `RadioStationNameColor.java` y `RadioSpectrumView.java`. Las capturas `radio_all_selected.png` y `drivehub_radio_after_fix.png` permiten comparar distribución, selección, colores y las cuatro categorías.

- **Emisoras:** lista BMW con hasta cuatro filas visibles; identificador estable durante cambios de foco. Giro recorre filas, pulsación solicita la emisora, deslizamiento vertical recorre la lista. Deslizamiento horizontal conserva el cambio entre tarjetas.
- **Filtros:** corazón (favoritos), estrella (destacadas BMW), música y deportes. Los grupos se combinan por unión; favoritos restringe el conjunto. Música/deportes usan PTY únicamente cuando BMW declara `PTT_RDS_DAB`; no se aplica la tabla europea a RBDS. [ETSI TS 101 756, tabla de tipos de programa](https://www.etsi.org/deliver/etsi_ts/101700_101799/101756/02.04.01_60/ts_101756v020401p.pdf).
- **Favoritos:** se leen las presintonías/indicadores originales. El corazón y la pulsación larga guardan una preferencia **local de BMWLauncher** en `radio.json`; no sobrescriben presintonías BMW. Se usa banda y service identifier cuando existe, con frecuencia/nombre como alternativa, en vez de persistir solamente un identificador temporal de base de datos.
- **Logos:** PNG/JPEG facilitados por BMW, hasta 96 KiB por imagen; se piden solo para las filas visibles o la emisora actual. Se decodifican fuera del hilo gráfico, con máximo 20 imágenes de 160 × 160 en memoria. Sin imagen se muestra el pictograma de radio, nunca el logo de otra emisora ni una descarga IP.
- **Programa:** radio text, artista y título cuando existen. Las peticiones de lista usan `EPG_NOW_PLUS_1_EVENT`; el primer evento de esa respuesta permite mostrar nombre y horario. La barra usa `epgReferenceTime` del coche, admite medianoche y desaparece si no hay horario/reloj vigente o el intervalo ya ha terminado. Se debe contrastar disponibilidad y orden de la EPG en la unidad. No se consulta una guía de radio online ni se inventan horarios.
- **Vúmetro visual:** el `RadioSpectrumView` de DriveHub genera valores pseudoaleatorios con suavizado; no analiza PCM. Aquí se reproduce esa animación de 64 barras, turquesa, a un máximo de 20 actualizaciones/s, únicamente mientras la tarjeta es visible y BMW anuncia radio activa sin pérdida de recepción. No certifica que el audio esté audible: volumen, mute o una interrupción de BMW pueden silenciarlo. No existe una señal de amplitud verificada en esta implementación.
- **Controles:** pulsación abre lista; en lista sintoniza. Pulsación larga cambia favorito. Arriba enfoca filtros; abajo devuelve foco a filas; giro recorre el grupo enfocado. Izquierda cierra primero la lista y después permite ir a la tarjeta anterior; derecha va a la siguiente tarjeta. El logo solicita escuchar la emisora actual. No se simula una pausa del sintonizador ni se modifica el mute global del coche.

## Arquitectura y protección frente a fallos

`radio-datos.js` define y normaliza contratos. `radio-bmw.js` posee proxies, getters, suscripciones y órdenes. `radio-listas.js` conserva listas completas, actualizaciones por identificador y revisiones independientes; impide que una respuesta de una consulta antigua sustituya una notificación nueva. `radio-model.js` valida el transporte. `radio-ui.js` posee foco, filtros, favoritos, caché de imágenes y la animación; libera las imágenes sustituidas, descartadas o al cerrar. La pertenencia a favoritos/populares y la deduplicación usan la identidad de emisora, también cuando BMW cambia el identificador entre listas. `radio-view.js` dibuja. `drivehub-state.js` conserva los gestos del carrusel y delega la interacción interna de Radio.

El OAP abre el adaptador al hacerse visible; lo cierra al ocultarse. Abrir, ocultar o cerrar la app **no inicia ni detiene la radio original**. La única escritura al coche es la selección explícita de fuente/emisora. No se toman recursos de audio propios ni canales de avisos.

Getters cada 5 s, sin solaparse por campo; las notificaciones más recientes ganan a un getter antiguo. La emisora y la fuente caducan en 15 s. La lista se pagina de 32 en 32 hasta el límite del catálogo (500 por lista), se refresca cada 30 s o al recibir cambios, y caduca en 90 s. Una modificación durante la paginación invalida esa lectura; una orden no usa una lista de otra revisión. Los reintentos de conexión son cada 10 s mientras la app está visible. El cierre dispone también proxies/suscripciones que se resuelvan tarde.

`/run/javi-carlab/radio.sock` usa el mismo control de propietario de los otros canales: modo 0600 y UID de BMWLauncher, un único cliente. Mensajes UTF-8 delimitados por salto de línea, máximo 1 MiB por estado y 4 KiB por orden; la serialización recorta listas excesivas y comunica `incomplete`. Una selección en curso bloquea otra selección. No se envía la orden de sintonización si se ocultó la app durante la activación de fuente. Se mantiene una sola consulta de imagen en curso y se descartan decodificaciones tardías. No se escriben preferencias ni firmware del sintonizador.

## Verificar y probar

```powershell
node --test emulator/split/*.test.js
node tools/Verificar-Radio-MGU.js "$env:TEMP/bmw-mgu21-knob/someip-interfaces.json"
node tools/Previsualizar-Radio.js
```

Las capturas se generan en `dist/radio-preview/` con emisoras y metadatos **simulados**. El comprobador compara píxeles del mapa y de la barra entre estados. El contrato se verifica contra el catálogo privado sin copiarlo al paquete. El enlace OAP local usa un donante sintético solo para verificar la construcción; el ZIP instalable distribuye fuentes propias y recibe el SDK de la unidad al instalarse.

Prueba pendiente en el coche, parado: abrir Radio con FM ya sonando; comparar emisora y lista con BMW; seleccionar otra por toque y rueda; pasar desde USB/Android Auto a una emisora; comprobar sonido, volumen, avisos y retorno. Contrastar logos, EPG, favoritos y categorías disponibles. Abrir otra tarjeta y salir con la casita: la radio debe continuar. Estas comprobaciones no se han realizado en esta sesión.

**Reversión:** instalar de nuevo la versión anterior de BMWLauncher y su Motor gráfico. No hay cambios de firmware ni configuración de audio que deshacer. Los favoritos propios permanecen en el archivo privado `radio.json`; no se han modificado los de BMW.
