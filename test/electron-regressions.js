// Reproduction harness: all persistence and network endpoints are disposable/local.
const {app}=require('electron');
const fs=require('fs');const os=require('os');const path=require('path');const crypto=require('crypto');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'nuventa-audit-edge-'));
app.setPath('userData',profile);
if(!process.argv.includes('--dev'))process.argv.push('--dev');
const root=path.join(__dirname,'..');
const assert=require('node:assert/strict');
const database=require(path.join(root,'src/main/database'));
const {apiClient}=require(path.join(root,'src/main/api-client'));
const {BundleSyncV2,canonicalJson,sha256}=require(path.join(root,'src/main/sync-bundle-v2'));
const {startLocalServer,stopLocalServer}=require(path.join(root,'src/main/local-server'));
let db,port;const results=[];
function record(name,data){results.push({name,...data});console.log(JSON.stringify(results.at(-1)));}
function reset(){
 db.transaction(()=>{
  for(const t of ['return_items','returns','sale_payments','sale_promotion_discounts','sale_items','sales','cash_movements','sync_outbox','cash_sessions','cash_registers','products','sync_state','app_config'])db.run(`DELETE FROM ${t}`);
  for(const [k,v]of Object.entries({auth_token:'audit-synthetic-token',client_id:'1',sucursal_id:'1',employee_id:'6',employee_name:'Audit cashier',roles:'["ROLE_CAJERO"]',last_online_at:new Date().toISOString()}))db.run('INSERT INTO app_config(key,value) VALUES (?,?)',[k,v]);
  db.run("INSERT INTO products(id,code,name,price,quantity,client_id,sucursal_id,active) VALUES(701,'AUDIT','Audit product',100,100,1,1,1)");
  db.run("INSERT INTO cash_registers(id,name,active,client_id,sucursal_id) VALUES(77,'Audit register',1,1,1)");
  db.run("INSERT INTO cash_sessions(client_session_uuid,client_id,sucursal_id,employee_id,status,business_date,opening_time,initial_amount,expected_amount,cash_register_id,sync_status) VALUES('audit-session',1,1,6,'OPEN','2026-09-05','2026-09-05T09:00:00',0,0,77,'synced')");
  db.run('DELETE FROM sync_outbox');
 });
 apiClient.setAuth({token:'audit-synthetic-token',clientId:1,sucursalId:1,employeeId:6});
 apiClient.setBaseUrl('http://127.0.0.1:9');apiClient.isOnline=async()=>false;
}
async function request(route,body){const r=await fetch(`http://127.0.0.1:${port}/api/client-panel/1/sucursales/1${route}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};}
const sale=(extra={})=>({items:[{productId:701,quantity:1}],payments:[{paymentMethod:'EFECTIVO',amount:100}],...extra});
function enqueue(payload={amount:1},key=crypto.randomUUID()){
 const json=canonicalJson(payload);
 db.run("INSERT INTO sync_outbox(idempotency_key,mutation_type,source_table,source_id,occurred_at,payload_json,payload_hash,client_id,sucursal_id,state) VALUES(?,'CASH_MOVEMENT','cash_movements',999,'2026-09-05T09:00:00',?,?,1,1,'PENDING')",[key,json,sha256(json)]);
}
app.whenReady().then(async()=>{
 await database.initDatabase();db=database.getDb();port=await startLocalServer();
 try{
  reset();const before=db.get('SELECT COUNT(*) n FROM sales').n;const realFsync=fs.fsyncSync;
  fs.fsyncSync=()=>{const e=new Error('AUDIT injected ENOSPC');e.code='ENOSPC';throw e;};
  const diskFailure=await request('/sales',sale());fs.fsyncSync=realFsync;
  const after=db.get('SELECT COUNT(*) n FROM sales').n;
  const retry=await request('/sales',sale());
  record('disk_failure_ghost_sale',{http:diskFailure.status,before,afterFailedRequest:after,afterRetry:db.get('SELECT COUNT(*) n FROM sales').n,retryStatus:retry.status,stock:db.get('SELECT quantity FROM products WHERE id=701').quantity});

  reset();const receiptRequest=sale({clientSaleUuid:crypto.randomUUID(),totalDiscount:25,originalTotal:100,finalTotal:75,payments:[{paymentMethod:'EFECTIVO',amount:50},{paymentMethod:'TRANSFERENCIA',amount:25}]});
  const receiptCreated=await request('/sales',receiptRequest);
  const receiptDuplicate=await request('/sales',receiptRequest);
  assert.equal(receiptCreated.status,201);
  for(const receipt of [receiptCreated.body,receiptDuplicate.body]) {
    assert.equal(receipt.items[0].productName,'Audit product');
    assert.equal(receipt.totalAmount,75);assert.equal(receipt.totalDiscount,25);
    assert.deepEqual(receipt.payments.map(p=>[p.paymentMethod,p.amount]),[['EFECTIVO',50],['TRANSFERENCIA',25]]);
  }
  record('sale_and_idempotent_retry_include_complete_receipt',{passed:true});
  const fiscalBytes=Buffer.from([37,80,68,70,45,49,46,55,10,128,255,0,10]);let fiscalHits=0;
  const fiscalServer=require('http').createServer((req,res)=>{fiscalHits++;res.writeHead(200,{'Content-Type':'application/pdf'});res.end(fiscalBytes);});
  await new Promise(resolve=>fiscalServer.listen(0,'127.0.0.1',resolve));
  apiClient.setBaseUrl('http://127.0.0.1:'+fiscalServer.address().port);
  try{
    const pdfResponse=await fetch(`http://127.0.0.1:${port}/api/client-panel/1/sucursales/1/arca/invoices/99/pdf?format=A4`);
    assert.equal(pdfResponse.status,200);assert.equal(pdfResponse.headers.get('content-type'),'application/pdf');
    assert.deepEqual(Buffer.from(await pdfResponse.arrayBuffer()),fiscalBytes);
    const wrongBranch=await fetch(`http://127.0.0.1:${port}/api/client-panel/1/sucursales/2/arca/invoices/99/pdf`);
    assert.equal(wrongBranch.status,403);assert.equal(fiscalHits,1);
    record('cashier_arca_pdf_preserves_binary_and_branch_scope',{passed:true});
  }finally{await new Promise(resolve=>fiscalServer.close(resolve));apiClient.setBaseUrl('http://127.0.0.1:9');}
  reset();record('negative_payment',await request('/sales',sale({payments:[{paymentMethod:'EFECTIVO',amount:-100}]})));
  reset();record('missing_payment',await request('/sales',sale({payments:[]})));
  reset();record('mismatched_total',await request('/sales',sale({finalTotal:1})));
  reset();const retryKey=crypto.randomUUID();await request('/sales',sale({clientSaleUuid:retryKey}));await request('/sales',sale({clientSaleUuid:retryKey}));record('duplicate_local_post',{requestedKey:retryKey,sales:db.get('SELECT COUNT(*) n FROM sales').n,distinctKeys:db.get('SELECT COUNT(DISTINCT client_sale_uuid) n FROM sales').n});

  reset();db.run("INSERT INTO cash_registers(id,name,active,client_id,sucursal_id) VALUES(88,'Other branch register',1,1,2)");
  record('offline_register_scope',await request('/registers/availability'));
  db.run("UPDATE cash_sessions SET status='CLOSED',sync_status='synced'");db.run('DELETE FROM sync_outbox');
  record('offline_open_other_branch',await request('/cash-sessions/open',{cashRegisterId:88,initialAmount:0}));

  reset();const refundable=await request('/sales',sale());record('negative_return',await request('/returns',{saleId:refundable.body.id,items:[{productId:701,quantity:-1}],refundMethod:'CASH'}));

  reset();for(let i=0;i<51;i++)enqueue();let calls=[];
  const fake={clientId:1,sucursalId:1,syncBundle:async body=>{calls.push(body.mutations.length);return {results:body.mutations.map(m=>({idempotencyKey:m.idempotencyKey,status:'APPLIED'})),changes:[],nextCursor:'next',hasMore:false};}};
  await new BundleSyncV2(fake).sync();record('backlog_51',{batchSizes:calls,remaining:db.get('SELECT COUNT(*) n FROM sync_outbox').n});

  reset();enqueue();calls=[];
  await new BundleSyncV2(fake).sync({uploadMutations:false});
  assert.deepEqual(calls,[0]);
  assert.equal(db.get('SELECT COUNT(*) n FROM sync_outbox').n,1);
  assert.equal(db.get('SELECT attempts FROM sync_outbox').attempts,0);
  await new BundleSyncV2(fake).sync();
  assert.deepEqual(calls,[0,1]);
  assert.equal(db.get('SELECT COUNT(*) n FROM sync_outbox').n,0);
  record('catalog_refresh_keeps_pending_until_upload',{passed:true});

  reset();enqueue({note:'x'.repeat(1048576)});enqueue();calls=[];await new BundleSyncV2(fake).sync();record('oversize_head_starvation',{batchSizes:calls,remaining:db.get('SELECT COUNT(*) n FROM sync_outbox').n,states:db.all('SELECT state,COUNT(*) n FROM sync_outbox GROUP BY state')});

  reset();calls=[];const changing={clientId:1,sucursalId:1,authEpoch:1,syncBundle:async body=>{
   calls.push({branch:changing.sucursalId,cursor:body.cursor});
   if(calls.length===1){changing.sucursalId=2;changing.authEpoch++;return {results:[],changes:[],nextCursor:'branch-1-cursor',hasMore:true};}
   return {results:[],changes:[{entityType:'PRODUCT',entityId:999,action:'UPSERT',payload:{id:999,name:'Branch 2 only',price:3,quantity:9}}],nextCursor:'branch-2-cursor',hasMore:false};
  }};await assert.rejects(new BundleSyncV2(changing).sync(), /identidad/);record('branch_change_during_bundle',{calls,misfiledProduct:db.get('SELECT id,name,sucursal_id FROM products WHERE id=999'),state:db.all('SELECT sucursal_id,cursor FROM sync_state')});

  reset();let count=0;const partial={clientId:1,sucursalId:1,syncBundle:async()=>{
   if(count++)throw new Error('AUDIT connection lost after snapshot page 1');
   return {results:[],resetRequired:true,changes:[{entityType:'PRODUCT',entityId:702,action:'UPSERT',payload:{id:702,name:'First page',price:3,quantity:2}}],nextCursor:'snapshot-page-2',hasMore:true};
  }};try{await new BundleSyncV2(partial).sync();}catch{}
  record('partial_snapshot_erases_available_catalog',{products:db.all('SELECT id,active FROM products'),registers:db.all('SELECT id,active FROM cash_registers')});
  database.closeDatabase();await database.initDatabase();db=database.getDb();
  await new BundleSyncV2({clientId:1,sucursalId:1,syncBundle:async body=>{
    assert.equal(body.cursor,'snapshot-page-2');
    return {results:[],changes:[{entityType:'PRODUCT',entityId:703,action:'UPSERT',payload:{id:703,name:'Last page',price:4,quantity:3}}],nextCursor:'snapshot-done',hasMore:false};
  }}).sync();
  assert.deepEqual(db.all('SELECT id FROM products WHERE active=1 ORDER BY id'),[{id:702},{id:703}]);
  record('snapshot_resume_after_reopen',{passed:true});

  reset();db.transaction(()=>{for(let i=0;i<1001;i++)enqueue();});calls=[];
  await new BundleSyncV2(fake).sync();
  assert.equal(db.get('SELECT COUNT(*) n FROM sync_outbox').n,1);
  await new BundleSyncV2(fake).sync();
  assert.equal(db.get('SELECT COUNT(*) n FROM sync_outbox').n,0);
  record('backlog_1001',{batches:calls.length,passed:true});

  reset();db.run("UPDATE cash_sessions SET status='CLOSED',float_left_for_next=0,counted_amount=100,closing_time='2026-09-05T10:00:00'");
  db.run('UPDATE cash_registers SET default_opening_float=500');db.run('DELETE FROM sync_outbox');
  const zeroPreview=await request('/cash-sessions/open-preview?cashRegisterId=77');
  assert.equal(zeroPreview.body.suggestedAmount,0);assert.equal(zeroPreview.body.hasCarryOver,true);
  record('zero_float_preview',{passed:true});

  reset();const {authService}=require(path.join(root,'src/main/auth-service'));
  const localUser={email:'fixture@demo.nuventa.local',pw_salt:'fixture',pw_hash:crypto.createHash('sha256').update('fixturepassword').digest('hex'),
    last_online_at:new Date().toISOString(),client_id:1,sucursal_id:1,employee_id:6,employee_name:'Fixture',client_name:'Fixture',roles:'["ROLE_CAJERO"]'};
  db.run("DELETE FROM app_config WHERE key IN ('auth_token','roles','employee_id')");
  const offlineLogin=authService._offlineLogin(localUser.email,'password',localUser);
  assert.equal(offlineLogin.success,true);assert.equal(offlineLogin.isOffline,true);
  assert.equal(require(path.join(root,'src/main/offline-session')).isOfflineSession(offlineLogin.token),true);
  assert.equal(apiClient._headers().Authorization,undefined);
  assert.ok(db.get("SELECT value FROM app_config WHERE key='auth_token'")?.value);
  assert.equal((await request('/sales',sale())).status,201);
  const oldUser={...localUser,employee_id:8,last_online_at:new Date(Date.now()-8*86400000).toISOString()};
  assert.equal(authService._offlineLogin(oldUser.email,'password',oldUser).success,false);
  record('offline_login_without_remote_token',{passed:true});

  reset();await request('/sales',sale());record('payload_not_frozen_at_commit',{outbox:db.all('SELECT mutation_type,payload_json,payload_hash FROM sync_outbox')});
  const {SyncService}=require(path.join(root,'src/main/sync-service'));const sync=new SyncService();sync._bundleV2Available=true;
  apiClient.isOnline=async()=>true;apiClient.lastHeartbeatAuthed=true;
  apiClient.syncBundle=async(body)=>({results:body.mutations.map(m=>({idempotencyKey:m.idempotencyKey,status:'RETRYABLE'})),changes:[],nextCursor:'retry-cursor',hasMore:false});
  await sync.forceSync();record('success_with_pending_no_retry',{pending:db.get('SELECT COUNT(*) n FROM sync_outbox').n,retryScheduled:!!sync._retryTimer,runAgain:sync._runAgain});sync.stop();

  reset();db.run("UPDATE products SET weighable=1 WHERE id=701");await request('/sales',sale());const beforePull=db.get('SELECT quantity FROM products WHERE id=701').quantity;
  await new BundleSyncV2({clientId:1,sucursalId:1,syncBundle:async()=>({results:[],changes:[{entityType:'PRODUCT',entityId:701,action:'UPSERT',payload:{id:701,name:'Audit product',price:100,quantity:100,weighable:true}}],nextCursor:'next',hasMore:false})}).sync();record('weighable_pending_overlay',{beforePull,afterPull:db.get('SELECT quantity FROM products WHERE id=701').quantity});

  const {UpdateService}=require(path.join(root,'src/main/update-service'));const EventEmitter=require('events');
  const updater=new EventEmitter();updater.setFeedURL=()=>{};updater._logger={info:()=>{}};
  updater.install=()=>{updater.emit('error',new Error('AUDIT installer missing'));return false;};
  const {BaseUpdater}=require(path.join(root,'node_modules/electron-updater/out/BaseUpdater'));
  updater.quitAndInstall=BaseUpdater.prototype.quitAndInstall;
  const service=new UpdateService({autoUpdater:updater,app:{isPackaged:true,getVersion:()=> '1.1.0'}});
  service.start();updater.emit('update-downloaded',{version:'1.1.1'});await service.prepareInstallation(async()=>{});
  record('updater_library_failure_reports_success',{reportedSuccess:service.installDownloadedUpdate(),state:service.getStatus().state,error:service.getStatus().error});service.stop();

  const a=new apiClient.constructor();a.setAuth({token:'audit-old-token',clientId:1,sucursalId:1});a.setBaseUrl('http://127.0.0.1:9');
  const savedFetch=global.fetch;let resolveResponse;global.fetch=()=>new Promise(resolve=>{resolveResponse=resolve;});
  let revoked=false;a.on('session-revoked',()=>{revoked=true;});
  const req=a._fetch('http://127.0.0.1:9/audit').catch(e=>e.status);a.setAuth({token:'audit-new-token',clientId:1,sucursalId:1});
  resolveResponse(new Response('{}',{status:401}));await req;global.fetch=savedFetch;
  record('late_api_401_revokes_new_login',{newLoginRevoked:revoked});


  reset();db.transaction(()=>{for(let i=0;i<1001;i++)enqueue();db.run("UPDATE sync_outbox SET next_retry_at=datetime('now','+1 hours')");});calls=[];
  await new BundleSyncV2(fake).sync({urgent:true});
  assert.equal(db.get('SELECT COUNT(*) n FROM sync_outbox').n,0);
  assert.equal(calls.length,21);
  record('urgent_close_drains_1001_despite_backoff',{passed:true,batches:calls.length});

  reset();enqueue();db.run('UPDATE sync_outbox SET client_id=NULL,sucursal_id=NULL');calls=[];
  await new BundleSyncV2(fake).sync({urgent:true});
  assert.equal(db.get('SELECT COUNT(*) n FROM sync_outbox').n,0);
  record('urgent_cycle_includes_legacy_unscoped_rows',{passed:true});

  reset();enqueue({clientSessionUuid:'urgent-dependent'},'first-retry');enqueue({clientSessionUuid:'urgent-dependent'},'dependent-close');calls=[];
  await new BundleSyncV2({clientId:1,sucursalId:1,syncBundle:async body=>{
    calls.push(body.mutations.map(m=>m.idempotencyKey));
    return {results:body.mutations.map(m=>({idempotencyKey:m.idempotencyKey,status:'RETRYABLE'})),changes:[],hasMore:false};
  }}).sync({urgent:true});
  assert.equal(calls.length,1);
  assert.deepEqual(db.all('SELECT attempts FROM sync_outbox'),[{attempts:1},{attempts:1}]);
  record('urgent_retry_does_not_spin',{passed:true});

  reset();db.run("UPDATE cash_sessions SET status='CLOSED',sync_status='synced'");db.run('DELETE FROM sync_outbox');
  await request('/cash-sessions/open',{cashRegisterId:77,initialAmount:0});await request('/sales',sale());calls=[];
  await new BundleSyncV2(fake).sync({urgent:true,cashStateOnly:true});
  assert.equal(db.get("SELECT COUNT(*) n FROM sync_outbox WHERE mutation_type='CASH_SESSION_OPEN'").n,0);
  assert.equal(db.get("SELECT COUNT(*) n FROM sync_outbox WHERE mutation_type='SALE'").n,1);
  record('reconnected_open_leaves_sales_for_hourly_cycle',{passed:true});

  reset();const {loginEvents}=require(path.join(root,'src/main/local-server'));
  let closeEvents=0;
  const observeClose=()=>{closeEvents++;assert.equal(db.get("SELECT status FROM cash_sessions ORDER BY id DESC LIMIT 1").status,'CLOSED');};
  loginEvents.on('cash-session-closed',observeClose);
  const localId=db.get('SELECT id FROM cash_sessions').id;
  assert.equal((await request('/cash-sessions/close',{countedAmount:-1})).status,400);
  assert.equal(closeEvents,0);
  assert.equal((await request('/cash-sessions/close',{countedAmount:0})).status,200);
  assert.equal(closeEvents,1);
  assert.equal((await request(`/cash-sessions/${localId}/close-with-tracking`,{countedAmount:0})).status,200);
  assert.equal(closeEvents,2);
  loginEvents.removeListener('cash-session-closed',observeClose);
  record('close_event_after_durable_success_and_idempotent_retry',{passed:true});

  reset();db.run('UPDATE cash_sessions SET cloud_id=54');
  apiClient.isOnline=async()=>true;apiClient.lastHeartbeatAuthed=true;
  const originalCurrent=apiClient.getCurrentSession;
  let finishCurrent,startedCurrent;
  const started=new Promise(resolve=>{startedCurrent=resolve;});
  apiClient.getCurrentSession=()=>new Promise(resolve=>{finishCurrent=resolve;startedCurrent();});
  const readCurrent=request('/cash-sessions/current');await started;
  await request('/cash-sessions/close',{countedAmount:0});
  finishCurrent({id:54,status:'OPEN',cashRegisterId:77,clientSessionUuid:'audit-session'});
  assert.equal((await readCurrent).body,null);
  assert.equal(db.get("SELECT COUNT(*) n FROM cash_sessions WHERE status='OPEN'").n,0);
  apiClient.getCurrentSession=originalCurrent;
  record('late_online_read_cannot_resurrect_closed_session',{passed:true});


  reset();db.run('UPDATE cash_sessions SET cloud_id=54');await request('/sales',sale());
  db.run("UPDATE sync_outbox SET next_retry_at=datetime('now','+1 hours')");
  apiClient.isOnline=async()=>true;apiClient.lastHeartbeatAuthed=true;
  const automatic=new SyncService();automatic._bundleV2Available=true;
  const uploaded=[];let automaticCycle;
  apiClient.syncBundle=async body=>{
    uploaded.push(...body.mutations.map(m=>m.type));
    return {results:body.mutations.map(m=>({idempotencyKey:m.idempotencyKey,status:'APPLIED',cloudId:m.type==='CASH_SESSION_CLOSE'?54:901})),changes:[],hasMore:false};
  };
  const triggerClose=()=>{automaticCycle=automatic.forceSync({urgent:true});};
  loginEvents.on('cash-session-closed',triggerClose);
  assert.equal((await request('/cash-sessions/close',{countedAmount:100})).status,200);
  await automaticCycle;loginEvents.removeListener('cash-session-closed',triggerClose);
  assert.deepEqual(uploaded,['SALE','CASH_SESSION_CLOSE']);
  assert.equal(db.get('SELECT COUNT(*) n FROM sync_outbox').n,0);
  assert.equal(db.get('SELECT sync_status FROM cash_sessions').sync_status,'synced');
  automatic.stop();
  record('close_automatically_uploads_sale_then_close',{passed:true,uploaded});

  reset();apiClient.isOnline=async()=>true;apiClient.lastHeartbeatAuthed=true;
  const originalAvailability=apiClient.getRegisterAvailability;
  apiClient.getRegisterAvailability=async()=>[{register:{id:77,name:'Audit register'},occupied:false}];
  const pendingAvailability=await request('/registers/availability');
  assert.equal(pendingAvailability.body[0].occupied,true);
  assert.equal(pendingAvailability.body[0].availabilityVerified,false);
  db.run("UPDATE cash_sessions SET status='CLOSED',sync_status='synced'");db.run('DELETE FROM sync_outbox');
  assert.equal((await request('/registers/availability')).body[0].occupied,false);
  apiClient.getRegisterAvailability=async()=>[{register:{id:77,name:'Audit register'},occupied:true,occupiedSessionId:999}];
  assert.equal((await request('/registers/availability')).body[0].occupiedSessionId,999);
  apiClient.getRegisterAvailability=originalAvailability;
  record('availability_reads_each_cloud_change_and_preserves_pending_open',{passed:true});


  reset();db.run('UPDATE cash_sessions SET cloud_id=54');
  assert.equal((await request('/cash-sessions/close',{countedAmount:0})).status,200);
  const offlineClose=new SyncService();offlineClose._bundleV2Available=true;
  await offlineClose.forceSync({urgent:true});
  assert.equal(db.get('SELECT sync_status FROM cash_sessions').sync_status,'pending');
  offlineClose.stop();
  const restored=new SyncService();restored._bundleV2Available=true;
  apiClient.isOnline=async()=>true;apiClient.lastHeartbeatAuthed=true;
  restored._retryPendingCashState();await restored.drain();
  assert.equal(db.get('SELECT COUNT(*) n FROM sync_outbox').n,0);
  assert.equal(db.get('SELECT sync_status FROM cash_sessions').sync_status,'synced');
  restored.stop();record('offline_close_recovers_with_new_service_without_manual_sync',{passed:true});

 const byName=Object.fromEntries(results.map(r=>[r.name,r]));
 assert.equal(byName.disk_failure_ghost_sale.afterFailedRequest,0);
 assert.equal(byName.disk_failure_ghost_sale.afterRetry,1);
 assert.equal(byName.disk_failure_ghost_sale.stock,99);
 for(const name of ['negative_payment','missing_payment','mismatched_total','negative_return']) assert.equal(byName[name].status,400,name);
 assert.equal(byName.duplicate_local_post.sales,1);
 assert.equal(byName.offline_register_scope.body.length,1);
 assert.equal(byName.offline_open_other_branch.status,409);
 assert.equal(byName.backlog_51.remaining,0);
 assert.deepEqual(byName.oversize_head_starvation.states,[{state:'QUARANTINED',n:1}]);
 assert.equal(byName.branch_change_during_bundle.calls.length,1);
 assert.equal(byName.branch_change_during_bundle.misfiledProduct,null);
 assert.equal(byName.partial_snapshot_erases_available_catalog.products.find(p=>p.id===701).active,1);
 assert.equal(byName.partial_snapshot_erases_available_catalog.registers[0].active,1);
 assert.ok(byName.payload_not_frozen_at_commit.outbox[0].payload_hash);
 assert.equal(byName.success_with_pending_no_retry.retryScheduled,false);
 assert.equal(byName.weighable_pending_overlay.afterPull,100);
 assert.equal(byName.updater_library_failure_reports_success.reportedSuccess,false);
 assert.equal(byName.late_api_401_revokes_new_login.newLoginRevoked,false);
 reset();
 const tutorialRequests = [];
 const tutorialCloud = require('http').createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
   tutorialRequests.push({method:req.method, path:req.url, body, authorization:req.headers.authorization});
   res.writeHead(200, {'Content-Type':'application/json'});
   res.end(JSON.stringify({status:'DISMISSED', revision:1}));
  });
 });
 await new Promise(resolve => tutorialCloud.listen(0, '127.0.0.1', resolve));
 try {
  apiClient.setBaseUrl(`http://127.0.0.1:${tutorialCloud.address().port}`);
  const url = `http://127.0.0.1:${port}/api/client-panel/1/onboarding`;
  assert.equal((await fetch(`${url}?tutorialVersion=commerce-v2`)).status, 200);
  const tutorialV2 = {tutorialVersion:'commerce-v2',status:'IN_PROGRESS',completedTaskIds:['inventory.create'],taskPositions:{'sales.open':'choose'},mutedSections:['inventory','purchaseOrders','finanzas','reports'],revision:0};
  assert.equal((await fetch(url, {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(tutorialV2)})).status, 200);
  assert.equal((await fetch(url.replace('/1/', '/2/'))).status, 403);
  assert.equal(tutorialRequests.length, 2);
  assert.equal(tutorialRequests[1].method, 'PUT');
  assert.equal(tutorialRequests[0].path, '/api/client-panel/1/onboarding?tutorialVersion=commerce-v2');
  assert.deepEqual(JSON.parse(tutorialRequests[1].body), tutorialV2);
  assert.equal(tutorialRequests[1].authorization, 'Bearer audit-synthetic-token');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM sync_outbox').n, 0);
  record('cashier_tutorial_progress_is_scoped_and_never_queued',{passed:true});
 } finally {
  await new Promise(resolve => tutorialCloud.close(resolve));
 }
 reset();
 const wholesaleRequests=[];
 const wholesaleCloud=require('http').createServer((req,res)=>{
  wholesaleRequests.push(req.url);
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end(JSON.stringify(req.method==='GET'
   ? [{sucursalId:1,productId:701,promotionId:1,minimumQuantity:6,unitPrice:80}]
   : {originalSubtotal:700,totalDiscount:140,finalTotal:560,appliedPromotions:[]}));
 });
 await new Promise(resolve=>wholesaleCloud.listen(0,'127.0.0.1',resolve));
 try {
  apiClient.setBaseUrl(`http://127.0.0.1:${wholesaleCloud.address().port}`);
  apiClient.isOnline=async()=>true;
  const quoteUrl=`http://127.0.0.1:${port}/api/client-panel/1/inventory/wholesale-prices`;
  const quotes=await fetch(quoteUrl);
  assert.equal(quotes.status,200);assert.equal((await quotes.json())[0].unitPrice,80);
  assert.equal((await fetch(quoteUrl.replace('/1/','/2/'))).status,403);
  apiClient.isOnline=async()=>true;apiClient.lastHeartbeatAuthed=true;
  const preview=await request('/promotions/apply',{items:[{productId:701,quantity:7,unitPrice:100}]});
  assert.equal(preview.status,200);assert.equal(preview.body.finalTotal,560);
  const wrongBranch=await fetch(`http://127.0.0.1:${port}/api/client-panel/1/sucursales/2/promotions/apply`,{
   method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:[]})});
  assert.equal(wrongBranch.status,403);assert.equal(wholesaleRequests.length,2);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM sync_outbox').n,0);
  apiClient.isOnline=async()=>false;
  const offline=await request('/promotions/apply',{items:[{productId:701,quantity:7,unitPrice:100}]});
  assert.equal(offline.body.finalTotal,700);assert.equal(wholesaleRequests.length,2);
  record('cashier_wholesale_prices_and_online_calculation_are_scoped',{passed:true});
 } finally {await new Promise(resolve=>wholesaleCloud.close(resolve));}


 reset();
 const signedQuoteCloud=require('http').createServer((req,res)=>{
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end(JSON.stringify({originalSubtotal:480,totalDiscount:0,finalTotal:480,unitPrices:{701:80},
   priceQuotes:{701:{unitPrice:80,catalogRevision:8,priceProof:'w1.online',wholesaleMinimumQuantity:6,quantity:6}},appliedPromotions:[]}));
 });
 await new Promise(resolve=>signedQuoteCloud.listen(0,'127.0.0.1',resolve));
 try {
  apiClient.setBaseUrl(`http://127.0.0.1:${signedQuoteCloud.address().port}`);
  apiClient.isOnline=async()=>true;apiClient.lastHeartbeatAuthed=true;
  const preview=await request('/promotions/apply',{productPricingVersion:1,items:[{productId:701,quantity:3,unitPrice:100},{productId:701,quantity:3,unitPrice:100}]});
  assert.equal(preview.body.finalTotal,480);
  const quotedSale=await request('/sales',sale({clientSaleUuid:crypto.randomUUID(),items:[{productId:701,quantity:6}],originalTotal:480,finalTotal:480,payments:[{paymentMethod:'EFECTIVO',amount:480}]}));
  assert.equal(quotedSale.status,201,JSON.stringify(quotedSale.body));assert.equal(quotedSale.body.items[0].unitPrice,80);
  const frozen=JSON.parse(db.get("SELECT payload_json FROM sync_outbox WHERE mutation_type='SALE' ORDER BY sequence DESC LIMIT 1").payload_json);
  assert.equal(frozen.items[0].priceProof,'w1.online');assert.equal(frozen.items[0].catalogRevision,8);
  const under=await request('/sales',sale({clientSaleUuid:crypto.randomUUID(),items:[{productId:701,quantity:5}],originalTotal:400,finalTotal:400,payments:[{paymentMethod:'EFECTIVO',amount:400}]}));
  assert.equal(under.status,400);
  apiClient.isOnline=async()=>false;
  const offline=await request('/promotions/apply',{items:[{productId:701,quantity:6,unitPrice:100}]});
  assert.equal(offline.body.finalTotal,600);
  record('signed_online_quote_matches_local_sale_despite_legacy_or_stale_catalog',{passed:true});
 } finally {await new Promise(resolve=>signedQuoteCloud.close(resolve));}
 reset();
 db.run("UPDATE products SET wholesale_enabled=1,wholesale_configured=1,wholesale_price=80,wholesale_minimum_quantity=6,wholesale_price_proof='w1.test',catalog_revision=3 WHERE id=701");
 const localOffers=await fetch(`http://127.0.0.1:${port}/api/client-panel/1/inventory/wholesale-prices`).then(r=>r.json());
 assert.equal(localOffers[0].unitPrice,80);
 const quote=await request('/promotions/apply',{items:[{productId:701,quantity:3,unitPrice:100},{productId:701,quantity:3,unitPrice:100}]});
 assert.equal(quote.body.originalSubtotal,480); assert.deepEqual(quote.body.appliedPromotions,[]);
 assert.equal(quote.body.unitPrices['701'],80);
 const nativeSale=await request('/sales',sale({clientSaleUuid:crypto.randomUUID(),items:[{productId:701,quantity:6}],originalTotal:480,finalTotal:480,payments:[{paymentMethod:'EFECTIVO',amount:480}]}));
 assert.equal(nativeSale.status,201,JSON.stringify(nativeSale.body));assert.equal(nativeSale.body.items[0].unitPrice,80);assert.equal(nativeSale.body.items[0].wholesaleApplied,true);
 const frozen=db.get("SELECT payload_json FROM sync_outbox WHERE mutation_type='SALE' ORDER BY sequence DESC LIMIT 1");
 assert.ok(frozen);const sold=JSON.parse(frozen.payload_json).items[0];
 assert.equal(sold.unitPrice,80);assert.equal(sold.wholesaleMinimumQuantity,6);assert.equal(sold.priceProof,'w1.test');
 db.run('UPDATE products SET wholesale_price=70,wholesale_minimum_quantity=10 WHERE id=701');db.save();
 database.closeDatabase();await database.initDatabase();db=database.getDb();
 assert.equal(db.get('SELECT unit_price FROM sale_items ORDER BY id DESC LIMIT 1').unit_price,80);
 assert.equal(JSON.parse(db.get("SELECT payload_json FROM sync_outbox WHERE mutation_type='SALE' ORDER BY sequence DESC LIMIT 1").payload_json).items[0].wholesaleMinimumQuantity,6);

 const nativeReturn=await request('/returns',{saleId:nativeSale.body.id,items:[{productId:701,quantity:3}],refundMethod:'CASH'});
 assert.equal(nativeReturn.status,201,JSON.stringify(nativeReturn.body));assert.equal(nativeReturn.body.totalRefund,240);
 record('native_wholesale_quote_sale_receipt_and_frozen_offline_proof_survive_restart',{passed:true});
 reset();
 const previousVersionSale=await request('/sales',sale());assert.equal(previousVersionSale.status,201);
 // Recreate a populated v13 database, then let the real startup migrator upgrade it.
 for(const [table,columns] of Object.entries({products:['wholesale_enabled','wholesale_configured','wholesale_price','wholesale_minimum_quantity','wholesale_price_proof'],sale_items:['wholesale_minimum_quantity'],sales:['product_pricing_version']})) {
  for(const column of columns) db.run(`ALTER TABLE ${table} DROP COLUMN ${column}`);
 }
 db.run('DELETE FROM schema_migrations WHERE version=14');db.save();
 database.closeDatabase();await database.initDatabase();db=database.getDb();
 assert.equal(db.get('SELECT wholesale_enabled FROM products WHERE id=701').wholesale_enabled,0);
 assert.equal(db.get('SELECT product_pricing_version FROM sales ORDER BY local_id DESC LIMIT 1').product_pricing_version,null);
 assert.equal(db.get('SELECT unit_price FROM sale_items ORDER BY id DESC LIMIT 1').unit_price,100);
 assert.equal(db.get('SELECT COUNT(*) n FROM schema_migrations WHERE version=14').n,1);
 record('existing_pos_v13_migrates_additively_without_repricing_sales',{passed:true});

 reset();
 db.run("UPDATE products SET catalog_revision=3,price_proof='v1.cached',wholesale_enabled=1,wholesale_configured=1,wholesale_price=80,wholesale_minimum_quantity=6,wholesale_price_proof='w1.cached' WHERE id=701");
 db.run("INSERT INTO sync_state(client_id,sucursal_id,device_id,cursor) VALUES(1,1,'test-device','existing-cursor')");
 const oldGetProducts=apiClient.getProducts;
 let downloaded={id:701,name:'Audit product',price:100,quantity:100,wholesaleEnabled:true,wholesaleConfigured:true,wholesalePrice:80,wholesaleMinimumQuantity:6};
 apiClient.getProducts=async()=>[downloaded];
 const catalogRefresh=new SyncService();
 try {
  await catalogRefresh._downloadProducts();
  assert.equal(db.get('SELECT wholesale_price_proof FROM products WHERE id=701').wholesale_price_proof,'w1.cached');
  assert.equal(db.get('SELECT catalog_revision FROM products WHERE id=701').catalog_revision,3);
  assert.equal(db.get('SELECT cursor FROM sync_state WHERE client_id=1 AND sucursal_id=1').cursor,'existing-cursor');
  downloaded={...downloaded,wholesaleMinimumQuantity:10};await catalogRefresh._downloadProducts();
  assert.equal(db.get('SELECT wholesale_price_proof FROM products WHERE id=701').wholesale_price_proof,null);
  assert.equal(db.get('SELECT cursor FROM sync_state WHERE client_id=1 AND sucursal_id=1').cursor,null);
  record('unsigned_catalog_refresh_preserves_matching_proofs_and_requests_changed_rules',{passed:true});
 } finally {apiClient.getProducts=oldGetProducts;catalogRefresh.stop();}
 console.log(`[REGRESSION] ${results.length} escenarios verificados`);
 }finally{if(process.env.NUVENTA_REGRESSION_RESULTS) fs.writeFileSync(process.env.NUVENTA_REGRESSION_RESULTS,JSON.stringify(results,null,2));await stopLocalServer();database.closeDatabase();app.quit();}
}).catch(e=>{console.error(e.stack);app.exit(1);});
