'use strict';

function roundedMarkupPrice(cost, markup) {
  if (!Number.isFinite(cost) || !Number.isFinite(markup) || cost < 0 || markup < 0 || markup > 10000) throw new Error('Revisá costo y recargo');
  const cents = BigInt(Math.round((cost + Number.EPSILON) * 100));
  const percent = BigInt(Math.round((markup + Number.EPSILON) * 100));
  const numerator = cents * (10000n + percent), divisor = 100000000n;
  return Number((numerator + divisor - 1n) / divisor) * 100;
}
function unitCost(amount, quantity, pack = 1) {
  if (amount == null) return null;
  if (!Number.isFinite(amount) || amount < 0 || !Number.isInteger(quantity) || quantity <= 0 || !Number.isInteger(pack) || pack <= 0 || quantity * pack > 2147483647) throw new Error('Revisá importe y unidades');
  const cents = BigInt(Math.round((amount + Number.EPSILON) * 100)), units = BigInt(quantity * pack);
  return Number((cents * 2n + units) / (units * 2n)) / 100;
}
function snapshot(product) {
  return { cost: Number(product.cost || 0), price: Number(product.price || 0), pricingMode: product.pricing_mode || 'MANUAL',
    targetMarkupPercent: product.target_markup_percent ?? null, costPending: !!product.cost_pending };
}
function propose(previous, cost) {
  const markup = previous?.pricingMode === 'MARKUP' ? previous.targetMarkupPercent
    : previous?.cost > 0 ? Math.round(((previous.price / previous.cost - 1) * 100 + Number.EPSILON) * 100) / 100 : null;
  if (!(cost > 0) || !previous || previous.costPending || !(previous.cost > 0) || markup == null || markup < 0 || markup > 10000) return null;
  return roundedMarkupPrice(cost, markup);
}
module.exports = { roundedMarkupPrice, unitCost, snapshot, propose };
