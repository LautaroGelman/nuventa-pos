'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const initSqlJs = require('sql.js');
const preferences = require('../src/main/business-ui-preferences');
async function fixture() {
  const SQL = await initSqlJs(); let raw = new SQL.Database(); let saved;
  raw.run('CREATE TABLE app_config(key TEXT PRIMARY KEY,value TEXT)');
  return { db: { get(sql,args) { const s=raw.prepare(sql); try { s.bind(args); return s.step()?s.getAsObject():undefined; } finally { s.free(); } },
    run(sql,args) { raw.run(sql,args); }, save() { saved=raw.export(); } },
    restart() { raw.close(); raw=new SQL.Database(saved); }, close() { raw.close(); } };
}
test('business preferences persist across restart, isolate tenants and never queue failed edits', async () => {
  const f=await fixture(); const api={clientId:1,authEpoch:1,token:'synthetic',baseUrl:'https://fixture.invalid',_fetch:async()=>({...preferences.DEFAULTS,showPayroll:false})};
  await preferences.syncPreferences(f.db,api,1); f.restart();
  assert.equal(preferences.getPreferences(f.db,1).showPayroll,false);
  assert.equal(preferences.getPreferences(f.db,2).showPayroll,true);
  api._fetch=async()=>{throw Object.assign(new Error('offline'),{status:503});};
  await assert.rejects(preferences.syncPreferences(f.db,api,1,{showPayroll:true}),{status:503});
  assert.equal(preferences.getPreferences(f.db,1).showPayroll,false);
  assert.equal(f.db.get('SELECT count(*) n FROM app_config').n,1);
  f.close();
});
test('a late response from a previous login cannot update the preferences cache', async () => {
  const f=await fixture(); let release; let started;
  const ready=new Promise(resolve=>{started=resolve;});
  const api={clientId:1,authEpoch:1,token:'synthetic',baseUrl:'https://fixture.invalid',_fetch:async()=>{started();return new Promise(resolve=>{release=resolve;});}};
  const request=preferences.syncPreferences(f.db,api,1); await ready;
  api.authEpoch=2; api.clientId=2; release({...preferences.DEFAULTS,showPayroll:false});
  await assert.rejects(request,{status:409});
  assert.equal(f.db.get('SELECT count(*) n FROM app_config').n,0); f.close();
});
test('invalid or offline patches cannot be saved locally', async () => {
  const f=await fixture(); const api={clientId:1,authEpoch:1,token:null};
  assert.throws(()=>preferences.validate({showPayroll:'false'}),{status:400});
  assert.throws(()=>preferences.validate({extra:true}),{status:400});
  await assert.rejects(preferences.syncPreferences(f.db,api,1,{showPayroll:false}),{status:503});
  assert.equal(f.db.get('SELECT count(*) n FROM app_config').n,0); f.close();
});
