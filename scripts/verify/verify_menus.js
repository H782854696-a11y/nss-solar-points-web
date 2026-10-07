// 2026-10-07 门店三板块移出 · 显隐逻辑验证
// 加载真实 app.js 片段，注入两套真实 grants（店长 / 总部），断言侧栏与工作区显隐。
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/v2/app.js', 'utf8');

// 抽出被测函数（连同依赖）
function extract(startMark, endMark) {
  const s = src.indexOf(startMark);
  const e = src.indexOf(endMark, s);
  if (s < 0 || e < 0) throw new Error('未找到片段: ' + startMark);
  return src.slice(s, e);
}

// 抽出被测函数（连同依赖 SCREEN_PERMS）
const block = extract('const SCREEN_PERMS = {', 'let appBound');

function runAs(me) {
  const state = { me };
  const can = perm => Array.isArray(me.grants) && me.grants.some(x => x.p === perm);
  const t = k => k;
  const roleLabel = () => 'r';
  const fn = new Function('state', 'can', 't', 'roleLabel', block + `
    return { canAccessScreen, canAccessWorkspace, isStoreManager, homeScreen, STORE_MANAGER_HIDDEN_SCREENS, STORE_MANAGER_HIDDEN_WORKSPACES };
  `);
  return fn(state, can, t, roleLabel);
}

// 店长真实权限（取自生产 lib/rbac.js store_manager 段）
const MGR = ['dashboard.view','org.view','warehouse.view','workflow.view','workflow.create','workflow.execute',
  'store.view','staff.view','staff.assign','staff.appraise','member.view','member.create','member.edit',
  'points.view','points.grant','points.deduct','approval.view','approval.create','mall.view','mall.redeem',
  'mall.fulfill','mall.cancel','crm.view','crm.create','crm.edit','task.view','task.create','task.edit',
  'task.assign','task.close','alert.view','alert.create'].map(p => ({ p, s: 'store' }));

// 总部（philippines_manager）关键权限
const HQ = ['org.view','org.manage','staff.view','staff.create','workflow.view','workflow.create','workflow.configure',
  'store.view','task.view','task.create','task.edit','alert.view','system.audit.view','db.view','announcement.manage',
  'announcement.view'].map(p => ({ p, s: 'philippines' }));

let pass = 0, fail = 0;
const t = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, '→ 实际', JSON.stringify(actual), '期望', JSON.stringify(expected)); }
};

console.log('\n【店长 store_manager】');
const m = runAs({ role: 'store_manager', grants: MGR });
t('识别为店长', m.isStoreManager(), true);
t('门店管理 stores 页面关闭', m.canAccessScreen('stores'), false);
t('门店跟进 storeops 工作区关闭', m.canAccessWorkspace('storeops'), false);
t('组织与流程设置 governance 工作区关闭', m.canAccessWorkspace('governance'), false);
t('中控平台仍可进（审批/任务日常要用）', m.canAccessScreen('controlCenter'), true);
t('审批中心工作区保留', m.canAccessWorkspace('approvals'), true);
t('任务协作工作区保留', m.canAccessWorkspace('collaboration'), true);
t('内容公告工作区保留', m.canAccessWorkspace('announcements'), true);
t('账号设置仍可进', m.canAccessScreen('account'), true);
t('首页不再落到门店管理', m.homeScreen() !== 'stores', true);
t('关键：store.view 权限本身未被回收', MGR.some(g => g.p === 'store.view'), true);

console.log('\n【旧角色名 manager 兼容】');
const legacy = runAs({ role: 'manager', grants: MGR });
t('旧角色名同样识别为店长', legacy.isStoreManager(), true);
t('旧角色名下 stores 关闭', legacy.canAccessScreen('stores'), false);

console.log('\n【总部 philippines_manager 不受影响】');
const h = runAs({ role: 'philippines_manager', grants: HQ });
t('非店长', h.isStoreManager(), false);
t('门店管理仍可见', h.canAccessScreen('stores'), true);
t('门店跟进仍可见', h.canAccessWorkspace('storeops'), true);
t('组织与流程设置仍可见', h.canAccessWorkspace('governance'), true);

console.log('\n【admin 不受影响】');
const a = runAs({ role: 'admin', grants: HQ });
t('admin 下 stores 可见', a.canAccessScreen('stores'), true);
t('admin 下 storeops 可见', a.canAccessWorkspace('storeops'), true);
t('admin 下 governance 可见', a.canAccessWorkspace('governance'), true);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
