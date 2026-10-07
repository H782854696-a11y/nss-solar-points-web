// 真实浏览器验证：注入店长(naga/manager)登录态，检查侧栏与中控平台工作区显隐
// 只读验证，不提交任何表单、不写生产数据。
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  // 拦截 /api/auth/me，返回店长真实权限（与生产 rbac.js store_manager 一致）
  const MGR_PERMS = ['dashboard.view','org.view','warehouse.view','workflow.view','workflow.create','workflow.execute',
    'store.view','staff.view','staff.assign','staff.appraise','member.view','member.create','member.edit',
    'points.view','points.grant','points.deduct','approval.view','approval.create','mall.view','mall.redeem',
    'mall.fulfill','mall.cancel','crm.view','crm.create','crm.edit','task.view','task.create','task.edit',
    'task.assign','task.close','alert.view','alert.create'];

  // ⚠️ 注册顺序很重要：Playwright 后注册的 handler 优先匹配。
  //   所以先注册「其它 API」兜底（用 predicate 排除下面两个），再注册 auth/me 与 stores 特例，
  //   保证 /api/auth/me 一定拿到带 grants 的店长身份，不会被兜底规则抢先返回 []。
  await page.route(url => url.pathname.startsWith('/api/') && url.pathname !== '/api/auth/me' && url.pathname !== '/api/stores',
    route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/v2/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], total: 0, offset: 0, limit: 20, counts: {}, unread: 0 }) }));

  await page.route('**/api/auth/me', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ id: 'LeqRlOKBJ0gpDcoKZLuYQ', username: 'naga', name: 'aping', role: 'manager',
      storeId: 'EplvJRndb7A7wSZ0qO2sD', grants: MGR_PERMS.map(p => ({ p, s: 'store' })) })
  }));
  await page.route('**/api/stores', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([{ id: 'EplvJRndb7A7wSZ0qO2sD', name: 'Naga', city: 'Cebu City', managerId: 'LeqRlOKBJ0gpDcoKZLuYQ', managerName: 'aping' }])
  }));

  await page.goto('https://nss-solar-points.com/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { localStorage.setItem('sp_token', 'verify-only'); localStorage.setItem('sp_lang', 'zh'); });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  // 读取侧栏所有可见项
  const sidebar = await page.evaluate(() => Array.from(document.querySelectorAll('.nav-item'))
    .map(el => ({ text: el.textContent.trim().replace(/\s+/g, ' '), visible: el.style.display !== 'none' })));

  console.log('\n=== 店长(naga/manager) 侧栏 ===');
  sidebar.forEach(i => console.log(`  ${i.visible ? '👁  显示' : '🚫 隐藏'}  ${i.text}`));

  const visibleTexts = sidebar.filter(i => i.visible).map(i => i.text);
  const mustHide = ['门店管理', '门店跟进', '组织与流程设置'];
  console.log('\n=== 断言 ===');
  let fail = 0;
  for (const m of mustHide) {
    const hidden = !visibleTexts.some(t => t.includes(m));
    console.log(`  ${hidden ? '✅' : '❌'} 「${m}」已从侧栏移除`);
    if (!hidden) fail++;
  }
  for (const keep of ['审批中心', '任务协作', '内容公告']) {
    const shown = visibleTexts.some(t => t.includes(keep));
    console.log(`  ${shown ? '✅' : '❌'} 「${keep}」正常保留`);
    if (!shown) fail++;
  }

  // 进入中控平台，检查页内标签页
  const cc = page.locator('.nav-item', { hasText: '中控平台' }).first();
  if (await cc.isVisible()) {
    await cc.click();
    await page.waitForTimeout(2000);
    const tabs = await page.evaluate(() => Array.from(document.querySelectorAll('[data-cc-tab]'))
      .map(b => ({ t: b.textContent.trim(), hidden: b.hidden })));
    console.log('\n=== 中控平台内标签页 ===');
    tabs.forEach(x => console.log(`  ${x.hidden ? '🚫 隐藏' : '👁  显示'}  ${x.t}`));
    const tabVisible = tabs.filter(x => !x.hidden).map(x => x.t);
    for (const m of ['门店跟进', '治理']) {
      const gone = !tabVisible.some(t => t.includes(m));
      console.log(`  ${gone ? '✅' : '❌'} 标签页「${m}」已移除`);
      if (!gone) fail++;
    }
    // 确认 storeops/governance 的 section 已从 DOM 移除
    const areas = await page.evaluate(() => Array.from(document.querySelectorAll('[data-cc-area]')).map(s => s.dataset.ccArea));
    console.log('  实际渲染的工作区: ' + JSON.stringify(areas));
    for (const a of ['storeops', 'governance']) {
      const gone = !areas.includes(a);
      console.log(`  ${gone ? '✅' : '❌'} 内容区 ${a} 已移除`);
      if (!gone) fail++;
    }
  }

  await page.screenshot({ path: __dirname + '/shot_store_manager.png', fullPage: false });
  console.log('\nJS 错误: ' + (errors.length ? errors.join(' | ') : '无 ✅'));
  if (errors.length) fail++;
  console.log(fail ? `\n❌ ${fail} 项未通过` : '\n✅ 全部通过');
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
