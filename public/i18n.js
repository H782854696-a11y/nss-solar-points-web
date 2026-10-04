/* ============================================================================
 * SolarPoints 双语字典 / Bilingual dictionary
 * ----------------------------------------------------------------------------
 * 默认语言：英文（菲律宾门店员工日常使用）
 * 可切换：中文（总部管理使用）
 * 用法：
 *   t('nav.members')                   → 'Members' / '会员管理'
 *   t('dash.storeCount', { n: 3 })     → '3 stores' / '3 家门店'
 *   tMsg(err.message)                  → 把服务器返回的中文/英文消息翻到当前语言
 *   L()                                → 当前 locale（zh-CN / en-PH），给日期数字用
 * ========================================================================== */
(function (global) {
  const STORAGE_KEY = 'sp_lang';
  const FALLBACK = 'en';

  // [英文, 中文]
  const M = {
    /* ==================== 通用 ==================== */
    'common.cancel': ['Cancel', '取消'],
    'common.close': ['Close', '关闭'],
    'common.save': ['Save', '保存'],
    'common.create': ['Create', '创建'],
    'common.edit': ['Edit', '编辑'],
    'common.delete': ['Delete', '删除'],
    'common.detail': ['Details', '详情'],
    'common.search': ['Search', '搜索'],
    'common.reset': ['Reset', '重置'],
    'common.query': ['Search', '查询'],
    'common.refresh': ['Refresh', '刷新'],
    'common.clear': ['Clear', '清除'],
    'common.download': ['Download', '下载'],
    'common.import': ['Import', '导入'],
    'common.loading': ['Loading…', '加载中…'],
    'common.loadFailed': ['Failed to load: {msg}', '加载失败：{msg}'],
    'common.noPermission': ["You don't have permission to view this page", '你没有查看此页面的权限'],
    'common.readingDb': ['Reading the data files…', '正在读取数据文件…'],
    'common.notSignedIn': ['Your session has expired. Please sign in again.', '登录已过期，请重新登录'],
    'common.optional': ['Optional', '选填'],
    'common.confirm': ['Confirm', '确认'],
    'common.points': ['points', '积分'],
    'common.saved': ['Saved', '已保存'],
    'common.deleted': ['Deleted', '已删除'],
    'common.langSwitch': ['中文', 'EN'],
    'common.langSwitchTitle': ['切换到中文', 'Switch to English'],

    /* ==================== 登录页 ==================== */
    'login.username': ['Account', '账号'],
    'login.usernamePh': ['Enter your account', '请输入账号'],
    'login.password': ['Password', '密码'],
    'login.passwordPh': ['Enter your password', '请输入密码'],
    'login.submit': ['Sign In', '登 录'],
    'login.submitting': ['Signing in…', '登录中…'],
    'login.titleMain': ['NSS Solar ', 'NSS Solar 集团'],
    'login.titleAccent': ['Group Control', '中控'],
    'login.subtitle': ['Group approvals · organization · store operations', '集团审批 · 组织管理 · 门店协作'],
    'login.showPwd': ['Show password', '显示密码'],
    'login.hidePwd': ['Hide password', '隐藏密码'],
    'login.hint': ['NSS Solar internal system · Do not share your credentials with anyone', 'NSS Solar 内部系统 · 请勿将账号密码告知他人'],
    'login.welcome': ['Welcome back, {name}', '欢迎回来，{name}'],

    /* ==================== 侧边栏 / 顶栏 ==================== */
    'nav.groupOps': ['OPERATIONS', '经营'],
    'nav.groupSystem': ['SYSTEM', '系统'],
    'nav.groupBiz': ['BUSINESS', '业务'],
    'nav.groupPoints': ['POINTS', '积分'],
    'nav.dashboard': ['Overview', '经营总览'],
    'nav.members': ['Members', '会员管理'],
    'nav.rules': ['Points Rules', '积分规则'],
    'nav.stores': ['Stores', '门店管理'],
    'nav.mall': ['Points Mall', '积分商城'],
    'nav.approvals': ['Approvals', '积分审核'],
    'nav.controlCenter': ['Group Control Center', '集团中控'],
    'nav.sheets': ['Cloud Sync', '云同步'],
    'nav.db': ['Data Store', '数据主库'],
    'nav.reports': ['Reports', '经营报表'],
    'nav.storeBiz': ['Store Operations', '门店经营'],
    'nav.memberBiz': ['Member Operations', '会员经营'],
    'nav.account': ['Account', '账号设置'],
    'nav.audit': ['Audit Log', '审计日志'],
    'nav.accounts': ['Accounts', '账号管理'],
    'nav.menu': ['Menu', '菜单'],

    // ============ 经营总览 / 门店经营 / 会员经营 ============
    'biz.overview.title': ['Operations Overview', '经营总览'],
    'biz.overview.subtitleAll': ['All stores · {n} stores', '全部门店 · 共 {n} 家'],
    'biz.overview.subtitleStore': ['This store · {store}', '本店 · {store}'],
    'biz.kpiSales': ['Sales', '销售额'],
    'biz.kpiOrders': ['Sales Orders', '销售单数'],
    'biz.kpiAov': ['Avg Order Value', '客单价'],
    'biz.kpiActiveMembers': ['Active Members', '活跃会员'],
    'biz.kpiNewMembers': ['New Members', '新增会员'],
    'biz.kpiProductCategories': ['Product Categories', '销售商品种类'],
    'biz.kpiStores': ['Stores', '门店数'],
    'biz.noSalesData': ['No sales data yet', '暂无销售数据'],
    'biz.dataPending': ['Pending Kingdee sync', '数据待接入'],
    'biz.trendTitle': ['Sales Trend', '销售趋势'],
    'biz.trendSub': ['Daily / monthly sales', '销售走势'],
    'biz.trendEmptyHint': ['Sales figures will flow in once the Kingdee integration is connected.', '销售额将在金蝶系统接入后自动汇入此处'],
    'biz.emptyDistTitle': ['No stores in this view', '当前视图暂无门店'],
    'biz.emptyDistHint': ['Member distribution appears once stores are added.', '新增门店后，会员分布将自动展示'],
    'biz.storeOverviewTitle': ['Store Operations', '门店经营概览'],
    'biz.storeOverviewSub': ['Per-store performance', '各门店经营表现'],
    'biz.memberOverviewTitle': ['Member Operations', '会员经营概览'],
    'biz.memberOverviewSub': ['Member lifecycle', '会员生命周期'],
    'biz.viewDetail': ['View Details', '查看详情'],
    'biz.store.title': ['Store Operations', '门店经营'],
    'biz.store.subtitle': ['Per-store metrics', '门店维度经营指标'],
    'biz.store.kpiStores': ['Stores', '门店数'],
    'biz.store.kpiMembers': ['Total Members', '会员总数'],
    'biz.store.kpiActive': ['Active Members', '活跃会员'],
    'biz.store.kpiSpend': ['Total Member Spend', '累计会员消费'],
    'biz.store.note': ['Member spend and points are aggregated from the loyalty system. Sales orders become available after Kingdee AI Xingchen integration.', '会员消费与积分为会员系统口径；销售额（销售订单）待金蝶 AI 星辰接入后提供。'],
    'biz.member.title': ['Member Operations', '会员经营'],
    'biz.member.subtitle': ['Member lifecycle metrics', '会员生命周期指标'],
    'biz.member.kpiTotal': ['Total Members', '会员总数'],
    'biz.member.kpiActive': ['Active Members', '活跃会员'],
    'biz.member.kpiSleep': ['Sleeping Members', '沉睡会员'],
    'biz.member.kpiTop': ['Top Spenders', '高价值会员'],
    'biz.member.levelTitle': ['Level Distribution', '等级分布'],
    'biz.member.levelEmpty': ['Level distribution pending', '等级分布待接入'],
    'biz.member.typeTitle': ['Type Distribution', '类型分布'],
    'biz.member.sleepTitle': ['Sleeping Members', '沉睡会员'],
    'biz.member.topTitle': ['Top Spenders', '高价值会员'],

    /* ==================== 积分审核（2026-09-19） ==================== */
    'approval.title': ['Points Approval', '积分审核'],
    'approval.subtitle': ['Manager-submitted point requests. Nothing is added to a member balance until you approve it.', '店长提交的新增积分申请。通过前不会计入会员余额。'],
    'approval.tabPending': ['Pending', '待审核'],
    'approval.tabApproved': ['Approved', '已通过'],
    'approval.tabRejected': ['Rejected', '已驳回'],
    'approval.tabAll': ['All', '全部'],
    'approval.stPending': ['Pending', '待审核'],
    'approval.stApproved': ['Approved', '已通过'],
    'approval.stRejected': ['Rejected', '已驳回'],
    'approval.kindPurchase': ['Purchase {amount}', '消费登记 {amount}'],
    'approval.kindEarn': ['Manual +{points} pts', '手工补录 +{points} 分'],
    'approval.by': ['By', '提交人'],
    'approval.note': ['Note', '审核意见'],
    'approval.empty': ['Nothing here.', '暂无相关申请'],
    'approval.approve': ['Approve', '通过'],
    'approval.reject': ['Reject', '驳回'],
    'approval.approveTitle': ['Approve this request?', '确认通过这条申请？'],
    'approval.approveBody': ['The points will be added to the member balance right away, and a ledger entry will be written.', '通过后积分会立即计入会员余额，并生成一条积分流水。'],
    'approval.approved': ['Approved · +{points} pts', '已通过 · +{points} 分'],
    'approval.rejectTitle': ['Reject this request', '驳回这条申请'],
    'approval.rejectReason': ['Reason (shown to the manager)', '驳回原因（店长可见）'],
    'approval.rejectReasonPh': ['e.g. Amount does not match the receipt', '例如：金额与小票不符'],
    'approval.rejected': ['Rejected', '已驳回'],
    'approval.needReason': ['Please enter a reason so the manager knows why.', '请填写驳回原因，方便店长知道为什么。'],
    'approval.submittedToast': ['Submitted · {amount} recorded, waiting for admin approval', '已提交 · {amount} 已登记，待管理员审核'],

    /* ==================== 积分商城（2026-09-19） ==================== */
    'mall.title': ['Points Mall', '积分商城'],
    'mall.subtitle': ['Redeem member points for gifts. Pick a member, then a product.', '用会员积分兑换商品。先选会员，再选商品。'],
    'mall.manage': ['Manage Products', '管理商品'],
    'mall.tabShop': ['Redeem', '兑换商品'],
    'mall.tabOrders': ['Orders', '兑换记录'],
    'mall.pickMember': ['1 · Choose a member', '第一步 · 选择会员'],
    'mall.pickMemberSub': ['Search by name or phone number', '按姓名或手机号搜索'],
    'mall.searchPh': ['Name or phone…', '姓名或手机号…'],
    'mall.noMember': ['No member found', '未找到会员'],
    'mall.clear': ['Change', '更换'],
    'mall.products': ['2 · Choose a product', '第二步 · 选择商品'],
    'mall.noProducts': ['No products yet', '暂无商品'],
    'mall.pointsUnit': ['pts', '分'],
    'mall.noImage': ['No image', '无图片'],
    'mall.redeem': ['Redeem', '兑换'],
    'mall.needMember': ['Pick a member first', '请先选会员'],
    'mall.notEnough': ['Not enough points', '积分不足'],
    'mall.confirmTitle': ['Confirm redemption', '确认兑换'],
    'mall.confirmBody': ['Redeem “{product}” for <b>{name}</b>? Points are deducted immediately.', '为 <b>{name}</b> 兑换「{product}」？积分将立即扣除。'],
    'mall.redeemDone': ['Redeemed “{product}” · -{points} pts', '已兑换「{product}」 · -{points} 分'],
    'mall.stPending': ['To issue', '待发放'],
    'mall.stFulfilled': ['Issued', '已发放'],
    'mall.stCancelled': ['Cancelled', '已取消'],
    'mall.by': ['By', '操作人'],
    'mall.fulfill': ['Mark as issued', '确认已发放'],
    'mall.cancel': ['Cancel', '取消'],
    'mall.fulfilled': ['Marked as issued', '已确认发放'],
    'mall.cancelled': ['Cancelled · points refunded', '已取消 · 积分已退回'],
    'mall.cancelTitle': ['Cancel this order?', '取消这张兑换单？'],
    'mall.cancelBody': ['The points will be returned to the member right away.', '积分会立即退回给会员。'],
    'mall.noOrders': ['No redemptions yet.', '暂无兑换记录'],
    'mall.manageTitle': ['Products', '商品管理'],
    'mall.addTitle': ['Add a product', '新增商品'],
    'mall.name': ['Name', '商品名称'],
    'mall.namePh': ['e.g. Solar Lantern', '例如：太阳能提灯'],
    'mall.points': ['Points required', '所需积分'],
    'mall.desc': ['Description (optional)', '商品描述（选填）'],
    'mall.descPh': ['Short description shown on the card', '卡片上显示的简短描述'],
    'mall.image': ['Image', '商品图片'],
    'mall.add': ['Add', '新增'],
    'mall.added': ['Product added', '商品已新增'],
    'mall.on': ['Publish', '上架'],
    'mall.off': ['Unpublish', '下架'],
    'mall.updated': ['Updated', '已更新'],
    'mall.needName': ['Please enter a product name', '请填写商品名称'],
    'mall.needPoints': ['Please enter a valid point value', '请填写正确的所需积分'],
    'mall.imgReadFail': ['Could not read that image', '图片读取失败'],
    'role.admin': ['Administrator', '超级管理员'],
    'role.owner': ['Owner', '老板'],
    'role.hq': ['HQ Operations', '中国总部运营'],
    'role.ph': ['Philippines Manager', '菲律宾负责人'],
    'role.region': ['Regional Manager', '区域负责人'],
    'role.manager': ['Store Manager', '店长'],
    'role.sales': ['Sales', '销售人员'],
    'role.warehouse': ['Warehouse', '仓库人员'],
    'role.service': ['Service', '售后/技术'],
    'header.searchPh': ['Search name / phone', '搜索姓名 / 手机号'],
    'header.logout': ['Sign out', '退出登录'],

    /* ==================== 经营报表 ==================== */
    'reports.title': ['Business Reports', '经营报表'],
    'reports.subtitleAll': ['{n} stores · all members · data through {ts}', '{n} 家门店 · 全量会员 · 数据截至 {ts}'],
    'reports.subtitleStore': ['{store} · store-scoped · data through {ts}', '{store} · 仅本门店 · 数据截至 {ts}'],
    'reports.refresh': ['Refresh', '刷新'],

    // — 头部 4 张卡 —
    'reports.liability.title': ['Outstanding liability', '积分负债'],
    'reports.liability.sub': ['{pts} pts issued, not yet redeemed', '累计已发 {pts} 积分，尚未核销'],
    'reports.liability.phpAt': ['≈ ₱{php} cash equivalent', '≈ ₱{php} 现金等价'],
    'reports.active.title': ['Active members', '活跃会员'],
    'reports.active.sub': ['{active} active · {frozen} frozen', '活跃 {active} · 冻结 {frozen}'],
    'reports.frozenOnly.sub': ['{frozen} frozen', '冻结 {frozen}'],
    'reports.mix.title': ['Customer mix', '客户构成'],

    // — 30 天总览 —
    'reports.activity.title': ['Last 30 days', '近 30 天运营'],
    'reports.activity.sub': ['Spend · points issued · points redeemed · repeat purchase rate', '消费金额 · 发放积分 · 核销积分 · 复购率'],
    'reports.activity.spend': ['Member Spend', '会员消费'],
    'reports.activity.earn': ['Issued', '发放积分'],
    'reports.activity.redeem': ['Redeemed', '核销积分'],
    'reports.activity.tx': ['Transactions', '交易笔数'],
    'reports.activity.active': ['Active buyers', '活跃买家'],
    'reports.activity.repeat': ['Repeat buyers', '复购买家'],
    'reports.activity.retention': ['Repeat purchase rate', '复购率'],
    'reports.activity.empty': ['No transactions yet — start issuing points from a member\'s detail page.', '尚无交易流水。请到任意会员详情页开始发分。'],

    // — 门店排行 —
    'reports.stores.title': ['Store ranking', '门店排行'],
    'reports.stores.sub': ['Points issued in the last 30 days, highest first', '按近 30 天积分发放额降序'],
    'reports.stores.earn30': ['Issued (30d)', '30 天发放'],
    'reports.stores.spendTotal': ['Cumulative spend', '累计消费'],
    'reports.stores.pointsTotal': ['Outstanding', '在账积分'],
    'reports.stores.members': ['Members', '会员数'],
    'reports.stores.empty': ['No stores in scope', '当前范围内暂无门店'],

    // — 沉睡名单 —
    'reports.sleep.title': ['Dormant members', '沉睡会员'],
    'reports.sleep.sub': ['No purchase for {d} days, or registered for over {rd} days without any spend', '{d} 天内无消费，或注册超 {rd} 天从未消费'],
    'reports.sleep.lastDays': ['Last buy {d} days ago', '最近消费 {d} 天前'],
    'reports.sleep.regDays': ['Registered {d} days ago', '注册 {d} 天'],
    'reports.sleep.empty': ['No dormant members — every customer has been active recently.', '暂无沉睡会员，所有客户近期都有互动。'],

    // — Top10 —
    'reports.top.title': ['Top customers', '头部客户'],
    'reports.top.sub': ['By cumulative spend', '按累计消费额'],
    'reports.top.spend': ['Total spend', '累计消费'],
    'reports.top.points': ['Outstanding', '在账积分'],
    'reports.top.empty': ['No customers yet', '暂无客户'],

    // — 月度趋势 —
    'reports.trend.title': ['6-month trend', '6 个月趋势'],
    'reports.trend.sub': ['Points issued (green) vs redeemed (amber), spend in grey bars', '积分发放（绿）vs 核销（琥珀），灰色柱状为消费金额'],
    'reports.trend.earn': ['Issued', '发放'],
    'reports.trend.redeem': ['Redeemed', '核销'],
    'reports.trend.spend': ['Spend', '消费'],
    'reports.trend.empty': ['No activity in the last 6 months', '近 6 个月没有产生数据'],

    // — 等级 / 类型构成 —
    'reports.level.title': ['Member levels', '等级分布'],
    'reports.level.sub': ['Active retail / B2B members per tier', '零售 / B2B 会员在每个等级的分布'],
    'reports.type.title': ['Retail vs B2B', '零售 vs B2B'],
    'reports.type.sub': ['Customer type mix', '客户类型构成'],

    // — 即将过期 —
    'reports.expire.title': ['Expiring soon', '即将过期'],
    'reports.expire.sub': ['Outstanding points due to expire within {d} days', '在账积分将在 {d} 天内过期'],
    'reports.expire.daysLeft': ['{d} days left', '还剩 {d} 天'],
    'reports.expire.empty': ['No points expiring within the next {d} days.', '未来 {d} 天内没有即将过期的积分。'],
    'reports.expire.call': ['Reach out and remind them to redeem.', '建议主动联系客户，提醒核销。'],

    /* ==================== 会员类型 / 等级 / 状态 ==================== */
    'type.retail': ['Retail', '零售'],
    'type.b2b': ['B2B', 'B2B'],
    'type.retailCustomer': ['Retail customer', '零售客户'],
    'type.b2bCustomer': ['B2B customer', 'B2B 客户'],
    'level.silver': ['Silver', 'Silver'],
    'level.gold': ['Gold', 'Gold'],
    'level.platinum': ['Platinum', 'Platinum'],
    'level.partner': ['Strategic Partner', '战略伙伴'],
    'level.bronze': ['Bronze', 'Bronze'],
    'status.active': ['Active', '正常'],
    'status.frozen': ['Frozen', '已冻结'],

    /* ==================== 流水类型 ==================== */
    'tx.earn': ['Purchase earned', '消费获得'],
    'tx.welcome': ['Welcome bonus', '新人礼'],
    'tx.redeem': ['Points redeemed', '积分核销'],
    'tx.expire': ['Expired', '已过期'],
    'tx.adjust': ['Manual adjustment', '人工调整'],

    /* ==================== 数据总览 ==================== */
    'dash.title': ['Dashboard', '数据总览'],
    'dash.subtitleStore': ['{store} · {sync}', '{store} · 数据 {sync}'],
    'dash.subtitleStoreNoSync': ['{store}', '{store}'],
    'dash.subtitleAllNoSync': ['{n} stores', '{n} 家门店'],
    'dash.subtitleAll': ['{n} stores · {sync}', '{n} 家门店 · 数据 {sync}'],
    'dash.syncedToSheets': ['synced to Google Sheets', '已同步至 Google Sheets'],
    'dash.localOnly': ['stored locally', '本地存储'],
    'dash.trendEmpty': ['No points activity yet', '还没有积分流水'],
    'dash.exportReport': ['Export report', '导出报表'],
    'dash.kpiTotal': ['Total members', '会员总数'],
    'dash.kpiPoints': ['Points balance', '积分余额合计'],
    'dash.kpiPointsSub': ['Issued minus redeemed', '累计发放与核销差额'],
    'dash.kpiSpend': ['Total spend (₱)', '累计消费 (₱)'],
    'dash.kpiSpendSub': ['{scope} total', '{scope}合计'],
    'dash.thisStore': ['This store', '本店'],
    'dash.allStores': ['All stores', '全部门店'],
    'dash.thisStoreSub': ['Manager view', '店长视角'],
    'dash.allStoresSub': ['Live sync', '实时同步中'],
    'dash.trendTitle': ['Points activity · last 30 days', '近 30 天积分流水'],
    'dash.trendSub': ['Aggregated every 3 days', '每 3 天聚合一次'],
    'dash.realData': ['Live data', '实数据'],
    'dash.storeDist': ['Members by store', '门店会员分布'],
    'dash.storeDistSub': ['Member count per store', '按门店统计会员数量'],
    'dash.heroTagline': ['Real-time store operations · data-driven growth', '实时掌握门店经营动态 · 数据驱动业务增长'],
    'dash.reportTitle': ['SolarPoints Report', 'SolarPoints 数据报表'],
    'dash.reportGenerated': ['Generated: {time}', '生成时间：{time}'],
    'dash.reportTotal': ['Total members', '会员总数'],
    'dash.reportRetail': ['Retail members', '零售会员'],
    'dash.reportB2b': ['B2B members', 'B2B 会员'],
    'dash.reportPoints': ['Points balance', '积分余额合计'],
    'dash.reportSpend': ['Total spend (₱)', '累计消费(₱)'],
    'dash.reportStore': ['Store', '门店'],
    'dash.reportStoreCount': ['Members', '会员数'],
    'dash.reportTrend': ['Points activity · last 30 days', '近 30 天积分流水'],
    'dash.reportBucket': ['Period', '日期段'],
    'dash.reportEarn': ['Earned', '发放'],
    'dash.reportRedeem': ['Redeemed', '核销'],
    'dash.reportDownloaded': ['Report downloaded', '报表已下载'],

    /* ==================== 会员管理 ==================== */
    'members.title': ['Members', '会员管理'],
    'members.subtitleAdmin': ['Retail + B2B in one place · {n} members', '零售 + B2B 客户统一管理 · 共 {n} 位会员'],
    'members.subtitleMgr': ['This store\'s members · {n} total', '本店会员管理 · 共 {n} 位会员'],
    'members.import': ['Bulk import', '批量导入'],
    'members.add': ['+ New member', '＋新增会员'],
    'members.searchPh': ['Search name / phone', '搜索姓名 / 手机号'],
    'members.allTypes': ['All types', '全部类型'],
    'members.allStores': ['All stores', '全部门店'],
    'members.allLevels': ['All levels', '全部等级'],
    'members.colMember': ['Member', '会员信息'],
    'members.colType': ['Type', '类型'],
    'members.colLevel': ['Level', '等级'],
    'members.colPoints': ['Points', '积分余额'],
    'members.colSpend': ['Total spend', '累计消费'],
    'members.colStore': ['Store', '最近门店'],
    'members.colStatus': ['Status', '状态'],
    'members.colActions': ['Actions', '操作'],
    'members.empty': ['No members yet — click "New member" to get started', '暂无会员数据，点击右上角「新增会员」开始'],
    'members.pager': ['{total} records · {size} per page · page {page} / {pages}', '共 {total} 条 · 每页 {size} 条 · 第 {page} / {pages} 页'],
    'members.emptyFiltered': ['No members match the current filters — try Reset', '没有符合当前筛选条件的会员，可点「重置」清空条件'],
    'members.recordShort': ['Purchase', '登记消费'],
    'members.prev': ['Previous', '上一页'],
    'members.next': ['Next', '下一页'],

    /* ---------- 会员表单 ---------- */
    'memberForm.new': ['New member', '新增会员'],
    'memberForm.edit': ['Edit member', '编辑会员'],
    'memberForm.name': ['Name *', '姓名 *'],
    'memberForm.phone': ['Mobile number *', '手机号 *'],
    'memberForm.type': ['Member type *', '会员类型 *'],
    'memberForm.store': ['Store *', '所属门店 *'],
    'memberForm.spend': ['Total spend (₱)', '累计消费 (₱)'],
    'memberForm.points': ['Points balance', '积分余额'],
    'memberForm.pointsHint': ['(admin only)', '（仅管理员可改）'],
    'memberForm.adjustNoteEdit': ['Changing the balance directly writes a traceable "manual adjustment" entry.', '直接改动积分余额会生成一条「人工调整」流水，可追溯。'],
    'memberForm.adjustNoteNew': ['Points entered here are booked as an opening balance. For day-to-day earning, use "Record purchase" on the member profile.', '建档时填写积分会作为「期初余额」入账；日常发积分请用会员详情里的「登记消费」。'],
    'memberForm.saved': ['Saved', '已保存'],
    'memberForm.createdMsg': ['Member created', '会员已创建'],

    /* ---------- 会员详情 ---------- */
    'memberDetail.phone': ['Mobile', '手机号'],
    'memberDetail.type': ['Type', '类型'],
    'memberDetail.level': ['Level', '等级'],
    'memberDetail.status': ['Status', '状态'],
    'memberDetail.balance': ['Points balance', '积分余额'],
    'memberDetail.earned': ['Total earned', '累计获得'],
    'memberDetail.redeemed': ['Total redeemed', '累计核销'],
    'memberDetail.expiry': ['Points expiry', '积分到期'],
    'memberDetail.expired': ['Expired', '已到期'],
    'memberDetail.expiryIn': ['{date} ({days} days left)', '{date}（剩 {days} 天）'],
    'memberDetail.spend': ['Total spend', '累计消费'],
    'memberDetail.lastPurchase': ['Last purchase', '最近消费'],
    'memberDetail.store': ['Store', '所属门店'],
    'memberDetail.createdAt': ['Created', '创建时间'],
    'memberDetail.notes': ['Notes', '备注'],
    'memberDetail.recordPurchase': ['+ Record purchase', '＋登记消费'],
    'memberDetail.redeem': ['Redeem points', '核销积分'],
    'memberDetail.adjust': ['Adjust points', '手动调整'],
    'memberDetail.ledger': ['Points ledger (latest 100)', '积分流水（最近 100 条）'],
    'memberDetail.noTx': ['No activity yet', '暂无流水'],

    /* ---------- 登记消费 ---------- */
    'purchase.title': ['Record purchase · {name}', '登记消费 · {name}'],
    'purchase.balanceLine': ['Current balance <b>{points}</b> points · total spend {spend}', '当前余额 <b>{points}</b> 积分 · 累计消费 {spend}'],
    'purchase.amount': ['Purchase amount (₱) *', '消费金额 (₱) *'],
    'purchase.amountPh': ['e.g. 12500', '例如 12500'],
    'purchase.previewEmpty': ['Enter an amount to see the points earned', '输入金额后自动计算本单可获得的积分'],
    'purchase.note': ['Note', '备注'],
    'purchase.notePh': ['Optional, e.g. order number', '选填，例如订单号'],
    'purchase.confirm': ['Confirm & issue points', '确认并发放积分'],
    'purchase.orderAmountLine': ['Order amount <b>{amount}</b>', '本单金额 <b>{amount}</b>'],
    'purchase.baseLine': ['Base points <b>{base}</b>{perPeso}', '基础积分 <b>{base}</b>{perPeso}'],
    'purchase.resultLine': ['→ Earn <b>{points} points</b>', '→ 可获得 <b>{points} 积分</b>'],
    'purchase.perPeso': [' (₱{rate} = 1 pt)', '（每 ₱{rate} 积 1 分）'],
    'purchase.calcFailed': ['Calculation failed: {msg}', '计算失败：{msg}'],
    'purchase.invalidAmount': ['Please enter a valid purchase amount', '请输入正确的消费金额'],
    'purchase.done': ['Recorded {amount} · issued {points} points', '已登记 {amount}，发放 {points} 积分'],
    'purchase.levelUp': ['Member upgraded: {from} → {to}', '会员等级已升级：{from} → {to}'],

    /* ---------- 核销积分 ---------- */
    'redeem.title': ['Redeem points · {name}', '核销积分 · {name}'],
    'redeem.balanceLine': ['Current balance <b>{points}</b> points', '当前余额 <b>{points}</b> 积分'],
    'redeem.orderAmount': ['Order amount (₱) *', '本次订单金额 (₱) *'],
    'redeem.orderAmountPh': ['e.g. 8000', '例如 8000'],
    'redeem.usePoints': ['Points to use *', '使用积分 *'],
    'redeem.previewEmpty': ['Enter the order amount to see the maximum usable points', '填写订单金额后显示本单最多可用积分'],
    'redeem.note': ['Note', '备注'],
    'redeem.confirm': ['Confirm redemption', '确认核销'],
    'redeem.belowMin': ['This member has not reached the redemption threshold yet: {min} points required (current {balance}).', '该会员尚未达到起兑门槛：需 {min} 积分（当前 {balance}）'],
    'redeem.rateLine': ['Rate <b>{p} pts = ₱{v}</b>{cap}', '兑换比例 <b>{p} 分 = ₱{v}</b>{cap}'],
    'redeem.capPercent': [' · max {pct}% of the order', ' · 单笔最多抵扣 {pct}%'],
    'redeem.capNone': [' · no redemption limit', ' · 抵扣无上限'],
    'redeem.maxLine': ['Up to <b>{points}</b> points this time (worth <b>{value}</b>)', '本单最多可用 <b>{points}</b> 积分（可抵 <b>{value}</b>）'],
    'redeem.percentApplied': [' · capped by the redemption percentage', ' · 已被抵扣比例限制'],
    'redeem.orderApplied': [' · capped by the order amount', ' · 不得超过订单金额'],
    'redeem.useMax': ['Use max {points} pts', '用满 {points} 分'],
    'redeem.usedLine': ['Using <b>{used}</b> pts → worth <b>{value}</b>', '本次使用 <b>{used}</b> 分 → 抵扣 <b>{value}</b>'],
    'redeem.done': ['Redeemed {points} points', '已核销 {points} 积分'],

    /* ---------- 手动调整 ---------- */
    'adjust.title': ['Adjust points · {name}', '手动调整积分 · {name}'],
    'adjust.warning': ['Use this to correct errors or back-fill historical data. It ignores the earning rules and every change is written to the ledger.', '这里用于纠错或补录历史数据，不会按消费规则计算，每一步都会记入流水。'],
    'adjust.balanceLine': ['Current balance <b>{points}</b> points', '当前余额 <b>{points}</b> 积分'],
    'adjust.amount': ['Change *', '变动数量 *'],
    'adjust.amountPh': ['Positive adds, negative deducts — e.g. 200 or -50', '正数增加，负数扣减，例如 200 或 -50'],
    'adjust.reason': ['Reason *', '原因 *'],
    'adjust.reasonPh': ['e.g. back-fill August purchase points', '例如 补录 8 月消费积分'],
    'adjust.confirm': ['Confirm adjustment', '确认调整'],
    'adjust.confirmTitle': ['Confirm manual adjustment', '确认人工调整积分'],
    'adjust.confirmBody': ['You are about to change this balance by <b>{amount}</b> points. This is recorded in the audit log and cannot be undone automatically. Continue?', '即将把余额调整 <b>{amount}</b> 分。该操作会记入审计日志，且无法自动撤销。确认执行？'],
    'adjust.invalid': ['Please enter an amount', '请输入变动数量'],
    'adjust.done': ['Points adjusted {sign}{amount}', '积分已调整 {sign}{amount}'],

    /* ---------- 删除 ---------- */
    'deleteMember.title': ['Delete member', '删除会员'],
    'deleteMember.body': ['Delete <b>{name}</b>? Their points ledger will be removed as well. This cannot be undone.', '确认删除 <b>{name}</b>？其积分流水也会一并移除，该操作不可撤销。'],
    'deleteMember.confirm': ['Delete member', '确认删除'],
    'deleteMember.doneWithTx': ['Member deleted · {n} ledger entries removed', '会员已删除 · 同时移除 {n} 条积分流水'],

    /* ---------- 批量导入 ---------- */
    'import.title': ['Bulk import members', '批量导入会员'],
    'import.hint': ['CSV format, first row is the header. Supported columns: name, phone, type (retail/b2b), storeName (must match an existing store name), spend, points, notes.', '支持 CSV 格式。第一行为表头。可选列：name, phone, type (retail/b2b), storeName（必须与现有门店名匹配）, spend, points, notes。'],
    'import.csvContent': ['CSV content', 'CSV 内容'],
    'import.paste': ['Please paste CSV content', '请粘贴 CSV'],
    'import.missingCol': ['CSV is missing column: {col}', 'CSV 缺少列：{col}'],
    'import.done': ['Import finished: {ok} succeeded, {fail} failed', '导入完成：成功 {ok} 条，失败 {fail} 条'],
    'import.doneDetail': ['Import finished: {ok} succeeded, {fail} failed · {detail}', '导入完成：成功 {ok} 条，失败 {fail} 条 · {detail}'],

    /* ==================== 积分规则 ==================== */
    'rules.title': ['Points Rules', '积分规则配置'],
    'rules.subtitle': ['Earning · membership levels · B2B rebates · changes take effect immediately', '基础积分 · 会员等级 · B2B 阶梯返利 · 变更立即生效'],
    'rules.saveBtn': ['Save settings', '保存设置'],
    'rules.readOnly': ['Read-only', '只读模式'],
    'rules.earningCard': ['Earning rules', '基础积分规则'],
    'rules.earningSub': ['Applies to all retail customers', '适用全部零售客户'],
    'rules.spendPerPoint': ['Earning rate', '消费积分'],
    'rules.spendPerPointUnit': ['₱ = 1 point', '₱ = 1 积分'],
    'rules.expiryMonths': ['Points validity', '积分有效期'],
    'rules.expiryMonthsUnit': ['months (0 = never expires)', '个月（0 = 永不过期）'],
    'rules.welcome': ['Welcome bonus', '新会员欢迎礼'],
    'rules.welcomeUnit': ['points', '积分'],
    'rules.effect': ['Effective behaviour', '生效效果'],
    'rules.effectWelcome': ['· New members get <b>{n}</b> points on sign-up<br/>', '· 新会员建卡即得 <b>{n}</b> 积分<br/>'],
    'rules.effectEarn': ['· Every <b>₱{rate}</b> spent earns 1 point — the same rate for every level<br/>', '· 每消费 <b>₱{rate}</b> 得 1 分，所有等级费率一致<br/>'],
    'rules.effectExpiry': ['· Points expire <b>{months} months</b> after they are earned (the clock resets on every earn)', '· 积分自获得之日起 <b>{months} 个月</b>后过期（每获得一次自动顺延）'],
    'rules.redeemCard': ['Redemption rules', '兑换规则'],
    'rules.redeemSub': ['Calculated automatically at the counter', '门店收银台自动计算'],
    'rules.ratio': ['Redemption rate', '兑换比例'],
    'rules.ratioUnit': ['points : ₱', '积分 : ₱'],
    'rules.maxPercent': ['Redemption cap per order', '单笔抵扣上限'],
    'rules.maxPercentUnit': ['% (0 = no limit)', '%（0 = 无上限）'],
    'rules.minPoints': ['Minimum to redeem', '最低使用门槛'],
    'rules.minPointsUnit': ['points (0 = none)', '积分（0 = 无门槛）'],
    'rules.requireConfirm': ['Confirm changes', '变更需二次确认'],
    'rules.effectMin': ['· Members can redeem once they hold <b>{n}</b> points<br/>', '· 账户满 <b>{n}</b> 积分才可核销<br/>'],
    'rules.effectMax': ['· Up to <b>{n}%</b> of an order can be paid with points<br/>', '· 单笔订单最多用积分抵扣 <b>{n}%</b><br/>'],
    'rules.effectMaxNone': ['· <b>No cap</b> — points can cover the whole order as long as the balance allows<br/>', '· <b>不设上限</b> — 只要余额够，可以抵掉整单金额<br/>'],
    'rules.effectMinNone': ['· <b>No minimum</b> — any balance can be redeemed<br/>', '· <b>无门槛</b> — 有余额即可核销<br/>'],
    'rules.effectCounter': ['· Enter the order amount at the counter and the system works out the maximum usable points', '· 收银台录入订单金额后，系统自动算出本单最多可用多少积分'],
    'rules.expiryScan': ['Expiry scan', '到期扫描'],
    'rules.expiryNever': ['Not run yet', '尚未运行'],
    'rules.expiryLast': ['Last run {time}', '上次 {time}'],
    'rules.expiryCycle': [' · every 6 hours', ' · 每 6 小时一次'],
    'rules.expiryResult': [' · last run expired {n} members / {points} points', ' · 上次过期 {n} 人 / {points} 分'],
    'rules.expiryDryRun': ['Dry-run expiry scan (no deduction)', '试算一次到期（不扣减）'],
    'rules.expiryNone': ['No member points have expired', '当前没有会员的积分到期'],
    'rules.expiryFound': ['{n} members have expired points, {points} points in total (dry run, nothing deducted)', '已有 {n} 位会员的积分到期，共 {points} 分（本次仅试算，未扣减）'],
    'rules.levelsCard': ['Retail member levels', '零售会员等级'],
    'rules.levelsSub': ['Automatic upgrade / downgrade by total spend · levels no longer affect earning speed', '按累计消费自动升降 · 等级不再影响赚分速度'],
    'rules.thresholdUnit': ['₱ from', '₱ 起'],
    'rules.b2bCard': ['B2B tier rebates', 'B2B 阶梯返利'],
    'rules.b2bSub': ['For installers and distributors', '面向安装商与分销商'],
    'rules.b2bNotWired': ['Discount rates are recorded for reference only — they are not applied to points or checkout yet', '折扣率目前仅作登记，尚未接入积分与结算计算'],
    'rules.confirmTitle': ['Confirm rule change', '确认修改积分规则'],
    'rules.confirmBody': ['Rule changes apply to every member immediately: <b>new sign-up bonuses</b>, <b>how fast points are earned</b>, <b>redemption limits</b> and <b>point expiry</b>. Already-issued points keep their value. Continue?', '规则修改后立即对全体会员生效：<b>新人礼</b>、<b>攒分速度</b>、<b>核销上限</b>、<b>积分有效期</b>。已发放积分的价值不受影响。确认保存？'],
    'rules.effectExpiryNone': ['· Points <b>never expire</b> (validity set to 0 months)', '· 积分<b>永不过期</b>（有效期设为 0 个月）'],
    'rules.b2bThresholdUnit': ['₱ annual', '₱ 年采购'],
    'rules.rateUnit': ['rebate rate', '返利率'],
    'rules.savedMsg': ['Rules saved', '规则已保存'],

    /* ==================== 门店管理 ==================== */
    'stores.title': ['Stores', '门店管理'],
    'stores.subtitleAdmin': ['{n} stores · create stores and assign managers', '{n} 家门店 · 可创建门店与分配店长'],
    'stores.subtitleMgr': ['{n} stores · view your store', '{n} 家门店 · 查看本店信息'],
    'stores.add': ['+ New store', '＋新增门店'],
    'stores.currentManager': ['Current manager', '当前店长'],
    'stores.managerActive': ['Manager account active', '店长账号已激活'],
    'stores.unbind': ['Unbind', '解绑'],
    'stores.noManager': ['⚠️ No manager assigned', '⚠️ 未分配店长'],
    'stores.assign': ['+ Assign manager', '＋分配店长'],
    'stores.editStore': ['Edit store', '编辑门店'],
    'stores.deleteStore': ['Delete store', '删除门店'],
    'stores.deleteTitle': ['Delete store', '删除门店'],
    'stores.deleteBody': ['Delete <b>{name}</b>? A store that still has members cannot be deleted — move those members to another store first.', '确认删除 <b>{name}</b>？门店名下若还有会员则无法删除，请先把会员转到其他门店。'],
    'stores.deletedMsg': ['Store deleted', '门店已删除'],
    'stores.changeManager': ['Change manager', '更换店长'],
    'stores.addManager': ['+ Add manager', '＋添加店长'],
    'storeForm.new': ['New store', '新增门店'],
    'storeForm.edit': ['Edit store', '编辑门店'],
    'storeForm.name': ['Store name *', '门店名称 *'],
    'storeForm.code': ['Store code', '门店编号'],
    'storeForm.kingdee': ['Kingdee account set', '金蝶帐套'],
    'storeForm.manager': ['Store manager', '门店经理'],
    'storeForm.managerBound': ['Bound to a manager account — the name is managed by account assignment.', '已绑定店长账号，经理名称由账号分配维护。'],
    'storeForm.city': ['City', '城市'],
    'storeForm.address': ['Address', '地址'],
    'storeForm.phone': ['Phone', '联系电话'],
    'storeForm.createdMsg': ['Store created', '门店已创建'],
    'managerForm.title': ['Add manager · {store}', '添加店长 · {store}'],
    'managerForm.hint': ['Creates a manager login. Managers can only manage members of their own store.', '创建店长登录账号。店长登录后只能管理本店会员。'],
    'managerForm.username': ['Username *', '用户名 *'],
    'managerForm.name': ['Full name *', '真实姓名 *'],
    'managerForm.password': ['Initial password *', '初始密码 *'],
    'managerForm.passwordPh': ['At least 12 characters', '至少 12 位'],
    'managerForm.phone': ['Mobile number', '手机号'],
    'managerForm.confirm': ['Create manager account', '创建店长账号'],
    'managerForm.created': ['Manager {name} created · username {username}', '店长 {name} 已创建，账号 {username}'],
    'unbind.title': ['Unbind manager', '解绑店长'],
    'unbind.body': ['Unbind <b>{manager}</b> from <b>{store}</b>? The manager account will be <b>disabled</b> and can no longer sign in. Assigning the same username to a store again will reactivate it.', '确认解绑 <b>{manager}</b> 与 <b>{store}</b>？解绑后该店长账号会被<b>停用</b>，无法再登录；用同一个用户名重新分配门店时会自动启用。'],
    'unbind.confirm': ['Unbind', '确认解绑'],
    'unbind.done': ['Unbound', '已解绑'],

    /* ==================== 云同步 ==================== */
    'sheets.title': ['Google Sheets Cloud Sync', 'Google Sheets 云同步'],
    'sheets.subtitle': ['Pushed automatically by the server · staff do nothing, data appears in your Google Sheet', '服务器自动推送 · 门店无需任何操作，数据自动出现在你的 Google 表格'],
    'sheets.syncNow': ['Sync now', '立即同步'],
    'sheets.syncing': ['Syncing…', '同步中…'],
    'sheets.statusCard': ['Sync status', '同步状态'],
    'sheets.configCard': ['Configuration', '配置'],
    'sheets.configSubEdit': ['Save to apply — this triggers a sync', '修改后保存，会自动触发一次同步'],
    'sheets.configSubNew': ['Three steps to set up', '首次配置只需 3 步'],
    'sheets.step1': ['Open your Google Sheet and go to <b>Extensions → Apps Script</b>', '打开你的 Google Sheet，点击顶部菜单 <b>扩展程序 → Apps Script</b>'],
    'sheets.step2': ['Delete the default <span class="mono">myFunction</span>, paste the script we provide, then <b>Deploy → New deployment</b>. Choose type <b>Web app</b>, execute as <b>Me</b>, access <b>Anyone</b>, and copy the Web app URL', '删掉默认 <span class="mono">myFunction</span>，粘贴我们提供的脚本，点击 <b>部署 → 新建部署</b>，类型选 <b>Web 应用</b>，执行身份选 <b>我</b>，访问权限选 <b>任何人</b>，复制 Web 应用 URL'],
    'sheets.step3': ['Paste the Apps Script URL and Sheet ID below (the middle part of <span class="mono">/d/&lt;ID&gt;/edit</span>) and save', '下方粘贴 Apps Script URL 与 Sheet ID（地址栏 <span class="mono">/d/&lt;ID&gt;/edit</span> 中间那段），点保存'],
    'sheets.saveCfg': ['Save configuration', '保存配置'],
    'sheets.adminOnly': ['Only administrators can configure sync', '仅管理员可配置'],
    'sheets.footnote': ['Sync runs on the server (which can reach Google directly), so it works even when you open the system from mainland China.<br/>The sheet has 4 tabs — Members, Stores, Transactions, Rules — and is fully overwritten on every sync.', '同步由服务器发起（可直连 Google），因此你在国内打开本系统也能正常同步。<br/>表格分 4 个标签页：Members、Stores、Transactions、Rules，每次同步整块覆盖为最新数据。'],
    'sheets.notConfigured': ['⚠️ Not configured yet — fill in the details below and automatic sync will start working', '⚠️ 尚未完成配置，填写下方信息后自动同步即会生效'],
    'sheets.notFilled': ['Not set', '未填写'],
    'sheets.running': ['✅ Running · store changes are pushed within about a minute; a heartbeat runs every {n} minutes when nothing changes', '✅ 运行中 · 门店改动约 1 分钟内自动推送，无改动时每 {n} 分钟心跳一次'],
    'sheets.paused': ['⏸️ Automatic sync is off · data is only pushed when you click "Sync now"', '⏸️ 自动同步已关闭 · 仅在你点击「立即同步」时推送'],
    'sheets.stIdle': ['Ready', '已就绪'],
    'sheets.stSyncing': ['Syncing…', '同步中…'],
    'sheets.stPending': ['New data pending', '有新数据待推送'],
    'sheets.stFailed': ['Failed · retrying automatically', '失败 · 自动重试中'],
    'sheets.nextSync': ['Next automatic sync', '下次自动同步'],
    'sheets.inProgress': ['In progress…', '进行中…'],
    'sheets.lastSync': ['Last sync', '上次同步时间'],
    'sheets.source': ['Triggered by', '触发方式'],
    'sheets.sourceManual': ['Manual', '手动触发'],
    'sheets.sourceAuto': ['Automatic', '自动同步'],
    'sheets.content': ['Synced content', '同步内容'],
    'sheets.count': ['Total syncs', '累计同步次数'],
    'sheets.autoSync': ['Automatic sync', '自动同步'],
    'sheets.autoSyncHint': ['When on, registering members and issuing points are written to your Google Sheet automatically', '开启后门店登记会员、发放积分都会自动写入 Google 表格'],
    'sheets.interval': ['Heartbeat interval', '心跳间隔'],
    'sheets.intervalHint': ['Even with no changes, a sync is pushed at this interval', '没有数据变动时，也会按此间隔补推一次'],
    'sheets.everyNMin': ['Every {n} min', '每 {n} 分钟'],
    'sheets.gasUrl': ['Apps Script URL', 'Apps Script URL'],
    'sheets.sheetId': ['Google Sheet ID', 'Google Sheet ID'],
    'sheets.fillUrl': ['Please enter the Apps Script URL', '请填写 Apps Script URL'],
    'sheets.fillId': ['Please enter the Google Sheet ID', '请填写 Google Sheet ID'],
    'sheets.cfgSaved': ['Saved, syncing…', '已保存，正在同步…'],
    'sheets.cfgFailed': ['Could not save: {msg}', '保存失败：{msg}'],
    'sheets.autoOn': ['Automatic sync enabled', '已开启自动同步'],
    'sheets.autoOff': ['Automatic sync paused', '已暂停自动同步'],
    'sheets.intervalUpdated': ['Heartbeat interval updated', '心跳间隔已更新'],
    'sheets.settingFailed': ['Could not update: {msg}', '设置失败：{msg}'],
    'sheets.syncDone': ['Sync complete: {summary}', '同步完成：{summary}'],
    'sheets.syncFailed': ['Sync failed: {msg}', '同步失败：{msg}'],
    'sheets.chipNotConfigured': ['Cloud sync not configured', '未配置云同步'],
    'sheets.chipSyncing': ['Syncing…', '正在同步…'],
    'sheets.chipError': ['Sync error · retrying', '同步异常 · 自动重试中'],
    'sheets.chipPending': ['New data · pending', '有新数据 · 待同步'],
    'sheets.chipAuto': ['Auto · {time}', '自动同步 · {time}'],
    'sheets.chipSynced': ['Synced · {time}', '已同步 · {time}'],
    'sheets.chipReady': ['Configured · first sync pending', '已配置 · 待首次同步'],
    'sheets.gasUrlPh': ['Apps Script Web App URL (https://script.google.com/macros/s/.../exec)', 'Apps Script Web App URL（形如 https://script.google.com/macros/s/.../exec）'],

    /* ==================== 数据主库 ==================== */
    'db.title': ['Data Store', '数据主库'],
    'db.subtitle': ['Raw data files on the server · read-only, no changes to live data', '服务器上的原始数据文件 · 只读查看，不会改动线上数据'],
    'db.exportAll': ['Export full store (JSON)', '导出整库 JSON'],
    'db.searchPh': ['Search this table…', '在当前数据表内搜索…'],
    'db.perPage': ['{n} per page', '每页 {n} 条'],
    'db.exportCsv': ['Export Excel (CSV)', '导出 Excel(CSV)'],
    'db.exportJson': ['Export JSON', '导出 JSON'],
    'db.storageCard': ['Storage location', '存储位置'],
    'db.storageSub': ['These JSON files are the master copy; the Google Sheet is only a mirror', '主库就是这些 JSON 文件，Google 表格只是镜像副本'],
    'db.backupCard': ['Daily backups', '每日备份'],
    'db.backupSub': ['Data packed automatically at 3am every day, kept for 30 days. Deployment code backups (.tgz) are listed too.', '每天凌晨 3 点自动打包数据，保留 30 天；上线时的代码备份 (.tgz) 也会一并列出。'],
    'db.noBackup': ['No backup files yet', '暂无备份文件'],
    'db.dataDir': ['Data directory', '数据目录'],
    'db.currentTable': ['Current table', '当前数据表'],
    'db.recordCount': ['Records', '记录数'],
    'db.filtered': [' · {n} after filter', ' · 已筛选 {n} 条'],
    'db.fileSize': ['File size', '文件大小'],
    'db.lastWrite': ['Last written', '最后写入'],
    'db.totalSize': ['Total size', '主库合计'],
    'db.serverTime': ['Server time', '服务器时间'],
    'db.noMatch': ['No matching records', '没有匹配的记录'],
    'db.emptyTable': ['This table has no data yet', '这张表还没有数据'],
    'db.rawJson': ['View raw JSON', '查看这条记录的原始 JSON'],
    'db.rawTitle': ['Raw record · {label}', '原始记录 · {label}'],
    'db.pager': ['{total} records{filtered} · {size} per page · page {page} / {pages}', '共 {total} 条{filtered} · 每页 {size} 条 · 第 {page} / {pages} 页'],
    'db.filteredMark': [' (filtered)', '（已筛选）'],
    'db.refreshed': ['Refreshed', '已刷新'],

    /* ==================== 审计日志（P4，2026-09-22） ==================== */
    'audit.title': ['Audit Log', '审计日志'],
    'audit.subtitle': ['Read-only operation log · append-only, no edit or delete', '服务器操作日志 · 只读查看，append-only，不提供修改与删除'],
    'audit.searchPh': ['Search in log messages…', '在日志内容中搜索…'],
    'audit.summary': ['{total} entries · page {page} / {pages}', '共 {total} 条 · 第 {page} / {pages} 页'],
    'audit.readonly': ['Read-only · newest first', '只读 · 最新在前'],
    'audit.empty': ['No log entries yet', '还没有日志记录'],
    'audit.emptyFiltered': ['No entries match your search', '没有匹配的日志'],

    /* ==================== 账号管理（P5 2026-09-22 / P6 2026-09-24） ==================== */
    'accounts.title': ['Accounts', '账号管理'],
    'accounts.subtitle': ['Enable, disable or remove accounts · no create, rename or role change', '账号启用 / 停用 / 删除 · 不提供新建 / 改名 / 改角色'],
    'accounts.summary': ['{total} accounts · {active} active', '共 {total} 个账号 · {active} 个启用'],
    'accounts.scopeFull': ['This page enables, disables or removes accounts', '本页提供启用 / 停用 / 删除'],
    'accounts.scopeReadonly': ['Read-only for your role', '你的角色只能查看'],
    'accounts.empty': ['No accounts found', '没有账号'],
    'accounts.colStore': ['Store', '门店'],
    'accounts.colUser': ['Username', '用户名'],
    'accounts.colRole': ['Role', '职位'],
    'accounts.colStatus': ['Status', '状态'],
    'accounts.colActions': ['Actions', '操作'],
    'accounts.statusActive': ['Active', '启用'],
    'accounts.statusDisabled': ['Disabled', '已停用'],
    'accounts.self': ['This is you', '当前登录账号'],
    'accounts.boundHint': ['Bound to {store}', '已绑定门店：{store}'],
    'accounts.disabledAtHint': ['Disabled at {at}', '停用时间 {at}'],
    'accounts.enable': ['Enable', '启用'],
    'accounts.disable': ['Disable', '停用'],
    'accounts.delete': ['Remove', '删除'],
    'accounts.enableTitle': ['Enable this account', '启用该账号'],
    'accounts.enableBody': ['Enable {username} ({name})? The account will regain sign-in capability.', '确认启用 {username}（{name}）？启用后，该账号将恢复登录能力。'],
    'accounts.disableTitle': ['Disable this account', '停用该账号'],
    'accounts.disableBody': ['Disable {username} ({name})? The account will no longer be able to sign in.', '确认停用 {username}（{name}）？停用后该账号将无法登录。'],
    'accounts.deleteTitle': ['Remove this account', '删除该账号'],
    'accounts.deleteBody': ['Remove {username} ({name})? This cannot be undone — the account record is deleted, and past approvals / orders / transactions that reference it can no longer be traced back to this account.', '确认删除 {username}（{name}）？此操作不可撤销 —— 账号记录会被真删除，历史审核 / 兑换 / 流水里对该账号的引用将无法再追溯。'],
    'accounts.enabled': ['Account enabled', '账号已启用'],
    'accounts.disabled': ['Account disabled', '账号已停用'],
    'accounts.deleted': ['Account removed', '账号已删除'],
    'accounts.resetPw': ['Reset password', '重置密码'],
    'accounts.resetPwTitle': ['Reset password', '重置密码'],
    'accounts.resetPwBody': ['Set a temporary password for {username} ({name}). The account is signed out immediately and must change this password after signing in.', '为 {username}（{name}）设置临时密码。重置后该账号会被立即登出，下次登录后必须更改此密码。'],
    'accounts.resetPwLabel': ['New password (at least 12 characters)', '新密码（至少 12 位）'],
    'accounts.resetPwGenerate': ['Generate', '随机生成'],
    'accounts.resetPwNeed12': ['New password must be at least 12 characters', '新密码至少 12 位'],
    'accounts.resetPwDone': ['Password reset', '密码已重置'],
    'accounts.resetPwDoneBody': ['Temporary password for {username} — copy it now. They must change it after signing in:', '{username} 的临时密码 —— 请现在复制。对方登录后必须修改：'],
    'accounts.resetPwCopy': ['Copy', '复制'],
    'accounts.resetPwCopied': ['Copied', '已复制'],
    'accounts.resetPwOnce': ['Close this window and it will never be shown again. The old password no longer works.', '关闭本窗口后不再显示。旧密码已失效。'],

    /* ==================== 账号设置 ==================== */
    'account.title': ['Account', '账号设置'],
    'account.subtitle': ['Profile and security', '个人信息与安全'],
    'account.profile': ['Profile', '个人信息'],
    'account.profileSubAdmin': ['Head-office administrator account', '总部管理员账号'],
    'account.profileSubMgr': ['Store manager account', '门店店长账号'],
    'account.username': ['Username', '账号'],
    'account.name': ['Name', '姓名'],
    'account.role': ['Role', '角色'],
    'account.roleAdmin': ['Administrator', '管理员'],
    'account.roleMgr': ['Store manager', '店长'],
    'account.store': ['Store', '所属门店'],
    'account.createdAt': ['Created', '创建时间'],
    'account.pwdCard': ['Change password', '修改密码'],
    'account.pwdSub': ['We recommend changing it every 90 days', '建议每 90 天更换一次'],
    'account.currentPwd': ['Current password *', '当前密码 *'],
    'account.newPwd': ['New password *', '新密码 *'],
    'account.confirmPwd': ['Confirm new password *', '确认新密码 *'],
    'account.changePwd': ['Change password', '修改密码'],
    'account.pwdMismatch': ['The two passwords do not match', '两次输入的密码不一致'],
    'account.pwdDone': ['Password changed — it takes effect at your next sign-in', '密码已修改，下次登录生效'],

    /* ==================== 会员积分自助查询（门店顾客看的公开页 /check） ==================== */
    'check.docTitle': ['Check your points · NSS Solar', '查询我的积分 · NSS Solar'],
    'check.title': ['Check your points', '查询我的积分'],
    'check.subtitle': ['See your balance, tier and recent activity', '查看余额、会员等级与近期流水'],
    'check.phoneLabel': ['Mobile number', '手机号'],
    'check.phonePh': ['0917 123 4567', '0917 123 4567'],
    'check.nameLabel': ['Name on the account', '会员姓名'],
    'check.namePh': ['Last name or full name', '姓氏或全名'],
    'check.hint': ['Use the mobile number you gave at the store.', '请填写在门店登记时留的手机号。'],
    'check.submit': ['Check my points', '查询积分'],
    'check.submitting': ['Checking…', '查询中…'],
    'check.privacy': ['Your points are private — both your mobile number and name must match.', '为保护隐私，手机号与姓名需同时匹配才会显示。'],
    'check.footerHelp': ['Need help? Ask any NSS Solar staff.', '需要帮助？请找门店工作人员。'],
    'check.footerNote': ['Points are issued at the store where you shop.', '积分由您消费的门店发放。'],
    'check.greeting': ['Hi, {name}', '您好，{name}'],
    'check.memberSince': ['Member since {date}', '{date} 起成为会员'],
    'check.balance': ['Points balance', '积分余额'],
    'check.toNext': ['₱{amount} more to reach {tier}', '再消费 ₱{amount} 即可升为 {tier}'],
    'check.qualifies': ['Your spending has reached {tier} — ask the store staff to upgrade your tier', '消费已达 {tier} 标准，可联系门店升级等级'],
    'check.topTier': ['Top tier — thanks for being with us', '已是最高等级，感谢您的支持'],
    'check.expiring': ['Points expire in {days} days', '积分将在 {days} 天后到期'],
    'check.expiringSub': ['on {date} — use them before they are gone', '到期日 {date}，请尽快使用'],
    'check.recent': ['Recent activity', '近期流水'],
    'check.recentLast': ['Last {n}', '最近 {n} 笔'],
    'check.txEarn': ['Purchase · ₱{amount}', '消费 · ₱{amount}'],
    'check.txEarnPlain': ['Points earned', '获得积分'],
    'check.txRedeem': ['Redeemed ₱{amount} discount', '积分抵现 ₱{amount}'],
    'check.txWelcome': ['Welcome bonus', '新人礼'],
    'check.txAdjust': ['Adjustment by staff', '门店调整'],
    'check.txExpire': ['Points expired', '积分到期扣减'],
    'check.rate': ['Earn 1 point per ₱{n}  ·  {p} points = ₱1', '每 ₱{n} 得 1 分  ·  {p} 积分抵 ₱1'],
    'check.noTx': ['No activity yet — make your first purchase to start earning.', '还没有流水，消费后即可开始攒分。'],
    'check.frozen': ['This account is frozen — please talk to the store staff.', '该会员账户已冻结，请联系门店工作人员。'],
    'check.askStaff': ['Something looks wrong? Ask the store staff.', '数据有疑问？请联系门店工作人员。'],
    'check.another': ['Check another member', '查询其他会员'],
    'check.errPhone': ['Please enter a valid mobile number (at least 7 digits).', '请输入有效的手机号（至少 7 位数字）。'],
    'check.errName': ['Please enter at least 2 characters of your name.', '请至少输入姓名中的 2 个字符。'],
  };

  /* --------------------------------------------------------------------------
   * 服务器消息翻译（后端目前返回中文，统在此处按当前语言处理）
   * ------------------------------------------------------------------------ */
  const ZH2EN = {
    '请输入账号和密码': 'Please enter your username and password.',
    '账号或密码错误': 'Incorrect username or password.',
    '未登录': 'Not signed in.',
    // —— 积分审核 / 积分商城（2026-09-19）——
    '仅管理员可审核': 'Only administrators can approve requests.',
    '仅管理员可维护商品': 'Only administrators can manage products.',
    '仅管理员可上传商品图片': 'Only administrators can upload product images.',
    '请填写驳回原因': 'Please enter a rejection reason.',
    '该申请已处理，无法重复操作': 'This request has already been processed.',
    '申请不存在': 'Request not found.',
    '该申请关联的会员已不存在，无法发放': 'The member on this request no longer exists.',
    '该会员已冻结，无法发放积分': 'This member is frozen; points cannot be granted.',
    '该会员已冻结，无法兑换': 'This member is frozen and cannot redeem.',
    '该商品已下架': 'This product is no longer available.',
    '商品不存在': 'Product not found.',
    '商品不存在或已下架': 'Product not found or no longer available.',
    '兑换单不存在': 'Redemption order not found.',
    '该兑换单已发放': 'This order has already been issued.',
    '该兑换单已取消': 'This order has been cancelled.',
    '无权处理其他门店的兑换单': 'You cannot handle orders from other stores.',
    '该兑换单关联的会员已不存在，无法退分': 'The member on this order no longer exists.',
    '请选择会员与商品': 'Please choose a member and a product.',
    '请填写正确的所需积分': 'Please enter a valid point value.',
    '所需积分必须是整数': 'Point value must be a whole number.',
    '所需积分过大，请核对': 'Point value is too large.',
    '请填写商品名称': 'Please enter a product name.',
    '请输入正确的积分数量': 'Please enter a valid point amount.',
    '积分数量必须是整数': 'Point amount must be a whole number.',
    '单次补录积分过大，请核对': 'That point amount is too large.',
    '消费金额过大，请核对': 'That amount is too large.',
    '图片格式不支持（仅 PNG / JPG / WEBP）': 'Unsupported image format (PNG / JPG / WEBP only).',
    '图片过大（上限 3MB）': 'Image is too large (max 3MB).',
    '图片内容为空': 'Image is empty.',
    '文件名非法': 'Invalid file name.',
    '图片不存在': 'Image not found.',
    '请填写当前密码和新密码': 'Please enter your current and new password.',
    '新密码至少 6 位': 'The new password must be at least 6 characters.',
    '新密码至少 12 位': 'The new password must be at least 12 characters.',
    '当前密码不正确': 'The current password is incorrect.',
    '请填写姓名和手机号': 'Please enter a name and mobile number.',
    '会员不存在': 'Member not found.',
    '无权操作其他门店会员': 'You cannot operate on members of another store.',
    '仅管理员可手动调整积分': 'Only administrators can adjust points manually.',
    '仅管理员可删除': 'Only administrators can delete.',
    '请输入正确的消费金额': 'Please enter a valid purchase amount.',
    '请输入正确的手机号': 'Please enter a valid mobile number.',
    '手机号或姓名不匹配': 'Mobile number and name do not match. Please check and try again.',
    '查询过于频繁，请稍后再试': 'Too many lookups from this network. Please try again in a few minutes.',
    '该会员已冻结，无法登记消费': 'This member is frozen — purchases cannot be recorded.',
    '交易类型无效': 'Invalid transaction type.',
    '请填写正确的积分变动数量': 'Please enter a valid points change.',
    '积分余额不足': 'Insufficient points balance.',
    '仅管理员可创建门店': 'Only administrators can create stores.',
    '请填写门店名称': 'Please enter a store name.',
    '仅管理员可修改门店': 'Only administrators can edit stores.',
    '门店不存在': 'Store not found.',
    '仅管理员可分配店长': 'Only administrators can assign managers.',
    '请填写用户名、姓名、初始密码': 'Please fill in username, name and initial password.',
    '初始密码至少 6 位': 'The initial password must be at least 6 characters.',
    '初始密码至少 12 位': 'The initial password must be at least 12 characters.',
    '请填写姓名，并设置至少 12 位的初始密码': 'Enter a name and an initial password of at least 12 characters.',
    '用户名已存在': 'That username already exists.',
    '仅管理员可解绑': 'Only administrators can unbind.',
    '该店长未绑定此门店': 'That manager is not bound to this store.',
    '仅管理员可操作': 'Only administrators can do this.',
    '仅管理员可修改规则': 'Only administrators can edit the rules.',
    '仅管理员可配置同步': 'Only administrators can configure sync.',
    '仅管理员可执行同步': 'Only administrators can run a sync.',
    '仅管理员可访问数据主库': 'Only administrators can access the data store.',
    '仅管理员可查看同步状态': 'Only administrators can view sync status.',
    '未知数据表': 'Unknown table.',
    '整库导出请选择 JSON，单个数据表才支持 CSV': 'Export the whole store as JSON; CSV is only available per table.',
    '非法文件名': 'Invalid file name.',
    '备份文件不存在': 'Backup file not found.',
    '仅管理员可查看': 'Only administrators can view this.',
    '同步正在进行中，请稍候': 'A sync is already running, please wait.',
    '尚未填写 Apps Script URL': 'Apps Script URL is not set yet.',
    '尚未填写 Google Sheet ID': 'Google Sheet ID is not set yet.',
    '未知错误': 'Unknown error.',
    // 2026-09-18 审计修复引入的校验与兜底消息
    '无权查看其他门店的会员': 'You cannot view members of another store.',
    '仅管理员可查看账号列表': 'Only administrators can list accounts.',
    '该账号已停用，请联系总部管理员': 'This account is disabled. Please contact the HQ administrator.',
    '当前账号未绑定门店，无法登记会员，请联系总部管理员': 'This account is not bound to a store, so members cannot be registered. Please contact the HQ administrator.',
    '所选门店不存在，请重新选择': 'The selected store does not exist. Please choose again.',
    '系统中还没有门店，请先创建门店': 'There are no stores yet. Please create a store first.',
    '会员类型无效': 'Invalid member type.',
    '门店名称不能为空': 'Store name cannot be empty.',
    '接口不存在': 'Endpoint not found.',
    '请求内容格式不正确或过大': 'The request body is malformed or too large.',
    '服务器内部错误，请稍后重试或联系管理员': 'Internal server error. Please try again later or contact the administrator.',
    '请求有误': 'Bad request.',
    '兑换比例格式应为「积分:金额」，例如 10:1，且两侧都要大于 0': 'The redemption rate must look like "points:amount" (e.g. 10:1) with both sides greater than 0.',
    'Apps Script 返回错误': 'Apps Script returned an error.',
    // 数据主库标签
    '会员': 'Members', '门店': 'Stores', '积分流水': 'Transactions', '积分规则': 'Rules',
    '账号': 'Accounts', '同步配置': 'Sync config', '操作审计日志': 'Audit log',
    '零售 + B2B 会员档案': 'Retail + B2B member profiles',
    '门店档案与店长绑定': 'Stores and manager binding',
    '积分发放 / 核销记录': 'Points issued / redeemed',
    '规则、等级、B2B 阶梯（单条）': 'Rules, levels, B2B tiers (single record)',
    '登录账号（密码已打码）': 'Login accounts (passwords masked)',
    'Google Sheets 同步状态': 'Google Sheets sync status',
    '服务器操作日志（倒序）': 'Server operation log (newest first)',
    '姓名': 'Name', '手机号': 'Mobile', '类型': 'Type', '等级': 'Level', '积分余额': 'Points',
    '累计消费(₱)': 'Total spend (₱)', '门店ID': 'Store ID', '所属门店': 'Store', '状态': 'Status',
    '备注': 'Notes', '积分到期': 'Points expiry', '最近获得积分': 'Last earned', '最近消费': 'Last purchase',
    '累计获得': 'Total earned', '累计核销': 'Total redeemed', '门店名': 'Store name', '城市': 'City',
    '地址': 'Address', '电话': 'Phone', '店长ID': 'Manager ID', '店长姓名': 'Manager name',
    '会员ID': 'Member ID', '会员姓名': 'Member name', '积分变动': 'Points change', '原因': 'Reason',
    '操作人ID': 'Operator ID', '操作人': 'Operator', '消费金额(₱)': 'Purchase amount (₱)',
    '计分基数': 'Base points', '变动后余额': 'Balance after',
    '密码': 'Password', '角色': 'Role', '绑定门店ID': 'Bound store ID',
    '每多少₱积1分': '₱ per 1 point', '有效期(月)': 'Validity (months)', '欢迎积分': 'Welcome bonus',
    '兑换比例': 'Redemption rate', '抵扣上限(%)': 'Redemption cap (%)', '最低使用门槛': 'Minimum to redeem',
    '二次确认': 'Confirm changes', '实时推送': 'Realtime push', '等级配置': 'Levels', 'B2B阶梯': 'B2B tiers',
    '启用': 'Enabled', '自动同步': 'Auto sync', '心跳间隔(分钟)': 'Heartbeat (min)',
    '上次同步时间': 'Last sync', '上次结果': 'Last result', '触发方式': 'Trigger', '同步内容': 'Content',
    '耗时(ms)': 'Duration (ms)', '上次失败时间': 'Last failure', '错误信息': 'Error',
    '累计同步次数': 'Sync count', '最后动作': 'Last action', '动作结果': 'Action result', '密钥': 'Secret',
    '行号': 'Line', '日志内容': 'Log', '创建时间': 'Created', '更新时间': 'Updated', '服务器时间': 'Server time',
    '单笔抵扣上限(%)': 'Redemption cap (%)',
  };

  // 带变量的服务器消息
  // 服务端校验消息里的中文字段名 → 英文（仅用于拼装消息，不是界面标签）
  const ZH2EN_FIELD = {
    '每多少₱积1分': 'Points per ₱N spent',
    '积分有效期(月)': 'Points validity (months)',
    '欢迎积分': 'Welcome bonus',
    '单笔抵扣上限(%)': 'Redemption cap (%)',
    '最低使用门槛': 'Minimum to redeem',
    '等级': 'Level',
    'B2B 阶梯': 'B2B tier',
  };

  const ZH2EN_PATTERNS = [
    [/^积分不足（当前 (\d+) 分，需要 (\d+) 分）$/, m => `Not enough points (have ${Number(m[1]).toLocaleString()}, need ${Number(m[2]).toLocaleString()}).`],
    [/^商品名称过长（最多 (\d+) 字）$/, m => `Product name is too long (max ${m[1]} characters).`],
    [/^商品描述过长（最多 (\d+) 字）$/, m => `Description is too long (max ${m[1]} characters).`],
    [/^备注过长（最多 (\d+) 字）$/, m => `Note is too long (max ${m[1]} characters).`],
    [/^该手机号已登记过（(.+)），请勿重复建档$/, m => `This mobile number is already registered (${m[1]}).`],
    [/^(.+)必须是数字$/, m => `${ZH2EN_FIELD[m[1]] || m[1]} must be a number.`],
    [/^(.+)必须在 (\d+) ~ (\d+) 之间$/, m => `${ZH2EN_FIELD[m[1]] || m[1]} must be between ${m[2]} and ${m[3]}.`],
    [/^(等级|B2B 阶梯)配置格式不正确$/, m => `${ZH2EN_FIELD[m[1]] || m[1]} configuration format is invalid.`],
    [/^(等级|B2B 阶梯)存在重复或空的标识$/, m => `${ZH2EN_FIELD[m[1]] || m[1]} contains a duplicate or empty key.`],
    [/^(等级|B2B 阶梯)的名称不能为空$/, m => `${ZH2EN_FIELD[m[1]] || m[1]} name cannot be empty.`],
    [/^(等级|B2B 阶梯)的门槛必须是非负数字$/, m => `${ZH2EN_FIELD[m[1]] || m[1]} threshold must be a non-negative number.`],
    [/^(等级|B2B 阶梯)的颜色需为 6 位十六进制色值（例如 #027637）$/, m => `${ZH2EN_FIELD[m[1]] || m[1]} colour must be a 6-digit hex value (e.g. #027637).`],
    [/^登录失败次数过多，请 (\d+) 分钟后再试$/, m => `Too many failed sign-in attempts. Please try again in ${m[1]} minute(s).`],
    [/^已存在名为「(.+)」的门店，请换一个名称$/, m => `A store named "${m[1]}" already exists. Please use a different name.`],
    [/^该门店名下还有 (\d+) 位会员，请先用「编辑会员」把他们转到其他门店，再删除$/, m => `This store still has ${m[1]} member(s). Move them to another store before deleting it.`],
    [/^已开启 · 心跳 (\d+) 分钟$/, m => `On · heartbeat every ${m[1]} min`],
    [/^未开启（或未配置）$/, () => 'Off (or not configured)'],
    [/^(\d+) 会员 \/ (\d+) 门店 \/ (\d+) 流水$/, m => `${m[1]} members / ${m[2]} stores / ${m[3]} transactions`],
    [/^返回内容不是 JSON：/, () => 'Response was not JSON: '],
  ];

  // 英文（积分引擎）→ 中文
  const EN2ZH_PATTERNS = [
    [/^Points must be greater than 0\.$/, () => '使用的积分必须大于 0'],
    [/^At least (\d+) points are required before redeeming\. Current balance: (\d+)\.$/, m => `至少需要 ${m[1]} 积分才能核销，当前余额 ${m[2]}`],
    [/^Insufficient points balance\.$/, () => '积分余额不足'],
    [/^This order is ₱([\d.,]+); up to ([\d.]+)% \(₱([\d.,]+)\) can be paid with points, i\.e\. max (\d+) points\.$/, m => `本单 ₱${m[1]}，最多可用积分抵扣 ${m[2]}%（₱${m[3]}），即最多 ${m[4]} 分`],
    [/^This order is ₱([\d.,]+); points alone cannot cover the full amount — max (\d+) points \(₱([\d.,]+)\)\.$/, m => `本单 ₱${m[1]}，积分最多抵扣 ${m[2]} 分（₱${m[3]}），不能全额抵扣`],
    [/^Maximum redeemable this time is (\d+) points\.$/, m => `本次最多可核销 ${m[1]} 积分`],
  ];

  /* --------------------------------------------------------------------------
   * 状态与工具
   * ------------------------------------------------------------------------ */
  let LANG = FALLBACK;
  try {
    const saved = global.localStorage && global.localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') LANG = saved;
  } catch (e) { /* ignore */ }

  const listeners = [];

  function getLang() { return LANG; }

  function setLang(next, opts) {
    const l = next === 'zh' ? 'zh' : 'en';
    const changed = l !== LANG;
    LANG = l;
    try { global.localStorage && global.localStorage.setItem(STORAGE_KEY, LANG); } catch (e) { /* ignore */ }
    if (global.document) global.document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';
    applyStatic();
    if (changed && !(opts && opts.silent)) listeners.forEach(fn => { try { fn(LANG); } catch (e) { /* ignore */ } });
    return LANG;
  }

  function toggleLang() { return setLang(LANG === 'zh' ? 'en' : 'zh'); }

  function t(key, vars) {
    const row = M[key];
    let s = row ? (LANG === 'zh' ? row[1] : row[0]) : key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m0, k) => (vars[k] === undefined || vars[k] === null ? m0 : String(vars[k])));
    return s;
  }

  /* ==========================================================================
   * 门店名双语显示 / Bilingual store-name display
   * 门店名是业务数据（存在 data/stores.json 的 name 字段），本身不分语言。
   * 这里按「已知门店名 → [英文, 中文]」做显示层翻译；未收录的自定义门店名原样返回。
   * ========================================================================== */
  const STORE_NAME_MAP = {
    '马尼拉旗舰店': ['Manila Flagship Store', '马尼拉旗舰店'],
    '奎松城分店': ['Quezon City Branch', '奎松城分店'],
    '宿务分店': ['Cebu Branch', '宿务分店'],
    '达沃分店': ['Davao Branch', '达沃分店'],
    // 双语的旧写法（若数据里已是英文则原样保留）
    'Manila Flagship Store': ['Manila Flagship Store', '马尼拉旗舰店'],
    'Quezon City Branch': ['Quezon City Branch', '奎松城分店'],
    'Cebu Branch': ['Cebu Branch', '宿务分店'],
    'Davao Branch': ['Davao Branch', '达沃分店'],
  };

  /** 把门店名翻到当前语言；未收录的名字原样返回 */
  function tStore(name) {
    if (!name) return name;
    const e = STORE_NAME_MAP[String(name).trim()];
    if (!e) return name;
    return LANG === 'zh' ? e[1] : e[0];
  }

  /* ==========================================================================
   * 人员/角色显示名双语 / Bilingual person-name display
   * 覆盖种子账号与常见占位值；真实人名（如菲律宾店长）原样返回，不需要翻译。
   * ========================================================================== */
  const PERSON_NAME_MAP = {
    '总部管理员': ['HQ Administrator', '总部管理员'],
    '门店店长': ['Store Manager', '门店店长'],
    '待分配': ['Unassigned', '待分配'],
  };

  /** 把人员显示名翻到当前语言；未收录的人名原样返回 */
  function tName(name) {
    if (!name) return name;
    const e = PERSON_NAME_MAP[String(name).trim()];
    if (!e) return name;
    return LANG === 'zh' ? e[1] : e[0];
  }

  /** 把服务器返回的消息翻到当前语言 */
  function tMsg(msg) {
    if (!msg) return msg;
    let s = String(msg);
    // 消息里若嵌了已知门店名 / 占位人名，一并按当前语言替换
    Object.keys(STORE_NAME_MAP).concat(Object.keys(PERSON_NAME_MAP)).forEach(k => {
      const row = STORE_NAME_MAP[k] || PERSON_NAME_MAP[k];
      const v = row[LANG === 'zh' ? 1 : 0];
      if (s.indexOf(k) !== -1 && v !== k) s = s.split(k).join(v);
    });
    if (LANG === 'en') {
      if (ZH2EN[s]) return ZH2EN[s];
      for (const [re, fn] of ZH2EN_PATTERNS) { const m = s.match(re); if (m) return fn(m); }
      return s;
    }
    for (const [re, fn] of EN2ZH_PATTERNS) { const m = s.match(re); if (m) return fn(m); }
    return s;
  }

  function locale() { return LANG === 'zh' ? 'zh-CN' : 'en-PH'; }

  /** 翻译 index.html 里带 data-i18n / data-i18n-ph / data-i18n-title 的静态节点 */
  function applyStatic(root) {
    const scope = root || global.document;
    if (!scope || !scope.querySelectorAll) return;
    scope.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
    scope.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
    scope.querySelectorAll('[data-i18n-ph]').forEach(el => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
    scope.querySelectorAll('[data-i18n-title]').forEach(el => { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
    scope.querySelectorAll('[data-lang-label]').forEach(el => { el.textContent = t('common.langSwitch'); });
  }

  function onChange(fn) { listeners.push(fn); }
  function on(fn) { return onChange(fn); }

  const API = { t, tMsg, tStore, tName, locale, getLang, setLang, toggleLang, applyStatic, onChange, on, dict: M, STORAGE_KEY };
  global.I18N = API;
  global.tStore = tStore;
  global.tName = tName;

  if (global.document) {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', () => applyStatic());
    } else {
      applyStatic();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
