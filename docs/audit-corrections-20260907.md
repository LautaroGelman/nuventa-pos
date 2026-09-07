# Correcciones de integridad POS — 7 de septiembre de 2026

El outbox v2 conserva orden, autor, identidad del turno y fechas de negocio. Las pruebas
reproducibles de Electron se ejecutan con `npm run test:regressions` sobre un perfil temporal,
sin backend externo; `npm run check` y `npm run test:smoke` completan la verificación local.

## Actualizador

El canal `/stable` se acepta y se informa según el feed efectivo. La instalación sólo continúa
cuando el ciclo de sincronización en curso terminó y existe un backup local verificado. Durante
la preparación se bloquean escrituras sin destruir el servidor local ni cerrar la base. Si
`electron-updater` emite un error, se informa `recoverable-error` y el proceso recupera su operación.
`quitAndInstall(true, true)` solicita relanzar el POS después de instalar.

La prueba de regresión usa el método real de `BaseUpdater` con un instalador fallido: verifica
que no se informe éxito. Esto no certifica la descarga/ejecución de un instalador NSIS firmado.
Antes de distribuir, probar upgrade entre dos versiones empaquetadas en un perfil e instalación
aislados, con el firmante real del release, conservación de datos y reapertura posterior.

## Compatibilidad de despliegue

Coordinar el POS con el backend que incluye V11 y los DTO extendidos de sesión. Revisar sesiones
duplicadas abiertas antes de aplicar la migración; ésta falla deliberadamente en lugar de cerrar
turnos o alterar su historia financiera. El secuenciador del change-log necesita prueba de carga
concurrida por su bloqueo global hasta commit.

Los archivos estáticos de `resources/web` se generan desde el frontend y deben distribuirse junto
con el main/preload. No publicar una mezcla de versiones del renderer y del contrato local.

La evaluación funcional local no sustituye las pruebas de impresión física, terminal de pago,
facturación fiscal ni del instalador firmado.
