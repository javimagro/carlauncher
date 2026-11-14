# Guiado BMW en HUD y cuadro

Revisión local 0.2.11 del 14-11-2026. No publicada, instalada ni probada en el coche en esta sesión.

## Decisión y alcance

BMWLauncher inicia una ruta mediante `Guidance.startGuidance`, el guiado BMW existente. Su motor conserva el cálculo de la siguiente maniobra, distancia, fases, representación de cruces, carriles y carteles. No se añade un mapa HUD propio ni se calculan recomendaciones de carril a partir de nuestra polilínea.

Esta entrega incorpora la lectura de contenido nativo destinado al HUD y al cuadro y la configuración de cinco preferencias originales desde **Ajustes → HUD y cuadro**. No acredita todavía que toda la experiencia solicitada se reproduzca en el i4: hay que observar una ruta real iniciada desde BMWLauncher. La cartografía independiente del panel central sigue siendo otra integración pendiente.

| Petición | Integración local | Pendiente real |
| --- | --- | --- |
| Próxima maniobra y ejecución | Guiado BMW y observación de `HIGH_GUIDING` por destino HUD/IC | Comparar momento, distancia y presentación con BMW Maps |
| Mapa al aproximarse a un cruce | Observar `JUNCTION_VIEW` y `CITY_HIGHWAY_MAP`; ajuste original de cruces 3D en cuadro | Ver qué escenas ofrece y muestra este i4 en HUD y cuadro |
| Recomendación/animación de cambio de carril | Conservar la política original; permitir guiado BMW con otros contenidos seleccionados en el cuadro | Confirmar animación y pantalla efectiva; no se ha programado una animación sustitutiva |
| Carteles de autovía | Preferencia `signboardPopupsEnabled` y observación de `SIGN_POST_INFO` | El ajuste no fuerza el destino HUD; falta confirmar dónde lo presenta BMW |

No se reclama ningún destino `hud`, `guide` o `map` de Cluster renderer, ni se publican escenas o se cambian las escenas BMW. El widget existente de tiempo/telemetría sigue en su categoría propia. No hay evidencia de que deba desactivarse durante toda la ruta; hacerlo ahora sería una modificación especulativa. No se cambia automáticamente la selección de contenido del cuadro ni el modo del HUD.

## Controles y confirmación

El panel muestra disponibilidad del HUD y el tipo de contenido **anunciado** por BMW para HUD/cuadro. No dice que esos píxeles estén visibles. Solo considera contenido no preliminar, con configuración y contenido vigentes y `configSequenceId` coincidente. Una lectura ausente, inválida o caducada produce «Sin dato»; no se interpreta como desactivación.

Los botones controlan individualmente:

- `junction3dViewInKombiEnabled`: cruces 3D en el cuadro.
- `visualizationInKombiNonNaviEnabled`: guiado con otros contenidos del cuadro.
- `additionalInformationEnabled`: información adicional de navegación.
- `guidingPopupsEnabled`: avisos de maniobra BMW.
- `signboardPopupsEnabled`: carteles de dirección BMW.

Son preferencias del navegador original. Se escribe únicamente después de pulsar el botón, una vez, con el valor booleano solicitado, y se consulta de nuevo para confirmar. No se habilitan todas al arrancar, no se reenvían al reconectar, no se alteran rutas y no se restauran silenciosamente al ocultar la app. El usuario puede revertir cada ajuste con el mismo botón. Si no se conoce su estado, el botón permanece deshabilitado.

El modo reducido/individual, activación y selección de contenido del HUD siguen bajo control de iDrive. `statusSelectionDisplayHUD3` es una máscara cuyos bits no están interpretados: no se usa para modificarla ni concluir que la navegación está habilitada. Como contexto público, BMW documenta información de navegación en el HUD y contenido temporal dependiente de la situación para OS8.5; esa documentación no sustituye la comprobación del firmware de este i4. [BMW, contenido del HUD](https://faq.bmwusa.com/s/article/BMW-iDrive-Displays-Head-up-display-OS85-Displays-TLnVU?language=en_US).

## Contratos verificados

Catálogo privado del firmware MGU21 036.010.004, fuera del repositorio:

- `Guidance` 64282/128 v7.13: cinco atributos booleanos anteriores con getter/setter/notifier. `junction3dViewEnabled` es una preferencia distinta, llamada «InMap» por Hmi8; no se presenta como ajuste HUD.
- `GuidanceRenderedContent` 64284/128 v3.2: `registeredViews`, `getViewConfig({viewId})`, `getViewContent({viewId})`, `viewContentChanged({viewId,viewContent})`. Solo lectura; no se escribe el registro ni se crean/configuran vistas.
- `RenderedContentConfig.targetUI`: NONE=0, CID=1, IC=2, HUD=3. El nombre de una vista nunca decide a qué pantalla pertenece.
- `RenderedContentType`: NONE=0, HIGH_GUIDING=1, JUNCTION_VIEW=2, CITY_HIGHWAY_MAP=3, SIGN_POST_INFO=4, SAPA=5, TUNNEL=6, SCREENSHOT=7, NOTIFY=8. Se correlacionan secuencia, tipo y `preview`; no se exportan IDs de escena ni el payload original.
- `KombiIF` 46363/1: `statusHUDSelection`. Preparado=2, no preparado=1; valores sin señal/error no se convierten en un booleano. Modo y selección de mapa son estados separados.

`navegacion-pantallas.js` posee proxies, suscripciones y cola: dos lecturas concurrentes, máximo dieciséis vistas de IDs de 128 caracteres, consultas/reintentos cada cinco segundos y caducidad de quince. Descarta getters antiguos frente a notificaciones y respuestas de vistas retiradas/recreadas. Cerrar elimina nuestras suscripciones y proxies, sin detener guiado ni tocar escenas. `navegacion-bmw.js` añade `presentation` al canal existente. `navigation-displays.js` valida la estructura recibida y comparte el panel/etiquetas; el protocolo acepta OAP anteriores sin ese campo.

## Evidencia estática y límites

REA abrió NavController SHA-256 `f504557e86b7dbe49527008cf23ca4e7e834afb0027f2689cc22515299f7f400`; `procedure_pseudo_code` devolvió `provider_unavailable`: Ghidra no configurado y backend Windows sin soporte para el ELF. Se continuó con catálogo, símbolos y Capstone, no con pseudocódigo decompilado.

Hmi8 `7aa4f8d007ce505fada5572a9643f542e8f8056e7d0ac3d25acc524607d30e20` contiene setters de cruces en cuadro `0x5521f30`, guiado con contenido no navegador `0x5524870`, carteles `0x55233d0` e InMap `0x5522350`. El setter de carteles no acredita su destino HUD.

Los estilos descargados distinguen 1170 High Guiding HUD, 1190 Ego Map HUD, 1180 High Guiding IC y 1200 Ego Map IC. `guiding.json`, SHA-256 `ed6ba294d5ac560364e1ba6e6f7569f889ec249c03305e1003a9fdf74c548733`, contiene reglas de fase, zoom HUD y diferencias de carriles. Se conservan en el motor original, sin copiar umbrales al producto.

`RICServiceGuidance` y los tipos `LaneChangeHint`/`CCPLaneChangeHintInfo` acreditan contratos para carriles. **No se encontró `nav_didui` en las extracciones examinadas**; falta trazar el consumidor final y validar la animación en esta unidad. Las constantes JV/HG de `RIC_View_Defines.hpp` pertenecen a un recurso 35UP: no se utilizan como IDs de escena de MGU21.

## Pruebas y comprobación pendiente

```powershell
node --test emulator/split/*.test.js
node tools/Verificar-Navegacion-MGU.js "$env:TEMP/bmw-mgu21-knob/someip-interfaces.json"
node tools/Previsualizar-Navegacion.js
```

Resultado local: 175 pruebas correctas; diez nuevas cubren el observador, carreras/caducidad, límites, cambio explícito y confirmación de ajustes, cierre y toque. Verificados contratos, permisos y enums contra catálogo. Ocho módulos pasan sintaxis/carga Node 8.16.2. Veintidós capturas de navegación, cuatro del nuevo panel; DriveHub y barra inferior idénticos píxel a píxel. Enlace sintético de diecisiete módulos, solo prueba de empaquetado, no SDK operativo.

Prueba en el i4 pendiente: comparar la misma ruta desde BMW Maps y BMWLauncher; comprobar una salida, enlace de autovía, rotonda y cambio de carril. Registrar qué anuncia cada destino y qué aparece físicamente, incluido modo reducido/individual del HUD. Comprobar coexistencia con el widget y continuidad al ocultar/cerrar BMWLauncher. Si falta contenido, capturar el consumidor original `nav_didui` con una futura sesión autorizada. Este trabajo no ha conectado por ENET/SSH ni ha modificado el coche.
