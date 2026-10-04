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

function seedMembers() {
  const stores = readAll('stores');
  const findStore = (n) => stores.find(s => s.name === n)?.id || '';
  const base = { status: 'active', createdAt: nowIso(), updatedAt: nowIso(), notes: '' };
  return [
    { id: nanoid(), name: 'Maria Santos',         phone: '0917 482 1129', type: 'retail', level: 'platinum', points: 58240,  spend: 486200, storeId: findStore('马尼拉旗舰店'), storeName: '马尼拉旗舰店', ...base },
    { id: nanoid(), name: 'Juan Dela Cruz',       phone: '0918 235 7682', type: 'retail', level: 'gold',     points: 21306,  spend: 152800, storeId: findStore('奎松城分店'),   storeName: '奎松城分店',   ...base },
    { id: nanoid(), name: 'SunPower Installers',  phone: '0918 921 4321', type: 'b2b',    level: 'partner',  points: 342500, spend: 2845000,storeId: findStore('宿务分店'),     storeName: '宿务分店',     ...base, notes: '认证分销商' },
    { id: nanoid(), name: 'Ana Reyes',            phone: '0917 854 3290', type: 'retail', level: 'silver',   points: 8420,   spend: 36900,  storeId: findStore('达沃分店'),     storeName: '达沃分店',     ...base },
    { id: nanoid(), name: 'Cebu Solar Trading',  phone: '0919 643 1187', type: 'b2b',    level: 'partner',  points: 512800, spend: 5120000,storeId: findStore('宿务分店'),     storeName: '宿务分店',     ...base, status: 'frozen', notes: '战略合作伙伴 - 暂停' },
  ].map(m => ({
    ...m,
    pointsExpireAt: null, lastEarnAt: null, lastPurchaseAt: null,
    earnedTotal: m.points, redeemedTotal: 0,
  }));
}

// 零售会员等级（默认值）
// 2026-09-11 起取消等级倍率：等级仅代表身份与累计消费档位，不再影响赚分速度。
const DEFAULT_LEVELS = [
  { key: 'silver',   name: 'Silver',   threshold: 0,      color: '#9CA3AF' },
  { key: 'gold',     name: 'Gold',     threshold: 50000,  color: '#F59E0B' },
  { key: 'platinum', name: 'Platinum', threshold: 200000, color: '#5046E5' },
];

// B2B 阶梯（默认值）
const DEFAULT_B2B_TIERS = [
  { key: 'bronze',  name: 'Registered Installer',  threshold: 500000,  rate: 0.02,  color: '#9CA3AF' },
  { key: 'silver',  name: 'Certified Distributor', threshold: 2000000, rate: 0.035, color: '#0369A1' },
  { key: 'partner', name: 'Strategic Partner',     threshold: 5000000, rate: 0.05,  color: '#5046E5' },
];

// 旧的中文默认名称（仅当规则里仍是这些名字时才自动改成英文，避免覆盖用户自定义）
const LEGACY_LEVEL_NAMES = { silver: '白银会员', gold: '黄金会员', platinum: '铂金会员' };
const LEGACY_B2B_NAMES = { bronze: '注册安装商', silver: '认证分销商', partner: '战略合作伙伴' };

const RULES_SCHEMA_VERSION = 4;

function seedRules() {
  return {
    id: 'singleton',
    // 2026-09-11 规则：每消费 ₱10 得 1 分（实际返利 1%）；10 分抵 ₱1；抵扣不设上限
    spendPerPoint: 10,
    expiryMonths: 24,
    welcomeBonus: 500,
    redeemRatio: '10:1',
    redeemMaxPercent: 0,      // 0 = 不限制单笔抵扣比例（无上限）
    redeemMinPoints: 0,       // 0 = 无起兑门槛
    requireConfirm: true,
    realtimePush: true,
    schemaVersion: RULES_SCHEMA_VERSION,
    levels: DEFAULT_LEVELS.map(l => ({ ...l })),
    b2bTiers: DEFAULT_B2B_TIERS.map(l => ({ ...l })),
    updatedAt: nowIso(),
  };
}

function seedSheets() {
  return {
    id: 'singleton',
    spreadsheetId: '',
    lastSyncAt: null,
    lastSyncResult: null,
    lastError: null,
    autoSync: false,
    autoSyncInterval: 300,
  };
}

function readAll(coll) {
  const { readCollection } = require('./store');
  return readCollection(coll);
}

function writeAll(coll, data) {
  const { writeCollection } = require('./store');
  writeCollection(coll, data);
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
  });
  if (userChanged) writeAll('users', users);
  const rules = readAll('rules');
  if (rules && typeof rules === 'object' && !Array.isArray(rules)) {
    let changed = false;
    // 1) 生日积分体系下线
    if ('birthdayDouble' in rules) { delete rules.birthdayDouble; changed = true; }
    if (!('expiryMonths' in rules)) { rules.expiryMonths = 24; changed = true; }
    if (!('redeemMinPoints' in rules)) { rules.redeemMinPoints = 0; changed = true; }

    const v = Number(rules.schemaVersion || 1);

    // 2) v2：每 ₱1 得 1 分 · 10 分抵 ₱1 · 抵扣无上限 · 无起兑门槛
    if (v < 2) {
      rules.spendPerPoint = 1;
      rules.redeemRatio = '10:1';
      rules.redeemMaxPercent = 0;
      rules.redeemMinPoints = 0;
      rules.schemaVersion = 2;
      changed = true;
    }

    // 3) v3：取消等级倍率（Gold×1.5 / Platinum×2 返利过重）
    //    等级退化为纯身份标识，差异化改由「权益」承载（方案另议）。
    if (v < 3) {
      (rules.levels || []).forEach(lv => {
        if ('multiplier' in lv) { delete lv.multiplier; changed = true; }
      });
      rules.schemaVersion = 3;
      changed = true;
    }

    // 4) v4：下调计分费率 —— 每 ₱10 得 1 分（实际返利 10% → 1%）
    //    积分单价不变（10 分抵 ₱1），存量会员的积分余额不会缩水，只是以后攒得慢。
    if (v < 4) {
      rules.spendPerPoint = 10;
      rules.schemaVersion = 4;
      changed = true;
    }

    // 5) 等级 / B2B 阶梯名称英文化（仅当仍为旧的中文默认名时）
    (rules.levels || []).forEach(lv => {
      const legacy = LEGACY_LEVEL_NAMES[lv.key];
      const preset = DEFAULT_LEVELS.find(d => d.key === lv.key);
      if (legacy && lv.name === legacy && preset) { lv.name = preset.name; changed = true; }
    });
    (rules.b2bTiers || []).forEach(lv => {
      const legacy = LEGACY_B2B_NAMES[lv.key];
      const preset = DEFAULT_B2B_TIERS.find(d => d.key === lv.key);
      if (legacy && lv.name === legacy && preset) { lv.name = preset.name; changed = true; }
    });

    if (changed) { rules.updatedAt = nowIso(); writeAll('rules', rules); }
  }
  // 6) 会员补齐积分引擎字段
  const members = readAll('members') || [];
  let mChanged = false;
  members.forEach(m => {
    if (m.pointsExpireAt === undefined) { m.pointsExpireAt = null; mChanged = true; }
    if (m.lastEarnAt === undefined) { m.lastEarnAt = null; mChanged = true; }
    if (m.lastPurchaseAt === undefined) { m.lastPurchaseAt = null; mChanged = true; }
    if (m.earnedTotal === undefined) { m.earnedTotal = Number(m.points) || 0; mChanged = true; }
    if (m.redeemedTotal === undefined) { m.redeemedTotal = 0; mChanged = true; }
  });
  if (mChanged) writeAll('members', members);
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
  writeAll('members', seedMembers());
  writeAll('transactions', []);
  writeAll('rules', seedRules());
  writeAll('sheets', seedSheets());
  seedControlDirectory();
  writeAll('_seeded', { id: 'singleton', at: nowIso() });
  migrate();
}

module.exports = { ensureSeeded, migrate, readAll, writeAll };
