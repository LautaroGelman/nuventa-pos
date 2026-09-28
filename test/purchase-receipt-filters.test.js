'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const initSqlJs = require('sql.js');
const receipts = require('../src/main/purchase-receipts');

test('receipt filters precede pagination, preserve local work and exclude stale online matches', async () => {
  const SQL=await initSqlJs(); const raw=new SQL.Database();
  raw.run('CREATE TABLE purchase_receipts(local_id INTEGER PRIMARY KEY,uuid TEXT,client_id INTEGER,sucursal_id INTEGER,state TEXT,receipt_json TEXT,draft_json TEXT,sync_status TEXT,created_at TEXT)');
  raw.run('CREATE TABLE purchase_receipt_amendments(local_id INTEGER PRIMARY KEY,receipt_local_id INTEGER,sync_status TEXT,sync_error TEXT)');
  const db={ all(sql,args=[]) { const statement=raw.prepare(sql); try { statement.bind(args); const rows=[]; while(statement.step()) rows.push(statement.getAsObject()); return rows; } finally {statement.free();} }, get(sql,args) {return this.all(sql,args)[0];} };
  const add=(id,state,totalAmount,sync='synced',tenant=1)=>raw.run('INSERT INTO purchase_receipts VALUES(?,?,?,2,?,?,NULL,?,?)',[id,`receipt-${id}`,tenant,state,JSON.stringify({uuid:`receipt-${id}`,state,totalAmount}),sync,`2026-09-${String(id).padStart(2,'0')}`]);
  add(1,'CONFIRMED',null); add(2,'CONFIRMED',0); add(3,'CONFIRMED',null,'pending');
  for(let i=4;i<10;i++) add(i,'DRAFT',null);
  add(10,'DRAFT',null,'pending'); add(11,'DRAFT',null,'synced',8);
  const scope={clientId:1,branchId:2};
  assert.equal(receipts.list(db,scope,0,2,'AMOUNT_PENDING').totalElements,2);
  assert.deepEqual(receipts.list(db,scope,0,2,'AMOUNT_PENDING').content.map(r=>r.uuid),['receipt-3','receipt-1']);
  assert.equal(receipts.list(db,scope,3,2,'DRAFT').content.length,1);
  assert.equal(receipts.list(db,scope,0,2,'DRAFT').totalElements,7);
  assert.deepEqual(receipts.list(db,scope,0,30,'DRAFT',['receipt-4']).content.map(r=>r.uuid),['receipt-10','receipt-4']);
  assert.equal(receipts.list(db,scope,0,30,'DRAFT').totalElements,7,'online filtering retains cached offline history');
  raw.close();
});
