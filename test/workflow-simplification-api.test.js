'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startLocalApp, photo } = require('./helpers/local-app');

test('simplified approvals, store catalogue, regions, announcements and shipment images', {timeout:60000}, async t => {
  const app = await startLocalApp(); t.after(app.close);
  const {request,login,dataDir} = app, admin = await login('admin');
  const stores = (await request('GET','/api/stores',null,admin)).data.items;
  const storeId = stores[0].id, otherStoreId = stores[1].id;
  const account = await request('POST','/api/v2/users',{username:'scope_manager',name:'Scope Manager',role:'manager',storeId,password:app.password},admin);
  assert.equal(account.status,201,JSON.stringify(account.data));
  const manager = await login('scope_manager');
  const reviewerResult = await request('POST','/api/v2/users',{username:'ph_reviewer',name:'PH Reviewer',role:'philippines_manager',password:app.password},admin);
  assert.equal(reviewerResult.status,201,JSON.stringify(reviewerResult.data));
  const reviewer = await login('ph_reviewer');
  const create = (type, form, images, cookie=admin) => request('POST','/api/v2/workflows',{type,form,...(images === undefined ? {} : {images})},cookie);
  const uploadCount = () => { const dir=path.join(dataDir,'uploads','workflow'); return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0; };
  const beforeTotal = async () => (await request('GET','/api/v2/workflows',null,admin)).data.total;
  let stocktake;
  await t.test('store picker returns all catalogue names but preserves submission scope', async () => {
    assert.equal((await request('GET','/api/v2/workflow-stores')).status,401);
    const catalogue = (await request('GET','/api/v2/workflow-stores',null,manager)).data.items;
    assert.equal(catalogue.length,stores.length);
    assert.equal(catalogue.find(x=>x.id===storeId).canSubmit,true);
    assert.equal(catalogue.find(x=>x.id===otherStoreId).canSubmit,false);
    assert.equal(Object.hasOwn(catalogue[0],'phone'),false,'catalogue does not expose store contact details');
    assert.equal((await create('stocktake',{storeId:otherStoreId},[photo],manager)).status,403);
    assert.equal((await create('stocktake',{storeName:'Handwritten'},[photo])).status,400);
    assert.equal((await create('stocktake',{storeId:'missing-id'},[photo])).status,400);
  });
  await t.test('mandatory images are atomic, validated and downloadable', async () => {
    const count=await beforeTotal(), files=uploadCount();
    for (const images of [undefined,[],[photo,{...photo,mimeType:'text/plain'}],[{...photo,data:'data:image/png;base64,ZXhl'}],Array(11).fill(photo)]) {
      assert.equal((await create('stocktake',{storeId},images)).status,400);
    }
    assert.equal(await beforeTotal(),count,'invalid uploads must not create pending approvals');
    assert.equal(uploadCount(),files,'invalid uploads must not leave orphan images');
    const result = await create('stocktake',{storeId,storeName:'Spoofed',counterName:''},[photo],manager);
    assert.equal(result.status,201,JSON.stringify(result.data));
    stocktake=result.data.item;
    assert.equal(stocktake.form.storeName,stores[0].name);
    assert.equal(stocktake.storeId,storeId);
    assert.equal(stocktake.attachments.length,1);
    const download = await fetch(app.base+`/api/v2/workflows/${stocktake.id}/attachments/${stocktake.attachments[0].id}/download`,{headers:{cookie:manager}});
    assert.equal(download.status,200); assert.deepEqual(Buffer.from(await download.arrayBuffer()),Buffer.from(photo.data.split(',')[1],'base64'));
  });
  await t.test('remediation and receipt accept exactly the new minimum fields',async () => {
    assert.equal((await create('store_remediation',{storeId,issue:'Repair sign'})).status,201);
    assert.equal((await create('store_remediation',{storeId})).status,400);
    const form={storeId,receiptDate:'2026-10-11',receiptNormal:'yes',confirmedBy:'Receiver'};
    assert.equal((await create('store_receipt',form)).status,201);
    assert.equal((await create('store_receipt',{...form,receiptNormal:'no'})).status,400);
    assert.equal((await create('store_receipt',{...form,receiptNormal:'no',exceptionReason:'Two damaged cartons'})).status,201);
    assert.equal((await create('store_receipt',{...form,receiptDate:'2026-02-30'})).status,400);
    for (const field of ['storeId','receiptDate','receiptNormal','confirmedBy']) {
      const invalid={...form};delete invalid[field];
      assert.equal((await create('store_receipt',invalid)).status,400,field);
    }
  });
  await t.test('discount amounts use cent arithmetic and require photos',async () => {
    const form={orderNumber:'SO-1',originalAmount:'100.10',discountAmount:'0.20',finalAmount:'99.90'};
    assert.equal((await create('discount_request',form)).status,400);
    const valid=await create('discount_request',form,[photo]);assert.equal(valid.status,201,JSON.stringify(valid.data));
    assert.equal(valid.data.item.form.finalAmount,99.9);
    for(const invalid of [{...form,finalAmount:'99.91'},{...form,discountAmount:'100.11'},{...form,originalAmount:'100.101'},{...form,discountAmount:'0.001'},{...form,orderNumber:''}]) assert.equal((await create('discount_request',invalid,[photo])).status,400);
    assert.equal((await create('discount_request',{orderNumber:'SO-zero',originalAmount:'1.00',discountAmount:'1.00',finalAmount:'0.00'},[photo])).status,201);
  });
  await t.test('expense reimbursement uses PHP amount, description and image evidence only',async () => {
    const valid = await create('expense_reimbursement',{storeId,expenseAmount:'1234.50',expenseDescription:'Taxi and parking'},[photo]);
    assert.equal(valid.status,201,JSON.stringify(valid.data));
    assert.equal(valid.data.item.form.expenseAmount,1234.5);
    assert.equal(valid.data.item.form.expenseCategory,undefined);
    for(const expenseAmount of ['0','0.00','-1','1.001','1000000001','1e2']) assert.equal((await create('expense_reimbursement',{storeId,expenseAmount,expenseDescription:'Taxi'},[photo])).status,400,expenseAmount);
    assert.equal((await create('expense_reimbursement',{storeId,expenseAmount:'10.00'},[photo])).status,400);
    assert.equal((await create('expense_reimbursement',{storeId,expenseAmount:'10.00',expenseDescription:'Taxi'})).status,400);
    assert.equal((await create('purchase_request',{purchaseSummary:'Solar panels',amount:100,reason:'Stock'},[photo])).status,400);
  });
  await t.test('return and resubmit retain evidence and reject store scope bypass',async () => {
    const returned=await request('POST',`/api/v2/workflows/${stocktake.id}/actions`,{action:'return',note:'Please update counter'},reviewer);
    assert.equal(returned.status,200,JSON.stringify(returned.data));
    assert.equal((await request('POST',`/api/v2/workflows/${stocktake.id}/actions`,{action:'resubmit',form:{storeId:otherStoreId}},manager)).status,403);
    const valid=await request('POST',`/api/v2/workflows/${stocktake.id}/actions`,{action:'resubmit',form:{storeId,counterName:'Updated counter'}},manager);
    assert.equal(valid.status,200,JSON.stringify(valid.data));
    assert.equal(valid.data.item.attachments.length,1);assert.equal(valid.data.item.status,'pending_approval');
    assert.equal(valid.data.item.form.counterName,'Updated counter');
  });
  await t.test('region edits keep stable IDs and linked stores',async () => {
    assert.equal((await request('POST','/api/v2/regions',{code:'DENY',name:'Denied'},manager)).status,403);
    const added=await request('POST','/api/v2/regions',{code:'TEST-REGION',name:'New area'},admin);
    assert.equal(added.status,201);assert.equal(added.data.item.countryCode,'PH');
    const region=(await request('GET','/api/v2/regions',null,admin)).data.items.find(x=>x.id===stores[0].regionId);
    assert.ok(region);
    const edited=await request('PUT',`/api/v2/regions/${region.id}`,{code:region.code,name:'Renamed area',countryCode:'CN'},admin);
    assert.equal(edited.status,200); assert.equal(edited.data.item.id,region.id);assert.equal(edited.data.item.countryCode,region.countryCode);
    assert.equal((await request('GET','/api/stores',null,admin)).data.items.find(x=>x.id===storeId).regionId,region.id);
    assert.equal((await request('PUT',`/api/v2/regions/${region.id}`,{code:'TEST-REGION',name:'Duplicate'},admin)).status,409);
    assert.equal((await request('PUT',`/api/v2/regions/${region.id}`,{code:'',name:''},admin)).status,400);
    assert.equal((await request('PUT',`/api/v2/regions/${region.id}`,{code:'DENY',name:'Denied'},manager)).status,403);
  });
  await t.test('announcement drafts cannot be saved and old drafts remain unexposed',async () => {
    const draft={id:'legacy-draft',title:'Unpublished',body:'Must stay private',status:'draft'};
    const file=path.join(dataDir,'announcements.json'),existing=JSON.parse(fs.readFileSync(file,'utf8'));
    fs.writeFileSync(file,JSON.stringify([...existing,draft]));
    assert.equal((await request('POST','/api/v2/announcements',{title:'Draft',body:'Text',status:'draft'},admin)).status,400);
    const published=await request('POST','/api/v2/announcements',{title:'Public notice',body:'Text',status:'published'},admin);
    assert.equal(published.status,201);
    assert.equal((await request('PUT',`/api/v2/announcements/${published.data.item.id}`,{title:'Back',body:'Text',status:'draft'},admin)).status,400);
    const list=(await request('GET','/api/v2/announcements?includeDrafts=1',null,admin)).data.items;
    assert.equal(list.some(x=>x.id===draft.id),false);
    assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).find(x=>x.id===draft.id).status,'draft');
  });
  await t.test('shipment ETA is a date across pages and image attachments are saved',async () => {
    const first=await request('POST','/api/v2/purchase-shipments',{orderNo:'PO-ETA-1',supplier:'Test',stage:'ordered',eta:'2026-11-15'},admin);
    assert.equal(first.status,201,JSON.stringify(first.data));
    const second=await request('POST','/api/v2/purchase-shipments',{orderNo:'PO-ETA-2',supplier:'Test',stage:'in_transit',eta:'2026-11-01'},admin);
    assert.equal(second.status,201);
    const list=await request('GET','/api/v2/purchase-shipments?limit=1',null,admin);
    assert.equal(list.data.nextExpectedArrival,'2026-11-01');
    const upload=await request('POST',`/api/v2/purchase-shipments/${first.data.item.id}/attachments`,photo,admin);
    assert.equal(upload.status,201,JSON.stringify(upload.data));
    const after=(await request('GET','/api/v2/purchase-shipments',null,admin)).data.items.find(x=>x.id===first.data.item.id);
    assert.equal(after.attachments.length,1);
  });
});
