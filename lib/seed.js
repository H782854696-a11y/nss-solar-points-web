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

module.exports = { ensureSeeded, migrate, readAll, writeAll };
