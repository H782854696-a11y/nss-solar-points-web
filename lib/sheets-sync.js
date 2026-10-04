// Google Sheets 自动同步引擎（服务端）
// ============================================================
// 设计目标：门店登记会员 / 发放积分后，数据自动出现在 Google 表格里，无需任何人工点击。
//
// 工作机制：
//   1. 变更检测 —— 每隔 10 秒向存储层要一次「数据变更签名」（见 dataSignature），
//      签名变化即标记为「有改动」。（2026-09-21 起不再依赖 JSON 文件的 mtime）
//   2. 防抖推送 —— 改动停止 10 秒后（避免门店连续操作时反复推送）才真正推送；
//      两次推送之间至少间隔 30 秒，保护 Apps Script 的执行额度。
//   3. 心跳同步 —— 即使没有任何改动，也按「同步间隔」周期性补推一次，
//      保证表格里的同步时间戳不过期。
//   4. 失败退避 —— 推送失败后按 1/2/4/8 分钟逐步退避重试，最多退到同步间隔。
//
// 推送由服务器直接发起（香港节点可直连 Google），因此国内也能正常同步。

const { readAll, writeAll } = require('./seed');
const { dataVersion } = require('./store');

const TICK_MS = 10 * 1000;        // 每 10 秒检查一次
const QUIET_MS = 10 * 1000;       // 改动停止 10 秒后才推送（防抖）
const MIN_GAP_MS = 30 * 1000;     // 两次推送最小间隔
const PUSH_TIMEOUT_MS = 120 * 1000;
const MAX_TX_ROWS = 5000;         // 流水最多推送最近 5000 条

const runtime = {
  timer: null,
  syncing: false,
  dirty: false,
  dirtyAt: 0,
  lastPushAt: 0,
  failCount: 0,
  nextAttemptAt: 0,
  lastSignature: '',
};

// ---------- 工具 ----------

function nowIso() { return new Date().toISOString(); }

// 复用 lib/audit 的写入口，这样也享受同一套大小轮转
const { auditLog: audit } = require('./audit');

/** 单元格取值：统一转成 GAS setValues 能接受的标量，避免出现空值导致列数不齐 */
function cell(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? v : '';
  if (typeof v === 'boolean') return v ? '是' : '否';
  return String(v);
}

/**
 * 数据变更签名 —— 同步引擎靠它判断「数据有没有变」。
 *
 * ⚠️ 2026-09-21 存储升级（重要）：
 *    旧实现是 stat data/*.json 的「修改时间 + 大小」。迁到 SQLite 后这些文件
 *    再也不会被写入 → 签名恒定 → 只有心跳能推，真实业务变更**永远不触发同步，
 *    而且不报任何错**（静默失效）。
 *
 *    现在改为向存储层要签名，两个驱动下都有正确实现：
 *      · JSON 驱动   → 原来那套文件签名（迁移前行为与之前逐字节一致）
 *      · SQLite 驱动 → 写入计数器，任何业务写入都会 +1
 *    调用方无需知道底层是哪个驱动，迁移与回滚对它完全透明。
 */
function dataSignature() {
  return dataVersion();
}

function autoSyncEnabled(cfg) {
  // 兼容语义：只有显式关掉才不自动同步
  return cfg.autoSync !== false;
}

/** 心跳间隔（分钟 → 毫秒），默认 15 分钟，允许 5 ~ 1440 */
function intervalMs(cfg) {
  const minutes = Math.max(5, Math.min(1440, Number(cfg.autoSyncInterval) || 15));
  return minutes * 60 * 1000;
}

function intervalMinutes(cfg) {
  return Math.max(5, Math.min(1440, Number(cfg.autoSyncInterval) || 15));
}

// ---------- 载荷 ----------

function buildPayload(cfg) {
  const members = readAll('members') || [];
  const stores = readAll('stores') || [];
  const transactions = (readAll('transactions') || []).slice(0, MAX_TX_ROWS);
  const rules = readAll('rules') || {};

  return {
    action: 'push',
    sheetId: cfg.spreadsheetId,
    pushedAt: nowIso(),
    source: 'server',
    tabs: {
      Members: {
        headers: ['ID', '姓名', '手机号', '类型', '等级', '积分余额', '累计获得', '累计核销', '积分到期', '累计消费(₱)', '最近消费', '门店ID', '门店名', '状态', '备注', '创建时间', '更新时间'],
        rows: members.map(m => [
          cell(m.id), cell(m.name), cell(m.phone), cell(m.type), cell(m.level),
          cell(m.points), cell(m.earnedTotal), cell(m.redeemedTotal), cell(m.pointsExpireAt),
          cell(m.spend), cell(m.lastPurchaseAt), cell(m.storeId), cell(m.storeName),
          cell(m.status), cell(m.notes), cell(m.createdAt), cell(m.updatedAt),
        ]),
      },
      Stores: {
        headers: ['ID', '门店名', '城市', '地址', '电话', '店长ID', '店长姓名', '创建时间'],
        rows: stores.map(s => [
          cell(s.id), cell(s.name), cell(s.city), cell(s.address), cell(s.phone),
          cell(s.managerId), cell(s.managerName), cell(s.createdAt),
        ]),
      },
      Transactions: {
        headers: ['ID', '会员ID', '会员姓名', '类型', '积分变动', '消费金额(₱)', '计分基数', '变动后余额', '原因', '门店ID', '门店名', '操作人', '创建时间'],
        rows: transactions.map(t => [
          cell(t.id), cell(t.memberId), cell(t.memberName), cell(t.type), cell(t.amount),
          cell(t.purchaseAmount), cell(t.basePoints), cell(t.balanceAfter),
          cell(t.reason), cell(t.storeId), cell(t.storeName), cell(t.operatorName), cell(t.createdAt),
        ]),
      },
      Rules: {
        headers: ['每多少₱积1分', '有效期(月)', '欢迎积分', '兑换比例', '单笔抵扣上限%(0=无上限)', '最低使用门槛(0=无门槛)', '二次确认', '实时推送', '更新时间'],
        rows: [[
          cell(rules.spendPerPoint), cell(rules.expiryMonths), cell(rules.welcomeBonus),
          cell(rules.redeemRatio), cell(rules.redeemMaxPercent), cell(rules.redeemMinPoints),
          cell(!!rules.requireConfirm), cell(!!rules.realtimePush),
          cell(rules.updatedAt),
        ]],
      },
    },
    counts: {
      members: members.length,
      stores: stores.length,
      transactions: transactions.length,
    },
  };
}

async function postToGas(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    redirect: 'follow',
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 120));
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  if (!json) throw new Error('返回内容不是 JSON：' + text.slice(0, 120));
  if (json.ok === false) throw new Error(json.error || 'Apps Script 返回错误');
  return json;
}

// ---------- 同步主流程 ----------

/**
 * 立即执行一次推送。
 * @param {'manual'|'auto'} source 触发来源
 */
async function syncNow(source = 'manual') {
  if (runtime.syncing) return { ok: false, error: '同步正在进行中，请稍候' };

  const cfg = readAll('sheets') || {};
  if (!cfg.gasUrl) return { ok: false, error: '尚未填写 Apps Script URL' };
  if (!cfg.spreadsheetId) return { ok: false, error: '尚未填写 Google Sheet ID' };

  runtime.syncing = true;
  runtime.lastPushAt = Date.now();
  let result;
  try {
    const payload = buildPayload(cfg);
    const started = Date.now();
    const resp = await postToGas(cfg.gasUrl, payload);
    const costMs = Date.now() - started;
    const summary = `${payload.counts.members} 会员 / ${payload.counts.stores} 门店 / ${payload.counts.transactions} 流水`;
    result = { ok: true, summary, costMs, at: nowIso() };
    runtime.dirty = false;
    runtime.failCount = 0;
    runtime.nextAttemptAt = 0;
    runtime.lastSignature = dataSignature();

    const fresh = readAll('sheets') || {};
    fresh.lastSyncAt = nowIso();
    fresh.lastSyncResult = 'success';
    fresh.lastError = null;
    fresh.lastSyncSource = source;
    fresh.lastSyncSummary = summary;
    fresh.lastSyncCostMs = costMs;
    fresh.syncedSignature = runtime.lastSignature;
    fresh.syncCount = Number(fresh.syncCount || 0) + 1;
    fresh.updatedAt = nowIso();
    writeAll('sheets', fresh);
    audit(`sheets sync(${source}) success in ${costMs}ms: ${summary}${resp && resp.summary ? ' gas=' + JSON.stringify(resp.summary) : ''}`);
  } catch (e) {
    const msg = (e && (e.message || String(e))) || '未知错误';
    const detail = e && e.cause && e.cause.message ? `${msg}（${e.cause.message}）` : msg;
    result = { ok: false, error: detail, at: nowIso() };
    runtime.failCount += 1;
    const backoff = Math.min(intervalMs(cfg), 60 * 1000 * Math.pow(2, Math.min(runtime.failCount - 1, 4)));
    runtime.nextAttemptAt = Date.now() + backoff;

    const fresh = readAll('sheets') || {};
    fresh.lastSyncResult = 'failed';
    fresh.lastError = detail;
    fresh.lastSyncSource = source;
    fresh.lastSyncFailedAt = nowIso();
    fresh.updatedAt = nowIso();
    writeAll('sheets', fresh);
    audit(`sheets sync(${source}) FAILED: ${detail} · ${Math.round(backoff / 60000)} 分钟后重试`);
  } finally {
    runtime.syncing = false;
  }
  return result;
}

/** 标记「有改动」，用于配置变更后主动触发 */
function markDirty() {
  runtime.dirty = true;
  runtime.dirtyAt = Date.now();
}

function tick() {
  const cfg = readAll('sheets') || {};
  if (!cfg.gasUrl || !cfg.spreadsheetId) return;
  if (!autoSyncEnabled(cfg)) return;
  if (runtime.syncing) return;

  const sig = dataSignature();
  if (sig !== runtime.lastSignature) {
    runtime.lastSignature = sig;
    runtime.dirty = true;
    runtime.dirtyAt = Date.now();
  }

  const now = Date.now();
  if (now < runtime.nextAttemptAt) return;

  const lastAt = Date.parse(cfg.lastSyncAt || '') || 0;
  const needHeartbeat = lastAt === 0 || (now - lastAt) >= intervalMs(cfg);
  if (!runtime.dirty && !needHeartbeat) return;
  if (runtime.dirty && (now - runtime.dirtyAt) < QUIET_MS) return;
  if (runtime.lastPushAt && (now - runtime.lastPushAt) < MIN_GAP_MS) return;

  syncNow('auto');
}

function start() {
  if (runtime.timer) return;
  const cfg = readAll('sheets') || {};
  runtime.lastSignature = dataSignature();
  // 启动时若上次同步签名与当前不一致，则视为待推送
  if (cfg.syncedSignature && cfg.syncedSignature !== runtime.lastSignature) runtime.dirty = true;
  runtime.timer = setInterval(() => {
    try { tick(); } catch (e) { console.error('[sheets-sync] tick error', e.message); }
  }, TICK_MS);
  runtime.timer.unref?.();

  const state = autoSyncEnabled(cfg) && cfg.gasUrl && cfg.spreadsheetId
    ? `已开启 · 心跳 ${intervalMinutes(cfg)} 分钟`
    : '未开启（或未配置）';
  console.log(`[sheets-sync] 自动同步${state}`);
}

function stop() {
  if (runtime.timer) { clearInterval(runtime.timer); runtime.timer = null; }
}

/** 供状态接口使用的运行时快照 */
function getRuntimeState() {
  const cfg = readAll('sheets') || {};
  const interval = intervalMs(cfg);
  const lastAt = Date.parse(cfg.lastSyncAt || '') || 0;
  let nextSyncAt = null;
  if (runtime.syncing) {
    nextSyncAt = null;
  } else if (runtime.nextAttemptAt > Date.now()) {
    nextSyncAt = new Date(runtime.nextAttemptAt).toISOString();
  } else if (runtime.dirty) {
    nextSyncAt = new Date(Math.max(runtime.dirtyAt + QUIET_MS, runtime.lastPushAt + MIN_GAP_MS)).toISOString();
  } else if (lastAt) {
    nextSyncAt = new Date(lastAt + interval).toISOString();
  }
  return {
    syncing: runtime.syncing,
    pendingChanges: runtime.dirty,
    nextSyncAt,
    retryScheduledAt: runtime.nextAttemptAt > Date.now() ? new Date(runtime.nextAttemptAt).toISOString() : null,
  };
}

module.exports = { start, stop, syncNow, markDirty, getRuntimeState, intervalMinutes };
