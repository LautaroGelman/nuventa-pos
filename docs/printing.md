# Impresora por computadora

En escritorio, Ventas y el formulario de venta muestran **Configurar impresora**.
El diálogo permite buscar las impresoras instaladas en Windows, elegir una,
seleccionar A4, ticket de 80 mm o ticket de 58 mm, enviar una prueba y guardar.
La prueba no crea ventas ni modifica caja o stock.

La configuración se conserva en `printerConfig` del perfil local de la app.
Se aplica a todas las cajas usadas desde ese perfil, sin sincronizar nombres de
dispositivos con otras computadoras. USB y Wi-Fi usan las colas instaladas en
Windows; la app no configura las credenciales Wi-Fi de la impresora.

## Puente y validación

- `getState`: configuración, impresoras instaladas y errores al enumerarlas.
- `saveConfig`: valida el formato y que el dispositivo seleccionado siga instalado.
- `openSettings`: abre exclusivamente `ms-settings:printers`, desde un renderer confiable.
- `printTicket`: permite probar un dispositivo y papel antes de guardar. HTML con
  contenido escapado; `pageSize` explícito para A4 y rollos en micrones.
- `printPdf`: conserva la cola y deduplicación de envíos automáticos.

Un dispositivo explícito ausente se rechaza: nunca se redirige a otra impresora.
La lista sólo confirma instalación, no conectividad física. `SPOOLED` representa
aceptación del trabajo, no papel impreso. Un timeout tampoco garantiza que Windows
haya eliminado el trabajo: revisar la cola antes de reenviar.

El diálogo permite activar por separado el ticket automático de cada venta y el
envío automático de comprobantes ARCA. Para ARCA, el frontend
solicita el PDF con el papel del equipo y usa su impresora exacta; `NONE` omite el
envío automático pero permite descargas y pruebas manuales. Los modos persistidos
son `NONE`, `SALES_ONLY`, `ARCA_ONLY` y `ALL_SALES` (ambas opciones).

El botón **Ticket (Ctrl + P)** y Ctrl+P del formulario usan `printTicket` en Electron para
la última venta no fiscal. Los nombres, pagos y descuentos se incluyen en la
respuesta local de creación y en su reintento idempotente. Un fallo de impresión
se informa por separado: no vuelve a registrar la venta. En navegador se conserva
`react-to-print`.

Después del alta confirmada (incluyendo Point y recuperación del cobro),
`autoPrintSale` consulta la configuración y envía el ticket si está habilitado.
Usa el UUID estable del intento y la deduplicación de Electron. La ausencia o fallo
de la impresora se informa sin repetir el cobro. Con ambas opciones activas, una
venta facturada imprime el ticket no fiscal y también su comprobante ARCA.
Estas opciones se abren también desde **Configurar Cajas**, conservando su alcance
por computadora. No se guardan nombres de impresoras en la nube.

Las conexiones admitidas son las que Windows presenta como una cola con controlador
compatible. USB y Wi-Fi no requieren un transporte distinto en Nuventa. Bluetooth
requiere también una cola compatible instalada: no se implementó envío ESC/POS
directo por COM ni BLE sin controlador. La HP P1102w sólo permite probar USB/Wi-Fi;
no demuestra compatibilidad física con impresoras térmicas ni Bluetooth.

## Verificación

Los tickets HTML A4 reservan 8 mm internos y la impresión A4 respeta los márgenes
del controlador. En 58/80 mm se conserva el ancho del rollo y 3 mm internos a cada
lado. Los PDF conservan su tamaño de página; el margen del contenido del PDF depende
de su generador.

`PosInvoiceAutoPrinter` escucha los comprobantes de `sync-complete` desde el layout
global, incluso con caja cerrada. Sólo procesa eventos del cliente y sucursal activos
y usa la misma clave de deduplicación que la emisión inmediata. El servidor local
permite descargar el PDF de esa sucursal también al cajero y conserva sus bytes.

`npm run check` cubre validación, cola, dispositivos ausentes, deduplicación y
tamaño del papel. La salida física requiere probar el controlador y hardware real.
Referencias: [Electron print](https://www.electronjs.org/docs/latest/api/web-contents#contentsprintoptions-callback)
y [Windows Settings](https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-settings).
# Indicación de precio mayorista

Los tickets destacan `PRECIO MAYORISTA APLICADO` y marcan cada línea que guarda `wholesaleApplied`. El indicador describe el precio unitario cobrado; no agrega un descuento ni modifica subtotal, promociones o total. Las ventas locales obtienen esta marca del mínimo mayorista guardado con la línea. Las ventas web nuevas la reciben del backend y las históricas sin marca conservan su presentación anterior.
