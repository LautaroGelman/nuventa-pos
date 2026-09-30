'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setTiendanubeSaleSync } = require('../src/main/local-server');

module.exports = async ({ db, apiClient, reset, request, record }) => {
  reset();
  const originalFetch = apiClient._fetch;
  const state = { active: true, linkedProductIds: [701], availableStock: { 701: 0 } };
  const sale = () => ({ clientSaleUuid: crypto.randomUUID(), items: [{ productId: 701, quantity: 1 }],
    payments: [{ paymentMethod: 'EFECTIVO', amount: 100 }] });
  db.run('UPDATE app_config SET value=? WHERE key=?', [JSON.stringify(state), 'tiendanube:1:1']);
  setTiendanubeSaleSync(async () => {});
  try {
    apiClient._fetch = async () => state;
    const reserved = await request('/sales', sale());
    assert.equal(reserved.status, 409); assert.match(reserved.body.error, /reservado/);
    assert.equal(db.get('SELECT COUNT(*) n FROM sales').n, 0);
    assert.equal(db.get('SELECT quantity FROM products WHERE id=701').quantity, 100);
    assert.equal(db.get('SELECT expected_amount FROM cash_sessions').expected_amount, 0);
    apiClient._fetch = async () => { throw new Error('offline'); };
    const offline = await request('/sales', sale()); assert.equal(offline.status, 503);
    assert.equal(db.get('SELECT COUNT(*) n FROM sales').n, 0);
    state.availableStock[701] = 1; apiClient._fetch = async () => state;
    const acceptedPayload = sale(); const accepted = await request('/sales', acceptedPayload);
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.equal(db.get('SELECT quantity FROM products WHERE id=701').quantity, 99);
    assert.equal(db.get('SELECT expected_amount FROM cash_sessions').expected_amount, 100);
    const pending = await request('/sales', sale()); assert.equal(pending.status, 409);
    apiClient._fetch = async () => { throw new Error('offline'); };
    const duplicate = await request('/sales', acceptedPayload); assert.equal(duplicate.status, 200);
    assert.equal(db.get('SELECT COUNT(*) n FROM sales').n, 1);
    record('tiendanube_reserved_offline_pending_and_duplicate_sales_preserve_stock_and_cash', { passed: true });
  } finally { apiClient._fetch = originalFetch; setTiendanubeSaleSync(null); reset(); }
};
