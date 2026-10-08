// 存储层：双驱动分发（JSON 文件 / SQLite）
// ============================================================
// 对外接口与历史版本完全一致：
//   readCollection(coll) / writeCollection(coll, data) / SCHEMAS / DATA_DIR
// 新增两个供「云同步」和「数据主库页」使用的能力：
//   dataVersion()  变更信号（两个驱动下都有实现，调用方无需知道底层是什么）
//   stats(coll)    集合统计（同上）
//
// 驱动选择：读 data/_storage.json 的 driver 字段
//   文件不存在 / 读不出来 / driver === 'json'  → 走 JSON 文件（历史行为）
//   driver === 'sqlite'                        → 走 SQLite
// 回滚 = 把该文件改回 json（或删除）+ 重启，瞬时生效。
//
// ⚠️ JSON 驱动是现有生产环境的唯一路径，其实现整段保留、逻辑未改一行。
//    SQLite 驱动是新增分支，属于本次存储升级。
// ============================================================
const fs = require('fs');
const path = require('path');
const db = require('./db');

// 数据目录。可用环境变量 SP_DATA_DIR 覆盖（仅供自动化测试隔离使用；
// 生产环境不设置该变量 → 行为与之前完全一致）。
const DATA_DIR = process.env.SP_DATA_DIR
  ? path.resolve(process.env.SP_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const STORAGE_MARKER = path.join(DATA_DIR, '_storage.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

const SCHEMAS = {
  _seeded: { id: 'single' },
  users: {
    id: 'string',           // nanoid
    username: 'string',     // 登录账号，唯一
    password: 'string',     // bcrypt hash
    name: 'string',         // 姓名
    role: 'string',         // admin | manager
    storeId: 'string|null', // 店长绑定门店
    regionId: 'string|null', employeeId: 'string|null',
    phone: 'string',
    createdAt: 'string',
    // 数据国家归属（2026-10-08 审计 C-1 补字段）：'PH' | 'CN'。
    // 从所属门店/区域/组织的 countryCode 推导，用于中菲数据隔离的 fail-closed 判定。
    country: 'string|null',
    // 解绑门店后账号会被停用（而不是变成没有门店的僵尸账号）；
    // 用同一个用户名重新分配店长时会复用并重新启用该账号。
    disabled: 'boolean',
    disabledAt: 'string|null',
    mustChangePassword: 'boolean',
  },
  stores: {
    id: 'string',
    name: 'string',
    storeCode: 'string',       // 门店编号（对接金蝶等外部系统；2026-09-25 新增）
    kingdeeAccount: 'string',  // 金蝶帐套（2026-09-25 新增）
    city: 'string',
    regionId: 'string|null',
    address: 'string',
    managerId: 'string|null',
    managerName: 'string',
    phone: 'string',
    createdAt: 'string',
    country: 'string|null',    // 2026-10-08 审计 C-1：从 region.countryCode 推导
  },
  // NSS Solar V2 管理域。与会员积分集合完全分离，新增字段向后兼容。
  organizations: {
    id: 'string', code: 'string', name: 'string', type: 'string', countryCode: 'string',
    parentId: 'string|null', timezone: 'string', active: 'boolean', createdAt: 'string', updatedAt: 'string',
  },
  regions: {
    id: 'string', code: 'string', name: 'string', organizationId: 'string|null', countryCode: 'string',
    active: 'boolean', createdAt: 'string', updatedAt: 'string',
  },
  warehouses: {
    id: 'string', code: 'string', name: 'string', city: 'string', address: 'string',
    regionId: 'string|null', organizationId: 'string|null', externalSystem: 'string|null',
    active: 'boolean', createdAt: 'string', updatedAt: 'string',
  },
  departments: {
    id: 'string', code: 'string', name: 'string', organizationId: 'string|null', parentId: 'string|null',
    active: 'boolean', createdAt: 'string', updatedAt: 'string',
  },
  positions: {
    id: 'string', code: 'string', name: 'string', departmentId: 'string|null',
    active: 'boolean', createdAt: 'string', updatedAt: 'string',
  },
  employees: {
    id: 'string', employeeCode: 'string', name: 'string', email: 'string', phone: 'string',
    organizationId: 'string|null', departmentId: 'string|null', positionId: 'string|null',
    storeId: 'string|null', warehouseId: 'string|null', userId: 'string|null', regionId: 'string|null',
    active: 'boolean', createdAt: 'string', updatedAt: 'string',
  },
  // 通用审批引擎与流程实例。每个实例固定保存模板版本快照。
  workflowDefinitions: {
    id: 'string', type: 'string', name: 'string', version: 'number', active: 'boolean',
    config: 'object', createdAt: 'string', updatedAt: 'string',
  },
  workflowInstances: {
    id: 'string', type: 'string', title: 'string', status: 'string', form: 'object',
    definitionId: 'string|null', definitionVersion: 'number', storeId: 'string|null', warehouseId: 'string|null',
    organizationId: 'string|null', regionId: 'string|null', sourceInspectionId: 'string|null', createdBy: 'string', createdByName: 'string', createdAt: 'string', updatedAt: 'string',
    country: 'string|null',   // 2026-10-08 审计 C-1：从创建者/门店推导，用于中菲隔离
    assigneeId: 'string|null', assigneeName: 'string|null', overdueReminderAt: 'string|null',
    approvalSlaHours: 'number|null', approvalDueAt: 'string|null', approvalReminderAt: 'string|null',
    executionRound: 'number',
    currentStep: 'number', externalDocumentNumber: 'string|null', executionStatus: 'string|null',
    executedBy: 'string|null', executedAt: 'string|null',
    comments: 'array', attachments: 'array', approvalDelegations: 'array',
  },
  workflowActions: {
    id: 'string', instanceId: 'string', action: 'string', step: 'number', actorId: 'string', actorName: 'string',
    note: 'string', createdAt: 'string',
  },
  tasks: {
    id: 'string', title: 'string', description: 'string', status: 'string', priority: 'string',
    kind: 'string|null', depositDate: 'string|null', lastReminderAt: 'string|null', reminderCount: 'number|null',
    assigneeId: 'string|null', assigneeName: 'string|null', storeId: 'string|null', warehouseId: 'string|null', regionId: 'string|null',
    country: 'string|null',   // 2026-10-08 审计 C-1：中菲隔离
    dueAt: 'string|null', createdBy: 'string', createdByName: 'string', createdAt: 'string', updatedAt: 'string',
    completedAt: 'string|null', overdueReminderAt: 'string|null', checklist: 'array', comments: 'array', attachments: 'array',
  },
  storeReports: {
    id: 'string', storeId: 'string', regionId: 'string|null', reportDate: 'string', salesNote: 'string',
    incidents: 'string', summary: 'string', additionalNote: 'string', createdBy: 'string', createdByName: 'string', createdAt: 'string', updatedAt: 'string', attachments: 'array',
  },
  storeInspections: {
    id: 'string', storeId: 'string', regionId: 'string|null', inspectionDate: 'string', result: 'string', score: 'number|null',
    checklist: 'string', findings: 'string', createdBy: 'string', createdByName: 'string', createdAt: 'string', remediationWorkflowId: 'string|null', attachments: 'array',
  },
  storeIssues: {
    id: 'string', storeId: 'string', regionId: 'string|null', title: 'string', description: 'string', severity: 'string',
    status: 'string', dueAt: 'string|null', ownerId: 'string|null', ownerName: 'string|null', createdBy: 'string',
    createdByName: 'string', createdAt: 'string', updatedAt: 'string', closedAt: 'string|null', overdueReminderAt: 'string|null',
  },
  notifications: {
    id: 'string', userId: 'string', type: 'string', title: 'string', body: 'string',
    resourceType: 'string|null', resourceId: 'string|null', readAt: 'string|null', createdAt: 'string',
  },
  dailyDeposits: {
    id: 'string', storeId: 'string', regionId: 'string|null', country: 'string|null', depositDate: 'string',
    status: 'string', bankName: 'string', reference: 'string', note: 'string',
    reportedBy: 'string', reportedByName: 'string', reportedAt: 'string', createdAt: 'string', updatedAt: 'string',
  },
  announcements: {
    id: 'string', title: 'string', body: 'string', status: 'string', pinned: 'boolean',
    createdBy: 'string', createdByName: 'string', createdAt: 'string', updatedAt: 'string',
    country: 'string|null',   // 2026-10-08 审计 C-1：公告归属，用于中菲隔离
  },
  auditEvents: {
    id: 'string', actorId: 'string|null', actorName: 'string', action: 'string', resourceType: 'string',
    resourceId: 'string|null', result: 'string', details: 'object', ip: 'string|null', createdAt: 'string',
  },

};

// 把集合结构注入 SQLite 引擎（避免 db.js 反向 require store.js 造成循环依赖）
db.configure(SCHEMAS);

function empty(coll) {
  const schema = SCHEMAS[coll];
  if (!schema) {
    // 未在 SCHEMAS 注册的集合视为普通集合（数组）
    return [];
  }
  if (schema.id === 'single') return null;
  return [];
}

/* ============================================================
 * JSON 驱动 —— 现有生产逻辑，原样保留（仅函数改名）
 * ============================================================ */

// 读缓存表（2026-10-08 审计 H-1）。key = 集合名，value = { data, mtime }。
// 读路径命中缓存时不再碰磁盘；写路径（jsonWrite）会清缓存保证读到最新。
const jsonCache = new Map();

function jsonRead(coll) {
  ensureDir();
  const file = path.join(DATA_DIR, coll + '.json');
  // 2026-10-08 审计 H-1：进程内读缓存（mtime 校验）。
  // JSON 驱动下每个请求都 readFileSync + JSON.parse 整个集合，是规模瓶颈。
  // 这里用「文件 mtime 未变则直接返回缓存」，命中时读路径不再碰磁盘。
  // 写路径（jsonWrite）会清缓存，保证读到的永远是最新。
  const cached = jsonCache.get(coll);
  if (cached) {
    try {
      if (cached.mtime === fs.statSync(file).mtimeMs) return cached.data;
    } catch (e) { /* 文件被删，落到下方重读 */ }
  }
  if (!fs.existsSync(file)) {
    const init = empty(coll);
    fs.writeFileSync(file, JSON.stringify(init, null, 2));
    jsonCache.set(coll, { data: init, mtime: fs.statSync(file).mtimeMs });
    return init;
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    jsonCache.set(coll, { data, mtime: fs.statSync(file).mtimeMs });
    return data;
  } catch (e) {
    // 解析失败时绝对不能直接覆盖：那会让一次读取异常变成永久性数据丢失。
    // 先把损坏文件改名留档，再降级返回空数据，并留下审计痕迹。
    console.error('[store] failed to parse', coll, e.message);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const corrupt = `${file}.corrupt-${stamp}`;
    try {
      fs.renameSync(file, corrupt);
      fs.writeFileSync(file, JSON.stringify(empty(coll), null, 2));
      jsonCache.delete(coll);
      const { auditLog } = require('./audit');
      auditLog(`DATA CORRUPT: ${coll}.json 解析失败（${e.message}），已留档为 ${path.basename(corrupt)}，当前已重置为空`);
    } catch (e2) {
      console.error('[store] failed to quarantine corrupt file', e2.message);
    }
    return empty(coll);
  }
}

function jsonWrite(coll, data) {
  ensureDir();
  const file = path.join(DATA_DIR, coll + '.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // 原子替换
  jsonCache.delete(coll);   // 写后失效，下次读取重建缓存（H-1）
}

/** 集合对应的 JSON 文件统计（数据主库页用） */
function jsonFileStat(coll) {
  const file = path.join(DATA_DIR, coll + '.json');
  try {
    const st = fs.statSync(file);
    return { size: st.size, updatedAt: st.mtime.toISOString() };
  } catch (e) {
    return { size: 0, updatedAt: null };
  }
}

/**
 * 变更签名要覆盖哪些集合？
 *
 * 口径 = **全部业务集合**（与 SQLite 驱动的写入计数器完全一致），
 * 只排除元数据集合。这样两个驱动的「什么算变化」标准是同一个，
 * 将来新增任意集合（leads / tasks / alerts …）都自动被纳入，
 * 不会再出现「数据变了但版本没变」的静默问题。
 */
function signatureCollections() {
  return Object.keys(SCHEMAS).filter(c => db.META_COLLECTIONS.indexOf(c) === -1);
}

/**
 * JSON 驱动下的变更签名：各业务集合文件的「大小 + 修改时间」。
 *
 * ⚠️ 与历史实现的差异说明：旧版只覆盖 members/stores/transactions/rules 四张表，
 *    写 pending/products/redemptions 不会触发同步。现按「全部业务集合」统一口径，
 *    代价是这些集合变化时会多触发一次推送（无害，且被 MIN_GAP 30 秒保护）；
 *    收益是两个驱动的判定标准一致，不会漏变更。
 */
function jsonSignature() {
  const parts = [];
  for (const name of signatureCollections()) {
    const file = path.join(DATA_DIR, name + '.json');
    try {
      const st = fs.statSync(file);
      parts.push(`${name}:${st.size}:${Math.round(st.mtimeMs)}`);
    } catch (e) {
      parts.push(`${name}:-`);
    }
  }
  return parts.join('|');
}

/* ============================================================
 * 驱动分发
 * ============================================================ */

let cachedDriver = null;

function readMarker() {
  try {
    if (!fs.existsSync(STORAGE_MARKER)) return null;
    const j = JSON.parse(fs.readFileSync(STORAGE_MARKER, 'utf8'));
    return j || null;
  } catch (e) {
    // 标记文件损坏时按 json 处理 —— 永远退回安全的一边（JSON 是原始数据源）
    console.error('[store] _storage.json 读取失败，回退到 JSON 驱动:', e.message);
    return null;
  }
}

function driver() {
  if (cachedDriver) return cachedDriver;
  const m = readMarker();
  cachedDriver = (m && m.driver === 'sqlite') ? 'sqlite' : 'json';
  return cachedDriver;
}

/** 测试 / 迁移脚本用：清掉驱动缓存 */
function resetDriverCache() { cachedDriver = null; }

function readCollection(coll) {
  return driver() === 'sqlite' ? db.readCollection(coll) : jsonRead(coll);
}

function writeCollection(coll, data) {
  return driver() === 'sqlite' ? db.writeCollection(coll, data) : jsonWrite(coll, data);
}

/**
 * 变更信号 —— 云同步靠它判断「数据有没有变」。
 *   JSON 驱动   → 文件签名（与历史实现完全一致）
 *   SQLite 驱动 → 写入计数器（任何业务写入都会 +1）
 * 两个驱动都返回「内容变了就一定不同」的字符串，调用方无需关心底层。
 */
function dataVersion() {
  return driver() === 'sqlite' ? String(db.dataVersion()) : jsonSignature();
}

/** 集合统计 —— 数据主库页靠它显示真实状态 */
function stats(coll) {
  return driver() === 'sqlite' ? db.stats(coll) : jsonFileStat(coll);
}

module.exports = {
  readCollection,
  writeCollection,
  SCHEMAS,
  DATA_DIR,
  // —— 新增（供云同步 / 数据主库页 / 迁移脚本使用）——
  dataVersion,
  stats,
  driver,
  resetDriverCache,
  readMarker,
  STORAGE_MARKER,
};
