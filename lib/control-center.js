// NSS Solar V2 domain helpers. Deliberately independent from member/points data.
const WORKFLOW_TYPES = {
  stocktake: { label: '库存盘点申请审批', required: ['warehouseName', 'countDate', 'reason'], money: null },
  store_remediation: { label: '门店整改', required: ['storeName', 'issue', 'dueDate'], money: null },
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
    if (value == null || String(value).trim() === '') return { ok: false, error: `请填写${field}` };
  }
  form.warehouseName = cleanText(form.warehouseName, 180);
  form.storeName = cleanText(form.storeName, 180);
  if (type === 'stocktake') {
    form.batchNumber = cleanText(form.batchNumber, 80);
    form.countArea = cleanText(form.countArea, 180);
    form.counterName = cleanText(form.counterName, 120);
    if (!Array.isArray(form.items)) form.items = [];
    if ((!form.items.length && !options.allowEmptyStocktakeItems) || form.items.length > 2000) return { ok: false, error: '盘点审批资料须有 1 至 2,000 行，或上传 Excel 原文件' };
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
  const dateField = type === 'stocktake' ? 'countDate' : 'dueDate';
  const dateValue = String(form[dateField] || '');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateValue) ? new Date(`${dateValue}T00:00:00.000Z`) : null;
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== dateValue) return { ok: false, error: '日期格式无效' };
  for (const key of Object.keys(form)) {
    if (typeof form[key] === 'string') form[key] = cleanText(form[key], key === 'reason' || key === 'issue' ? 2000 : 500);
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
    if (instance.status !== 'pending_approval' && instance.status !== 'approved') return { ok: false, error: '该申请当前不可撤回' };
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
  if (action === 'cancel') instance.status = 'cancelled';
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
