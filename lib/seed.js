// 种子数据 - 首次启动写入，后续重启保留
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function nowIso() { return new Date().toISOString(); }

function seedUsers() {
  const dataDir = process.env.SP_DATA_DIR ? path.resolve(process.env.SP_DATA_DIR) : path.join(__dirname, '..', 'data');
  const initialPassword = process.env.SP_ADMIN_PASSWORD;
  if (initialPassword && initialPassword.length < 16) throw new Error('SP_ADMIN_PASSWORD must be at least 16 characters');
  let password = initialPassword || null;
  if (!password) {
    fs.mkdirSync(dataDir, { recursive: true });
    const credentialFile = path.join(dataDir, 'INITIAL_ADMIN_CREDENTIALS.txt');
    if (fs.existsSync(credentialFile)) {
      const existing = fs.readFileSync(credentialFile, 'utf8').match(/^Temporary password: ([a-f0-9]{64})$/m);
      if (!existing) throw new Error('Initial admin credential file exists but is invalid; preserve it and repair the local data directory before starting.');
      password = existing[1];
    } else {
      password = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(credentialFile, `NSS Solar initial administrator\nUsername: admin\nTemporary password: ${password}\n\nThis file is created only for first initialization. Store the password safely, then delete this file.\n`, { mode: 0o600, flag: 'wx' });
    }
  }
  return [{
    id: nanoid(),
    username: 'admin',
    password: bcrypt.hashSync(password, 12),
    name: '总部管理员',
    role: 'admin',
    mustChangePassword: true,
    storeId: null,
    phone: '',
    createdAt: nowIso(),
  }];
}

function seedStores() {
  const cities = ['Manila', 'Quezon City', 'Makati', 'Pasig', 'Taguig', 'Cebu City', 'Iloilo City', 'Bacolod', 'Davao City', 'Cagayan de Oro'];
  const names = ['马尼拉旗舰店', '奎松城分店', '马卡蒂分店', '帕西格分店', '塔吉格分店', '宿务分店', '伊洛伊洛分店', '巴科洛德分店', '达沃分店', '卡加延德奥罗分店'];
  return cities.map((city, i) => ({ id: nanoid(), name: names[i], city, address: '', phone: '', storeCode: `NSS-PH-${String(i + 1).padStart(3, '0')}`, kingdeeAccount: '', managerId: null, managerName: '待分配', createdAt: nowIso() }));
}

function seedControlDirectory() {
  const stores = readAll('stores') || [], createdAt = nowIso();
  const orgs = [
    { id: nanoid(), code: 'NSS-GROUP', name: 'NSS Solar Group', type: 'group', countryCode: 'PH', parentId: null, timezone: 'Asia/Manila', active: true, createdAt, updatedAt: createdAt },
    { id: nanoid(), code: 'NSS-CN-HQ', name: '中国管理中心', type: 'headquarters', countryCode: 'CN', parentId: null, timezone: 'Asia/Shanghai', active: true, createdAt, updatedAt: createdAt },
    { id: nanoid(), code: 'NSS-PH-HQ', name: '菲律宾管理中心', type: 'headquarters', countryCode: 'PH', parentId: null, timezone: 'Asia/Manila', active: true, createdAt, updatedAt: createdAt },
  ];
  const departments = ['集团管理', '门店运营', '人力行政', '合规审计'].map((name, i) => ({ id: nanoid(), code: `DEPT-${String(i + 1).padStart(2, '0')}`, name, organizationId: orgs[0].id, parentId: null, active: true, createdAt, updatedAt: createdAt }));
  const positionNames = ['集团负责人', '中国运营负责人', '菲律宾总经理', '区域经理', '部门主管', '人事行政专员', '审计专员'];
  const positions = positionNames.map((name, i) => ({ id: nanoid(), code: `POS-${String(i + 1).padStart(2, '0')}`, name, departmentId: null, active: true, createdAt, updatedAt: createdAt }));
  const regions = [['NCR', 'National Capital Region'], ['CV', 'Central Visayas'], ['WV', 'Western Visayas'], ['MIN', 'Mindanao']].map(([code, name]) => ({ id: nanoid(), code, name, organizationId: orgs[2].id, countryCode: 'PH', active: true, createdAt, updatedAt: createdAt }));
  stores.forEach((store, i) => { store.regionId = regions[i < 5 ? 0 : i === 5 ? 1 : i < 8 ? 2 : 3].id; });
  writeAll('stores', stores);
  const warehouses = [];
  const employees = [];
  const workflowTypes = ['stocktake','store_remediation'];
  const workflowDefinitions = workflowTypes.map(type => ({
    id: nanoid(), type, name: type, version: 1, active: true,
    config: { steps: [{ label: 'Management approval', mode: 'any', approvers: [{ kind: 'role', id: 'admin' }, { kind: 'role', id: 'owner' }, { kind: 'role', id: 'philippines_manager' }] }] },
    createdAt, updatedAt: createdAt,
  }));
  writeAll('organizations', orgs); writeAll('regions', regions); writeAll('departments', departments);
  writeAll('positions', positions); writeAll('warehouses', warehouses); writeAll('employees', employees); writeAll('workflowDefinitions', workflowDefinitions);
}

function readAll(coll) {
  const { readCollection } = require('./store');
  return readCollection(coll);
}

function writeAll(coll, data) {
  const { writeCollection } = require('./store');
  writeCollection(coll, data);
}

/**
 * 数据国家归属推导（2026-10-08 审计 C-1）。
 *
 * 中菲隔离的 fail-closed 判定依赖每条业务记录的 `country` 字段。
 * 归属链：region.countryCode → store.regionId → user.storeId。
 * 推导优先级：
 *   ① 记录本身已有 country → 原样返回
 *   ② 有 regionId → 查 region.countryCode
 *   ③ 有 storeId → 查 store.regionId → region.countryCode
 *   ④ 有 organizationId → 查 organization.countryCode
 *   ⑤ 都拿不到 → null（由调用方决定默认值）
 *
 * ⚠️ 集团级账号（如 admin）无 storeId/regionId，其归属由调用方显式指定。
 */
function countryOf(record, regionIndex, storeIndex, orgIndex) {
  if (!record) return null;
  if (record.country) return record.country;
  if (record.regionId && regionIndex && regionIndex.has(record.regionId)) return regionIndex.get(record.regionId);
  if (record.storeId && storeIndex && storeIndex.has(record.storeId)) {
    const regionId = storeIndex.get(record.storeId);
    if (regionId && regionIndex && regionIndex.has(regionId)) return regionIndex.get(regionId);
  }
  if (record.organizationId && orgIndex && orgIndex.has(record.organizationId)) return orgIndex.get(record.organizationId);
  return null;
}

/** 构建 country 推导所需的三个索引（region→country、store→region、org→country） */
function countryIndexes() {
  const regions = readAll('regions') || [];
  const stores = readAll('stores') || [];
  const organizations = readAll('organizations') || [];
  const regionIndex = new Map(regions.filter(r => r && r.id && r.countryCode).map(r => [r.id, r.countryCode]));
  const storeIndex = new Map(stores.filter(s => s && s.id && s.regionId).map(s => [s.id, s.regionId]));
  const orgIndex = new Map(organizations.filter(o => o && o.id && o.countryCode).map(o => [o.id, o.countryCode]));
  return { regionIndex, storeIndex, orgIndex };
}

/** 数据迁移：让老数据文件跟得上新模型（每次启动都会跑，幂等） */
function migrate() {
  // If the legacy fixed development credential is still active, require a reset at next login.
  const users = readAll('users') || [];
  let userChanged = false;
  users.forEach(user => {
    if (user.username === 'admin' && !user.mustChangePassword && user.password && bcrypt.compareSync('admin123', user.password)) {
      user.mustChangePassword = true; userChanged = true;
    }
    if ((user.role === 'manager' || user.role === 'store_manager') && user.mustChangePassword) {
      user.mustChangePassword = false; userChanged = true;
    }
  });
  if (userChanged) writeAll('users', users);

  // ── 2026-10-08 审计 C-1：为存量数据回填 country 字段（幂等，缺才补）──
  const { regionIndex, storeIndex, orgIndex } = countryIndexes();

  // 用户：优先沿 store → region 推导；其次按角色语义（菲律宾相关角色默认 PH）；
  // 都拿不到（集团/中国账号，如 admin/owner/hq）默认 CN。
  const PH_ROLES = new Set(['philippines_manager', 'regional_manager', 'store_manager', 'manager', 'sales', 'warehouse', 'service']);
  if (users.some(u => !u.country)) {
    users.forEach(u => {
      if (u.country) return;
      u.country = countryOf(u, regionIndex, storeIndex, orgIndex)
        || (PH_ROLES.has(u.role) ? 'PH' : 'CN');
    });
    writeAll('users', users);
  }

  // 门店：沿 region 推导，默认 PH（当前所有门店都在菲律宾）
  const stores = readAll('stores') || [];
  if (stores.some(s => !s.country)) {
    stores.forEach(s => { if (!s.country) s.country = countryOf(s, regionIndex, storeIndex, orgIndex) || 'PH'; });
    writeAll('stores', stores);
  }

  // 工作流实例 / 任务 / 公告 / 门店汇报 / 巡检 / 采购批次：沿记录自身归属推导
  const countryBackfillCollections = [
    'workflowInstances', 'tasks', 'announcements', 'storeReports', 'storeInspections', 'purchaseShipments',
  ];
  for (const coll of countryBackfillCollections) {
    const items = readAll(coll) || [];
    if (!Array.isArray(items) || !items.some(x => x && !x.country)) continue;
    items.forEach(x => { if (x && !x.country) x.country = countryOf(x, regionIndex, storeIndex, orgIndex) || 'PH'; });
    writeAll(coll, items);
  }
}

function ensureSeeded() {
  const { readCollection } = require('./store');
  const seededFlag = readCollection('_seeded');
  if (seededFlag && seededFlag.at) {
    migrate();
    return;
  }
  // 首次启动写入种子
  writeAll('users', seedUsers());
  writeAll('stores', seedStores());
  seedControlDirectory();
  writeAll('_seeded', { id: 'singleton', at: nowIso() });
  migrate();
}

module.exports = { ensureSeeded, migrate, readAll, writeAll, countryOf, countryIndexes };
