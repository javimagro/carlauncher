# Selección del widget al abrir BMWLauncher

El parche experimental se aplica a Cluster renderer 0.8.13, revisión
`9da968c8644ef4f6bcce174b0836f9f24d8db7fb`. Incluye el cliente JavaScript
de esa misma revisión. El servicio conserva GPL-3.0-or-later y el cliente
MPL-2.0. [Código original de Cluster renderer 0.8.13](https://github.com/robertnisipeanu/idrive-apps/tree/9da968c8644ef4f6bcce174b0836f9f24d8db7fb/native/cluster-render)

En la prueba física del 25-11-2026 el cuadro mostró el widget al recibir
la solicitud y volvió a velocidad 533 ms después de retirarla. La prueba
no superó el requisito de conservar la selección. Véase la
[bitácora de la prueba](../../BITACORA.md#2026-11-25--seleccionar-el-widget-al-abrir-bmwlauncher).

Desde un checkout de esa revisión, con Docker disponible y la ruta absoluta de BMWLauncher en `BMWLAUNCHER`:

```sh
git apply --check "$BMWLAUNCHER/tools/cluster-render/widget-focus-0.8.13.patch"
git apply "$BMWLAUNCHER/tools/cluster-render/widget-focus-0.8.13.patch"
cd native/cluster-render
make test-x86
make target
```

El binario ID8 queda en `build/target/cluster-render-idrive8`. El cliente
actualizado está en `js/cluster_render_client.js`. El artefacto de CI incluye
ambos, su SHA-256 y la información ELF. El ZIP de BMWLauncher sigue usando
el Cluster renderer que esté instalado.

## Protocolo

Con `id8_widget_focus=0`, el servidor ID8 anuncia `widget_focus: 1` en
`hello` al cliente local `javi_bmwlauncher` con UID 0. `focus_widget`
requiere la referencia de la imagen propia y que el contenido `43204001`
esté anunciado y aparcado en el destino `widget`. El identificador de
petición DCSM 1 caduca a los cuatro segundos o cuando el cuadro confirma
el foco. El cliente puede enviar `cancel_widget_focus`. Desconectar el
socket, retirar la capa o parar la oferta también libera la solicitud.

En la comprobación en el i4, partir con la vista de velocidad y el coche
estacionado. Abrir BMWLauncher, comprobar que el widget aparece y que
permanece visible tras retirar la solicitud. Cambiar de vista desde el
volante, esperar y verificar que la vista elegida se conserva mientras la
app sigue abierta. Salir y volver a abrir la app debe producir una segunda
solicitud. El arranque en segundo plano debe dejar la vista que el cuadro
presente. Los registros `temporary widget focus requested` y
`temporary widget focus released` permiten cotejar el resultado.

Cualquier prueba de instalación se hace con una copia de ambos archivos
originales y con el coche estacionado. Para revertir se restaura esa pareja
en la siguiente activación controlada. La unidad puede reiniciarse al parar
Cluster renderer. [Notas de funcionamiento de ID8 del proyecto original](https://github.com/robertnisipeanu/idrive-apps/blob/9da968c8644ef4f6bcce174b0836f9f24d8db7fb/native/cluster-render/README.md#idrive-8)
