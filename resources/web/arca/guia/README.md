# Capturas de la guía de certificado ARCA

El componente [`ArcaCertGuide`](../../../src/components/client/billing/ArcaCertGuide.tsx) muestra
estas capturas en el paso "Certificado" del wizard de activación
([`ArcaCertificadoStep`](../../../src/components/client/billing/ArcaCertificadoStep.tsx)). La guía es
**solo del circuito de producción**: es lo que hace el usuario final. Mientras un archivo no exista,
el wizard muestra un placeholder con el nombre esperado.

> En homologación (dev) no hay guía con capturas: el wizard habilita un "modo prueba" para cargar
> un certificado de test emitido por WSASS.

Formato sugerido: **PNG**, ~1200 px de ancho, recortadas al área relevante. Tapá datos sensibles
(CUIT, nombres) antes de subirlas. Las capturas se ven a `max-h-80` en el carrusel y a tamaño
completo en el visor ampliado (click en la imagen), así que tienen que leerse bien en ambos.

Las capturas están repartidas en **dos mazos**, separados por el checkpoint en el que el comercio
carga y valida el certificado en Nuventa:

## Mazo 1 — `GUIA_CREAR_CERTIFICADO` (crear el certificado)

Servicio: "Administración de Certificados Digitales".

| Archivo | Qué mostrar | Estado |
|---------|-------------|--------|
| `01-ingreso-clave-fiscal.png` | Login de ARCA/AFIP con Clave Fiscal. | ✅ |
| `02-servicio-certificados.png` | Buscador de servicios con "Administración de Certificados Digitales". | ✅ |
| `03-crear-alias.png` | Pantalla de Certificados con el botón "Agregar alias". | ✅ |
| `04-pegar-csr.png` | Form: alias + "Seleccionar archivo" (nuventa.csr) + "Agregar alias". | ✅ |
| `05-ver-detalle.png` | Lista de certificados con el link "Ver". | ✅ |
| `06-descargar-crt.png` | Detalle del certificado (Nro Serie, fechas, VÁLIDO) con "Descargar". | ✅ |

⏸ **Checkpoint**: el comercio sube el `.crt` a Nuventa y el backend lo valida (clave↔certificado,
CUIT y vencimiento). No se puede seguir sin pasar por acá.

## Mazo 2 — `GUIA_AUTORIZAR_WSFE` (habilitar el certificado a facturar)

Servicio: "Administrador de Relaciones".

| Archivo | Qué mostrar | Estado |
|---------|-------------|--------|
| `07-administrador-relaciones.png` | Portal con el ícono "Administrador de relaciones". | ✅ |
| `08-adherir-servicio.png` | Pantalla de Administrador de Relaciones con "Adherir Servicio". | ✅ |
| `09-webservices.png` | Árbol de organismos: ARCA → "WebServices". | ✅ |
| `10-facturacion-electronica.png` | Lista de WebServices: selección de "Facturación Electrónica". | ✅ |
| `11-incorporar-relacion.png` | "Incorporar nueva Relación" (servicio FE) + Buscar representante. | ✅ |
| `12-computador-fiscal.png` | Selección del Computador Fiscal (Nuventa) + "Confirmar". | ✅ |

⏸ **Checkpoint final**: "Verificar conexión" hace un login WSAA real contra ARCA
(`GET /puntos-venta/list`), que es lo que confirma que la autorización quedó hecha.
