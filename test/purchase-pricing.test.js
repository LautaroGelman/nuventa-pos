'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const pricing = require('../src/main/purchase-pricing');
const contract = require('../contracts/purchase-pricing-v1.json');
test('purchase pricing matches the shared frontend and backend contract', () => {
  for (const c of contract.markupCases) assert.equal(pricing.roundedMarkupPrice(c.cost, c.percent), c.expected);
  for (const c of contract.unitCostCases) assert.equal(pricing.unitCost(c.amount, c.quantity, c.pack), c.expected);
  assert.equal(pricing.propose({cost: 1800, price: 2400, pricingMode: 'MARKUP', targetMarkupPercent: 30}, 2300), 3000);
});
