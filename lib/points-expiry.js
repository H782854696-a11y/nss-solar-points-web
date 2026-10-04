// 积分到期扫描
// ============================================================
// 规则里的 expiryMonths 以前只是配置项，从不执行。
// 现在：每 6 小时检查一次，对已过期的积分做扣减并写 expire 流水。
// 采用「滚动有效期」——每次获得积分都会把该会员的到期时间顺延 expiryMonths。
// ============================================================
const { readAll, writeAll } = require('./seed');
const points = require('./points');
const { deductPoints } = require('./ledger');
const { auditLog } = require('./audit');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小时
const FIRST_RUN_DELAY_MS = 90 * 1000;         // 启动后 90 秒做第一次

let timer = null;
let inMemory = null;

/** 扫描一次；dryRun=true 只统计不扣减 */
function scan({ dryRun = false } = {}) {
  const rules = readAll('rules') || {};
  const months = Number(rules.expiryMonths) || 0;
  const now = Date.now();
  const stamp = new Date(now).toISOString();
  const state = {
    lastRunAt: stamp,
    expiryMonths: months,
    expiredMembers: 0,
    expiredPoints: 0,
    dryRun: !!dryRun,
    nextRunAt: new Date(now + CHECK_INTERVAL_MS).toISOString(),
    note: '',
  };

  if (months <= 0) {
    state.note = 'Points expiry is disabled (validity = 0 months).';
    inMemory = state;
    if (!dryRun) writeAll('expiry-state', state);
    return state;
  }

  const members = readAll('members') || [];
  let changed = false;
  const details = [];
  members.forEach(m => {
    if (!points.isExpired(m, now)) return;
    const lost = Number(m.points) || 0;
    if (lost <= 0) return;
    details.push(`${m.name}: ${lost}`);
    state.expiredMembers += 1;
    state.expiredPoints += lost;
    if (dryRun) return;
    deductPoints(m, lost, 'expire', {
      reason: `Expired after ${months} months (balance ${lost})`,
    });
    m.pointsExpireAt = null;
    m.updatedAt = stamp;
    changed = true;
  });

  if (changed) writeAll('members', members);
  if (!dryRun) {
    writeAll('expiry-state', state);
    if (state.expiredMembers > 0) {
      auditLog(`points expiry: ${state.expiredMembers} member(s), ${state.expiredPoints} points expired`);
    }
  }
  inMemory = state;
  return state;
}

function status() {
  return inMemory || readAll('expiry-state') || null;
}

function start() {
  if (timer) return;
  const run = () => {
    try { scan(); } catch (e) { console.error('[points-expiry] scan failed:', e.message); }
  };
  setTimeout(run, FIRST_RUN_DELAY_MS).unref?.();
  timer = setInterval(run, CHECK_INTERVAL_MS);
  timer.unref?.();
}

module.exports = { scan, status, start, CHECK_INTERVAL_MS };
