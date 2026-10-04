/* SolarPoints Phase D UI 重构 · 本地真实浏览器验收
 * 运行：NODE_PATH=<managed>/node_modules node scripts/acceptance_test.cjs
 * 依赖：本地 SP_DATA_DIR 沙箱服务已在 :3100 启动（不可触碰生产）
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://localhost:3100';

// 14 个导航屏（= 桌面端 14 项验收）
const SCREENS = [
  { screen: 'dashboard',  label: '经营总览', group: '经营' },
  { screen: 'reports',    label: '经营报表', group: '经营' },
  { screen: 'storeBiz',   label: '门店经营', group: '经营' },
  { screen: 'memberBiz',  label: '会员经营', group: '经营' },
  { screen: 'stores',     label: '门店管理', group: '业务' },
  { screen: 'members',    label: '会员管理', group: '业务' },
  { screen: 'rules',      label: '积分规则', group: '积分' },
  { screen: 'mall',       label: '积分商城', group: '积分' },
  { screen: 'approvals',  label: '积分审核', group: '系统' },
  { screen: 'sheets',     label: '云同步',   group: '系统' },
  { screen: 'db',         label: '数据主库', group: '系统' },
  { screen: 'audit',      label: '审计日志', group: '系统' },
  { screen: 'accounts',   label: '账号管理', group: '系统' },
  { screen: 'account',    label: '账号设置', group: '系统' },
];

  const consoleErrors = [];
  const pageErrors = [];
  const response401 = [];

function isBenign(text) {
  // 过滤与 UI 重构验收无关的噪音：图片 404、401（初始未登录探针 /api/auth/me 的正常回落）
  return /favicon\.ico/.test(text) || /logo\.png/.test(text) || /404/.test(text) || /401/.test(text) || /Unauthorized/i.test(text);
}

async function login(page) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  // 登录页
  await page.waitForSelector('#loginForm', { timeout: 10000 });
  await page.fill('input[name="username"]', 'admin');
  await page.fill('input[name="password"]', 'admin123');
  await page.click('#loginForm button[type="submit"]');
  await page.waitForSelector('#appShell:not(.hidden)', { timeout: 10000 });
  await page.waitForTimeout(500);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error' && !isBenign(m.text())) consoleErrors.push(m.text()); });
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('response', r => { if (r.status() === 401) response401.push(r.url()); });

  const report = { desktop: {}, mobile: {}, permission: {}, data: {}, console: {} };

  await login(page);

  // ---------- 桌面端 1440×900 ----------
  // 结构检查
  const structure = await page.evaluate(() => {
    const groups = Array.from(document.querySelectorAll('.nav-group-label')).map(e => e.textContent.trim());
    const navItems = Array.from(document.querySelectorAll('.nav-item')).map(e => e.dataset.screen);
    return { groups, navItems, navCount: navItems.length };
  });
  report.desktop.structure = structure;

  // 14 屏逐项点测
  const screenResults = [];
  for (const s of SCREENS) {
    const before = await page.evaluate(() => document.querySelector('#content')?.innerHTML.length || 0);
    const visible = await page.evaluate((scr) => {
      const el = document.querySelector(`.nav-item[data-screen="${scr}"]`);
      if (!el) return false;
      return el.style.display !== 'none' && el.offsetParent !== null;
    }, s.screen);
    if (visible) {
      await page.click(`.nav-item[data-screen="${s.screen}"]`);
      await page.waitForTimeout(800);
    }
    const info = await page.evaluate((scr) => {
      const c = document.querySelector('#content');
      const txt = c ? c.innerText : '';
      const htmlLen = c ? c.innerHTML.length : 0;
      const failed = /加载失败|Failed|noPermission|无权限/.test(txt);
      // 取首个可见标题
      const h = c ? (c.querySelector('h1,h2,.screen-title,.page-title') || {}) : {};
      return { text: txt.slice(0, 400), htmlLen, failed, title: (h.textContent || '').trim().slice(0, 60) };
    }, s.screen);
    const changed = info.htmlLen !== before;
    screenResults.push({
      screen: s.screen, label: s.label, group: s.group,
      navVisible: visible,
      rendered: visible && info.htmlLen > 50 && !info.failed,
      title: info.title,
      htmlLen: info.htmlLen,
      note: info.failed ? '渲染失败/无权限占位' : (visible ? (changed ? 'OK' : '内容未变化') : '导航不可见(无权限)'),
    });
  }
  report.desktop.screens = screenResults;

  // ---------- 数据真实性（API 层 + UI 层） ----------
  const apiData = await page.evaluate(async () => {
    const r = await fetch('/api/reports/overview');
    return await r.json();
  });
  // 导航到某屏（桌面侧栏可见，触发真实 click 处理函数）
  async function gotoScreen(screen) {
    await page.evaluate((s) => { const el = document.querySelector(`.nav-item[data-screen="${s}"]`); if (el && el.style.display !== 'none') el.click(); }, screen);
    await page.waitForTimeout(700);
  }
  // 默认英文：先验证英文空状态
  await gotoScreen('dashboard');
  const dashUIEn = await page.evaluate(() => { const c = document.querySelector('#content'); return c ? c.innerText : ''; });
  // 英文态：报表页（本次回归：经营页不得出现「活跃会员/活跃买家」）
  await gotoScreen('reports');
  const reportsUIEn = await page.evaluate(() => { const c = document.querySelector('#content'); return c ? c.innerText : ''; });
  const langBefore = await page.evaluate(() => state.lang);
  // 切到中文（点语言按钮），再验证中文空状态 + 门店数
  await page.evaluate(() => { const b = document.querySelector('#langBtn'); if (b) b.click(); });
  await page.waitForTimeout(500);
  await gotoScreen('dashboard');
  const dashUIZh = await page.evaluate(() => { const c = document.querySelector('#content'); return c ? c.innerText : ''; });
  // 冻结规则回归（本次最小修正）：经营总览不得再含整张"会员经营概览"卡（原 data-goto=memberBiz 按钮是其唯一入口）
  const dashMemberCard = await page.evaluate(() => {
    const c = document.querySelector('#content');
    return { hasMemberBizBtn: !!(c && c.querySelector('[data-goto="memberBiz"]')) };
  });
  const langAfter = await page.evaluate(() => state.lang);

  // 中文态：报表页 + KPI 卡结构（本次回归：三经营页 KPI 行应为 3 卡）
  await gotoScreen('reports');
  const reportsUIZh = await page.evaluate(() => { const c = document.querySelector('#content'); return c ? c.innerText : ''; });
  const kpiRowsNow = await page.evaluate(() => Array.from(document.querySelectorAll('.kpi-row')).map(r => ({ cls: r.className, cards: r.querySelectorAll('.kpi-card').length })));
  const storeBizUI = await page.evaluate(async () => { const el = document.querySelector('.nav-item[data-screen="storeBiz"]'); if (el && el.style.display !== 'none') el.click(); await new Promise(r => setTimeout(r, 700)); const c = document.querySelector('#content'); return c ? c.innerText : ''; });
  const memberBizUI = await page.evaluate(async () => { const el = document.querySelector('.nav-item[data-screen="memberBiz"]'); if (el && el.style.display !== 'none') el.click(); await new Promise(r => setTimeout(r, 700)); const c = document.querySelector('#content'); return c ? c.innerText : ''; });

  report.data = {
    api: {
      hasLevelDist: !!(apiData.levelDist && Object.keys(apiData.levelDist).length),
      levelDistKeys: apiData.levelDist ? Object.keys(apiData.levelDist) : [],
      storeRankingLen: (apiData.storeRanking || []).length,
      summaryMembersTotal: apiData.summary ? apiData.summary.membersTotal : null,
      summaryMembersActive: apiData.summary ? apiData.summary.membersActive : null,
      hasTypeDist: !!(apiData.typeDist && Object.keys(apiData.typeDist).length),
    },
    dashboardUI: {
      langBefore, langAfter,
      en_noSalesData: dashUIEn.includes('No sales data yet'),
      en_dataPending: dashUIEn.includes('Pending Kingdee sync'),
      zh_noSalesData: dashUIZh.includes('暂无销售数据'),
      zh_dataPending: dashUIZh.includes('数据待接入'),
      zh_hasStoreCount: /\d/.test(dashUIZh),
      // 冻结规则回归：经营总览不得出现客单价 / 活跃会员 / 新增会员（中英文均查）
      en_noAov: !/Avg Order Value|客单价/.test(dashUIEn),
      zh_noAov: !/Avg Order Value|客单价/.test(dashUIZh),
      en_noActiveMembers: !/Active Members|活跃会员/.test(dashUIEn),
      zh_noActiveMembers: !/Active Members|活跃会员/.test(dashUIZh),
      en_noNewMembers: !/New Members|新增会员/.test(dashUIEn),
      zh_noNewMembers: !/New Members|新增会员/.test(dashUIZh),
      // 本次最小修正回归：经营总览不再含整张"会员经营概览"卡（会员信息归积分体系、经营总览不承载会员经营指标）
      zh_noMemberOverview: !dashUIZh.includes('会员经营概览'),
      en_noMemberOverview: !dashUIEn.includes('Member Operations'),
      dash_noMemberBizBtn: dashMemberCard.hasMemberBizBtn === false,
    },
    storeBizUI_sample: storeBizUI.slice(0, 200),
    memberBizUI_hasLevel: /Platinum|Gold|Silver|Partner|Bronze|等级/.test(memberBizUI),
    memberBizUI_hasType: /Retail|B2B|类型|零售|伙伴/.test(memberBizUI),
    // 本次回归（2026-09-24）：全站移除「活跃会员」展示（报表页 KPI 卡 + 活跃买家格、门店经营卡、会员经营卡）
    activeMembersRemoved: {
      reports_en_noActive: !/Active Members|活跃会员|Active buyers|活跃买家/.test(reportsUIEn),
      reports_zh_noActive: !/Active Members|活跃会员|Active buyers|活跃买家/.test(reportsUIZh),
      storeBiz_zh_noActive: !/Active Members|活跃会员|Active buyers|活跃买家/.test(storeBizUI),
      memberBiz_zh_noActive: !/Active Members|活跃会员|Active buyers|活跃买家/.test(memberBizUI),
      storeBiz_zh_frozenSub: /冻结 \d+/.test(storeBizUI),
      memberBiz_zh_frozenSub: /冻结 \d+/.test(memberBizUI),
      kpiRows: kpiRowsNow,
      kpiAll3Cards: kpiRowsNow.length > 0 && kpiRowsNow.every(r => r.cards === 3 && /kpi-row-3/.test(r.cls)),
    },
  };

  // ---------- 权限点测（3 项，直接调用真实前端函数） ----------
  const perm = await page.evaluate(() => {
    const realGrants = state.me.grants.slice();
    const r1 = {
      hasReportView: realGrants.some(x => x.p === 'report.view'),
      storeBizVisible: canAccessScreen('storeBiz'),
      memberBizVisible: canAccessScreen('memberBiz'),
      reportsAlwaysVisible: canAccessScreen('reports'), // 无 SCREEN_PERMS 条目 → 恒 true
      storeBizNavDisplay: (() => { const e = document.querySelector('.nav-item[data-screen="storeBiz"]'); return e ? e.style.display : 'missing'; })(),
    };
    // 负向：合成一个无 report.view 的账号（不改 RBAC、不碰生产）。grants 是 [{p,s}] 对象数组
    state.me.grants = realGrants.filter(x => x.p !== 'report.view');
    document.querySelectorAll('.nav-item').forEach(el => { el.style.display = canAccessScreen(el.dataset.screen) ? '' : 'none'; });
    const r3 = {
      storeBizVisible: canAccessScreen('storeBiz'),
      memberBizVisible: canAccessScreen('memberBiz'),
      reportsAlwaysVisible: canAccessScreen('reports'),
      storeBizNavDisplay: (() => { const e = document.querySelector('.nav-item[data-screen="storeBiz"]'); return e ? e.style.display : 'missing'; })(),
      memberBizNavDisplay: (() => { const e = document.querySelector('.nav-item[data-screen="memberBiz"]'); return e ? e.style.display : 'missing'; })(),
    };
    // 还原
    state.me.grants = realGrants;
    document.querySelectorAll('.nav-item').forEach(el => { el.style.display = canAccessScreen(el.dataset.screen) ? '' : 'none'; });
    return { positive: r1, negative: r3 };
  });
  report.permission = perm;

  // ---------- 矮视口 1000×480（本次修复回归：侧栏自身滚动，body 不再被撑出整页滚动） ----------
  await page.setViewportSize({ width: 1000, height: 480 });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#appShell:not(.hidden)', { timeout: 10000 });
  await page.waitForTimeout(400);
  report.shortViewport = await page.evaluate(() => {
    const sb = document.querySelector('.sidebar');
    return {
      bodyNoScroll: document.body.scrollHeight <= window.innerHeight + 2,
      htmlNoScroll: document.documentElement.scrollHeight <= window.innerHeight + 2,
      sidebarOverflowY: getComputedStyle(sb).overflowY,
      sidebarScrolls: sb.scrollHeight > sb.clientHeight,
      bodyScrollH: document.body.scrollHeight,
      innerH: window.innerHeight,
    };
  });

  // ---------- 移动端 390×844 ----------
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#appShell:not(.hidden)', { timeout: 10000 });
  // 等侧栏离屏动画结束：直接判断汉堡按钮中心是否仍被侧栏矩形覆盖（覆盖=仍处过渡/错误状态）
  await page.waitForFunction(() => {
    const sb = document.querySelector('.sidebar');
    const tg = document.querySelector('#navToggle');
    if (!sb || !tg) return false;
    const sbR = sb.getBoundingClientRect();
    const tgR = tg.getBoundingClientRect();
    const cx = tgR.x + tgR.width / 2, cy = tgR.y + tgR.height / 2;
    const covered = cx >= sbR.x && cx <= sbR.x + sbR.width && cy >= sbR.y && cy <= sbR.y + sbR.height;
    return !covered;
  }, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  // 诊断（若仍被覆盖则打印，便于发现真实布局问题）
  const diag = await page.evaluate(() => {
    const sb = document.querySelector('.sidebar'); const tg = document.querySelector('#navToggle');
    if (!sb || !tg) return null;
    const sbR = sb.getBoundingClientRect(); const tgR = tg.getBoundingClientRect();
    return { appShellClass: document.querySelector('#appShell').className, sbRight: Math.round(sbR.x + sbR.width), tgX: Math.round(tgR.x), tgVisible: tgR.width > 0 };
  });
  if (diag) console.log('MOBILE_DIAG:', JSON.stringify(diag));

  const m = {};
  // 移动端点击：直接触发真实 DOM click 事件（规避 Playwright 对 position:fixed 元素的命中测试假阳性）。
  // 这仍会执行应用真实的点击处理函数（openNav / setScreen + closeNav），等价于真人点按。
  async function clickSel(sel) {
    await page.evaluate((s) => { const el = document.querySelector(s); if (el) el.click(); }, sel);
    await page.waitForTimeout(450);
  }
  async function mobileGoto(screen) {
    const open = await page.evaluate(() => document.querySelector('#appShell').classList.contains('nav-open'));
    if (!open) await clickSel('#navToggle');
    await clickSel(`.nav-item[data-screen="${screen}"]`);
    await page.waitForTimeout(450);
  }
  // M1: 汉堡可见、侧栏默认隐藏
  m.hamburgerVisible = await page.evaluate(() => {
    const t = document.querySelector('#navToggle');
    return t && t.offsetParent !== null;
  });
  // M2: 点汉堡开抽屉，14 项可见
  await clickSel('#navToggle');
  m.drawerOpens = await page.evaluate(() => document.querySelector('#appShell').classList.contains('nav-open'));
  m.mobileNavItems = await page.evaluate(() => Array.from(document.querySelectorAll('.nav-item')).filter(e => e.style.display !== 'none').length);
  // M3: dashboard 4 KPI（冻结）→ 移动端 2 列；不含客单价；含销售商品种类
  await mobileGoto('dashboard');
  const kpiInfo = await page.evaluate(() => {
    const row = document.querySelector('.kpi-row-4');
    if (!row) return { columns: -1, cardCount: 0, hasAov: true, hasProductCategories: false };
    const cs = getComputedStyle(row).gridTemplateColumns;
    const columns = cs.split(' ').filter(s => s.trim().length).length;
    const labels = Array.from(row.querySelectorAll('.kpi-label')).map(e => e.innerText.trim());
    return {
      columns,
      cardCount: labels.length,
      hasAov: labels.some(t => /客单价|Avg Order Value/i.test(t)),
      hasProductCategories: labels.some(t => /销售商品种类|Product Categories/i.test(t)),
      labels,
    };
  });
  m.kpiColumns = kpiInfo.columns;
  m.kpiCardCount = kpiInfo.cardCount;
  m.kpiHasAov = kpiInfo.hasAov;
  m.kpiHasProductCategories = kpiInfo.hasProductCategories;
  m.kpiLabels = kpiInfo.labels;
  // M4: 门店经营 移动端渲染（table→rep-list）
  await mobileGoto('storeBiz');
  m.storeBizMobileRendered = await page.evaluate(() => {
    const c = document.querySelector('#content');
    return c && c.innerHTML.length > 80 && !/加载失败/.test(c.innerText);
  });
  // M5: 无横向溢出（在桌面/移动均检查，这里取移动值）
  m.noHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
  // M6: 经营报表 移动端渲染
  await mobileGoto('reports');
  m.reportsMobileRendered = await page.evaluate(() => {
    const c = document.querySelector('#content');
    return c && c.innerHTML.length > 80 && !/加载失败/.test(c.innerText);
  });
  // M7: 会员经营 移动端分布条渲染
  await mobileGoto('memberBiz');
  m.memberBizMobileRendered = await page.evaluate(() => {
    const c = document.querySelector('#content');
    return c && c.innerHTML.length > 80 && !/加载失败/.test(c.innerText);
  });
  // M8: 关闭抽屉（此时抽屉因上一次点击已关闭，验证可再次打开+关闭）
  await clickSel('#navToggle');
  const reopened = await page.evaluate(() => document.querySelector('#appShell').classList.contains('nav-open'));
  await clickSel('#navToggle');
  m.drawerCloses = await page.evaluate(() => !document.querySelector('#appShell').classList.contains('nav-open'));
  m.drawerReopen = reopened;
  report.mobile = m;

  // ---------- Console 错误汇总 ----------
  report.console = {
    consoleErrors: consoleErrors.slice(0, 30),
    pageErrors: pageErrors.slice(0, 30),
    consoleErrorCount: consoleErrors.length,
    pageErrorCount: pageErrors.length,
    response401: Array.from(new Set(response401)),
  };

  await browser.close();

  const fs = require('fs');
  fs.writeFileSync('/tmp/acceptance_report.json', JSON.stringify(report, null, 2));

  // 打印摘要
  console.log('===== 桌面端 1440×900 =====');
  console.log('结构: groups=' + JSON.stringify(report.desktop.structure.groups) + ' navCount=' + report.desktop.structure.navCount);
  let passD = 0;
  for (const r of report.desktop.screens) {
    const ok = r.rendered ? '✅' : '❌';
    if (r.rendered) passD++;
    console.log(`  ${ok} [${r.group}] ${r.label}(${r.screen}) navVisible=${r.navVisible} rendered=${r.rendered} "${r.note}"`);
  }
  console.log(`  桌面屏渲染通过 ${passD}/${report.desktop.screens.length}`);

  console.log('\n===== 数据真实性 =====');
  console.log('  API levelDist 键=' + JSON.stringify(report.data.api.levelDistKeys) + ' 有levelDist=' + report.data.api.hasLevelDist + ' storeRanking=' + report.data.api.storeRankingLen + ' membersTotal=' + report.data.api.summaryMembersTotal + ' hasTypeDist=' + report.data.api.hasTypeDist);
  console.log('  dashboard(英文) 无销售数据=' + report.data.dashboardUI.en_noSalesData + ' 待接入=' + report.data.dashboardUI.en_dataPending);
  console.log('  dashboard(中文) 暂无销售数据=' + report.data.dashboardUI.zh_noSalesData + ' 数据待接入=' + report.data.dashboardUI.zh_dataPending + ' 含门店数=' + report.data.dashboardUI.zh_hasStoreCount);
  console.log('  冻结规则(经营总览禁现): 客单价 en=' + report.data.dashboardUI.en_noAov + ' zh=' + report.data.dashboardUI.zh_noAov + ' | 活跃会员 en=' + report.data.dashboardUI.en_noActiveMembers + ' zh=' + report.data.dashboardUI.zh_noActiveMembers + ' | 新增会员 en=' + report.data.dashboardUI.en_noNewMembers + ' zh=' + report.data.dashboardUI.zh_noNewMembers);
  console.log('  本次修正回归(经营总览移除会员经营概览卡): 中文无该卡=' + report.data.dashboardUI.zh_noMemberOverview + ' 英文无该卡=' + report.data.dashboardUI.en_noMemberOverview + ' 无 memberBiz 查看详情按钮=' + report.data.dashboardUI.dash_noMemberBizBtn);
  console.log('  memberBiz 等级分布渲染=' + report.data.memberBizUI_hasLevel + ' 类型分布渲染=' + report.data.memberBizUI_hasType);

  const amr = report.data.activeMembersRemoved;
  console.log('\n===== 本次回归：活跃会员移除 + 侧栏滚动修复 =====');
  console.log('  无活跃会员(报表en/报表zh/门店/会员)=' + [amr.reports_en_noActive, amr.reports_zh_noActive, amr.storeBiz_zh_noActive, amr.memberBiz_zh_noActive].join('/'));
  console.log('  冻结副文案(门店/会员)=' + amr.storeBiz_zh_frozenSub + '/' + amr.memberBiz_zh_frozenSub + ' KPI 行 3 卡=' + amr.kpiAll3Cards + ' rows=' + JSON.stringify(amr.kpiRows));
  const sv = report.shortViewport;
  console.log('  矮视口1000×480: body不整页滚=' + sv.bodyNoScroll + ' html不整页滚=' + sv.htmlNoScroll + ' 侧栏overflowY=' + sv.sidebarOverflowY + ' 侧栏内部滚动=' + sv.sidebarScrolls + ' (bodyH=' + sv.bodyScrollH + ' innerH=' + sv.innerH + ')');

  console.log('\n===== 权限点测 =====');
  console.log('  正向(report.view 持有): storeBiz=' + report.permission.positive.storeBizVisible + ' memberBiz=' + report.permission.positive.memberBizVisible + ' reports(恒可见)=' + report.permission.positive.reportsAlwaysVisible);
  console.log('  负向(无 report.view): storeBiz=' + report.permission.negative.storeBizVisible + ' memberBiz=' + report.permission.negative.memberBizVisible + ' reports(恒可见)=' + report.permission.negative.reportsAlwaysVisible);
  console.log('  负向导航隐藏: storeBiz.display=' + report.permission.negative.storeBizNavDisplay + ' memberBiz.display=' + report.permission.negative.memberBizNavDisplay);

  console.log('\n===== 移动端 390×844 =====');
  console.log('  M1 汉堡可见=' + report.mobile.hamburgerVisible + ' M2 抽屉开=' + report.mobile.drawerOpens + ' 可见导航项=' + report.mobile.mobileNavItems);
  console.log('  M3 KPI列数=' + report.mobile.kpiColumns + ' 卡数=' + report.mobile.kpiCardCount + ' 含客单价=' + report.mobile.kpiHasAov + ' 含销售商品种类=' + report.mobile.kpiHasProductCategories);
  console.log('       KPI标签=[' + (report.mobile.kpiLabels || []).join(' | ') + ']');
  console.log('  M4 门店经营渲染=' + report.mobile.storeBizMobileRendered + ' M5 无横溢=' + report.mobile.noHorizontalOverflow);
  console.log('  M6 报表渲染=' + report.mobile.reportsMobileRendered + ' M7 会员经营渲染=' + report.mobile.memberBizMobileRendered + ' M8 抽屉关=' + report.mobile.drawerCloses);

  console.log('\n===== Console 错误 =====');
  console.log('  console.error(非噪音)=' + report.console.consoleErrorCount + ' pageerror=' + report.console.pageErrorCount);
  console.log('  401 来源(应为初始未登录探针 /api/auth/me，属正常回落)=' + JSON.stringify(report.console.response401));
  if (report.console.consoleErrorCount) console.log('  ' + JSON.stringify(report.console.consoleErrors.slice(0, 10)));
  if (report.console.pageErrorCount) console.log('  ' + JSON.stringify(report.console.pageErrors.slice(0, 10)));

  console.log('\n报告已写入 /tmp/acceptance_report.json');
})().catch(e => { console.error('TEST_CRASH:', e); process.exit(1); });
