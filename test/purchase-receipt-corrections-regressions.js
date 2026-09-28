'use strict';
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const receipts = require('../src/main/purchase-receipts');
const corrections = require('../src/main/purchase-receipt-corrections');
const pricing = require('../src/main/purchase-pricing');
const { BundleSyncV2, pendingStockDelta } = require('../src/main/sync-bundle-v2');

module.exports = async function correctionRegressions(database, post) {
  let db = database.getDb();
  const scope = { clientId:98,branchId:98,employeeId:6,canPrice:true };
  const product = id => db.get('SELECT * FROM products WHERE id=?', [id]);
  db.transaction(() => {
    db.run('INSERT OR REPLACE INTO app_config(key,value) VALUES (?,?)', [receipts.featureKey(scope), '{"enabled":true,"receiptCorrections":true}']);
    for (const id of [2900,2901,2902,2903,2904]) db.run("INSERT INTO products(id,client_id,sucursal_id,code,name,cost,price,quantity,cloud_quantity,stock_tracked,active,pricing_mode,catalog_revision) VALUES (?,98,98,?,?,50,100,0,0,1,1,'MANUAL',1)", [id,`COR-${id}`,`Corrección ${id}`]);
  });
  const line = (id, qty=10, amount=1000) => ({ uuid:randomUUID(),productId:id,clientProductUuid:null,newProduct:null,decision:'RECEIVE',sourceDescription:null,
    invoiceQuantity:qty,unitsPerPack:1,lineAmount:amount,priceDecision:'ACCEPT',expectedPricing:pricing.snapshot(product(id)),reviewed:true,rememberMatch:false });
  const confirm = lines => receipts.confirm(db,scope,{uuid:randomUUID(),providerId:null,totalAmount:lines.reduce((n,l)=>n+l.lineAmount,0),adjustmentAmount:null,adjustmentReason:null,lines});
  const request = (receipt,action,extra={}) => ({mutationUuid:randomUUID(),expectedVersion:receipts.get(db,scope,receipt.uuid).version,action,...extra});
  const correct = (receipt,lineUuid,body,actor=scope) => {
    const view=corrections.preview(db,actor,receipt.uuid,lineUuid,body);
    return corrections.correct(db,actor,receipt.uuid,lineUuid,{...body,previewHash:view.previewHash});
  };
  const original = confirm([line(2900)]);
  assert.equal(product(2900).cost,100); assert.equal(product(2900).price,200);
  assert.throws(()=>corrections.preview(db,scope,original.uuid,original.lines[0].uuid,request(original,'CORRECT',{
    productId:2900,invoiceQuantity:1,unitsPerPack:1,choices:[{productId:2900,decision:'REVIEWED',reviewedSalePrice:1e16}]
  })),/precio revisado válido/);
  db.transaction(()=>db.run('UPDATE products SET quantity=quantity-3 WHERE id=2900'));
  const undo = request(original,'UNDO'), preview = corrections.preview(db,scope,original.uuid,original.lines[0].uuid,undo);
  assert.equal(product(2900).quantity,7,'Preview never changes stock');
  const frozen={...undo,previewHash:preview.previewHash};
  const undone=corrections.correct(db,scope,original.uuid,original.lines[0].uuid,frozen);
  assert.equal(product(2900).quantity,-3); assert.equal(product(2900).price,100); assert.equal(product(2900).cost,50); assert.equal(undone.receipt.totalAmount,1000);
  corrections.correct(db,scope,original.uuid,original.lines[0].uuid,frozen); assert.equal(product(2900).quantity,-3,'Lost response retry is idempotent');
  assert.equal(pendingStockDelta(db,2900,98,98),0,'Original +10 and reversal -10 remain separate and net to zero');
  const inventory={...scope,canPrice:false};
  const withPrice=confirm([line(2901)]);
  const pending=correct(withPrice,withPrice.lines[0].uuid,request(withPrice,'UNDO'),inventory);
  assert.equal(product(2901).cost,50); assert.equal(product(2901).price,200); assert.ok(pending.receipt.pricingEffects['2901'].reason);
  correct(withPrice,withPrice.lines[0].uuid,request(withPrice,'REVIEW_PRICING',{choices:[{productId:2901,decision:'APPLY'}]}));
  assert.equal(product(2901).price,100); assert.equal(product(2901).quantity,0);
  const repeated=confirm([line(2902),line(2902)]);
  correct(repeated,repeated.lines[0].uuid,request(repeated,'UNDO')); assert.equal(product(2902).cost,100);
  correct(repeated,repeated.lines[1].uuid,request(repeated,'UNDO')); assert.equal(product(2902).cost,50);
  const reassigned=confirm([line(2903)]);
  correct(reassigned,reassigned.lines[0].uuid,request(reassigned,'CORRECT',{productId:2904,invoiceQuantity:4,unitsPerPack:2}));
  assert.equal(product(2903).quantity,0); assert.equal(product(2904).quantity,8); assert.equal(product(2904).cost,125);
  correct(reassigned,reassigned.lines[0].uuid,request(reassigned,'UNDO')); assert.equal(product(2904).quantity,0); assert.equal(product(2904).cost,50);
  correct(reassigned,reassigned.lines[0].uuid,request(reassigned,'CORRECT',{productId:2903,invoiceQuantity:1,unitsPerPack:1}));
  db.transaction(()=>{db.run('UPDATE products SET price=222 WHERE id=2903');db.run('UPDATE products SET price=100 WHERE id=2903');});
  const later=correct(reassigned,reassigned.lines[0].uuid,request(reassigned,'UNDO')); assert.ok(later.products.find(p=>p.productId===2903).reviewRequired);
  database.closeDatabase(); await database.initDatabase(); db=database.getDb();
  assert.equal(receipts.get(db,scope,original.uuid).lines[0].stockState,'REVERSED'); assert.equal(product(2900).quantity,-3);
  assert.ok(db.get("SELECT COUNT(*) n FROM sync_outbox WHERE mutation_type='PURCHASE_RECEIPT_CORRECTION' AND client_id=98").n>=8);

  // A cloud correction may commit before its response is received. Downloads must keep
  // the local compensating movement until the same immutable operation is acknowledged.
  const local=receipts.get(db,scope,reassigned.uuid);
  const beforePayloads=db.all('SELECT idempotency_key,payload_json FROM sync_outbox WHERE client_id=98');
  const beforePricing=corrections.snapshot(product(2900));
  const cloud={authEpoch:1,clientId:98,sucursalId:98,employeeId:6,token:'synthetic-correction-token',syncBundle:async()=>({results:[],changes:[{entityType:'PRODUCT',entityId:2900,action:'UPSERT',payload:{id:2900,clientId:98,sucursalId:98,name:'Corrección 2900',cost:70,price:300,quantity:0,stockTracked:true,catalogRevision:20,pricingRevision:44}}],hasMore:false})};
  await new BundleSyncV2(cloud).sync({uploadMutations:false});
  assert.equal(product(2900).quantity,-3,'Catalog before ACK does not apply the reversal twice');
  assert.deepEqual(corrections.snapshot(product(2900)),beforePricing,'Deferred prices do not change the local pricing revision');
  assert.deepEqual(db.all('SELECT idempotency_key,payload_json FROM sync_outbox WHERE client_id=98'),beforePayloads,'Downloads never rewrite frozen messages');
  assert.equal(receipts.get(db,scope,reassigned.uuid).version,local.version);
  console.log('[CORRECTIONS] Undo, reassign, quantities, grouped costs, price permissions, repeated edits, durable restart and catalog-before-ACK: OK');

  // Full local API chain: provisional product -> correction -> overselling -> restart -> delayed ACKs.
  const earlier = db.get('SELECT COALESCE(MAX(sequence),0) n FROM sync_outbox WHERE client_id=1').n;
  db.transaction(()=>db.run("UPDATE sync_outbox SET state='QUARANTINED' WHERE client_id=1"));
  const chainCount=()=>db.get('SELECT COUNT(*) n FROM sync_outbox WHERE client_id=1 AND sequence>?',[earlier]).n;
  db.transaction(()=>{
    db.run("UPDATE cash_sessions SET status='CLOSED' WHERE client_id=1 AND sucursal_id=1");
    db.run("INSERT INTO cash_sessions(client_session_uuid,client_id,sucursal_id,employee_id,status,business_date,opening_time,initial_amount,expected_amount,cash_register_id,sync_status) VALUES('test-correction-session',1,1,6,'OPEN','2026-09-25','2026-09-25T09:00:00',0,0,77,'synced')");
  });
  const retail={clientId:1,branchId:1,employeeId:6,canPrice:true};
  db.transaction(()=>db.run('INSERT OR REPLACE INTO app_config(key,value) VALUES (?,?)',[receipts.featureKey(retail),'{"enabled":true,"receiptCorrections":true}']));
  const clientProductUuid=randomUUID(), lineUuid=randomUUID();
  const received=receipts.confirm(db,retail,{uuid:randomUUID(),providerId:null,totalAmount:null,adjustmentAmount:null,lines:[{
    uuid:lineUuid,productId:null,clientProductUuid,newProduct:{clientProductUuid,name:'Producto offline corregido',code:'COR-PROVISIONAL',noCode:false,price:2500},decision:'RECEIVE',
    invoiceQuantity:10,unitsPerPack:1,lineAmount:null,priceDecision:'KEEP',expectedPricing:{cost:0,price:2500,pricingMode:'MANUAL',targetMarkupPercent:null,costPending:true},reviewed:true,rememberMatch:false }]});
  const provisional=received.lines[0].productId;
  const correction={mutationUuid:randomUUID(),expectedVersion:received.version,action:'CORRECT',productId:provisional,clientProductUuid,invoiceQuantity:2,unitsPerPack:3};
  const corrected=corrections.correct(db,retail,received.uuid,lineUuid,{...correction,previewHash:corrections.preview(db,retail,received.uuid,lineUuid,correction).previewHash});
  const sold=await post('/sales',{clientSaleUuid:randomUUID(),items:[{productId:provisional,quantity:8}],payments:[{paymentMethod:'EFECTIVO',amount:20000}]});
  assert.equal(sold.status,201,JSON.stringify(sold.body)); assert.equal(sold.body.stockWarnings[0].stockAfter,-2);
  assert.equal(product(provisional).quantity,-2);
  const frozenChain=db.all('SELECT idempotency_key,payload_json,payload_hash FROM sync_outbox WHERE client_id=1');
  database.closeDatabase();await database.initDatabase();db=database.getDb();
  const remoteId=3900, applied=new Map(); let lost=true, cloudQuantity=0;
  const remoteReceipt=value=>({...value,syncStatus:'SYNCED',lines:value.lines.map(l=>({...l,productId:remoteId,currentQuantity:cloudQuantity,currentCatalogRevision:10,currentPricing:pricing.snapshot(product(remoteId)||product(provisional))})),pricingEffects:{[remoteId]:Object.values(value.pricingEffects)[0]}});
  const server={clientId:1,sucursalId:1,syncBundle:async body=>{
    const results=[];
    for (const mutation of body.mutations) {
      const frozen=frozenChain.find(r=>r.idempotency_key===mutation.idempotencyKey);
      assert.deepEqual(mutation.payload,JSON.parse(frozen.payload_json),'Provisional mapping never changes the frozen message');assert.equal(mutation.payloadHash,frozen.payload_hash);
      if(applied.has(mutation.idempotencyKey)){results.push({...applied.get(mutation.idempotencyKey),status:'DUPLICATE'});continue;}
      let response;
      if(mutation.type==='PURCHASE_RECEIPT'){cloudQuantity+=10;response=remoteReceipt(received);}
      else if(mutation.type==='PURCHASE_RECEIPT_CORRECTION'){
        assert.ok(applied.has(received.uuid));assert.equal(mutation.payload.baseMutationUuid,received.uuid);cloudQuantity-=4;
        response={mutationUuid:correction.mutationUuid,receipt:remoteReceipt(corrected.receipt),products:corrected.products.map(p=>({...p,productId:remoteId,quantityAfter:cloudQuantity,catalogRevision:11}))};
      } else if(mutation.type==='SALE'){
        assert.ok(applied.has(correction.mutationUuid));assert.equal(mutation.payload.items[0].receiptPriceUuid,correction.mutationUuid);cloudQuantity-=8;response={id:9900,totalAmount:20000};
      } else throw new Error('Unexpected chain mutation '+mutation.type);
      const result={idempotencyKey:mutation.idempotencyKey,status:'APPLIED',cloudId:mutation.type==='SALE'?9900:null,result:response};applied.set(mutation.idempotencyKey,result);results.push(result);
    }
    if(lost && body.mutations.length){lost=false;throw new Error('Lost response after server commit');}
    return {results,changes:[],hasMore:false};
  }};
  try{await new BundleSyncV2(server).sync();}catch(error){assert.match(error.message,/Lost response/);}
  for(let attempt=0;attempt<6 && chainCount();attempt++){
    db.transaction(()=>db.run("UPDATE sync_outbox SET state='PENDING',next_retry_at=NULL WHERE client_id=1 AND sequence>?",[earlier]));
    await new BundleSyncV2(server).sync();
    assert.equal(product(remoteId)?.quantity ?? product(provisional)?.quantity,-2,'Each old ACK preserves later correction and sale deltas');
  }
  assert.equal(chainCount(),0,JSON.stringify(db.all('SELECT mutation_type,state,last_error,payload_json FROM sync_outbox WHERE client_id=1 AND sequence>?',[earlier])));
  assert.equal(cloudQuantity,-2);assert.equal(product(remoteId).quantity,-2);
  assert.equal(receipts.get(db,retail,received.uuid).lines[0].receivedUnits,6);
  console.log('[CORRECTIONS] Provisional product, offline correction and sale, negative stock, restart, lost response and dependent ACKs: OK');

  // Only the dependent sale waits for a conflicting correction; unrelated sales in the same cash session continue.
  const latest=receipts.get(db,retail,received.uuid);
  const conflictRequest={mutationUuid:randomUUID(),expectedVersion:latest.version,action:'CORRECT',productId:remoteId,clientProductUuid,invoiceQuantity:3,unitsPerPack:3};
  corrections.correct(db,retail,received.uuid,lineUuid,{...conflictRequest,previewHash:corrections.preview(db,retail,received.uuid,lineUuid,conflictRequest).previewHash});
  assert.equal((await post('/sales',{items:[{productId:remoteId,quantity:1}],payments:[{paymentMethod:'EFECTIVO',amount:2500}]})).status,201);
  db.transaction(()=>db.run("INSERT INTO products(id,client_id,sucursal_id,code,name,cost,price,quantity,cloud_quantity,stock_tracked,active) VALUES(3901,1,1,'UNRELATED','Venta independiente',1,10,0,0,1,1)"));
  const unrelated=await post('/sales',{items:[{productId:3901,quantity:1}],payments:[{paymentMethod:'EFECTIVO',amount:10}]});assert.equal(unrelated.status,201);
  const uploaded=[];
  await new BundleSyncV2({clientId:1,sucursalId:1,syncBundle:async body=>({hasMore:false,changes:[],results:body.mutations.map(mutation=>{
    uploaded.push(mutation);
    return mutation.type==='PURCHASE_RECEIPT_CORRECTION'?{idempotencyKey:mutation.idempotencyKey,status:'CONFLICT',errorCode:'RECEIPT_CHANGED'}:{idempotencyKey:mutation.idempotencyKey,status:'APPLIED',cloudId:9901,result:{id:9901,totalAmount:10}};
  })})}).sync();
  assert.equal(uploaded.filter(m=>m.type==='SALE').length,1);
  assert.equal(uploaded.find(m=>m.type==='SALE').payload.items[0].productId,3901);
  assert.equal(receipts.get(db,retail,received.uuid).syncStatus,'REVIEW_REQUIRED');
  assert.ok(db.get('SELECT 1 FROM sync_outbox WHERE idempotency_key=?',[conflictRequest.mutationUuid]));
  console.log('[CORRECTIONS] A conflicting correction preserves its message and blocks only dependent sales: OK');
};
