const test = require('node:test');
const assert = require('node:assert/strict');
const initSqlJs = require('sql.js');
const { cacheInternalCodeProduct, internalCodeRoute } = require('../src/main/sync-bundle-v2');

test('confirmed internal codes survive restart and preserve pending local stock/prices', async () => {
  const SQL = await initSqlJs(); let raw = new SQL.Database(); let saved;
  raw.run('CREATE TABLE products(id INTEGER PRIMARY KEY,client_id INTEGER,sucursal_id INTEGER,code TEXT,no_code INTEGER,stock_tracked INTEGER,quantity INTEGER,price REAL)');
  raw.run('INSERT INTO products VALUES(7,1,10,NULL,1,0,23,120)');
  const db = { get(sql, args) { const s=raw.prepare(sql); try {s.bind(args);return s.step()?s.getAsObject():undefined;} finally{s.free();} },
    run(sql,args){raw.run(sql,args);}, save(){saved=raw.export();} };
  const product={id:7,code:'NV000000000007',stockTracked:false,quantity:9,price:100};
  cacheInternalCodeProduct(db,product,1,10);
  cacheInternalCodeProduct(db,product,1,10);
  raw.close(); raw=new SQL.Database(saved);
  assert.deepEqual(db.get('SELECT * FROM products WHERE id=?',[7]),{id:7,client_id:1,sucursal_id:10,code:product.code,no_code:0,stock_tracked:0,quantity:23,price:120});
  assert.throws(()=>cacheInternalCodeProduct(db,product,2,10),/otra sucursal/);
  assert.throws(()=>cacheInternalCodeProduct(db,{...product,code:''},1,10),/inválida/);
  raw.close();
});

test('only /items create/update forward internal-code generation; other routes are rejected', () => {
  assert.equal(internalCodeRoute('/items', 'POST', { generateInternalCode: true }), 'forward');
  assert.equal(internalCodeRoute('/items/42', 'PUT', { generateInternalCode: true }), 'forward');
  assert.equal(internalCodeRoute('/products', 'POST', { generateInternalCode: true }), 'reject');
  assert.equal(internalCodeRoute('/products/42', 'PUT', { generateInternalCode: true }), 'reject');
  assert.equal(internalCodeRoute('/items/42', 'PATCH', { generateInternalCode: true }), 'reject');
  assert.equal(internalCodeRoute('/items', 'POST', { generateInternalCode: false }), null);
  assert.equal(internalCodeRoute('/items', 'POST', null), null);
});
