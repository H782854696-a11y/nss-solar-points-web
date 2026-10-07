// 反向验证：总部/管理员账号必须完全不受本次改动影响
const { chromium } = require('playwright');
const HQ = ['org.view','org.manage','staff.view','staff.create','workflow.view','workflow.create','workflow.approve',
 'workflow.configure','store.view','task.view','task.create','task.edit','alert.view','system.audit.view',
 'db.view','announcement.view','announcement.manage','system.user.view'].map(p=>({p,s:'philippines'}));

async function check(role, label) {
  const b = await chromium.launch();
  const p = await (await b.newContext()).newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.route(u => u.pathname.startsWith('/api/') && u.pathname !== '/api/auth/me' && u.pathname !== '/api/stores',
    r => r.fulfill({status:200,contentType:'application/json',body:'[]'}));
  await p.route('**/api/auth/me', r => r.fulfill({status:200,contentType:'application/json',
    body: JSON.stringify({id:'a',username:'admin',name:'总部管理员',role:role,storeId:null,grants:HQ})}));
  await p.route('**/api/stores', r => r.fulfill({status:200,contentType:'application/json',body:'[]'}));
  await p.goto('https://nss-solar-points.com/', {waitUntil:'domcontentloaded'});
  await p.evaluate(()=>{localStorage.setItem('sp_token','verify-only');localStorage.setItem('sp_lang','zh');});
  await p.reload({waitUntil:'networkidle'});
  await p.waitForTimeout(2200);
  const vis = await p.evaluate(()=>Array.from(document.querySelectorAll('.nav-item'))
    .filter(el=>el.style.display!=='none').map(el=>el.textContent.trim().replace(/\s+/g,' ')));
  console.log(`\n=== ${label}（role=${role}）可见菜单 ===`);
  vis.forEach(v=>console.log('  👁 '+v));
  const need = ['门店管理','门店跟进','组织与流程设置'];
  let fail=0;
  need.forEach(n=>{ const ok=vis.some(v=>v.includes(n)); console.log(`  ${ok?'✅':'❌'} 「${n}」对${label}仍可见`); if(!ok)fail++; });
  if(errs.length){console.log('  ❌ JS错误: '+errs.join('|'));fail++;}
  await b.close();
  return fail;
}
(async()=>{
  let f = 0;
  f += await check('admin','总部管理员');
  f += await check('philippines_manager','菲律宾负责人');
  console.log(f? `\n❌ ${f} 项失败` : '\n✅ 总部侧完全不受影响');
  process.exit(f?1:0);
})();
