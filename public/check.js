/* ============================================================================
 * 会员积分自助查询（门店顾客公开页 /check）
 * ----------------------------------------------------------------------------
 * · 不依赖后台 app.js，只复用 i18n.js（同一套字典 + 语言记忆）。
 * · 提交后调用 POST /api/public/points-lookup，双因子（手机号 + 姓名）由服务端校验。
 * · 渲染一律走 escapeHtml：姓名/门店名来自数据库，直接拼进 innerHTML 会 XSS。
 * ========================================================================== */
(function () {
  const I18N = window.I18N;
  const { t, tMsg, tStore, locale, applyStatic, onChange, getLang, setLang } = I18N;

  const $ = (sel) => document.querySelector(sel);
  const elViewForm = $('#viewForm');
  const elViewResult = $('#viewResult');
  const elForm = $('#lookupForm');
  const elPhone = $('#phone');
  const elName = $('#pname');
  const elError = $('#formError');
  const elSubmit = $('#submitBtn');

  /** 上一次查询结果 + 当次输入。切换语言时用它重绘，避免请求两次。 */
  let lastResult = null;

  // ==================== 小工具 ====================
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const fmt = (n) => Number(n || 0).toLocaleString(locale());
  /** 金额：整数不带小数，「₱2,130.6」补成「₱2,130.60」 */
  const money = (n) => {
    const v = Math.round(Number(n || 0) * 100) / 100;
    return '₱' + v.toLocaleString(locale(), {
      minimumFractionDigits: Number.isInteger(v) ? 0 : 2,
      maximumFractionDigits: 2,
    });
  };
  const fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(locale(), { day: '2-digit', month: 'short', year: 'numeric' });
  };

  /** 到期提醒只在 120 天内展示；还早得很就不打扰顾客（接口本身会一直返回到期时间） */
  const EXPIRING_HINT_DAYS = 120;

  function showError(msg) {
    elError.textContent = msg;
    elError.classList.remove('hidden');
  }
  function hideError() { elError.classList.add('hidden'); elError.textContent = ''; }

  function setLoading(on) {
    elSubmit.disabled = on;
    elSubmit.textContent = on ? t('check.submitting') : t('check.submit');
  }

  // ==================== 流水行 ====================
  function txTitle(tx, rules) {
    switch (tx.type) {
      case 'earn':
        return tx.purchaseAmount > 0
          ? t('check.txEarn', { amount: fmt(tx.purchaseAmount) })
          : t('check.txEarnPlain');
      case 'redeem':
        // 流水里的 amount 是「扣掉的积分数」，这里换算成顾客更直观的比索
        return t('check.txRedeem', { amount: fmt(Math.abs(tx.amount) * (rules.pointValue || 0)) });
      case 'welcome': return t('check.txWelcome');
      case 'expire': return t('check.txExpire');
      default: return t('check.txAdjust');
    }
  }

  // ==================== 结果页 ====================
  function renderResult(data) {
    const m = data.member || {};
    const rules = data.rules || {};
    const tier = data.tier;
    const txs = data.recent || [];

    const tierName = tier ? tier.currentName : (m.level || '');

    // 下一档文案三种情况：已是最高档 / 消费已够但等级还没调（B2B 常见）/ 还差多少
    const progressText = !tier ? ''
      : !tier.nextKey ? t('check.topTier')
        : tier.qualifies ? t('check.qualifies', { tier: tier.nextName })
          : t('check.toNext', { amount: fmt(tier.remaining), tier: tier.nextName });

    const progress = tier ? `
      <div class="progress">
        <div class="text">${escapeHtml(progressText)}</div>
        <div class="track"><div class="fill" style="width:${Math.round((tier.percent || 0) * 100)}%"></div></div>
      </div>` : '';

    const expiring = (data.expiring && data.expiring.days <= EXPIRING_HINT_DAYS) ? `
      <div class="expiring">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <circle cx="12" cy="12" r="8.6" stroke="#A9761A" stroke-width="1.8"/>
          <path d="M12 7.4V12l3.1 1.9" stroke="#A9761A" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <div class="txt">
          <div class="t1">${escapeHtml(t('check.expiring', { days: data.expiring.days }))}</div>
          <div class="t2">${escapeHtml(t('check.expiringSub', { date: fmtDate(data.expiring.at) }))}</div>
        </div>
      </div>` : '';

    const frozen = m.status === 'frozen'
      ? `<div class="frozen">${escapeHtml(t('check.frozen'))}</div>` : '';

    const rows = txs.length ? txs.map((tx) => `
      <div class="tx-row">
        <div class="tx-main">
          <div class="tx-title">${escapeHtml(txTitle(tx, rules))}</div>
          <div class="tx-sub">${escapeHtml([tx.storeName ? tStore(tx.storeName) : '', fmtDate(tx.createdAt)].filter(Boolean).join(' · '))}</div>
        </div>
        <div class="tx-delta ${tx.amount >= 0 ? 'plus' : 'minus'}">${(tx.amount >= 0 ? '+' : '') + fmt(tx.amount)}</div>
      </div>`).join('') : `<div class="empty">${escapeHtml(t('check.noTx'))}</div>`;

    elViewResult.innerHTML = `
      <div class="result-head">
        <div class="greet">${escapeHtml(t('check.greeting', { name: m.name || '' }))}</div>
        <div class="meta">${escapeHtml([m.phone, m.storeName ? tStore(m.storeName) : ''].filter(Boolean).join(' · '))}</div>
      </div>

      ${frozen}

      <div class="balance">
        <div class="row1">
          <span class="label">${escapeHtml(t('check.balance'))}</span>
          <span class="tier-pill"><span class="dot"></span>${escapeHtml(tierName)}</span>
        </div>
        <div class="value-row">
          <span class="amount">${fmt(m.points)}</span>
          <span class="worth">≈ ${money(m.pointsValue)}</span>
        </div>
        ${progress}
      </div>

      ${expiring}

      <div class="activity">
        <div class="activity-head">
          <div class="title">${escapeHtml(t('check.recent'))}</div>
          <div class="sub">${escapeHtml(t('check.recentLast', { n: txs.length }))}</div>
        </div>
        ${rows}
      </div>

      <div class="rate">${escapeHtml(t('check.rate', { n: rules.spendPerPoint || 10, p: rules.ratioPoints || 10 }))}</div>

      <div class="result-footer">
        ${m.memberSince ? `<p class="ask">${escapeHtml(t('check.memberSince', { date: fmtDate(m.memberSince) }))}</p>` : ''}
        <p class="ask">${escapeHtml(t('check.askStaff'))}</p>
        <button class="btn-ghost" id="againBtn" type="button">${escapeHtml(t('check.another'))}</button>
      </div>
    `;

    const again = $('#againBtn');
    if (again) {
      again.addEventListener('click', () => {
        elPhone.value = '';
        elName.value = '';
        lastResult = null;
        hideError();
        elViewResult.classList.add('hidden');
        elViewForm.classList.remove('hidden');
        window.scrollTo({ top: 0 });
        elPhone.focus();
      });
    }
  }

  // ==================== 提交 ====================
  elForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();

    const phone = elPhone.value.trim();
    const name = elName.value.trim();
    if (phone.replace(/\D/g, '').length < 7) {
      showError(t('check.errPhone'));
      elPhone.focus();
      return;
    }
    if (name.length < 2) {
      showError(t('check.errName'));
      elName.focus();
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/public/points-lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || '加载失败');

      lastResult = data;
      renderResult(data);
      elViewForm.classList.add('hidden');
      elViewResult.classList.remove('hidden');
      window.scrollTo({ top: 0 });
    } catch (err) {
      showError(tMsg(err && err.message ? err.message : '未知错误'));
    } finally {
      setLoading(false);
    }
  });

  // ==================== 语言 ====================
  const syncTitle = () => { document.title = t('check.docTitle'); };

  $('#langBtn').addEventListener('click', () => {
    setLang(getLang() === 'zh' ? 'en' : 'zh');
  });

  onChange(() => {
    applyStatic();
    syncTitle();
    // 结果页是纯函数渲染的，切语言时重绘一次即可（不重新请求）
    if (lastResult && !elViewResult.classList.contains('hidden')) renderResult(lastResult);
  });

  applyStatic();
  syncTitle();
})();
