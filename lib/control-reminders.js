'use strict';

const { nanoid } = require('nanoid');
const store = require('./store');
const rbac = require('./rbac');

function scanOverdue() {
  const now = new Date();
  const notifications = store.readCollection('notifications') || [];
  const append = (item, kind, recipientIds, description, deadline = item.dueAt, reminderField = 'overdueReminderAt') => {
    const due = deadline ? new Date(deadline) : null;
    if (!due || !Number.isFinite(due.getTime()) || due > now || item[reminderField]) return false;
    const uniqueIds = [...new Set(recipientIds.filter(Boolean))];
    if (!uniqueIds.length) return false;
    for (const userId of uniqueIds) notifications.unshift({
      id: nanoid(), userId, type: `${kind}.overdue`, title: description,
      body: item.title, resourceType: kind, resourceId: item.id, readAt: null, createdAt: now.toISOString(),
    });
    item[reminderField] = now.toISOString();
    return true;
  };

  const tasks = store.readCollection('tasks') || [];
  let tasksChanged = false;
  const dayParts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(part => [part.type, part.value]));
  const todayInManila = `${dayParts.year}-${dayParts.month}-${dayParts.day}`;
  for (const task of tasks) {
    if (task.kind !== 'daily_deposit' || !task.depositDate || task.depositDate >= todayInManila || !['open','in_progress'].includes(task.status)) continue;
    task.status = 'cancelled'; task.updatedAt = now.toISOString(); tasksChanged = true;
    if (task.createdBy) notifications.unshift({ id: nanoid(), userId: task.createdBy, type: 'daily_deposit.missed', title: '门店未上报当日存款', body: `${task.title} · ${task.depositDate}`, resourceType: 'task', resourceId: task.id, readAt: null, createdAt: now.toISOString() });
  }
  for (const task of tasks) {
    if (!['completed', 'cancelled'].includes(task.status)) {
      tasksChanged = append(task, 'task', [task.assigneeId, task.createdBy], '任务已逾期') || tasksChanged;
    }
  }
  if (tasksChanged) store.writeCollection('tasks', tasks);

  const issues = store.readCollection('storeIssues') || [];
  let issuesChanged = false;
  for (const issue of issues) {
    if (issue.status !== 'closed') {
      issuesChanged = append(issue, 'storeIssue', [issue.ownerId, issue.createdBy], '门店整改已逾期') || issuesChanged;
    }
  }
  if (issuesChanged) store.writeCollection('storeIssues', issues);

  const workflows = store.readCollection('workflowInstances') || [];
  const users = store.readCollection('users') || [];
  let workflowsChanged = false;
  // 2026-10-08 审计 C-1：不再硬编码 country:'PH' 放行。写入侧已为 workflow 补
  // country（见 seed.js migrate / server.js 创建路由），此处直接用真实值做审批人资格判定。
  for (const workflow of workflows) {
    if (workflow.status === 'pending_approval' && workflow.approvalDueAt) {
      const step = (workflow.approvalSteps || [])[workflow.currentStep] || {}, ids = new Set();
      const signedSlots = new Set((workflow.stepApprovals || []).filter(x => x.step === workflow.currentStep).map(x => x.approverKey));
      const scopeResource = { ...workflow, country: workflow.country || 'PH' };
      for (const approver of step.approvers || []) {
        const approverKey = `${approver.kind}:${approver.id}`;
        if (signedSlots.has(approverKey)) continue;
        if (approver.kind === 'user') {
          const delegation = (workflow.approvalDelegations || []).find(x => x.step === workflow.currentStep && x.approverKey === approverKey);
          const user = users.find(x => x.id === (delegation?.userId || approver.id) && !x.disabled);
          if (user && rbac.hasPermission(user, 'workflow.approve') && rbac.hasPermission(user, 'workflow.view') && rbac.can(user, 'workflow.approve', scopeResource) && rbac.can(user, 'workflow.view', scopeResource)) ids.add(user.id);
        } else {
          const delegation = (workflow.approvalDelegations || []).find(x => x.step === workflow.currentStep && x.approverKey === approverKey);
          if (delegation) {
            const user = users.find(x => x.id === delegation.userId && !x.disabled);
            if (user && rbac.hasPermission(user, 'workflow.approve') && rbac.hasPermission(user, 'workflow.view') && rbac.can(user, 'workflow.approve', scopeResource) && rbac.can(user, 'workflow.view', scopeResource)) ids.add(user.id);
          } else {
            users.filter(x => !x.disabled && (x.role === approver.id || rbac.normalizeRole(x.role) === rbac.normalizeRole(approver.id)))
              .filter(x => rbac.hasPermission(x, 'workflow.approve') && rbac.hasPermission(x, 'workflow.view') && rbac.can(x, 'workflow.approve', scopeResource) && rbac.can(x, 'workflow.view', scopeResource))
              .forEach(x => ids.add(x.id));
          }
        }
      }
      ids.delete(workflow.createdBy);
      workflowsChanged = append(workflow, 'workflow.approval', [...ids], '流程审批已逾期', workflow.approvalDueAt, 'approvalReminderAt') || workflowsChanged;
    }
    if (workflow.type === 'store_remediation' && ['approved','execution_pending'].includes(workflow.status)) {
      const dueDate = String(workflow.form?.dueDate || '');
      const deadline = /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? `${dueDate}T15:59:59.999Z` : null;
      workflowsChanged = append(workflow, 'workflow', [workflow.assigneeId, workflow.createdBy], '门店整改已逾期', deadline) || workflowsChanged;
    }
  }
  if (workflowsChanged) store.writeCollection('workflowInstances', workflows);
  if (tasksChanged || issuesChanged || workflowsChanged) store.writeCollection('notifications', notifications.slice(0, 20000));
}

function start() {
  const run = () => {
    try { scanOverdue(); }
    catch (error) { console.error('Overdue reminder scan failed:', error.message); }
  };
  run();
  const timer = setInterval(run, 15 * 60 * 1000);
  timer.unref?.();
  return timer;
}

module.exports = { scanOverdue, start };
