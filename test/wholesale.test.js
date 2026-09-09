const test = require('node:test');
const assert = require('node:assert/strict');
const initSqlJs = require('sql.js');
const { wholesalePrice } = require('../src/main/wholesale-pricing');
const { getPreferences, patchPreferences, syncPreferences } = require('../src/main/product-form-preferences');
const product = { price: 1000, wholesale_enabled: 1, wholesale_price: 800, wholesale_minimum_quantity: 6 };
test('mayorista aplica al alcanzar mínimo y nunca aumenta el minorista', () => {
  assert.equal(wholesalePrice(product, 5), 1000);
  assert.equal(wholesalePrice(product, 6), 800);
  assert.equal(wholesalePrice(product, 9), 800);
  assert.equal(wholesalePrice({...product, price:700}, 9),700);
  assert.equal(wholesalePrice({...product, weighable:1}, 9),1000);
});
test('preferencias sobreviven reinicio, aíslan sucursales y conservan cambios durante sync', async () => {
  const SQL = await initSqlJs(); let raw = new SQL.Database(); let saved;
  raw.run('CREATE TABLE app_config(key TEXT PRIMARY KEY, value TEXT)');
  const db = { get(sql, args) { const s = raw.prepare(sql); try { s.bind(args); return s.step() ? s.getAsObject() : undefined; } finally { s.free(); } }, run(sql,args) { raw.run(sql,args); }, save() { saved = raw.export(); } };
  patchPreferences(db,1,10,{wholesaleEnabled:true}); raw.close(); raw = new SQL.Database(saved);
  assert.equal(getPreferences(db,1,10).wholesaleEnabled,true);
  assert.equal(getPreferences(db,1,11).wholesaleEnabled,false);
  const api = {baseUrl:"https://cloud.test",authEpoch:1, async _fetch(url, options) {
    assert.match(url,/sucursales\/10\/product-form-preferences$/);
    assert.deepEqual(JSON.parse(options.body),{wholesaleEnabled:true});
    patchPreferences(db,1,10,{photoEnabled:true});
    return {wholesaleEnabled:true,photoEnabled:false};
  }};
  await syncPreferences(db,api,1,10);
  assert.deepEqual(getPreferences(db,1,10),{wholesaleEnabled:true,photoEnabled:true});
  api._fetch = async (_url,options) => JSON.parse(options.body);
  await syncPreferences(db,api,1,10);
  assert.equal(db.get('SELECT value FROM app_config WHERE key=?',['product_form_preferences_pending:1:10']),undefined);
  raw.close();
});
