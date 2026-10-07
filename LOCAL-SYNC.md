# NSS Solar 集团中控平台 V2 · 本地开发副本

> **同步时间**：2026-10-07 15:45 CST
> **生产来源**：`/opt/solarpoints-v2/current` → `releases/release-20261007T061222Z`
> **本地产物**：与生产**逐字节一致**（关键文件 md5 已核对）

## 这个目录是什么

生产 V2 的**本地开发副本**。改动流程：本地改 → 提交 git → 部署到生产。

生产环境：
- 域名 `https://nss-solar-points.com`
- 代码 `/opt/solarpoints-v2/current`（软链指向 `releases/release-<时间戳>`）
- 数据 `/opt/solarpoints-v2/data/`（**共享目录，切换 release 不动**）
- PM2 进程 `solarpoints-v2`，端口 3001

## 本地与远端 Git 的关系

| | 说明 |
|---|---|
| 远端 | `https://github.com/H782854696-a11y/nss-solar-points-web.git`（私有），`main` = `50f00f5` |
| 本地领先 | 2 个提交：店长菜单隐藏 + 验证脚本 |
| 部署 | 生产 = 远端 main + 本地这 2 个提交 |

`git log --oneline -3` 可看当前状态。**推远端用 `git push`，禁止强推。**

## ⚠️ 两个必知的坑

**1. `package-lock.json` 里有 5 处腾讯云镜像地址**

第 44/136/263/549/628 行硬编码 `http://mirrors.tencentyun.com/npm/...`。该镜像已故障，本地 `npm install` 会报 `E502`，重试还会因残留目录报 `CODEBUDDY_BROKER_DENY`。

正确装法（不改动 lock 文件，保持与生产一致）：
```bash
printf 'registry=https://registry.npmjs.org/\nreplace-registry-host=always\n' > /tmp/sp_npmrc
NPM_CONFIG_USERCONFIG=/tmp/sp_npmrc npm install
```
若中途失败，`node_modules` 会留残缺状态，先 `mv node_modules /tmp/xxx` 再重装。

**2. 本地运行必须用隔离数据目录**

```bash
SP_DATA_DIR=/绝对路径/本地数据 npm start
```
首次初始化会写随机管理员凭据到该目录下的 `INITIAL_ADMIN_CREDENTIALS.txt`（已被 `.gitignore` 排除）。**绝不要指向生产路径。**

## 测试

```bash
npm test    # node --test --test-concurrency=1 test/*.test.js
```

⚠️ 跑测试**必须带 `SP_DATA_DIR` 沙箱**。`test/points-engine.test.js` 会写真实数据目录。

侧栏/权限改动另有三个只读验证脚本：
```bash
node scripts/verify/verify_menus.js     # 逻辑单测（无需依赖）
node scripts/verify/browser_verify.js   # 需 playwright，注入店长登录态
node scripts/verify/verify_hq.js        # 反向验证总部账号不受影响
```

## 部署

**优先用自带脚本**（强制 git 干净提交、`git archive` 只发已审查内容、服务器端自动备份、失败自动回滚）：
```bash
./deploy/deploy-v2.sh ubuntu@<host>
```
需主机可用的 SSH 发布密钥。

若仅改纯前端（`public/*.js|css|html`），也可只 scp 单个文件 + 改 `index.html` 里的 `?v=` 版本号 —— 零停机、不需重启 PM2。**但改 `server.js` 或 `lib/` 必须重启 PM2。**

前端资源版本号（2026-10-07）：`app.js?v=67`｜`i18n.js?v=30`｜`styles.css?v=43`｜`tokens.css?v=1`｜`ui-review.css?v=5`。
`service-worker.js` 是 network-first（断网才回退缓存），不会挡住新版本。

## 重要约定

- **权限判定只走 `lib/rbac.js` + `lib/rbac-guard.js`**，`server.js` 里不得写 `u.role === '...'`。按角色关**界面**要在前端 `canAccessScreen`/`canAccessWorkspace` 加分支，**不要回收权限** —— `store.view` 是店长登记会员的前提，回收会让整条链路 403。
- **`users.role` 存的是旧角色名 `manager`**，经 `normalizeRole`（`LEGACY_ROLE_MAP`）转为 `store_manager`。
- 会员积分旧应用在 `/opt/solarpoints/`（v1），**与 V2 互不干扰，部署 V2 不得触碰**。
- 金蝶云星辰**不接任何 API**，不进销存由金蝶负责，本平台不重复建设。

## 文档

- `README-V2.md` — 产品边界与已实现功能
- `ARCHITECTURE-V2.md` — 最终确认架构（思维导图）
- `IMPLEMENTATION-STATUS.md` — 实施进度与待验收项
- `HANDOFF.md` — 交接细节与逐项下一步
