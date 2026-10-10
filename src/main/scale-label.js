'use strict';

// =============================================================================
// Scale labels whose PLU is not loaded as a product: sold as "Balanza (PLU …)".
// Same rules as `parseScaleBarcode` (frontend) and `ScaleSettingsService.parse` (backend).
// The amount comes from the label, never from the price sent by the sale screen.
// A mask with W carries the WEIGHT instead of the amount: those labels need a product (its price
// per kg), so they are never sold as "Balanza (PLU …)".
// =============================================================================

function isValidEan13(code) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(code[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}

/**
 * { plu, amount } (máscara de importe) o { plu, weightGrams } (máscara de peso, W), o null si el
 * código no es una etiqueta válida para esta configuración.
 */
function parseScaleLabel(code, settings) {
  const value = String(code ?? '').trim();
  const prefix = String(settings?.prefix ?? '').trim();
  const mask = String(settings?.mask ?? '').trim().toUpperCase();
  if (!/^\d{13}$/.test(value) || !/^\d{1,2}$/.test(prefix) || !value.startsWith(prefix)
      || !/^[PIWX]+$/.test(mask) || mask.length !== 13 - prefix.length - 1 || !isValidEan13(value)) return null;
  if (mask.includes('I') === mask.includes('W')) return null; // importe o peso, exactamente uno
  const body = value.slice(prefix.length, 12);
  let plu = '';
  let rawValue = '';
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 'P') plu += body[i];
    else if (mask[i] === 'I' || mask[i] === 'W') rawValue += body[i];
  }
  if (!plu || !rawValue) return null;
  const n = Number(rawValue);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (mask.includes('W')) return { plu, weightGrams: n };
  return { plu, amount: settings.priceInCents ? n / 100 : n };
}

/**
 * Valida un ítem con `scaleLabel` y le fija nombre e importe a partir de la etiqueta.
 * Devuelve `{ item }` o `{ status, error }`.
 */
function resolveScaleLabelItem(item, settings) {
  if (item.productId != null) return { status: 400, error: 'Una etiqueta de balanza sin producto no lleva productId.' };
  if (!settings?.enabled) return { status: 400, error: 'La lectura de etiquetas de balanza no está habilitada en esta sucursal.' };
  if (settings.unregisteredLabelsEnabled === false) {
    return { status: 403, error: 'Esta sucursal no vende etiquetas de balanza sin producto cargado. Cargá el PLU como producto pesable.' };
  }
  if (Number(item.quantity) !== 1) return { status: 400, error: 'Cada etiqueta de balanza se registra en su propia línea (cantidad 1).' };
  const parsed = parseScaleLabel(item.scaleLabel, settings);
  if (!parsed) return { status: 400, error: `La etiqueta de balanza ${item.scaleLabel} no es válida. Volvé a escanearla.` };
  if (parsed.weightGrams != null) {
    return { status: 400, error: `La etiqueta de balanza trae el peso: el PLU ${parsed.plu} tiene que estar cargado como producto pesable con su precio por kg.` };
  }
  return { item: { ...item, scaleLabel: String(item.scaleLabel).trim(), customName: `Balanza (PLU ${parsed.plu})`, unitPrice: parsed.amount } };
}

module.exports = { parseScaleLabel, resolveScaleLabelItem };
