# Integración para revisión manual — 7 de septiembre de 2026

Rama común: `review/integracion-20260907`. Son cuatro repositorios independientes,
por lo que existe una rama con ese nombre en cada uno. Se parte de las principales
remotas actualizadas por `git fetch`, no de las ramas principales locales atrasadas.

## Cambios reunidos

| Repositorio | Principal de partida | Trabajo integrado |
|---|---|---|
| Frontend | `origin/main` (`1cd45902`) | Release POS 1.1.4, tutorial guiado recuperado de cambios sin commit, navegación y ayuda por rol, progreso individual, impresoras, caja, sincronización y avisos de actualización. |
| Backend | `origin/main` (`3cd7f92`) | Sincronización POS v2, integridad de caja V11, progreso del tutorial V12 y correcciones de integración/pruebas. Incluye el cambio más reciente de main sobre cifrado de tokens. |
| POS | `origin/master` (`db65cb2`) | Release 1.1.4, impresión y updater, tutorial para cajeros/inventario, frontend compilado integrado y runner de tests corregido. |
| Landing | `origin/main` (`9646eb2`) | Página pública de descarga de Windows. |

### Ramas pendientes y equivalencias

- `feat/pos-sync-v2-updater-20260902`: integrado en los cuatro repositorios. Contiene
  las ramas `release/pos-1.1.1-20260907` a `release/pos-1.1.4-20260907` donde existen.
- `feat/aviso-pos-y-login-arca` del frontend: absorbida. Las mejoras de cuenta y ARCA
  ya están representadas en el resultado. Se conserva la descarga actual del POS:
  no se vuelve al aviso antiguo de «próximamente» ni se deshabilita el instalador.
- `feat/pos-cashier-flow-20260902` y `hotfix/point-caja-prod-20260831`: el contenido
  ya estaba en main por squash; también se conserva su ascendencia en la integración.
- `fix/mercadopago-orders-20260828` del POS: incluida dentro del release del POS.
- Las ramas de inventario/compras, reportes de propietario, dispositivos, CORS,
  preflight, esquema V9 y SEO/Amplify ya estaban integradas a sus principales.
- Tutorial sin commit: recuperado de `nuventa-frontend-dev` y `nuventa-backend-dev`.
  Se preservó primero en ramas `review/rescate-local-frontend-20260907` y
  `review/rescate-local-backend-20260907`, luego se integró.

Se verificó por ascendencia que **todos los tips locales/remotos inventariados**
están incluidos en la rama final de su repositorio. Inventario completo local:
`integration-review-20260907/branch-inventory.json`.

### Soft delete

El borrado lógico ya estaba en main; no faltaba rescatar una rama adicional.
El modelo conserva el producto con `active=false`, y el inventario permite buscar
por código y restaurarlo. La implementación histórica aparece en `4251b77` del backend;
el flujo de restauración del inventario se incorporó con `4e8c58db` del frontend.

La nueva prueba MySQL verifica: otra sucursal no puede borrar/restaurar; el producto
borrado desaparece de consultas activas pero conserva sus 7 unidades; restaurar lo
recupera con el mismo ID/stock; el feed POS recibe UPSERT, DELETE y UPSERT; repetir
la restauración es idempotente.

## Resoluciones necesarias

1. El tutorial proponía `V3__user_onboarding_progress.sql`, pero V3 ya está ocupado.
   Se integra como **V12**. V1–V11 no se modificaron. Sus timestamps usan Buenos Aires.
2. El prototipo local de impresión era anterior al release: se conserva la impresión
   del release, incluidos ARCA diferido, modos por equipo y prevención de duplicados.
   No se incorpora el aviso antiguo que decía que esas facturas no se imprimían.
3. Se habilitan GET/PUT de progreso del tutorial en el proxy POS para cajeros e
   inventario, con validación del comercio activo y sin agregar operaciones al outbox.
   La persistencia del tutorial requiere conexión; no es una nueva operación offline.
4. Se actualizan las comprobaciones del esquema a V12/91 tablas y el test del feed
   para incluir el catálogo de categorías. El test de vencimiento usa un cursor v2.
5. El seeder H2 ahora dispone de la tabla del feed que Hibernate no genera porque
   pertenece a Flyway. La migración completa y su trigger se prueban en MySQL real.
6. El runner de tests POS inicializa Electron una vez antes de lanzar procesos
   paralelos: evita la carrera de instalación del binario reproducida con npm ci.

## Validación

| Componente | Resultado |
|---|---|
| Backend | 700 tests, 0 fallos, 0 errores, 0 omitidos; `mvnw.cmd --batch-mode verify`. Incluye 6 pruebas sobre MySQL 8.4.10 descartable. |
| Frontend | 139 tests en 35 archivos; TypeScript sin errores; lint aprobado con warnings existentes; export estático aprobado. |
| POS | 75 tests tras `npm ci` limpio; 34 escenarios de regresión Electron; smoke de inventario, imagen, venta, caja y persistencia aprobado. |
| Landing | 6 tests; lint, TypeScript, compilación de demo/sitio y validación del artefacto Amplify aprobados. |
| Integridad | Los 207 archivos del export frontend coinciden byte por byte con `pos/resources/web`; ramas originales incluidas; carpetas originales intactas. |

Los fallos iniciales quedaron registrados en los logs locales. Las pruebas de rotación
MercadoPago heredaban una variable de cifrado del proceso; se retiró **solo del entorno
hijo de tests**, sin modificar la configuración productiva ni revelar sus valores.
Las pruebas usan H2, MySQL descartable y perfiles temporales Electron. No se probaron
pagos reales, facturación real, impresión física ni un nuevo instalador publicado.

Logs locales: `backend-verify-complete.log`, `frontend-test-final.log`,
`frontend-types-final.log`, `frontend-lint.log`, `pos-build-web.log`,
`pos-check-final.log`, `pos-regressions-final.log`, `pos-smoke.log`, `landing-check.log`.
Los logs y evidencias están en `integration-review-20260907`, fuera de los repositorios.

## Revisión manual y despliegue posterior

Usar los worktrees `integration-review-20260907/frontend`, `backend`, `pos` y `landing`.
Las carpetas originales permanecen en sus ramas y con sus cambios locales intactos.
Para compilar el POS de esta revisión, definir `NUVENTA_FRONTEND_DIR` apuntando al
worktree `frontend`, ya que el script tiene un frontend hermano predeterminado.

1. En una base local/de staging migrada a V12, ingresar como propietario y cajero:
   bienvenida, Ahora no, reapertura desde Ayuda, avance, pausa, recarga y roles visibles.
2. Borrar un producto de prueba con stock, verificar que desaparece, buscar su código
   y restaurarlo. Comprobar otra sucursal y ventas históricas.
3. En POS: abrir caja, vender offline, sincronizar, cerrar; probar impresora y avisos
   de actualización/logout. Verificar que el tutorial guarda progreso online.
4. Revisar descarga de Windows y estados de cuenta/ARCA.

**Requisito comprobado antes de desplegar el backend:** V11 crea
`pos_sync_change_ordered_id`. Con binary logging habilitado, MySQL necesita permitir
la creación del trigger al usuario de migraciones (por ejemplo,
`log_bin_trust_function_creators=1`, además de permiso TRIGGER). Sin ello rechaza V11.
También deben revisarse duplicados de cajas/empleados abiertos según
`backend/docs/pos-integrity-v11.md`. Se configuró únicamente el contenedor descartable;
no se alteró la base productiva ni se editaron migraciones ya aplicadas.

No se hizo merge a main/master, no se desplegó producción ni se publicó una nueva
versión del instalador. El workflow de release asignará la versión al publicar.
