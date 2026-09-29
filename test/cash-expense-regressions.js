'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');

module.exports = async function ({ db, apiClient, reset, request, record, port }) {
  const expense = { amount: 25, categoryRef: '91', description: 'Gasto de prueba' };
  function prepare() {
    reset();
    db.run("INSERT OR REPLACE INTO expense_categories(id,client_id,sucursal_id,name,active) VALUES(91,1,1,'Prueba',1)");
    db.run('UPDATE cash_sessions SET cloud_id=9001');
  }
  const count = () => db.get('SELECT COUNT(*) n FROM cash_movements').n;
  for (const selection of [{ withdrawFromMyCash: true }, { sourceCashSessionId: 9001 }]) {
    prepare();
    const response = await request('/expenses', { ...expense, ...selection });
    assert.equal(response.status, 201);
    assert.equal(count(), 1);
    assert.equal(db.get('SELECT expected_amount FROM cash_sessions').expected_amount, -25);
    assert.equal(db.get("SELECT COUNT(*) n FROM sync_outbox WHERE mutation_type='CASH_MOVEMENT'").n, 1);
  }
  prepare();
  db.run('UPDATE cash_sessions SET cloud_id=NULL');
  const localId = db.get('SELECT id FROM cash_sessions').id;
  assert.equal((await request('/expenses', { ...expense, sourceCashSessionId: localId })).status, 201);
  record('cashier_expense_own_cloud_and_pending_local_session', { passed: true });

  prepare();
  assert.equal((await request('/expenses', { ...expense, sourceCashSessionId: 9002 })).status, 503);
  assert.equal(count(), 0);
  assert.equal(db.get('SELECT expected_amount FROM cash_sessions').expected_amount, 0);
  record('other_register_offline_never_charges_current_register', { passed: true });

  for (const invalid of [{ type: 'WITHDRAWAL' }, { categoryRef: 'SYS::RETIRO' }, { scope: 'BRANCH' }]) {
    prepare();
    assert.equal((await request('/expenses', { ...expense, ...invalid })).status, 403);
    assert.equal(count(), 0);
  }
  prepare();
  db.run("UPDATE app_config SET value='[\"ROLE_INVENTARIO\"]' WHERE key='roles'");
  assert.equal((await request('/expenses', expense)).status, 403);
  prepare();
  db.run("UPDATE cash_sessions SET status='CLOSED'");
  assert.equal((await request('/expenses', { ...expense, withdrawFromMyCash: true })).status, 409);
  assert.equal(count(), 0);
  record('cashier_administrative_movements_inventory_and_closed_own_cash_rejected', { passed: true });

  prepare();
  let hits = [];
  let cloudStatus = 201;
  const cloud = http.createServer(async (req, res) => {
    let body = '';
    for await (const data of req) body += data;
    hits.push({ url: req.url, body: JSON.parse(body) });
    res.writeHead(cloudStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cloudStatus === 201 ? { id: 77, sourceCashSessionId: 9002 } : { message: 'Caja cerrada' }));
  });
  await new Promise(resolve => cloud.listen(0, '127.0.0.1', resolve));
  apiClient.setBaseUrl('http://127.0.0.1:' + cloud.address().port);
  apiClient.isOnline = async () => true;
  try {
    const payload = { ...expense, sourceCashSessionId: 9002 };
    assert.equal((await request('/expenses', payload)).status, 201);
    assert.deepEqual(hits[0], { url: '/api/client-panel/1/sucursales/1/expenses', body: payload });
    assert.equal(count(), 0);
    assert.equal(db.get('SELECT expected_amount FROM cash_sessions').expected_amount, 0);
    db.run("UPDATE cash_sessions SET status='CLOSED'");
    assert.equal((await request('/expenses', payload)).status, 201);
    assert.equal(count(), 0);
    cloudStatus = 409;
    assert.equal((await request('/expenses', payload)).status, 409);
    assert.equal(count(), 0);
    const wrongBranch = await fetch(`http://127.0.0.1:${port}/api/client-panel/1/sucursales/2/expenses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal(wrongBranch.status, 403);
    assert.equal(hits.length, 3);
    record('selected_cloud_register_preserved_and_rejections_never_enqueued', { passed: true });
  } finally {
    await new Promise(resolve => cloud.close(resolve));
    reset();
  }
};
