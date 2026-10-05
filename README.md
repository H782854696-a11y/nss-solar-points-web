# NSS Solar 集团中控平台 V2

本项目是 NSS Solar 现有 SolarPoints 会员积分系统的隔离源码副本及集团中控 V2 开发版本。集团中控负责远程审批、任务协作、门店跟进、通知和审计；金蝶云星辰继续作为正式财务、销售、商品和进销存系统。

## 当前范围与状态

- 集团中控是唯一管理主板块；不建立独立“经营”板块。
- 只允许新建库存盘点申请和门店整改两类流程。采购、费用报销、付款、调拨、库存调整、价格调整的旧记录只读归档，不再接收新单。
- 不维护中控专用的门店/店长或仓库/负责人主档，不重复实现金蝶已有的财务、销售、商品和库存账。
- 不接入金蝶 API。需要时，工作人员手工登记外部单据编号和执行状态。
- 原会员积分功能保持独立；V2 已发布，未重置或迁移旧会员积分数据。
- 当前实现和产品边界见 [README-V2.md](README-V2.md)、[ARCHITECTURE-V2.md](ARCHITECTURE-V2.md) 与 [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md)。完整状态、验证记录和交接步骤见 [HANDOFF.md](HANDOFF.md)。

## 架构与技术栈

- Node.js + Express 服务端，静态前端位于 `public/`。
- `server.js` 提供登录、权限、审批、任务、通知、门店跟进和审计 API。
- `lib/` 按审批、权限、存储、报表、审计和提醒等职责拆分业务逻辑。数据可使用 JSON 存储或 Node 内置 `node:sqlite` SQLite 驱动。
- `public/` 包含管理界面、样式、双语资源和 PWA manifest/service worker。PWA 可缓存页面外壳，离线时可匹配带版本参数的静态资源；只清理本应用旧缓存，不删除同域其他应用缓存。业务 API 仍需联网。
- `deploy/` 保存 V2 独立目录发布、备份、只读预检和 PM2 配置辅助脚本。2026-10-05 已用这些脚本发布到服务器，详细结果见 [HANDOFF.md](HANDOFF.md)。
- 主要运行依赖列于 `package.json` 与 `package-lock.json`：Express、cookie-parser、bcryptjs、nanoid。

## 前置环境与安装

需要 Node.js 22.5 或更高版本（使用内置 `node:sqlite` 时）；建议使用当前受支持的 Node.js LTS，并安装 npm。安装依赖：

```sh
npm ci
```

如果依赖下载受网络限制，先配置可用的 npm 镜像/网络或使用已缓存的锁文件依赖；不要删除或重写 `package-lock.json` 来绕过安装问题。本次本机没有 npm，曾用 pnpm 的 `--no-lockfile --ignore-scripts` 模式装入被忽略的 `node_modules/` 以运行回归测试；没有修改 npm 锁文件。正式环境仍以 `npm ci` 为准。

## 本地配置与启动

复制 `.env.example` 为 `.env`，将初始化密码替换为只在本地使用的随机强密码（至少 16 个字符）。应用不会自动读取 `.env`，启动前需在 shell 中加载它：

```sh
cp .env.example .env
# 编辑 .env，替换 SP_ADMIN_PASSWORD
set -a
. ./.env
set +a
npm start
```

Windows PowerShell 可直接设置环境变量后运行 `npm start`。不要把 `.env`、初始管理员凭据或运行数据提交到版本库。`SP_DATA_DIR` 应始终指向独立的本地目录，不能指向生产服务器数据；首次初始化产生的 `INITIAL_ADMIN_CREDENTIALS.txt` 是敏感凭据，应妥善保管并在首次登录后改密。设置 `SP_ADMIN_PASSWORD` 只影响新初始化的数据目录。

默认本地地址为 `http://localhost:3000`。`PORT` 可改为其他未占用端口。

## 检查与测试

仓库没有独立的前端构建步骤。安装依赖后可运行：

```sh
node --check server.js
node --check public/app.js
node --check public/service-worker.js
npm test
```

`scripts/acceptance_test.cjs` 是早期会员积分界面的旧验收脚本，仍使用旧登录前提和已停用的经营页面；它保留供历史参考，**不要作为 V2 验收命令运行**。V2 先运行 `npm test`，再用独立 `SP_DATA_DIR` 做逐角色浏览器验收。当前 24 个测试文件共 31 项测试在本地通过（0 失败）。隔离浏览器已核对盘点 XLSX 导入、流程切换和多岗位视图；“待我审批”仅计入当前账号真正可签署的申请，并直达对应列表。管理员已在隔离浏览器完成店长盘点申请的批准与手填外部单据编号；门店整改的批准、指派、提交复查、确认关闭也在多个测试账号之间走通。菲律宾经理创建并指派任务，门店员工逐项完成清单后成功结项；任务指派候选名单已与服务端权限规则对齐。整改测试图片经隔离 API 上传后在页面可见，文件选择框的真实手工上传仍待验收。390px 模拟手机宽度下，审批表单未超出屏幕，盘点明细在表格内部横向滚动。隔离 API 回归已验证列表与计数的数据权限。真实手机验证及正式 `npm ci` 安装仍待进行。详细记录见 [HANDOFF.md](HANDOFF.md)。

## 部署说明

生产域名为 `nss-solar-points.com`。既有部署记录指向 `/opt/solarpoints-v2/`（PM2 名称 `solarpoints-v2`，本机端口 3001），原会员积分应用使用独立的 `/opt/solarpoints/` 路径。以上是历史交接信息，本地源码不能证明当前生产状态。

先用 `deploy/preflight-v2.sh nss-solar-v2` 只读核对服务器目录、数据、磁盘和进程。`deploy/deploy-v2.sh` 面向已存在的 V2 目录和数据目录，要求显式提供 SSH 目标，只从已提交的 Git 版本制作发布包，并在切换前备份和校验备份。2026-10-05 已完成一次失败自动回退和一次成功发布，当前公网前端版本 `v58`，PM2 从 `/opt/solarpoints-v2/current/server.js` 运行。发布脚本不能用于首次初始化，也不操作 `/opt/solarpoints/`。备份文件完整性已核对；仍需定期演练从备份恢复。此次未修改 DNS 或证书。

## 常见问题

- **启动时提示缺少模块**：在项目根目录运行 `npm ci`，确认 npm 网络可用。
- **提示端口已占用**：修改 `PORT` 为其他空闲端口，并用相同地址访问。
- **误把资料写进项目目录**：为 `SP_DATA_DIR` 设置明确的本地隔离路径；不要使用生产路径。`.local-data/` 已加入忽略规则。
- **`.env` 修改后配置没有生效**：本项目不自动加载 `.env`；按上面的 shell 命令加载后再启动。
- **手机离线时流程无法提交**：PWA 只缓存页面外壳，审批、通知和附件 API 需要网络连接。
- **浏览器仍显示旧页面**：强制刷新页面并重新登录；若 PWA 仍缓存旧版，关闭后重新打开。服务器已核对 `app.js?v=58`；若依旧显示旧版，再检查浏览器缓存和 service worker。
