# Telemetría del BMW i4 en MGU21

Primera inspección local sobre PSdZData 4.58.15 Full. El paquete `SWFL 000056EE 036_010_004` contiene el catálogo `/etc/oap/someip/someip-interfaces.json`. En los ELF del paquete `SWFL 000056E7` se encontraron símbolos de despliegue SOME/IP para el campo de autonomía eléctrica del cuadro y para el porcentaje de carga HV. El catálogo confirma nombres, tipos e identificadores de transporte. La disponibilidad, las escalas y la correspondencia con el cuadro del i4 se validan en la unidad.

## Lecturas para validar

| Dato | Interfaz y campo | Qué comprobar en el i4 |
| --- | --- | --- |
| Batería actual | `Efficiencytainment2.statusChargeOfBatteryHybrid` y `LSCDataSink.displayConditionHybrid` | Las dos estructuras contienen un valor de carga visible de alta tensión y tienen `255` como valor sin inicializar. Comparar ambas con el porcentaje del cuadro, también después de cargar. |
| Autonomía actual | `LSCDataSink.dataRangeDisplay` y `KombiIF.displayRangeElectricVehicle` | El primero distingue autonomía eléctrica de total e indica unidad y si se debe mostrar. `4095` es el valor por defecto. Comparar con los km que presenta el cuadro. |
| Consumo medio | `KombiIF.statusConsumptionAverageElectricVehicle` | Ofrece dos medias, BC1 y BC2, y el código de unidad. Comparar escala y periodo de cada media con Datos de viaje de BMW. |
| Distancia, duración y velocidad media | `BcPersonal.driveSegment` | Comprobar si publica el trayecto en curso o solo segmentos finalizados y cómo responde al reinicio del periodo de viaje. |
| Altura | `Positioning.rawPositionData` | Contiene `heightValid` y `height.rawLengthMeter`. Comprobar con fijación 3D y confirmar la referencia vertical antes de presentarla como altitud sobre el nivel del mar. |
| Temperaturas | `EnvironmentalInformation.ExteriorTemperature` y `Efficiencytainment2.statusBatteryTemperature` | Para exterior, Live Data usa `valor × 0,5 − 40` °C. Verificar esa escala y la de la batería en el i4. Ambas estructuras usan `255` como valor por defecto. |
| Consumo instantáneo y energía | `Efficiencytainment2.displayPowerDrive`, `Vehicle2.statusCarSpeed2` y `Vehicle2.highVoltageStorageInfoToExternal` | El catálogo identifica una cuota relativa de tracción o regeneración y valores de energía disponible y máxima. Falta una señal pasiva de potencia física con signo para obtener consumo instantáneo y acumular energía. La cuota relativa queda como lectura de diagnóstico. |

El catálogo denomina algunas interfaces `Hybrid`. La prueba debe decidir si se publican en el i4. La app eDrive de IterioDev 1.1.0 consulta el DID `DDBC` para el porcentaje y estima su autonomía. El perfil OBD del BMWLauncher Android para el i4 Gen5 usa `E5CE` para carga del pack, `E5C7` para energía disponible, `E54D` para voltaje y `E561` para corriente. Son antecedentes para una eventual comparación con OBD. La sonda usa el acceso a campos SOME/IP del SDK OAP. [eDrive de IterioDev](https://github.com/IterioDev/car-apps#edrive-iteriodev-edrive-idrive-8-only) · [Escalas de Live Data](https://github.com/cauliflowermossgrape/idrive7-apps/blob/main/apps/live_data/signals.js)

Si se obtiene potencia HV física, la estimación a partir de potencia y velocidad en km/h es `100 × potencia_kW / velocidad_km_h`. Se deben alinear las muestras, excluir velocidades próximas a cero y conservar el signo de la regeneración. La potencia medida en el pack puede incluir auxiliares. Batería y autonomía tras parada o llegada se calculan con una ruta, su consumo previsto y la recarga de cada parada.

## Verificar la versión de prueba

En la raíz del proyecto y con Node.js 18 o superior:

```powershell
node tools/Verificar-Telemetria-MGU.js 'D:/Usuarios/javie/BMW/psdzdata/swe/swfl/swfl_000056ee.bin.036_010_004'
node --test emulator/split/drivehub.test.js emulator/split/telemetria.test.js
node emulator/split/server.js --drivehub --telemetry
```

También se admite el catálogo JSON extraído. El script contrasta cada instancia, operación y campo con los permisos de solo lectura que se empaquetan en la app.

Desde la 0.2.5, el OAP consulta la velocidad cada dos segundos y se suscribe a sus avisos de cambio. Lee los demás campos que tienen getter cada diez segundos. Los que solo tienen notificador siguen por suscripción. Se envía un resumen cada segundo al renderizador y al cerrar se cancelan las consultas programadas y se liberan las suscripciones. De posición solo se recoge altura y validez de fijación. **Lecturas del coche** muestra la edad desde la última recepción. Un campo con getter aparece **Sin actualizar** si pasan tres periodos sin una muestra. [Lectura periódica de velocidad en el kit comunitario](https://github.com/cauliflowermossgrape/idrive7-apps/blob/main/kit/runtime/parked.js)

Para la velocidad se muestra `valor ÷ 64` km/h y se descarta `65535`, valor por defecto del catálogo. La escala procede de Live Data y queda por contrastar en movimiento con el cuadro del i4. Los demás valores del panel conservan sus formatos de diagnóstico. La franja de energía y las cifras de Trayecto se identifican como demostración. [Conversión de velocidad en Live Data](https://github.com/cauliflowermossgrape/idrive7-apps/blob/main/apps/live_data/signals.js)

## Validación en la unidad

El 11 de noviembre de 2026 la MGU del i4 confirmó por ENET que lleva `SWFL 000056EE 036_010_004`. Por SSH se comprobó que el catálogo instalado coincide byte por byte con el local.

- **Trayecto.** Se observó una oferta del servicio `BcPersonal` y su getter `driveSegment` respondió por TCP con código de éxito y 107 bytes. La longitud coincide con la estructura del catálogo. Se extrajeron campos de duración, distancia, consumo, velocidad media y carga al inicio y al final. Faltan las escalas y comprobar si el segmento corresponde al trayecto en curso.
- **Batería y autonomía.** Se observaron ofertas de `LSCDataSink` y `KombiIF`. El binario `Hmi8` enlaza callbacks de batería y autonomía del cuadro a `Efficiencytainment2.statusChargeOfBatteryHybrid` y `KombiIF.displayRangeElectricVehicle`. `Efficiencytainment2` no se vio en la ventana de descubrimiento. El cliente UDP directo recibió `EPERM` al consultar `KombiIF`. El intento con el módulo SOME/IP nativo desde SSH tampoco entregó muestras.
- **Siguiente contraste.** Leer desde el proceso OAP con su manifiesto y comparar con el cuadro y **Datos de viaje**. Verificar cambios en dos momentos, unidades, caducidad y cierre de suscripciones. Separar la validación de carga actual de la estimación de batería tras parada.
- **Observación con 0.2.4.** En las fotos del usuario, la autonomía de `KombiIF` y la del cuadro mostraban 414 km. Las fotos tienen horas distintas. El usuario observó 0 en el panel de velocidad incluso al moverse. El OAP consultaba ese campo una sola vez y carecía de permiso de suscripción para él. El valor bruto de batería del diagnóstico era 192. Hace falta una comparación simultánea en varios estados de carga para validar su conversión.

## Precalentamiento HV

El HMI original tiene un `ChargingPreconditioningController` y un `CDevCarBattery` con rutas para los modos manual y automático. El servicio anunciado por el i4 es `PredictiveThermalManagement` (`0xB53B`, instancia `1`). `operationMode` tiene una operación de escritura. El catálogo distingue desactivado, automático, manual y manual con automático.

El estado se lee de `statusPredictiveThermalManagement` mediante getter `2` y notificador `0x8001`. En la revisión analizada, el HMI convierte `statusVWM` y pasa su **bit 0** al icono de la barra de estado. Los valores `61–63` quedan fuera de esa interpretación. `statusFeedbackVWM` confirma el modo y `statusRestrictionsVWM` describe restricciones, por ejemplo autonomía insuficiente. `statusHighVoltageBattery` aporta el estado térmico para carga rápida y los tiempos térmicos.

La sonda solicita los dos campos de estado y devuelve el indicador que corresponde al icono del HMI. Se validó el decodificador con datos simulados. La consulta UDP directa de estado térmico recibió `EPERM`. Durante la sesión no se accionó el precalentamiento. Para activar la presentación de producción, contrastar el bit en una transición observada en el i4 y mostrar **Precalentamiento HV activo** junto a la temperatura de batería en Trayecto cuando el estado sea válido y reciente.

En la prueba manual posterior, el usuario inició el precalentamiento desde el menú de Carga original de BMW y confirmó que apareció una batería pequeña en el cuadro. La transición del campo SOME/IP queda pendiente de observar.
