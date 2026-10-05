# NSS Solar 集团中控平台 V2

本项目是 NSS Solar 现有 SolarPoints 会员积分系统的隔离源码副本及集团中控 V2 开发版本。集团中控负责远程审批、任务协作、门店跟进、通知和审计；金蝶云星辰继续作为正式财务、销售、商品和进销存系统。

## 当前范围与状态

- 集团中控是唯一管理主板块；不建立独立“经营”板块。
- 只允许新建库存盘点申请和门店整改两类流程。采购、费用报销、付款、调拨、库存调整、价格调整的旧记录只读归档，不再接收新单。
- 不维护中控专用的门店/店长或仓库/负责人主档，不重复实现金蝶已有的财务、销售、商品和库存账。
- 不接入金蝶 API。需要时，工作人员手工登记外部单据编号和执行状态。
- 原会员积分功能保持独立；本次工作只在本地隔离源码副本中进行，没有重置或部署生产会员数据。
- 当前实现和产品边界见 [README-V2.md](README-V2.md)、[ARCHITECTURE-V2.md](ARCHITECTURE-V2.md) 与 [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md)。完整状态、验证记录和交接步骤见 [HANDOFF.md](HANDOFF.md)。

## 架构与技术栈

- Node.js + Express 服务端，静态前端位于 `public/`。
- `server.js` 提供登录、权限、审批、任务、通知、门店跟进和审计 API。
- `lib/` 按审批、权限、存储、报表、审计和提醒等职责拆分业务逻辑。数据可使用 JSON 存储或 Node 内置 `node:sqlite` SQLite 驱动。
- `public/` 包含管理界面、样式、双语资源和 PWA manifest/service worker。PWA 可缓存页面外壳，离线时可匹配带版本参数的静态资源；只清理本应用旧缓存，不删除同域其他应用缓存。业务 API 仍需联网。
- `deploy/` 保存 V2 独立目录发布、备份和 PM2 配置辅助脚本。它们未在本次交接准备中对生产服务器执行。
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

仓库目前没有独立的前端构建步骤，也没有配置 `npm test` 脚本。安装依赖后可运行：

```sh
node --check server.js
node --check public/app.js
node --check public/service-worker.js
node --test --test-concurrency=1 test/*.test.js
```

`scripts/acceptance_test.cjs` 是需连接本地隔离服务的验收脚本，不是独立测试。先用临时 `SP_DATA_DIR` 和非生产端口启动本地服务，再通过 `BASE=http://localhost:<端口> node scripts/acceptance_test.cjs` 执行。当前 24 个测试文件共 31 项测试在本地通过（0 失败）。隔离浏览器已核对盘点 XLSX 导入、流程切换、管理员列表，以及店长、整改负责人和菲律宾审批人的部分视图；“待我审批”仅计入当前账号真正可签署的申请。390px 模拟手机宽度下，审批表单未超出屏幕，盘点明细在表格内部横向滚动。隔离 API 回归已验证列表与计数的数据权限。完整岗位业务闭环、真实手机验证及正式 `npm ci` 安装仍待进行。详细记录见 [HANDOFF.md](HANDOFF.md)。

## 部署说明

生产域名为 `nss-solar-points.com`。既有部署记录指向 `/opt/solarpoints-v2/`（PM2 名称 `solarpoints-v2`，本机端口 3001），原会员积分应用使用独立的 `/opt/solarpoints/` 路径。以上是历史交接信息，本地源码不能证明当前生产状态。

`deploy/deploy-v2.sh` 面向已存在的 V2 目录和数据目录，要求显式提供 SSH 目标并完成服务器备份、发布、健康检查和回滚处理。当前脚本未完成远程演练；执行前必须由维护者审阅目标主机、备份恢复能力、SSH 身份和服务器现状。不要拿它作为首次初始化脚本，也不要让它访问 `/opt/solarpoints/`。本次工作未部署、未重启生产服务、未修改 DNS 或证书。

## 常见问题

- **启动时提示缺少模块**：在项目根目录运行 `npm ci`，确认 npm 网络可用。
- **提示端口已占用**：修改 `PORT` 为其他空闲端口，并用相同地址访问。
- **误把资料写进项目目录**：为 `SP_DATA_DIR` 设置明确的本地隔离路径；不要使用生产路径。`.local-data/` 已加入忽略规则。
- **`.env` 修改后配置没有生效**：本项目不自动加载 `.env`；按上面的 shell 命令加载后再启动。
- **手机离线时流程无法提交**：PWA 只缓存页面外壳，审批、通知和附件 API 需要网络连接。
- **生产版功能与本地代码不同**：本地后续改造尚未发布；须先核对生产部署版本和审批授权，再安排发布。
