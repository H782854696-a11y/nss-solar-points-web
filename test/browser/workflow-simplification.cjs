'use strict';
// Run with Playwright available via NODE_PATH. Only a fresh temporary data directory is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');
const {startLocalApp,photo} = require('../helpers/local-app');
(async () => {
  const app=await startLocalApp(); let browser;
  const outputDir=path.resolve(process.env.UI_OUTPUT_DIR || path.join(app.dataDir,'screenshots'));fs.mkdirSync(outputDir,{recursive:true});
  const errors=[]; let page;
  try {
    browser=await chromium.launch({headless:true,...(process.env.TEST_BROWSER_EXECUTABLE ? {executablePath:process.env.TEST_BROWSER_EXECUTABLE} : {})});
    const admin=await app.login('admin');
    const stores=(await app.request('GET','/api/stores',null,admin)).data.items;
    await app.request('POST','/api/v2/purchase-shipments',{orderNo:'PO-PREVIEW-001',supplier:'演示供应商',productName:'太阳能组件',stage:'in_transit',eta:'2026-11-15'},admin);
    const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:1,serviceWorkers:'block'});
    await context.addInitScript(() => localStorage.setItem('nss_lang','zh'));
    page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    // Exercise the existing real login form, not a fake UI session.
    await page.goto(app.base);
    await page.locator('#loginForm [name="username"]').fill('admin');
    await page.locator('#loginForm [name="password"]').fill(app.changedPassword);
    await page.locator('#loginSubmit').click();
    await page.locator('.cc-home-hero').waitFor();
    await page.evaluate(() => I18N.setLang('zh'));
    await page.locator('.cc-home-hero').waitFor();
    await page.locator('.nav-item[data-workspace="approvals"]').click();
    await page.locator('#ccWorkflowForm').waitFor({state:'visible'});
    assert.equal(await page.locator('.nav-item.active').count(),1);
    assert.equal(await page.locator('.nav-item[data-workspace="storeops"]').count(),0);
    assert.equal(await page.locator('[data-i18n="nav.groupCommunications"]').textContent(),'公司公告');
    const form=page.locator('#ccWorkflowForm');
    const expected={
      stocktake:['storeId','counterName','images'],store_remediation:['storeId','issue','images'],
      store_receipt:['storeId','receiptDate','receiptNormal','exceptionReason','confirmedBy','images'],
      discount_request:['orderNumber','originalAmount','discountAmount','finalAmount','images'],
      expense_reimbursement:['storeId','expenseCategory','images'],
    };
    assert.equal(await form.locator('[name="type"] option').count(),5);
    for(const [type,keys] of Object.entries(expected)){
      await form.locator('[name="type"]').selectOption(type);
      const actual=await form.locator('[name]').evaluateAll(nodes=>nodes.map(x=>x.name).filter(x=>x!=='type'));
      assert.deepEqual(actual,keys,type+' exact fields');
      assert.equal(await form.locator('[name="images"]').getAttribute('accept'),'image/png,image/jpeg');
      assert.equal(await form.locator('[name="images"]').evaluate(x=>x.required),['stocktake','discount_request','expense_reimbursement'].includes(type));
    }
    await form.locator('[name="type"]').selectOption('store_receipt');
    assert.equal(await form.locator('[name="exceptionReason"]').isVisible(),false);
    await form.locator('[name="receiptNormal"]').selectOption('no');
    assert.equal(await form.locator('[name="exceptionReason"]').isVisible(),true);
    assert.equal(await form.locator('[name="exceptionReason"]').evaluate(x=>x.required),true);
    await form.locator('[name="storeId"]').selectOption(stores[0].id);
    await form.locator('[name="receiptDate"]').fill('2026-10-11');
    await form.locator('[name="confirmedBy"]').fill('收货确认人');
    await form.locator('[name="exceptionReason"]').fill('两箱外包装破损，待核对货物。');
    await page.screenshot({path:path.join(outputDir,'receipt-desktop.png'),fullPage:true});
    await form.locator('[name="type"]').selectOption('discount_request');
    await form.locator('[name="orderNumber"]').fill('SO-20261011-001');
    await form.locator('[name="originalAmount"]').fill('1000.10');
    await form.locator('[name="discountAmount"]').fill('50.20');
    assert.equal(await form.locator('[name="finalAmount"]').inputValue(),'949.90');
    assert.equal(await form.evaluate(f=>f.checkValidity()),false,'mandatory photo blocks submission');
    await form.locator('[name="images"]').setInputFiles({name:photo.fileName,mimeType:photo.mimeType,buffer:Buffer.from(photo.data.split(',')[1],'base64')});
    await form.locator('[data-photo-preview] img').waitFor();
    const submitted=page.waitForResponse(r=>r.url().endsWith('/api/v2/workflows')&&r.request().method()==='POST');
    await form.locator('[type="submit"]').click();
    assert.equal((await submitted).status(),201);
    await page.locator('#ccWorkflowForm [name="type"]').waitFor();
    // Workspaces share a stable content tree. Switching must not recreate the form or flash a loading skeleton.
    await page.evaluate(() => {
      window.originalWorkflowForm=document.querySelector('#ccWorkflowForm');
      window.menuViolations=[];
      window.menuObserver=new MutationObserver(() => {
        if(document.querySelectorAll('.nav-item.active').length>1) window.menuViolations.push('multiple active items');
        if(document.querySelector('.cc-loading')) window.menuViolations.push('loading flash');
      });
      window.menuObserver.observe(document.querySelector('#appShell'),{subtree:true,attributes:true,childList:true});
    });
    for(const key of ['org','collaboration','purchasing','announcements','governance','approvals']) await page.locator(`.nav-item[data-workspace="${key}"]`).click();
    assert.equal(await page.evaluate(()=>window.originalWorkflowForm===document.querySelector('#ccWorkflowForm')),true);
    assert.deepEqual(await page.evaluate(()=>window.menuViolations),[]);
    await page.evaluate(()=>window.menuObserver.disconnect());
    // Rapidly alternating full screens and workspaces must end on the last choice.
    await page.evaluate(() => {
      document.querySelector('.nav-item[data-screen="stores"]').click();
      document.querySelector('.nav-item[data-screen="accounts"]').click();
      document.querySelector('.nav-item[data-workspace="approvals"]').click();
    });
    await page.waitForFunction(()=>!document.querySelector('#content').hasAttribute('aria-busy')&&document.querySelector('#ccWorkflowForm')?.offsetHeight>0);
    assert.equal(await page.locator('.nav-item.active').count(),1);
    await page.locator('.nav-item[data-screen="stores"]').click();
    await page.locator('[data-region-new]').waitFor();
    await page.locator('[data-region-new]').click();
    await page.locator('#regionForm [name="code"]').fill('VIS-PREVIEW');
    await page.locator('#regionForm [name="name"]').fill('演示区域');
    await page.locator('[data-region-save]').click();
    await page.locator('.cc-region-directory-row').filter({hasText:'演示区域'}).waitFor();
    await page.locator('.cc-region-directory-row').filter({hasText:'演示区域'}).locator('button').click();
    await page.locator('#regionForm [name="name"]').fill('演示区域（已编辑）');
    await page.locator('[data-region-save]').click();
    await page.locator('.cc-region-directory-row').filter({hasText:'演示区域（已编辑）'}).waitFor();
    await page.screenshot({path:path.join(outputDir,'regions-desktop.png'),fullPage:true});
    await page.locator('.nav-item[data-workspace="announcements"]').click();
    await page.locator('[data-cc-ann-new]').waitFor({state:'visible'});
    assert.equal(await page.locator('[data-cc-ann-filter="draft"]').count(),0);
    await page.locator('[data-cc-ann-new]').click();
    assert.equal(await page.locator('#ccAnnouncementCreate select[name="status"]').count(),0);
    await page.locator('#ccAnnouncementCreate [name="title"]').fill('测试公告');
    await page.locator('#ccAnnouncementCreate [name="body"]').fill('仅用于本地回归验证。');
    await page.locator('#ccAnnouncementCreateSave').click();
    await page.locator('.cc-ann-item').filter({hasText:'测试公告'}).waitFor();
    await page.locator('.nav-item[data-workspace="purchasing"]').click();
    const shipment=page.locator('#ccPurchaseImages');
    await shipment.waitFor({state:'visible'});
    assert.equal(await page.locator('.cc-workspace-stats .cc-eta-stat strong').textContent(),'2026-11-15');
    await shipment.locator('[name="shipmentId"]').selectOption({index:1});
    await shipment.locator('[name="images"]').setInputFiles({name:photo.fileName,mimeType:photo.mimeType,buffer:Buffer.from(photo.data.split(',')[1],'base64')});
    const uploaded=page.waitForResponse(r=>r.url().includes('/purchase-shipments/')&&r.url().endsWith('/attachments')&&r.request().method()==='POST');
    await shipment.locator('[type="submit"]').click();assert.equal((await uploaded).status(),201);
    await page.locator('#ccPurchaseImages').waitFor();
    await page.screenshot({path:path.join(outputDir,'shipment-desktop.png'),fullPage:true});
    await page.locator('.nav-item[data-workspace="approvals"]').click();
    await page.locator('#ccWorkflowForm [name="type"]').selectOption('stocktake');
    await page.locator('#ccWorkflowForm [name="storeId"]').selectOption(stores[0].id);
    await page.screenshot({path:path.join(outputDir,'approvals-desktop.png'),fullPage:true});
    for(const width of [768,390,320]){
      await page.setViewportSize({width,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`no horizontal overflow at ${width}`);
      assert.equal(await page.locator('#ccWorkflowForm button[type="submit"]').isVisible(),true);
      await page.screenshot({path:path.join(outputDir,`approvals-${width}.png`),fullPage:true});
    }
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({ok:true,screenshots:outputDir,checks:['real login','five exact forms','photo required & upload','receipt conditional reason','discount arithmetic','stable sidebar','rapid navigation','region create/edit','no drafts','shipment ETA & images','desktop/tablet/mobile widths'],pageErrors:errors},null,2));
  } catch(error) {
    if(page) await page.screenshot({path:path.join(outputDir,'failure.png'),fullPage:true}).catch(()=>{});
    console.error(error);process.exitCode=1;
  } finally {await browser?.close();await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
