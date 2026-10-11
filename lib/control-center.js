// NSS Solar V2 domain helpers. Deliberately independent from member/points data.
const WORKFLOW_TYPES = {
  stocktake: { label: '库存盘点', required: ['storeId'], storeRequired: true, photosRequired: true, money: null },
  store_remediation: { label: '门店整改', required: ['storeId', 'issue'], storeRequired: true, money: null },
  store_receipt: { label: '门店收货确认', required: ['storeId', 'receiptDate', 'receiptNormal', 'confirmedBy'], storeRequired: true, money: null },
  discount_request: { label: '订单优惠申请', required: ['orderNumber', 'originalAmount', 'discountAmount', 'finalAmount'], photosRequired: true, money: 'discountAmount' },
  expense_reimbursement: { label: '费用报销', required: ['storeId', 'expenseCategory'], storeRequired: true, photosRequired: true, money: null },
};

const WORKFLOW_STATES = ['draft', 'pending_approval', 'approved', 'rejected', 'returned', 'execution_pending', 'awaiting_review', 'completed', 'cancelled'];

function cleanText(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function validateWorkflow(type, raw, options = {}) {
  const spec = WORKFLOW_TYPES[type];
  if (!spec) return { ok: false, error: '不支持的流程类型' };
  const form = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  for (const field of spec.required) {
    const value = form[field];
    const label = { storeId: '门店名称', issue: '整改事项', receiptDate: '收货日期', receiptNormal: '是否正常收货', confirmedBy: '确认人', orderNumber: '订单编号', originalAmount: '订单原金额', discountAmount: '优惠金额', finalAmount: '订单优惠后总金额', expenseCategory: '费用类型' }[field] || field;
    if (value == null || String(value).trim() === '') return { ok: false, error: `请填写${label}` };
  }
  form.warehouseName = cleanText(form.warehouseName, 180);
  form.storeName = cleanText(form.storeName, 180);
  if (type === 'stocktake') {
    form.batchNumber = cleanText(form.batchNumber, 80);
    form.countArea = cleanText(form.countArea, 180);
    form.counterName = cleanText(form.counterName, 120);
    if (!Array.isArray(form.items)) form.items = [];
    if (form.items.length > 2000) return { ok: false, error: '盘点明细最多 2,000 行' };
    const seen = new Set(), normalizedItems = [];
    for (let index = 0; index < form.items.length; index += 1) {
      const row = form.items[index];
      if (!row || typeof row !== 'object' || Array.isArray(row)) return { ok: false, error: `第 ${index + 1} 行格式无效` };
      const itemCode = cleanText(row.itemCode, 80);
      if (!itemCode) return { ok: false, error: `第 ${index + 1} 行缺少商品编码` };
      const location = cleanText(row.location, 80);
      const uniqueKey = `${itemCode.toLowerCase()}\u0000${location.toLowerCase()}`;
      if (seen.has(uniqueKey)) return { ok: false, error: `商品编码和库位重复：${itemCode}${location ? ` / ${location}` : ''}` };
      seen.add(uniqueKey);
      const countedQuantity = Number(row.countedQuantity);
      if (row.countedQuantity == null || String(row.countedQuantity).trim() === '' || !Number.isFinite(countedQuantity) || countedQuantity < 0 || countedQuantity > 1000000000) return { ok: false, error: `第 ${index + 1} 行实盘数量无效` };
      let systemQuantity = null;
      if (row.systemQuantity != null && String(row.systemQuantity).trim() !== '') {
        systemQuantity = Number(row.systemQuantity);
        if (!Number.isFinite(systemQuantity) || systemQuantity < 0 || systemQuantity > 1000000000) return { ok: false, error: `第 ${index + 1} 行账面数量无效` };
      }
      let recountedQuantity = null;
      if (row.recountedQuantity != null && String(row.recountedQuantity).trim() !== '') {
        recountedQuantity = Number(row.recountedQuantity);
        if (!Number.isFinite(recountedQuantity) || recountedQuantity < 0 || recountedQuantity > 1000000000) return { ok: false, error: `第 ${index + 1} 行复盘数量无效` };
      }
      const finalQuantity = recountedQuantity == null ? countedQuantity : recountedQuantity;
      const differenceQuantity = systemQuantity == null ? null : Math.round((finalQuantity - systemQuantity) * 1000000) / 1000000;
      const varianceReason = cleanText(row.varianceReason, 500);
      if (differenceQuantity != null && differenceQuantity !== 0 && !varianceReason) return { ok: false, error: `第 ${index + 1} 行存在数量差异，请填写差异原因` };
      normalizedItems.push({ itemCode, itemName: cleanText(row.itemName, 180), location, systemQuantity, countedQuantity, recountedQuantity, finalQuantity, differenceQuantity, varianceReason, remark: cleanText(row.remark, 500) });
    }
    form.items = normalizedItems;
    form.sourceFileName = cleanText(form.sourceFileName, 180);
  }
  const dateField = type === 'stocktake' ? 'countDate' : type === 'store_remediation' ? 'dueDate' : type === 'store_receipt' ? 'receiptDate' : type === 'expense_reimbursement' ? 'expenseDate' : null;
  if (dateField && (form[dateField] || type === 'store_receipt')) {
    const dateValue = String(form[dateField] || '');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(dateValue) ? new Date(`${dateValue}T00:00:00.000Z`) : null;
    if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== dateValue) return { ok: false, error: '日期格式无效' };
  }
  if (spec.money) {
    const amount = Number(form[spec.money]);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000000) return { ok: false, error: '金额必须大于 0' };
    form[spec.money] = Math.round(amount * 100) / 100;
  }
  if (type === 'store_receipt') {
    if (!['yes', 'no'].includes(form.receiptNormal)) return { ok: false, error: '请选择是否正常收货' };
    if (form.receiptNormal === 'no' && !cleanText(form.exceptionReason, 2000)) return { ok: false, error: '异常收货必须填写异常原因' };
    if (form.receiptNormal === 'yes') form.exceptionReason = '';
  }
  if (type === 'discount_request') {
    const cents = value => /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(String(value)) ? Math.round(Number(value) * 100) : NaN;
    const original = cents(form.originalAmount), discount = cents(raw.discountAmount), final = cents(form.finalAmount);
    if (![original, discount, final].every(Number.isSafeInteger) || original <= 0 || original > 100000000000 || discount <= 0 || discount > original || final < 0 || original - discount !== final) return { ok: false, error: '请核对金额：优惠后总金额必须等于原金额减去优惠金额，最多两位小数' };
    form.originalAmount = original / 100; form.discountAmount = discount / 100; form.finalAmount = final / 100;
  }
  if (type === 'expense_reimbursement' && !['office_supplies', 'maintenance', 'transport', 'accommodation'].includes(form.expenseCategory)) return { ok: false, error: '请选择有效费用类型' };
  for (const key of Object.keys(form)) {
    if (typeof form[key] === 'string') form[key] = cleanText(form[key], ['reason','issue','exceptionReason'].includes(key) ? 2000 : 500);
  }
  return { ok: true, value: form };
}

function canTransition(instance, action, payload = {}) {
  if (!instance) return { ok: false, error: '申请不存在' };
  if (action === 'approve' || action === 'reject' || action === 'return') {
    if (instance.status !== 'pending_approval') return { ok: false, error: '该申请当前不在审批状态' };
    return { ok: true };
  }
  if (action === 'execution') {
    if (instance.status !== 'approved' && instance.status !== 'execution_pending') return { ok: false, error: '只有已批准的申请可以登记执行' };
    return { ok: true };
  }
  if (action === 'review_pass' || action === 'review_return') {
    if (instance.type !== 'store_remediation' || instance.status !== 'awaiting_review') return { ok: false, error: '该整改当前不在复查状态' };
    if (instance.createdBy === payload.actorId || instance.assigneeId === payload.actorId) return { ok: false, error: '申请人和整改负责人不能复查自己的整改' };
    return { ok: true };
  }
  if (action === 'cancel') {
    // 2026-10-08 审计 H-4：撤回只允许在审批通过前（草稿 / 待审批）。
    // 已批准（approved）及之后的执行中 / 待复查 / 已完成一律不可撤回，
    // 否则「已批准事项凭空消失」，执行侧失去任务来源且残留脏字段。
    if (instance.status !== 'draft' && instance.status !== 'pending_approval') return { ok: false, error: '当前状态不可撤回，已批准的事项如需终止请联系管理员关闭' };
    return { ok: true };
  }
  if (action === 'resubmit') {
    if (instance.status !== 'returned' || instance.createdBy !== payload.actorId) return { ok: false, error: '只有被退回的申请人可以重新提交' };
    return { ok: true };
  }
  return { ok: false, error: '不支持的操作' };
}

function applyTransition(instance, action, payload = {}) {
  const allowed = canTransition(instance, action, payload);
  if (!allowed.ok) return allowed;
  const note = cleanText(payload.note, 1000);
  if (action === 'approve') instance.status = 'approved';
  if (action === 'reject') {
    if (!note) return { ok: false, error: '驳回时请填写原因' };
    instance.status = 'rejected';
  }
  if (action === 'return') {
    if (!note) return { ok: false, error: '退回时请填写修改意见' };
    instance.status = 'returned';
  }
  if (action === 'cancel') {
    instance.status = 'cancelled';
    // 撤回时统一清空执行侧字段，避免残留脏状态被报表/提醒读到（审计 H-4）
    instance.assigneeId = null;
    instance.assigneeName = null;
    instance.executionStatus = null;
    instance.executedBy = null;
    instance.executedAt = null;
    instance.externalDocumentNumber = null;
    instance.executionRound = 1;
  }
  if (action === 'resubmit') instance.status = 'pending_approval';
  if (action === 'execution') {
    const externalNumber = cleanText(payload.externalDocumentNumber, 120);
    const executionStatus = cleanText(payload.executionStatus, 80);
    if (!['completed', 'in_progress'].includes(executionStatus)) return { ok: false, error: '执行状态只能是 completed 或 in_progress' };
    if (instance.type !== 'store_remediation' && !externalNumber) return { ok: false, error: '请填写外部单据编号' };
    if (!executionStatus) return { ok: false, error: '请选择执行状态' };
    instance.externalDocumentNumber = externalNumber || null;
    instance.executionStatus = executionStatus;
    instance.executedBy = payload.actorId || null;
    instance.executedAt = new Date().toISOString();
    instance.status = executionStatus === 'completed' && instance.type === 'store_remediation' ? 'awaiting_review' : executionStatus === 'completed' ? 'completed' : 'execution_pending';
  }
  if (action === 'review_pass') instance.status = 'completed';
  if (action === 'review_return') {
    if (!note) return { ok: false, error: '退回整改时请填写复查意见' };
    instance.status = 'execution_pending';
    instance.executionStatus = 'in_progress';
  }
  return { ok: true, value: instance, note };
}

module.exports = { WORKFLOW_TYPES, WORKFLOW_STATES, validateWorkflow, canTransition, applyTransition, cleanText };
