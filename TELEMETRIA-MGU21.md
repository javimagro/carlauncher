# Telemetría del BMW i4 en MGU21

Primera inspección local sobre PSdZData 4.58.15 Full. El paquete `SWFL 000056EE 036_010_004` contiene el catálogo `/etc/oap/someip/someip-interfaces.json`. En los ELF del paquete `SWFL 000056E7` se encontraron símbolos de despliegue SOME/IP para el campo de autonomía eléctrica del cuadro y para el porcentaje de carga HV. El catálogo confirma nombres, tipos e identificadores de transporte. La disponibilidad, las escalas y la correspondencia con el cuadro del i4 se validan en la unidad.

## Lecturas para validar

El control manual descrito al final es independiente de estas lecturas: añade una escritura explícita solicitada por el usuario, no una activación automática de la sonda.

| Dato | Interfaz y campo | Qué comprobar en el i4 |
| --- | --- | --- |
| Batería actual | `Efficiencytainment2.statusChargeOfBatteryHybrid` y `LSCDataSink.displayConditionHybrid` | Las dos estructuras contienen un valor de carga visible de alta tensión y tienen `255` como valor sin inicializar. Comparar ambas con el porcentaje del cuadro, también después de cargar. |
| Autonomía actual | `LSCDataSink.dataRangeDisplay` y `KombiIF.displayRangeElectricVehicle` | El primero distingue autonomía eléctrica de total e indica unidad y si se debe mostrar. `4095` es el valor por defecto. Comparar con los km que presenta el cuadro. |
| Consumo medio | `KombiIF.statusConsumptionAverageElectricVehicle` | Ofrece dos medias, BC1 y BC2, y el código de unidad. Comparar escala y periodo de cada media con Datos de viaje de BMW. |
| Datos de viaje por periodo | `ResetLogic3.bcDataAll` | El HMI lo usa para distancia, duración y consumo. Contrastar los cuatro periodos con el cuadro. |
| Segmento bruto | `BcPersonal.driveSegment` | Distancia, duración, consumo y velocidad media de un segmento. La relación entre ese segmento y los periodos del cuadro sigue pendiente. |
| Altura | `Positioning.rawPositionData` | Contiene `heightValid` y `height.rawLengthMeter`. Comprobar con fijación 3D y confirmar la referencia vertical antes de presentarla como altitud sobre el nivel del mar. |
| Temperaturas | `EnvironmentalInformation.ExteriorTemperature` y `Efficiencytainment2.statusBatteryTemperature` | Para exterior, Live Data usa `valor × 0,5 − 40` °C. Verificar esa escala y la de la batería en el i4. Ambas estructuras usan `255` como valor por defecto. |
| Potencia de batería HV | `InternalTasu` y UDS al SME | Contrastar tensión, corriente y potencia del OAP con el lector OBD de Android y comprobar la cadencia en la MGU. |
| Indicador de tracción y energía disponible | `Efficiencytainment2.displayPowerDrive`, `Vehicle2.highVoltageStorageInfoToExternal` | El catálogo identifica una cuota relativa de tracción o regeneración y valores de energía disponible y máxima. |

El catálogo denomina algunas interfaces `Hybrid`. La prueba debe decidir si se publican en el i4. La app eDrive de IterioDev 1.1.0 consulta el DID `DDBC` para el porcentaje y estima su autonomía. El perfil OBD del BMWLauncher Android para el i4 Gen5 usa `E5CE` para carga del pack, `E5C7` para energía disponible, `E54D` para voltaje y `E561` para corriente. Son antecedentes para una eventual comparación con OBD. La sonda usa el acceso a campos SOME/IP del SDK OAP. [eDrive de IterioDev](https://github.com/IterioDev/car-apps#edrive-iteriodev-edrive-idrive-8-only) · [Escalas de Live Data](https://github.com/cauliflowermossgrape/idrive7-apps/blob/main/apps/live_data/signals.js)

Si se obtiene potencia HV física, la estimación a partir de potencia y velocidad en km/h es `100 × potencia_kW / velocidad_km_h`. Se deben alinear las muestras, excluir velocidades próximas a cero y conservar el signo de la regeneración. La potencia medida en el pack puede incluir auxiliares. Batería y autonomía tras parada o llegada se calculan con una ruta, su consumo previsto y la recarga de cada parada.

## Potencia de la batería HV

BMWLauncher usa el mismo perfil de lectura del i4 Gen5 que CarLauncher Android. Al SME (`0x07`) se le consultan los DIDs `E54D` y `E561` por separado con UDS `0x22`. Tras los bytes de respuesta `62` y del DID, la tensión se lee como entero sin signo de 16 bits desde el byte 0, multiplicado por 0,01 V. La corriente se lee como entero con signo de 16 bits desde el byte 2, multiplicado por −0,01 A. Ambos enteros son big-endian.

El OAP usa el método `sendTasuRequest` y el evento selectivo `sendTasuResponse` del catálogo MGU21. Comprueba que la respuesta corresponde al SME y al DID solicitado. Calcula `kW = V × A ÷ 1000` a partir de las dos lecturas del mismo ciclo. Los valores positivos indican descarga y los negativos, entrada de energía a la batería. El diagnóstico muestra los kW, voltios y amperios en la misma fila. La cadencia prevista es de un par por segundo y hay una pausa de cinco segundos si falla una lectura. Se cancela el muestreo al ocultar la app. [Pasarela de diagnóstico de iDrive](https://github.com/cauliflowermossgrape/idrive7-apps/blob/main/README.md) · [eDrive de IterioDev](https://github.com/IterioDev/car-apps/tree/main/apps/iteriodev_edrive)

En el i4, la primera comprobación es obtener las tres cifras con el coche parado y comparar su variación al activar la climatización. Después se contrasta la lectura y el signo con el OBD2 de Android durante una prueba de marcha y regeneración.

## Verificar la versión de prueba

El catálogo de MGU21 identifica los periodos de `ResetLogic3.bcDataAll` como `INDIVIDUAL` (1), `CHARGE` (3), `STARTOFDRIVING` (4) y `LONGTERM` (5). El orden del array puede variar. `DevJourneyData::onBcDataAll` y sus consumidores de `Hmi8` confirman el uso del registro en Datos de viaje. El HMI aplica `counterDistance × 0,1` en `updateCounterDistance` y `(consumptionElectricAverageDigit − 65535) × 0,1` en `updateAvgElConsumption`. Ambas funciones tratan `0xfffffffd` como no disponible. `updateSpeedAverage` usa `speedAverage × 0,1` y el marcador de ausencia `0xfffd`. La duración se obtiene de los campos de día, hora, minuto y segundo. Trayecto y el diagnóstico comparten esas conversiones cuando la unidad es compatible.

Compara la distancia y el consumo en **Inicio de viaje**, **Última carga**, **Individual** y **Desde fábrica** con iDrive. Mantén las filas de `BcPersonal` como valores brutos mientras falten sus escalas y periodo. El catálogo también ofrece el consumo eléctrico instantáneo de `ResetLogic3` y su código de unidad. Queda por medir su cadencia en el i4 y comprobar cuándo indica consumo por distancia o por tiempo antes de calcular potencia.

En la raíz del proyecto y con Node.js 18 o superior:

```powershell
node tools/Verificar-Telemetria-MGU.js 'D:/Usuarios/javie/BMW/psdzdata/swe/swfl/swfl_000056ee.bin.036_010_004'
node --test emulator/split/drivehub.test.js emulator/split/telemetria.test.js
node emulator/split/server.js --drivehub --telemetry
```

También se admite el catálogo JSON extraído. El script contrasta cada instancia, operación y campo con los permisos de solo lectura que se empaquetan en la app.

Desde la 0.2.5, el OAP consulta la velocidad cada dos segundos y se suscribe a sus avisos de cambio. Lee los demás campos que tienen getter cada diez segundos. Los que solo tienen notificador siguen por suscripción. Se envía un resumen cada segundo al renderizador y al cerrar se cancelan las consultas programadas y se liberan las suscripciones. De posición solo se recoge altura y validez de fijación. **Lecturas del coche** muestra la edad desde la última recepción. Un campo con getter aparece **Sin actualizar** si pasan tres periodos sin una muestra. [Lectura periódica de velocidad en el kit comunitario](https://github.com/cauliflowermossgrape/idrive7-apps/blob/main/kit/runtime/parked.js)

Para la velocidad se muestra `valor ÷ 64` km/h y se descarta `65535`, valor por defecto del catálogo. La escala procede de Live Data y queda por contrastar en movimiento con el cuadro del i4. En la 0.2.6, **Ahora** muestra batería y autonomía válidas del cuadro. El diagnóstico convierte también las temperaturas y el consumo medio cuando su unidad es kWh/100 km. Las previsiones de energía y los valores de trayecto sin validar siguen identificados como demostración. [Conversión de velocidad en Live Data](https://github.com/cauliflowermossgrape/idrive7-apps/blob/main/apps/live_data/signals.js)

## Validación en la unidad

El 11 de noviembre de 2026 la MGU del i4 confirmó por ENET que lleva `SWFL 000056EE 036_010_004`. Por SSH se comprobó que el catálogo instalado coincide byte por byte con el local.

- **Trayecto.** Se observó una oferta del servicio `BcPersonal` y su getter `driveSegment` respondió por TCP con código de éxito y 107 bytes. La longitud coincide con la estructura del catálogo. Se extrajeron campos de duración, distancia, consumo, velocidad media y carga al inicio y al final. Faltan las escalas y comprobar si el segmento corresponde al trayecto en curso.
- **Batería y autonomía.** Se observaron ofertas de `LSCDataSink` y `KombiIF`. El binario `Hmi8` enlaza callbacks de batería y autonomía del cuadro a `Efficiencytainment2.statusChargeOfBatteryHybrid` y `KombiIF.displayRangeElectricVehicle`. `Efficiencytainment2` no se vio en la ventana de descubrimiento. El cliente UDP directo recibió `EPERM` al consultar `KombiIF`. El intento con el módulo SOME/IP nativo desde SSH tampoco entregó muestras.
- **Siguiente contraste.** Leer desde el proceso OAP con su manifiesto y comparar con el cuadro y **Datos de viaje**. Verificar cambios en dos momentos, unidades, caducidad y cierre de suscripciones. Separar la validación de carga actual de la estimación de batería tras parada.
- **Observación con 0.2.4.** En las fotos del usuario, la autonomía de `KombiIF` y la del cuadro mostraban 414 km. Las fotos tienen horas distintas. El usuario observó 0 en el panel de velocidad incluso al moverse. El OAP consultaba ese campo una sola vez y carecía de permiso de suscripción para él. El valor bruto de batería del diagnóstico era 192. Hace falta una comparación simultánea en varios estados de carga para validar su conversión.
- **Contraste con 0.2.5.** El usuario confirmó que la velocidad cambia con el coche en movimiento. `displayRangeElectricVehicle` y el cuadro coincidieron en 431 km. La carga bruta `182` coincidió con el 91 % del cuadro y la temperatura exterior `112` con 16 °C. El consumo medio `170` coincidió con 17,0 kWh/100 km en el periodo **Desde fábrica**. La cuota de tracción o regeneración `100` y el consumo del trayecto actual siguen pendientes de validación.
- **Temperatura HV.** En el ELF `Hmi8` de la revisión indicada, `CDevCarBattery::onPxyStatusBatteryTemperatureChanged` descarta `255` y resta `0x32` al byte de temperatura en `0x75730b9`. La lectura `69` corresponde a 19 °C, coherente con la comprobación del usuario. La 0.2.6 muestra las temperaturas exterior y HV en el diagnóstico y en Trayecto. Las lecturas caducadas o no válidas quedan sin valor en las tarjetas.

## Precalentamiento HV

El HMI original tiene un `ChargingPreconditioningController` y un `CDevCarBattery` con rutas para los modos manual y automático. El servicio anunciado por el i4 es `PredictiveThermalManagement` (`0xB53B`, instancia `1`). `operationMode` tiene una operación de escritura. El catálogo distingue desactivado, automático, manual y manual con automático.

El estado se lee de `statusPredictiveThermalManagement` mediante getter `2` y notificador `0x8001`. En la revisión analizada, el HMI convierte `statusVWM` y pasa su **bit 0** al icono de la barra de estado. Los valores `61–63` quedan fuera de esa interpretación. `statusFeedbackVWM` confirma el modo y `statusRestrictionsVWM` describe restricciones, por ejemplo autonomía insuficiente. `statusHighVoltageBattery` aporta el estado térmico para carga rápida y los tiempos térmicos.

La sonda solicita los dos campos de estado y devuelve el indicador que corresponde al icono del HMI. Se validó el decodificador con datos simulados. La consulta UDP directa de estado térmico recibió `EPERM`. Durante la sesión no se accionó el precalentamiento. Para activar la presentación de producción, contrastar el bit en una transición observada en el i4 y mostrar **Precalentamiento HV activo** junto a la temperatura de batería en Trayecto cuando el estado sea válido y reciente.

En la prueba manual posterior, el usuario inició el precalentamiento desde el menú de Carga original de BMW y confirmó que apareció una batería pequeña en el cuadro. La transición del campo SOME/IP queda pendiente de observar.

### Botón de preacondicionamiento HV

Revisión local 0.2.11, 2026-11-14: a la izquierda de Datos aparece una batería con ventilador y la etiqueta HV. Una pulsación completa pide activación manual; una segunda pide desactivación. El color seleccionado se basa en feedback manual o actividad real, no en una variable optimista. Automático habilitado sin actividad no se presenta como una petición manual ya activa. Mientras espera no admite pulsaciones repetidas. Mantiene la temperatura bajo control de BMW; tener preparación habilitada no prueba que el calentador esté consumiendo.

Contrato comprobado con el catálogo privado 036.010.004 y desensamblado de Hmi8 (SHA-256 `7aa4f8d007ce505fada5572a9643f542e8f8056e7d0ac3d25acc524607d30e20`):

- `operationMode` es un wrapper `{operationModeVWM}`, setter 1, servicio 46395/1, instancia 1. Orden 0 desactivado, 1 automático, 2 manual, 3 manual+automático.
- **No reutilizar el enum de órdenes para interpretar el feedback:** `statusFeedbackVWM` usa 0 desactivado, 1 manual, 2 automático, 3 ambos. `getVwmManualState` en `0x7571630` reconoce 1/3 y `getVwmAutoState` en `0x7571640` reconoce 2/3. `calcOperationCommandVWM` en `0x7574630` calcula `(manual ? 2 : 0) + (automático ? 1 : 0)`; `setVwmManualState` en `0x75747a0` conserva el modo automático.
- ON envía 2, o 3 si el feedback anterior era automático/ambos. OFF envía 0, por lo que también solicita detener la preparación iniciada por una ruta. No es el simple apagado del bit manual dejando automático habilitado. Una decisión posterior de BMW se reflejará en las nuevas muestras.
- La confirmación de ON requiere feedback manual/ambos; OFF requiere feedback desactivado y actividad falsa. No se considera confirmación que termine la llamada al setter. Restricciones de autonomía, carga o máxima eficiencia se comunican al usuario; valores desconocidos impiden activar. OFF sigue disponible con una restricción conocida y estado válido.
- La lectura se consulta cada dos segundos además de la suscripción, caduca a los quince; la UI descarta una conexión sin actualizaciones durante cinco segundos. Confirmación limitada a doce segundos; no se reintenta una escritura automáticamente. Si el setter queda pendiente, se indica indisponibilidad y se impide solapar órdenes. Cerrar la app libera proxy, suscripción y temporizador, sin apagar el preacondicionamiento.

Verificación local: `node tools/Verificar-Preacondicionamiento-MGU.js RUTA_CATALOGO_PRIVADO`, pruebas de `emulator/split/preconditioning.test.js`, Node 8.16.2 y capturas con `node tools/Previsualizar-Preacondicionamiento.js`. El setter del SDK y la respuesta efectiva del vehículo todavía requieren una prueba en la MGU; no se ha conectado ni escrito en el coche durante este cambio. Instalada la futura versión, comprobar ON/OFF desde estado manual y desde ruta automática, rechazo por restricción y coincidencia con el menú Carga de BMW. El icono por sí solo no valida potencia térmica.

### Estado térmico para carga rápida

`PredictiveThermalManagement.statusHighVoltageBattery` usa el getter 3 y el notificador `0x8002`. El catálogo distingue 0 sin limitaciones, 1 frío, 2 frío condicional, 3 calor y 4 calor condicional. Los códigos de error, ausencia o indisponibilidad dejan el valor vacío. La 0.2.7 mostraba «Limitación por frío» para el código 2 y perdía el matiz condicional. Desde la 0.2.8 se suscribe a los cambios, repite la consulta cada cinco segundos y caduca a los quince segundos. Una temperatura de 33 °C y un estado de frío condicional pueden llegar simultáneamente en dos señales distintas. Para averiguar por qué el coche mantiene el estado, compara ambas muestras y el estado de precalentamiento durante la misma prueba de carga rápida.
