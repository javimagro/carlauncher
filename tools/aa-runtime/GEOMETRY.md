# Contrato de geometría MAIN

El soporte está preparado, sin activación desde `service.js` ni configuración de
usuario. Sin una confirmación interna se conserva exactamente el perfil actual:
vídeo fuente 1920×1080, crop `[0,260,1920,560]`, salida I420 1536×448. Su fallback
decodifica 1536×864 y copia tres planos contiguos; no se añaden bucles de filas JS.

El futuro adaptador puede proporcionar a `createIntegration`:

```js
{
    resolveGeometryProfile: function (identity, epoch) {
        // Esperar geometría MAIN observada y confirmada en ESTA sesión.
        // No usar una respuesta de otro teléfono, proceso o conexión.
        return geometryObservationFor(identity, epoch);
    }
}
```

El resultado es `undefined` para conservar el perfil actual, o un objeto interno:

```js
{
    display: 'MAIN', confirmed: true,
    x: 376, y: 250, w: 1168, h: 580,
    width: 1168, height: 580
}
```

El ejemplo solo define el formato; **no acredita que ese perfil haya sido
negociado ni probado físicamente**. `confirmed` es una atestación del adaptador,
no una verificación del teléfono ni una opción editable por el usuario. El
adaptador futuro debe ser propietario de la solicitud, observación de la
configuración, confirmación de geometría en la misma sesión y restauración;
resolver la promesa no realiza ninguna de esas operaciones por sí mismo.

`UpdateUiConfig` es bidireccional: `0x8009` va de la unidad al teléfono y
`0x800A` del teléfono a la unidad. El análisis estático acredita esas direcciones
y un esquema compartido, no una pareja petición/respuesta ni tráfico observado.
Por tanto, un callback, aunque Cinemo lo denomine `Reply`, no acredita por sí solo
un ACK transaccional de nuestra solicitud. La activación requiere observar la
configuración y confirmar que la geometría corresponde a la sesión actual.
Fuente: [auditoría primaria de UpdateUiConfig, revisión 61eab61](https://github.com/mrmees/open-android-auto/blob/61eab61c5f9968154ff1a80faa8c0a427b208479/oaa/video/UpdateUiConfigRequestMessage.audit.yaml).

- El resolutor se llama de nuevo antes de cada adquisición/recuperación, con
  identidad de captura copiada e inmutable y un `epoch` nuevo. Tiene un límite
  de 4 s; ocultar/cerrar cancela la espera y descarta las respuestas tardías.
- Como alternativa para un llamador que ya haya observado y confirmado la
  geometría en esa misma sesión, `geometryProfile`
  suministra una sola confirmación al construir la integración. Se consume una
  vez; otra adquisición exige confirmación nueva. No se mezcla con el resolutor.
- Crop y salida requieren enteros pares, origen no negativo, tamaño mínimo
  2×2, fuente exacta 1920×1080 y crop dentro de ella. La salida no aumenta el
  tamaño del crop y conserva su proporción exacta. Si no se dan `width/height`,
  se usa `w/h`. Máximo: 1920×1080, 3.110.400 bytes I420 por cuadro.
- Los perfiles distintos del actual requieren el filtro `crop` nativo de
  FFmpeg. No se reutiliza el fallback de tres copias para crops parciales.
- `player.start(identity, changed, profile)` fija el perfil de esa generación.
  El worker lo incluye en el mensaje `video`; el supervisor exige coincidencia
  exacta antes de registrar la superficie. Un cambio tardío falla y cierra.
- `frame.geometry` contiene la geometría inmutable validada. Dibujo y toque
  usan el mismo ajuste proporcional; no se asume un crop para frames que no lo
  incluyan. Cambiar de frame durante un gesto envía cancel con el punto anterior.

No cambia la transformación de coordenadas de `aa-input` hacia Hmi8 ni la
captura AAF1 limitada a MAIN. Antes de activar otro perfil será necesario
comprobar también que la geometría táctil real sigue siendo la esperada.

Regresiones en `aa-playback.test.js`, `aa-ui.test.js` y `aa-lifecycle.test.js`:
proporción y mapeo, tamaños/planos I420, perfiles inválidos, crop nativo, perfil
inmutable por generación, confirmación vencida/tardía y cancelación de gesto. La validación
de Windows y Node 8 no sustituye un ensayo del puente y del teléfono en la MGU.
