'use strict';
// Two isolated Electron main-process workers against a deliberately local QA backend.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const output = path.resolve(arg('--output'));
const catalog = JSON.parse(fs.readFileSync(arg('--catalog'), 'utf8'));
const sharedStock = process.argv.includes('--shared-stock');
assert.ok(catalog.clientId > 1 || (sharedStock && catalog.clientId === 1));
if (sharedStock) {
  assert.equal(catalog.products.length, 1, 'Pin exactly one shared product');
  assert.ok(!fs.existsSync(path.join(output, 'reservation-released.json')));
  assert.ok(!fs.existsSync(path.join(output, 'return-authorized.json')));
}
fs.mkdirSync(output, { recursive: true });
const evidence = [];
const workers = [];
function record(name, details) { evidence.push({ name, passed: true, ...details }); }
function rpc(worker, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(worker.channel); let data = '';
    socket.setTimeout(60000, () => socket.destroy(new Error('QA command timed out')));
    socket.setEncoding('utf8'); socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('data', chunk => { data += chunk; }); socket.on('error', reject);
    socket.on('end', () => { try { const response = JSON.parse(data); response.ok ? resolve(response.result) : reject(new Error(response.error)); } catch (error) { reject(error); } });
  });
}
function launch(name, fixture) {
  return new Promise((resolve, reject) => {
    const channel = `\\\\.\\pipe\\nuventa-pos-qa-${crypto.randomUUID()}`;
    const env = { ...process.env, NUVENTA_POS_QA_CLIENT_ID: String(catalog.clientId) };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), ['test/electron-qa-worker.js', '--dev', '--qa',
      ...(sharedStock ? ['--shared-stock'] : []), '--fixture', path.resolve(fixture), '--channel', channel],
      { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = fs.createWriteStream(path.join(output, `${name}.log`));
    const worker = { name, channel, child, log }; workers.push(worker);
    let buffer = ''; const timeout = setTimeout(() => reject(new Error(`${name} startup timed out`)), 90000);
    child.stdout.on('data', chunk => {
      log.write(chunk); buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'); const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (line.startsWith('QA_READY ')) { clearTimeout(timeout); worker.initial = JSON.parse(line.slice(9)); resolve(worker); }
        if (line.startsWith('QA_FAILED ')) { clearTimeout(timeout); reject(new Error(line)); }
      }
    });
    child.stderr.on('data', chunk => log.write(chunk));
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('exit', code => { clearTimeout(timeout); log.end(); if (!worker.initial) reject(new Error(`${name} exited ${code}`)); });
  });
}
const qty = (snapshot, id) => snapshot.products.find(row => row.id === id).quantity;
async function checked(worker, route, body) {
  const response = await rpc(worker, { action: 'request', route, body });
  assert.ok(response.status >= 200 && response.status < 300, `${route}: ${response.status} ${JSON.stringify(response.body)}`);
  return response;
}
function persist(name, details) {
  fs.writeFileSync(path.join(output, name), JSON.stringify(details, null, 2));
}
async function waitForStage(name, productId) {
  console.log(`QA_WAIT ${name}`);
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    const file = path.join(output, `${name}.json`);
    if (fs.existsSync(file)) {
      const signal = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(signal.clientId, catalog.clientId);
      assert.equal(signal.sucursalId, catalog.sucursalId);
      assert.equal(signal.productId, productId);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for coordinated stage ${name}`);
}
async function rejectWithoutMutation(worker, payload, expectedStatus) {
  const before = await rpc(worker, { action: 'snapshot' });
  const rejected = await rpc(worker, { action: 'request', route: '/sales', body: payload });
  assert.equal(rejected.status, expectedStatus, JSON.stringify(rejected.body));
  const after = await rpc(worker, { action: 'snapshot' });
  for (const field of ['products', 'sales', 'sessions', 'outbox']) assert.deepEqual(after[field], before[field]);
  return { terminal: worker.name, status: rejected.status, message: rejected.body.error };
}
async function reverseSale(worker, cloudId) {
  const details = await checked(worker, `/sales/${cloudId}`);
  assert.equal(details.body.items.length, 1);
  const item = details.body.items[0];
  await checked(worker, '/returns', { clientReturnUuid: crypto.randomUUID(), saleId: cloudId,
    reason: 'Reversion de prueba QA POS coordinada', refundMethod: 'CASH',
    items: [{ saleItemId: item.saleItemId || item.id, quantity: 1 }] });
  const state = await rpc(worker, { action: 'sync' }); assert.equal(state.outbox.length, 0);
  return state;
}
async function closeOwnSessions(terminals) {
  for (const worker of terminals) {
    const before = await rpc(worker, { action: 'snapshot' }); const session = before.sessions.find(row => row.status === 'OPEN');
    assert.ok(session);
    // Physical test cash is zero after returning the only cash sale.
    await checked(worker, `/cash-sessions/${session.id}/close-with-tracking`, { countedAmount: 0, floatLeftForNext: 0, note: 'Cierre QA POS: venta y devolucion completas' });
    const closed = await rpc(worker, { action: 'sync' }); assert.equal(closed.outbox.length, 0);
    assert.ok(closed.sessions.every(row => row.status === 'CLOSED'));
  }
}
async function runSharedStock(a, b, product, initial) {
  assert.equal(initial, 1, 'Start with exactly one physical unit');
  const policy = await rpc(a, { action: 'policy' });
  assert.equal(policy.active, true);
  assert.ok(policy.linkedProductIds.includes(product.id));
  assert.equal(policy.availableStock[product.id], 0, 'Tiendanube must reserve the only unit before this stage');
  const newPayload = () => ({ clientSaleUuid: crypto.randomUUID(), items: [{ productId: product.id, quantity: 1 }],
    payments: [{ paymentMethod: 'EFECTIVO', amount: product.price }] });
  const rejected = [];
  for (const worker of [a, b]) rejected.push(await rejectWithoutMutation(worker, newPayload(), 409));
  await rpc(a, { action: 'online', value: false });
  rejected.push(await rejectWithoutMutation(a, newPayload(), 503));
  await rpc(a, { action: 'online', value: true });
  record('shared_reserved_and_offline_sales_rejected_without_mutation', { rejected });
  persist('reserved-rejections.json', { evidence, a: await rpc(a, { action: 'snapshot' }), b: await rpc(b, { action: 'snapshot' }) });
  await waitForStage('reservation-released', product.id);
  const released = await rpc(a, { action: 'policy' }); assert.equal(released.availableStock[product.id], 1);
  const payload = newPayload();
  const created = await checked(a, '/sales', payload); assert.equal(created.status, 201);
  const sent = await rpc(a, { action: 'sync' }); assert.equal(sent.outbox.length, 0);
  assert.equal(sent.sales.length, 1); assert.equal(sent.sales[0].sync_status, 'synced');
  const cloudId = sent.sales[0].cloud_id; assert.ok(cloudId > 0);
  const duplicate = await checked(a, '/sales', payload); assert.equal(duplicate.status, 200);
  const refreshed = await rpc(b, { action: 'sync' }); assert.equal(qty(refreshed, product.id), 0);
  const lastRejected = await rejectWithoutMutation(b, newPayload(), 409);
  const second = await rpc(b, { action: 'sync' }); assert.equal(qty(second, product.id), 0);
  record('shared_last_unit_sale_acked_once_and_second_terminal_rejected', { cloudSaleId: cloudId, secondTerminal: lastRejected });
  persist('last-unit-sold.json', { evidence, a: await rpc(a, { action: 'snapshot' }), b: second });
  await waitForStage('return-authorized', product.id);
  await reverseSale(a, cloudId);
  const restored = await rpc(b, { action: 'sync' }); assert.equal(qty(restored, product.id), 1);
  await closeOwnSessions([a, b]);
  record('shared_sale_returned_inventory_restored_and_cash_closed', { physicalQuantity: 1 });
}
(async () => {
  const [a, b] = await Promise.all([launch('terminal-a', arg('--fixture-a')), launch('terminal-b', arg('--fixture-b'))]);
  assert.notEqual(a.initial.profile, b.initial.profile);
  assert.notEqual(a.initial.employeeId, b.initial.employeeId);
  assert.equal(a.initial.protocolVersion, 2); assert.equal(b.initial.protocolVersion, 2);
  const product = sharedStock ? catalog.products[0] : catalog.products.find(row => row.code === 'QA-POS-A');
  const initial = qty(a.initial, product.id);
  assert.equal(qty(b.initial, product.id), initial);
  for (const [worker, register] of [[a, catalog.registers[0]], [b, catalog.registers[1]]]) {
    await checked(worker, '/cash-sessions/open', { cashRegisterId: register.id, initialAmount: 0 });
    const state = await rpc(worker, { action: 'sync' }); assert.equal(state.outbox.length, 0);
  }
  record('two_separate_profiles_employees_and_synced_registers', { profiles: [a.initial.profile, b.initial.profile], clientId: catalog.clientId, sucursalId: catalog.sucursalId });
  if (sharedStock) {
    await runSharedStock(a, b, product, initial);
    persist('results.json', { visualDesktopE2E: false, liveCheckoutRace: false, liveSharedStock: true, evidence });
    console.log(JSON.stringify({ passed: evidence.length, clientId: catalog.clientId, liveSharedStock: true, visualDesktopE2E: false }));
    return;
  }
  const policy = await rpc(a, { action: 'policy' }); assert.equal(policy.active, false);
  record('real_tiendanube_metadata_for_unlinked_qa_branch', { active: policy.active, linkedProducts: policy.linkedProductIds.length });
  const payload = { clientSaleUuid: crypto.randomUUID(), items: [{ productId: product.id, quantity: 1 }],
    payments: [{ paymentMethod: 'EFECTIVO', amount: product.price }] };
  await rpc(a, { action: 'online', value: false });
  const created = await checked(a, '/sales', payload); assert.equal(created.status, 201);
  let state = await rpc(a, { action: 'reload' });
  assert.equal(qty(state, product.id), initial - 1); assert.ok(state.outbox.some(row => row.mutation_type === 'SALE'));
  const duplicate = await checked(a, '/sales', payload); assert.equal(duplicate.status, 200);
  state = await rpc(a, { action: 'snapshot' }); assert.equal(state.sales.length, 1);
  record('offline_sale_durable_restart_and_idempotent_retry', { localId: created.body.id, quantity: qty(state, product.id), outbox: state.outbox.length });
  await rpc(a, { action: 'online', value: true });
  state = await rpc(a, { action: 'sync' }); assert.equal(state.outbox.length, 0); assert.equal(state.sales[0].sync_status, 'synced');
  const cloudId = state.sales[0].cloud_id; assert.ok(cloudId > 0);
  const second = await rpc(b, { action: 'sync' }); assert.equal(qty(second, product.id), initial - 1);
  const repeated = await rpc(a, { action: 'sync' }); assert.equal(repeated.sales[0].cloud_id, cloudId); assert.equal(repeated.outbox.length, 0);
  record('real_bundle_ack_and_other_terminal_inventory_converge', { cloudSaleId: cloudId, quantityBoth: initial - 1 });
  // Exercise the supported business reversal, preserving the synthetic sale history.
  state = await reverseSale(a, cloudId);
  const restored = await rpc(b, { action: 'sync' }); assert.equal(qty(restored, product.id), initial);
  record('real_return_restores_inventory_across_both_terminals', { quantity: initial });
  await closeOwnSessions([a, b]);
  record('own_qa_cash_sessions_closed_and_outboxes_empty', {});
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ visualDesktopE2E: false, liveCheckoutRace: false, evidence }, null, 2));
  console.log(JSON.stringify({ passed: evidence.length, clientId: catalog.clientId, protocol: 2, visualDesktopE2E: false }));
})().catch(error => { fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.message, evidence }, null, 2)); console.error(error.message); process.exitCode = 1; })
  .finally(async () => { for (const worker of workers) { try { await rpc(worker, { action: 'shutdown' }); } catch { worker.child.kill(); } } });
