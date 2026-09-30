# Homologación local aislada del POS

El POS admite `--dev --qa` únicamente desde el código fuente sin empaquetar. Exige dos
orígenes HTTP(S) de loopback explícitos y crea un directorio `nuventa-pos-qa-*` nuevo en
la carpeta temporal antes de cargar configuración, SQLite o sesiones. No reutiliza el
perfil del POS instalado. Sin `--qa`, las variables siguientes no tienen efecto: desarrollo
sigue usando `localhost:3000/8080` y producción conserva sus dominios habituales.

```powershell
$env:NUVENTA_POS_QA_WEB_URL = 'http://localhost:3010'
$env:NUVENTA_POS_QA_API_URL = 'http://127.0.0.1:8088'
npm run start:dev -- --qa
```

Este comando abre la aplicación para una prueba manual. La homologación CLI descrita abajo
no abre ventanas ni sustituye esa revisión visual. Las URL externas, credenciales en URL,
rutas y el uso de QA desde una aplicación empaquetada fallan antes del arranque.

## Harness técnico con dos terminales

`scripts/run-pos-qa.js` inicia dos procesos main reales de Electron, cada uno con SQLite
y servidor HTTP local propios. Usa los módulos reales de autorización local, inventario,
outbox y sincronización v2 contra un backend de homologación que ya está en ejecución.
No usa `BrowserWindow`, automatización de escritorio ni perfiles instalados.

Preparar un comercio y sucursal sintéticos exclusivos, dos cajeros con sesión vigente
previamente verificada por OTP y dos cajas distintas. Los fixtures privados contienen
`clientId`, `sucursalId`, `employeeId`, `email`, `password`, `token`, `deviceFingerprint`,
`name` y `role`. No deben versionarse ni copiarse en los informes. La prueba no realiza
login ni OTP: valida la sesión contra el backend antes de guardarla en el perfil nuevo.

El catálogo JSON público fija el alcance y los IDs de productos/cajas:

```json
{
  "clientId": 2,
  "sucursalId": 2,
  "products": [{"id": 5, "code": "QA-POS-A", "price": 100}],
  "registers": [{"id": 1, "name": "Caja QA A"}, {"id": 2, "name": "Caja QA B"}]
}
```

Con las variables anteriores definidas:

```powershell
node scripts/run-pos-qa.js --output C:/qa/resultado-nuevo `
  --catalog C:/qa/catalog.json `
  --fixture-a C:/qa/secrets/cajero-a.json --fixture-b C:/qa/secrets/cajero-b.json
```

Verifica perfiles/cajeros separados, cajas sincronizadas, metadata Tiendanube de una
sucursal sin vínculos, venta offline persistida tras reabrir SQLite, reintento idempotente,
ACK remoto, convergencia de stock del segundo terminal, devolución y cierre de ambas
cajas con outbox vacío. Después de sincronizar, la consulta/devolución usa el ID remoto
de la venta. El historial sintético permanece; no se borran ventas ni bases de datos.

`results.json` registra los escenarios completados. Ante un fallo, `failure.json` conserva
los pasos que pasaron y los logs muestran las rutas de los perfiles de esa corrida.
Los procesos se detienen, pero una venta o caja ya confirmada puede requerir devolución
o cierre explícitos dentro del mismo comercio QA antes de repetir. No se compensa una
operación automáticamente sin verificar qué alcanzó a confirmar la nube.

## Escenario coordinado de stock compartido

`--shared-stock` habilita una variante distinta para un producto y una tienda de prueba
vinculados realmente a Tiendanube. También permite el comercio de demostración ID 1
únicamente en ese modo explícito. Requiere cajeros/cajas dedicados y un catálogo con
exactamente un producto. Debe coordinarse con quien opera la tienda; no es un smoke
test autónomo contra una tienda comercial.

1. Antes de arrancar, preparar una unidad física y un pedido impago que la reserve.
2. El harness verifica rechazo de ambos terminales por disponible cero, y rechazo
   offline del producto vinculado, sin ventas, outbox ni cambios de caja/inventario.
3. Se detiene en `QA_WAIT reservation-released`. Cancelar el pedido en Tiendanube y
   verificar la liberación. Crear `reservation-released.json` en la carpeta de resultados
   con `{ "clientId": 1, "sucursalId": 1, "productId": 2 }`, usando los IDs reales fijados.
4. El primer terminal vende una unidad y recibe ACK único; el segundo sincroniza y
   rechaza una nueva venta. Se detiene en `QA_WAIT return-authorized`, dejando evidencia
   en `last-unit-sold.json` para comprobar stock remoto cero.
5. Crear `return-authorized.json` con los mismos IDs sólo después de esa comprobación.
   El harness devuelve la venta, sincroniza la reposición y cierra sus dos cajas.

Las señales no deben existir al arrancar. Cada espera vence a los 30 minutos. Esta prueba
cubre reservas y actualización compartida de manera secuencial; no demuestra atomicidad
entre un checkout simultáneo de Tiendanube y el POS. La API remota conserva esa limitación.
La UI nativa de OAuth, navegación, impresión y experiencia de caja requieren una prueba
manual de escritorio separada.

## Regresiones automatizadas

`npm test` ejecuta los archivos `test/*.test.js`. `npm run test:regressions` ejecuta
escenarios SQLite/HTTP en Electron main con perfiles temporales y servicios controlados.
`test/qa-environment.test.js` comprueba límites de entorno y perfiles nuevos;
`test/tiendanube-policy.test.js` y las regresiones Electron comprueban rechazos antes de
escribir stock/caja, aislamiento de sucursal y reintentos. Los mocks no acreditan entregas
de webhooks públicos ni un checkout real.
