/**
 * SolarPoints Google Sheets 中转脚本
 * =====================================
 * 功能：接收 POST 的会员/门店/流水/规则数据，写入对应的 Google Sheet。
 *
 * 当前调用方：SolarPoints 服务器（自动同步引擎，默认每 15 分钟心跳一次 /
 * 门店有数据变动时约 1 分钟内自动推送）。浏览器不再直接调用本脚本，
 * 因此国内网络环境也能正常同步。
 *
 * 部署步骤：
 * 1. 打开你的 Google Sheet（命名建议 SolarPoints）
 * 2. 菜单 → 扩展程序 → Apps Script
 * 3. 删除默认的 myFunction()，把本文件全部内容粘贴进去
 * 4. 点击「部署」→「新建部署」
 * 5. 类型选择「Web 应用」
 *    - 说明：SolarPoints Sync
 *    - 执行身份：我
 *    - 访问权限：任何人
 * 6. 点击「部署」，复制弹出的 Web 应用 URL（形如 https://script.google.com/macros/s/.../exec）
 * 7. 把这个 URL 粘贴到 SolarPoints → 系统 → 云同步 → Apps Script URL
 *
 * 注意：脚本内容若改动，需要「部署 → 管理部署 → 编辑 → 版本：新版本」才会生效。
 */

// ==================== 入口 ====================

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents || '{}');
    var action = data.action || '';
    if (action === 'push') {
      return json_(pushToSheet_(data));
    }
    if (action === 'ping') {
      return json_({ ok: true, message: 'pong', time: new Date().toISOString() });
    }
    return json_({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet(e) {
  return json_({ ok: true, message: 'SolarPoints Sync GAS · POST 数据到当前 URL' });
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ==================== 写入 ====================

/**
 * 把 payload 中的 tabs 全部写入指定 Sheet：
 *  - 自动确保每个 tab 存在
 *  - 把 A1 起整块覆盖（先清空对应 tab 的 A:Z 范围）
 *  - 写入表头 + 数据行
 */
function pushToSheet_(payload) {
  var sheetId = payload.sheetId;
  if (!sheetId) throw new Error('缺少 sheetId');

  var ss = SpreadsheetApp.openById(sheetId);
  var tabs = payload.tabs || {};
  var summary = {};

  Object.keys(tabs).forEach(function (name) {
    var tab = tabs[name];
    var headers = tab.headers || [];
    var rows = tab.rows || [];

    var sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
    }

    // 清空数据范围（保留其它格式），按最大列计算
    var lastRow = Math.max(rows.length + 1, 1);
    var lastCol = Math.max(headers.length, 1);
    sh.getRange(1, 1, lastRow, lastCol).clearContent();

    // 写表头
    if (headers.length) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      sh.getRange(1, 1, 1, headers.length)
        .setFontWeight('bold')
        .setBackground('#5046E5')
        .setFontColor('#FFFFFF');
      sh.setFrozenRows(1);
    }
    // 写数据
    if (rows.length) {
      sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
    }
    // 列宽自适应（仅限非空单元格，避免大表超时）
    if (headers.length && rows.length < 500) {
      for (var c = 1; c <= headers.length; c++) {
        sh.autoResizeColumn(c);
      }
    }

    summary[name] = rows.length;
  });

  // 如果主 Sheet 上有 _meta_ 记录同步时间
  var metaSh = ss.getSheetByName('_meta_');
  if (!metaSh) metaSh = ss.insertSheet('_meta_');
  metaSh.getRange('A1').setValue('上次同步');
  metaSh.getRange('B1').setValue(payload.pushedAt || new Date().toISOString());

  return { ok: true, pushedAt: new Date().toISOString(), summary: summary };
}