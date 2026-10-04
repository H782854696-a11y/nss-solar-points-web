// ============================================================
// P1 针对性测试：前端「可见但必 403」的假按钮门禁
// ============================================================
// 背景：后端鉴权一直是对的，但前端有几处按钮没加 `can(...)` 门禁 ——
//   角色能看到按钮，点下去只会拿到 403。本测试用**静态扫描**锁死这几处，
//   防止回归（也覆盖了上一轮 12 按钮扫描漏掉的 `data-act` 模板那一类）。
//
// 纯静态：只读 public/app.js 与 public/index.html，不启动服务、不写任何数据。
// ============================================================
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(APP, 'public', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(APP, 'public', 'index.html'), 'utf8');
const LINES = SRC.split('\n');

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; fails.push(name); console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

/** 找出所有含指定片段的行号 */
function linesWith(needle) {
  const out = [];
  LINES.forEach((l, i) => { if (l.indexOf(needle) !== -1) out.push(i + 1); });
  return out;
}
/** 该行（含前 3 行回溯，兼容跨行三元）是否被 can(...) 类门禁包住 */
function gatedAt(lineNo) {
  const i = lineNo - 1;
  const ctx = LINES.slice(Math.max(0, i - 3), i + 1).join('\n');
  const before = ctx.slice(0, ctx.lastIndexOf('<button'));
  return /can\(|can[A-Z][A-Za-z]*\s*\?|isSelfManager\(/.test(before);
}
const has = (s) => SRC.indexOf(s) !== -1;

console.log('\n══════ P1 前端门禁针对性测试 ══════\n');

// ─────────────────────────────────────────────
console.log('【P1a】积分审核页：通过 / 驳回');
ok('定义了 canApprove = can(\'approval.approve\')', has("const canApprove = can('approval.approve')"));
ok('定义了 canReject  = can(\'approval.reject\')', has("const canReject = can('approval.reject')"));
const approveLines = linesWith('data-act="approve"');
const rejectLines = linesWith('data-act="reject"');
ok('「通过」按钮恰好 1 处', approveLines.length === 1, approveLines);
ok('「驳回」按钮恰好 1 处（不含弹窗确认键 id=doReject）', rejectLines.length === 1, rejectLines);
ok('「通过」按钮已被 canApprove 门禁', approveLines.length === 1 && gatedAt(approveLines[0]), approveLines);
ok('「驳回」按钮已被 canReject 门禁', rejectLines.length === 1 && gatedAt(rejectLines[0]), rejectLines);
ok('两个都没有权限时不渲染空的 .ap-actions 容器（避免空白块）',
  /\(canApprove \|\| canReject\) \?/.test(SRC));

// ─────────────────────────────────────────────
console.log('\n【P1b】会员列表：录入消费 / 编辑（桌面表格 + 手机卡片，两套都要）');
ok('renderMembersTable 中定义 canPurchaseRow = can(\'points.grant\')', has("const canPurchaseRow = can('points.grant')"));
ok('renderMembersTable 中定义 canEditRow = can(\'member.edit\')', has("const canEditRow = can('member.edit')"));
ok('门禁变量声明 2 次（桌面 + 手机各一套，双布局同步）',
  (SRC.match(/const canPurchaseRow = can\('points\.grant'\)/g) || []).length === 2,
  (SRC.match(/const canPurchaseRow = can\('points\.grant'\)/g) || []).length);
const purchaseLines = linesWith('data-action="purchase"');
const editLines = linesWith('data-action="edit"');
const detailLines = linesWith('data-action="detail"');
ok('「录入消费」按钮恰好 2 处（桌面行 + 手机卡）', purchaseLines.length === 2, purchaseLines);
ok('「编辑」按钮恰好 2 处', editLines.length === 2, editLines);
ok('「详情」按钮恰好 2 处', detailLines.length === 2, detailLines);
ok('全部「录入消费」都已被 canPurchaseRow 门禁', purchaseLines.every(gatedAt), purchaseLines.filter(n => !gatedAt(n)));
ok('全部「编辑」都已被 canEditRow 门禁', editLines.every(gatedAt), editLines.filter(n => !gatedAt(n)));
ok('「详情」保持不带门禁（本页已要求 member.view，无需再判）',
  // 用「同一行内 <button 之前的片段」判断：不能出现 canXxx ? 这类三元门禁。
  // （不能用 gatedAt —— 它回溯 3 行，会把相邻按钮的门禁算进来，产生假阳性。）
  detailLines.every(n => {
    const l = LINES[n - 1];
    return !/can[A-Za-z]*\s*\?/.test(l.slice(0, l.indexOf('<button')));
  }),
  detailLines.filter(n => {
    const l = LINES[n - 1];
    return /can[A-Za-z]*\s*\?/.test(l.slice(0, l.indexOf('<button')));
  }));

// ─────────────────────────────────────────────
console.log('\n【P1c】积分商城：兑换 / 已发放 / 取消');
ok('productCardHtml 中定义 canRedeem = can(\'mall.redeem\')', has("const canRedeem = can('mall.redeem')"));
ok('renderMallOrders 中定义 canFulfill = can(\'mall.fulfill\')', has("const canFulfill = can('mall.fulfill')"));
ok('renderMallOrders 中定义 canCancel  = can(\'mall.cancel\')', has("const canCancel = can('mall.cancel')"));
const redeemLines = linesWith('data-redeem=');
const fulfillLines = linesWith('data-order="fulfill"');
const cancelLines = linesWith('data-order="cancel"');
ok('「兑换」按钮恰好 1 处', redeemLines.length === 1, redeemLines);
ok('「已发放」按钮恰好 1 处', fulfillLines.length === 1, fulfillLines);
ok('「取消」按钮恰好 1 处', cancelLines.length === 1, cancelLines);
ok('「兑换」已被 canRedeem 门禁', redeemLines.length === 1 && gatedAt(redeemLines[0]), redeemLines);
ok('「已发放」已被 canFulfill 门禁', fulfillLines.length === 1 && gatedAt(fulfillLines[0]), fulfillLines);
ok('「取消」已被 canCancel 门禁', cancelLines.length === 1 && gatedAt(cancelLines[0]), cancelLines);
ok('无权限时不渲染空的 .ap-actions（兑换单）', /\(o\.status === 'pending' && \(canFulfill \|\| canCancel\)\)/.test(SRC));

// ─────────────────────────────────────────────
console.log('\n【P1d】门店页：店长不再看到自己用不了的「分配 / 解绑」');
ok('定义了 isSelfManager(store) 辅助函数', /function isSelfManager\(store\) \{/.test(SRC));
ok('isSelfManager 比较的是 store.managerId === state.me.id',
  /store\.managerId === state\.me\.id/.test(SRC));
const assignLines = linesWith('data-action="assign"');
const unbindLines = linesWith('data-action="unbind"');
ok('「分配店长」按钮 2 处（未分配支 + 操作行）', assignLines.length === 2, assignLines);
ok('「解绑」按钮 1 处', unbindLines.length === 1, unbindLines);
ok('「解绑」已被 !isSelfManager(s) 门禁',
  unbindLines.length === 1 && /!isSelfManager\(s\)/.test(LINES[unbindLines[0] - 1]), unbindLines);
ok('操作行的「分配/更换店长」已被 !isSelfManager(s) 门禁',
  assignLines.some(n => /!isSelfManager\(s\)/.test(LINES[n - 1])),
  assignLines.map(n => LINES[n - 1].trim().slice(0, 60)));
ok('门店卡外层容器条件也同步用了 !isSelfManager(s)',
  /canEditStore \|\| \(canAssignManager && !isSelfManager\(s\)\) \|\| canDeleteStore/.test(SRC));

// ─────────────────────────────────────────────
console.log('\n【总不变量】所有写操作按钮都必须有门禁（白名单除外）');
const WRITE = /(data-action=|data-act=|data-order=|data-redeem=)/;
// 合法不带门禁的：详情（本页已要求 member.view）
const ALLOW = [/data-action="detail"/];
const offenders = [];
LINES.forEach((l, i) => {
  if (l.indexOf('<button') === -1) return;
  if (!WRITE.test(l)) return;
  if (ALLOW.some(re => re.test(l))) return;
  if (!gatedAt(i + 1)) offenders.push({ line: i + 1, txt: l.trim().slice(0, 90) });
});
ok('没有「写操作按钮但缺权限门禁」的行', offenders.length === 0, offenders);

// ─────────────────────────────────────────────
console.log('\n【缓存版本】改前端必须递增 app.js 版本号（否则用户看到旧界面）');
const m = HTML.match(/\/app\.js\?v=(\d+)/);
ok('index.html 里能找到 app.js 版本号', !!m, m && m[0]);
ok('app.js 版本号已递增到 34 或更高（本批为 34）', !!m && Number(m[1]) >= 34, m && m[1]);

// ─────────────────────────────────────────────
console.log(`\n══════ P1 门禁测试 ${pass} passed, ${fail} failed ══════`);
if (fails.length) console.log('失败项:\n  - ' + fails.join('\n  - '));
process.exit(fail ? 1 : 0);
