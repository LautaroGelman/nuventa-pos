'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const initSqlJs = require('sql.js');
const policy = require('../src/main/tiendanube-policy');

async function fixture() {
  const SQL = await initSqlJs(); const raw = new SQL.Database();
  raw.run('CREATE TABLE app_config(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE sync_outbox(client_id INTEGER,sucursal_id INTEGER)');
  const db = { get(sql, args) { const s = raw.prepare(sql); try { s.bind(args); return s.step() ? s.getAsObject() : undefined; } finally { s.free(); } },
    run(sql, args) { raw.run(sql, args); }, save() {} };
  const response = { active: true, linkedProductIds: [7], availableStock: { 7: 1 } };
  const api = { token: 'synthetic', authEpoch: 1, clientId: 1, sucursalId: 2,
    _branchPath: () => '/api/client-panel/1/sucursales/2', _fetch: async () => response };
  return { raw, db, api, response };
}

test('shared stock metadata is scoped and stale login responses cannot replace it', async () => {
  const f = await fixture();
  await policy.refresh(f.db, f.api);
  assert.deepEqual(policy.cached(f.db, f.api).linkedProductIds, [7]);
  assert.equal(policy.cached(f.db, { ...f.api, sucursalId: 3 }), null);
  f.api._fetch = async () => { f.api.authEpoch++; return f.response; };
  await assert.rejects(policy.refresh(f.db, f.api), { status: 409 }); f.raw.close();
});

test('shared sale flushes pending operations before checking fresh reservations', async () => {
  const f = await fixture(); const events = [];
  await policy.refresh(f.db, f.api);
  f.api._fetch = async path => { events.push(path); return f.response; };
  await policy.prepareSale(f.db, f.api, [{ productId: 7, quantity: 1 }], async () => events.push('flush'));
  assert.equal(events[0], 'flush'); assert.match(events[1], /refreshReservations=true$/);
  await assert.rejects(policy.prepareSale(f.db, f.api, [{ productId: 7, quantity: 1 }, { productId: 7, quantity: 1 }], async () => {}), { status: 409 });
  f.raw.close();
});

test('offline shared sales and unresolved uploads fail before local stock can change', async () => {
  const f = await fixture(); await policy.refresh(f.db, f.api);
  f.api._fetch = async () => { throw new Error('offline'); };
  await assert.rejects(policy.prepareSale(f.db, f.api, [{ productId: 7, quantity: 1 }], async () => {}), /offline/);
  f.db.run('INSERT INTO sync_outbox VALUES(1,2)');
  await assert.rejects(policy.prepareSale(f.db, f.api, [{ productId: 7, quantity: 1 }], async () => {}), /pendientes/);
  f.raw.close();
});

test('known non-shared branches preserve offline sales without invoking sync', async () => {
  const f = await fixture(); f.response.active = false; f.response.linkedProductIds = [];
  await policy.refresh(f.db, f.api); f.api.token = null;
  await policy.prepareSale(f.db, f.api, [{ productId: 7, quantity: 99 }], async () => { throw new Error('must not sync'); });
  f.raw.close();
});

test('a first stock sale requires initial policy verification and checks are serialized', async () => {
  const f = await fixture(); f.api.token = null;
  await assert.rejects(policy.prepareSale(f.db, f.api, [{ productId: 7, quantity: 1 }], async () => {}), { status: 503 });
  let release; const order = [];
  const first = policy.exclusive('scope', async () => { order.push(1); await new Promise(resolve => { release = resolve; }); });
  const second = policy.exclusive('scope', async () => order.push(2));
  await Promise.resolve(); assert.deepEqual(order, [1]); release(); await Promise.all([first, second]);
  assert.deepEqual(order, [1, 2]); f.raw.close();
});
