'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseScaleLabel, resolveScaleLabelItem } = require('../src/main/scale-label');

// Prefijo 2, PLU 00123, importe 004350, verificador 6.
const LABEL = '2001230043506';
const settings = { enabled: true, prefix: '2', mask: 'PPPPPIIIIII', priceInCents: false, unregisteredLabelsEnabled: true };

test('lee PLU e importe de la etiqueta', () => {
  assert.deepEqual(parseScaleLabel(LABEL, settings), { plu: '00123', amount: 4350 });
  assert.deepEqual(parseScaleLabel(LABEL, { ...settings, priceInCents: true }), { plu: '00123', amount: 43.5 });
});

test('rechaza verificador, prefijo o importe inválidos', () => {
  assert.equal(parseScaleLabel('2001230043507', settings), null);
  assert.equal(parseScaleLabel(LABEL, { ...settings, prefix: '21', mask: 'PPPPIIIIII' }), null);
  assert.equal(parseScaleLabel('2001230000004', settings), null);
});

test('arma el renglón "Balanza (PLU …)" con el importe de la etiqueta, no el enviado', () => {
  const result = resolveScaleLabelItem({ productId: null, quantity: 1, scaleLabel: LABEL, customName: 'x', unitPrice: 1 }, settings);
  assert.equal(result.item.customName, 'Balanza (PLU 00123)');
  assert.equal(result.item.unitPrice, 4350);
});

test('respeta la configuración de la sucursal y la cantidad 1', () => {
  const item = { productId: null, quantity: 1, scaleLabel: LABEL };
  assert.equal(resolveScaleLabelItem(item, { ...settings, unregisteredLabelsEnabled: false }).status, 403);
  assert.equal(resolveScaleLabelItem(item, { ...settings, enabled: false }).status, 400);
  assert.equal(resolveScaleLabelItem(item, null).status, 400);
  assert.equal(resolveScaleLabelItem({ ...item, quantity: 2 }, settings).status, 400);
  // Config cacheada por un POS viejo, sin el campo: se vende igual (default activado).
  const { unregisteredLabelsEnabled: _omit, ...legacy } = settings;
  assert.ok(resolveScaleLabelItem(item, legacy).item);
});
