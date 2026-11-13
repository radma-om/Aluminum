/* =============================================================
   «المكافآت والعمولات» (managers): each month, the sales staff's sales
   (without installation and delivery) against their target and the %
   over it; the technicians' % of the installation they completed.
   Approving a month keeps it as it was.
   And for each employee: «هدفي هذا الشهر» (their own figures only).
   Uses api(), $id(), esc(), setStatus(), ME from the other admin scripts.
   ============================================================= */
let bonusData = null;
const bMoney = (n) => Number(n || 0).toFixed(2);
/* «متبقٍ يوم / يومان / 5 أيام / 17 يوماً» */
const bDays = (n) => (n === 1 ? 'يوم واحد' : n === 2 ? 'يومان' : n >= 3 && n <= 10 ? `${n} أيام` : `${n} يوماً`);

async function loadBonuses() {
    if (!$id('bonusMonth').value) $id('bonusMonth').value = new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 7);
    try {
        bonusData = await api('GET', '/api/admin/bonuses?month=' + encodeURIComponent($id('bonusMonth').value));
        renderBonuses();
        setStatus('bonusStatus', '');
    } catch (err) { setStatus('bonusStatus', err.message, 'err'); }
}

function renderBonuses() {
    const b = bonusData;
    const locked = Boolean(b.approved);
    $id('bonusApproval').innerHTML = locked
        ? `<span class="badge on">معتمد ✓ — ${esc(b.approved.by || '')} ${esc(String(b.approved.at || '').slice(0, 10))}</span>
           <button class="link-btn" onclick="bonusUnapprove()">إلغاء الاعتماد</button>`
        : `<button class="btn btn-primary btn-sm" onclick="bonusApprove()"><i class="fas fa-stamp"></i> اعتماد كشف الشهر</button>`;
    const sales = b.people.filter((p) => p.kind === 'sales');
    const techs = b.people.filter((p) => p.kind === 'technician');
    const input = (p, f, v, w = 90, step = '0.5') => locked ? `<b>${v ?? '—'}</b>` :
        `<input type="number" class="bonus-in" min="0" step="${step}" style="width:${w}px" data-user="${p.user_id}" data-f="${f}" value="${v ?? ''}" placeholder="—">`;
    const bar = (p) => p.progress == null ? '<span class="status-text">لا هدف</span>'
        : `<div class="bonus-bar ${p.reached ? 'ok' : ''}"><span style="width:${Math.min(100, p.progress)}%"></span></div><small>${p.progress}%</small>`;
    const details = (p) => p.kind === 'sales'
        ? (p.invoices.length ? `<table class="bonus-sub"><thead><tr><th>الفاتورة</th><th>العميل</th><th>صدرت</th><th>دُفع 50% في</th><th>مدفوع</th><th>قبل الضريبة</th><th>تركيب وتوصيل</th><th>تُحتسب</th></tr></thead><tbody>
            ${p.invoices.map((i) => `<tr><td>${esc(i.number)}</td><td>${esc(i.customer_name)}</td><td>${esc(i.date)}</td><td>${esc(i.qualified_on || '')}</td><td>${i.paid_percent ?? ''}%</td><td>${bMoney(i.subtotal)}</td><td>${i.excluded ? '−' + bMoney(i.excluded) : '—'}</td><td><b>${bMoney(i.base)}</b></td></tr>`).join('')}
            </tbody></table>` : '<p class="status-text">لا فواتير مُحتسبة هذا الشهر.</p>')
          + ((p.pending_invoices || []).length ? `<p class="sub-heading" style="margin-top:10px">بانتظار دفع 50% (${p.pending_invoices.length}) — لا تُحتسب بعد</p>
            <table class="bonus-sub"><thead><tr><th>الفاتورة</th><th>العميل</th><th>صدرت</th><th>مدفوع</th><th>المتبقي لبلوغ 50%</th><th>ستُحتسب</th></tr></thead><tbody>
            ${p.pending_invoices.map((i) => `<tr class="pending"><td>${esc(i.number)}</td><td>${esc(i.customer_name)}</td><td>${esc(i.date)}</td><td>${i.paid_percent}%</td><td>${bMoney(Math.max(0, i.total / 2 - i.paid))}</td><td>${bMoney(i.base)}</td></tr>`).join('')}
            </tbody></table>` : '')
        : (p.orders.length ? `<table class="bonus-sub"><thead><tr><th>أمر العمل</th><th>العميل</th><th>اكتمل</th><th>مبلغ التركيب</th><th></th></tr></thead><tbody>
            ${p.orders.map((o) => `<tr><td>${esc(o.number)}</td><td>${esc(o.customer_name)}</td><td>${esc(o.date)}</td><td><b>${bMoney(o.fee)}</b></td><td class="status-text">${esc(o.note || '')}</td></tr>`).join('')}
            </tbody></table>` : '<p class="status-text">لم يُكمل تركيبات هذا الشهر.</p>');
    const row = (p, cells) => `<tr class="bonus-row" onclick="if (!event.target.closest('input')) this.nextElementSibling.hidden = !this.nextElementSibling.hidden">${cells}</tr>
        <tr class="bonus-detail" hidden><td colspan="10">${details(p)}</td></tr>`;
    const per = b.period || {};
    const st = b.stats || {};
    const proj = per.current && st.projected_commission != null;
    const hist = b.history || [];
    const hMax = Math.max(1, ...hist.map((h) => h.commission));
    $id('bonusBody').innerHTML = `
        <div class="bonus-period"><i class="fas fa-calendar-days"></i> <b>${esc(per.name || b.month)}</b> — من ${esc(per.from || '')} إلى ${esc(per.to || '')}
            ${per.current ? `<span class="badge">متبقٍ ${bDays(per.days_left)}</span>` : per.ended ? `<span class="badge">انتهى${b.approved ? ' — مغلق' : ''}</span>` : '<span class="badge">لم يبدأ</span>'}</div>
        <div class="kpi-row bonus-kpis">
            <div class="kpi"><small>مبيعات الموظفين (بدون تركيب وتوصيل)</small><strong>${bMoney(b.totals.sales)}</strong></div>
            <div class="kpi"><small>قيمة التركيبات المنجزة</small><strong>${bMoney(b.totals.installations)}</strong></div>
            ${st.waiting_count ? `<div class="kpi"><small>بانتظار دفع 50% (لا تُحتسب بعد)</small><strong>${bMoney(st.waiting_base)}</strong><small>${st.waiting_count === 1 ? 'فاتورة واحدة' : st.waiting_count + ' فواتير'}</small></div>` : ''}
            <div class="kpi"><small>حققوا الهدف</small><strong>${st.reached ?? 0} / ${st.with_target ?? 0}</strong>${st.avg_progress != null ? `<small>متوسط التحقيق ${st.avg_progress}%</small>` : ''}</div>
            <div class="kpi good"><small>إجمالي العمولات ${per.current ? 'حتى الآن' : ''}</small><strong>${bMoney(b.totals.commission)} ر.ع</strong>${proj ? `<small>المتوقع بنهاية الشهر ≈ ${bMoney(st.projected_commission)}</small>` : ''}</div>
        </div>
        ${hist.length ? `<div class="bonus-history"><div class="bonus-history-head">العمولات في آخر 6 أشهر</div><div class="bonus-bars">
            ${hist.map((h) => `<div class="bonus-col ${h.month === b.month ? 'on' : ''}" title="مبيعات ${bMoney(h.sales)} — تركيب ${bMoney(h.installations)}">
                <small>${bMoney(h.commission)}</small><span style="height:${Math.max(3, Math.round(h.commission / hMax * 70))}px"></span>
                <em>${esc(h.name.split(' ')[0])}${h.approved ? ' ✓' : ''}</em><small class="status-text">${h.with_target ? `${h.reached}/${h.with_target}` : ''}</small></div>`).join('')}
        </div></div>` : ''}
        <p class="sub-heading">الموظفون — عمولة بعد الهدف</p>
        <div class="table-wrapper"><table class="bonus-table"><thead><tr><th>الموظف</th><th>الهدف (ر.ع)</th><th>النسبة %</th><th>المبيعات</th><th>التقدّم</th><th>فوق الهدف</th><th>العمولة</th>${proj ? '<th>المتوقع</th>' : ''}<th>فواتير</th><th>بانتظار الدفع</th></tr></thead><tbody>
        ${sales.map((p) => row(p, `<td><b>${esc(p.name)}</b>${p.role === 'manager' ? ' <small class="status-text">مدير</small>' : ''}</td>
            <td>${input(p, 'target', p.target || null, 100, '100')}</td><td>${input(p, 'percent', p.percent || null, 70, '0.1')}</td>
            <td><b>${bMoney(p.base)}</b></td><td class="bonus-progress">${bar(p)}</td><td>${p.over ? bMoney(p.over) : '—'}</td>
            <td class="bonus-commission ${p.commission ? 'pos' : ''}">${bMoney(p.commission)}</td>
            ${proj ? `<td class="status-text" title="بهذه الوتيرة حتى نهاية الشهر">${p.projected != null ? `${bMoney(p.projected)}<br>≈ ${bMoney(p.projected_commission)} عمولة` : '—'}</td>` : ''}
            <td>${p.count} <i class="fas fa-chevron-down status-text"></i></td>
            <td class="status-text">${p.pending ? `${p.pending} — ${bMoney(p.pending_base)}` : '—'}</td>`)).join('') || '<tr><td colspan="8" class="status-text">لا يوجد موظفون.</td></tr>'}
        </tbody></table></div>
        <p class="sub-heading">الفنيون — نسبة من التركيب</p>
        <div class="table-wrapper"><table class="bonus-table"><thead><tr><th>الفني</th><th>النسبة % من التركيب</th><th>تركيبات منجزة</th><th>مبلغ التركيب</th><th>العمولة</th><th></th></tr></thead><tbody>
        ${techs.map((p) => row(p, `<td><b>${esc(p.name)}</b></td><td>${input(p, 'percent', p.percent || null, 70, '0.5')}</td>
            <td>${p.count}</td><td><b>${bMoney(p.base)}</b></td><td class="bonus-commission ${p.commission ? 'pos' : ''}">${bMoney(p.commission)}</td><td><i class="fas fa-chevron-down status-text"></i></td>`)).join('') || '<tr><td colspan="6" class="status-text">لا يوجد فنيون.</td></tr>'}
        </tbody></table></div>
        ${b.unassigned.length ? `<details class="bonus-unassigned"><summary>فواتير غير منسوبة لموظف (${b.unassigned.length}) — لا تدخل في العمولات</summary>
            <p class="status-text">صدرت بكلمة مرور الإدارة العامة أو لموظف حُذف حسابه.</p>
            ${b.unassigned.map((i) => `<div>${esc(i.number)} — ${esc(i.customer_name)} — ${esc(i.date)} — ${bMoney(i.base)}${i.owner ? ` (${esc(i.owner)})` : ''}</div>`).join('')}</details>` : ''}`;
}

/* A target or % typed in the table: saved at once, the month counted again */
$id('bonusBody').addEventListener('change', async (e) => {
    const el = e.target.closest('.bonus-in');
    if (!el) return;
    const p = bonusData.people.find((x) => x.user_id === Number(el.dataset.user));
    const row = el.closest('tr');
    const val = (f) => { const i = row.querySelector(`[data-f="${f}"]`); return i ? i.value : null; };
    try {
        await api('PUT', `/api/admin/bonuses/plan/${p.user_id}`, { target: p.kind === 'sales' ? val('target') : null, percent: val('percent') });
        setStatus('bonusStatus', `حُفظ ${p.name} ✓`, 'ok');
        await loadBonuses();
    } catch (err) { setStatus('bonusStatus', err.message, 'err'); }
});
$id('bonusMonth').addEventListener('change', loadBonuses);

async function bonusApprove() {
    if (!confirm(`اعتماد كشف ${bonusData.month}؟\nيُحفظ الكشف كما هو الآن، ولا يتغير بتعديل الفواتير أو الأهداف لاحقاً (يمكن إلغاء الاعتماد).`)) return;
    try { bonusData = await api('POST', `/api/admin/bonuses/${bonusData.month}/approve`); renderBonuses(); } catch (err) { alert(err.message); }
}
async function bonusUnapprove() {
    if (!confirm('إلغاء اعتماد الشهر؟ سيُحسب الكشف من جديد بالأرقام والأهداف الحالية.')) return;
    try { bonusData = await api('DELETE', `/api/admin/bonuses/${bonusData.month}/approve`); renderBonuses(); } catch (err) { alert(err.message); }
}

function bonusCsv() {
    if (!bonusData) return;
    const rows = [['الشهر', 'الاسم', 'النوع', 'الهدف', 'النسبة %', 'المبيعات / التركيب', 'فوق الهدف', 'العمولة', 'العدد']];
    for (const p of bonusData.people) rows.push([bonusData.month, p.name, p.kind === 'sales' ? 'مبيعات' : 'فني', p.target ?? '', p.percent, p.base, p.over ?? '', p.commission, p.count]);
    // Keep employee names from becoming formulas when the CSV is opened in Excel.
    const cell = (v) => {
        const t = String(v ?? '');
        const safe = /^[=+\-@]/.test(t) && typeof v === 'string' ? "'" + t : t;
        return `"${safe.replace(/"/g, '""')}"`;
    };
    const csv = '﻿' + rows.map((r) => r.map(cell).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `commissions-${bonusData.month}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* «هدفي هذا الشهر»: an employee's own progress (shown only when the manager set a target or a %) */
async function loadMyBonus() {
    if (!ME || ME.owner) return null;
    try { return (await api('GET', '/api/admin/me/bonus')).bonus; } catch { return null; }
}
function myBonusHtml(m) {
    if (!m) return '';
    const per = m.period || {};
    const when = `<small class="status-text">${esc(per.name || m.month)}: من ${esc(per.from || '')} إلى ${esc(per.to || '')}${per.current ? ` — متبقٍ ${bDays(per.days_left)}` : ''}</small>`;
    const prev = m.previous && m.previous.commission > 0 ? `<span class="status-text">${esc(m.previous.name)}: ${bMoney(m.previous.commission)} ر.ع${m.previous.progress != null ? ` (${m.previous.progress}%)` : ''}</span>` : '';
    if (m.kind === 'technician') {
        return `<div class="my-bonus-card"><div class="my-bonus-head"><span><i class="fas fa-sack-dollar"></i> <b>عمولتي هذا الشهر</b></span>${when}</div>
            <div class="my-bonus-figs"><span>نسبتي <b>${m.percent}%</b> من التركيب — عند اكتمال التركيب</span><span>تركيبات منجزة <b>${m.count}</b></span><span>مبلغ التركيب <b>${bMoney(m.base)}</b></span>
                <span class="pos">العمولة <b>${bMoney(m.commission)} ر.ع</b></span>${m.projected_commission != null ? `<span class="status-text">المتوقع ≈ ${bMoney(m.projected_commission)}</span>` : ''}${prev}</div></div>`;
    }
    return `<div class="my-bonus-card"><div class="my-bonus-head"><span><i class="fas fa-bullseye"></i> <b>هدفي هذا الشهر</b></span>${when}</div>
        ${m.target ? `<div class="my-bonus-gauge"><strong class="${m.reached ? 'pos' : ''}">${m.progress}%</strong><span>من الهدف (${bMoney(m.target)} ر.ع)</span></div>
            <div class="bonus-bar big ${m.reached ? 'ok' : ''}"><span style="width:${Math.min(100, m.progress)}%"></span></div>` : ''}
        <div class="my-bonus-figs"><span>مبيعاتي المُحتسبة <b>${bMoney(m.base)}</b> <small class="status-text">(مدفوع منها 50% فأكثر، بدون التركيب والتوصيل)</small></span>
            ${m.pending ? `<span class="status-text">⏳ بانتظار الدفع: ${m.pending} ${m.pending === 1 ? 'فاتورة' : 'فواتير'} بقيمة ${bMoney(m.pending_base)} — تُحتسب عند دفع 50%</span>` : ''}
            <span>نسبة عمولتي <b>${m.percent}%</b> بعد الهدف</span>
            ${m.reached ? `<span class="pos">تجاوزت الهدف بـ <b>${bMoney(m.over)}</b></span>` : m.target ? `<span>متبقٍ للهدف <b>${bMoney(m.left_to_target)}</b></span>` : ''}
            <span class="pos">عمولتي <b>${bMoney(m.commission)} ر.ع</b></span>
            ${m.projected != null ? `<span class="status-text">بهذه الوتيرة: ${bMoney(m.projected)} مبيعات ≈ ${bMoney(m.projected_commission)} عمولة</span>` : ''}${prev}</div></div>`;
}
async function showMyBonus() {
    if (!ME || ME.role === 'technician' || ME.owner) return;
    const m = await loadMyBonus();
    $id('myBonus').innerHTML = myBonusHtml(m);
    $id('myBonus').hidden = !m;
}

const switchTabBeforeBonuses = window.switchTab;
window.switchTab = function (tabId) {
    switchTabBeforeBonuses(tabId);
    if (!online) return;
    if (tabId === 'bonuses') loadBonuses();
    if (tabId === 'quotes') showMyBonus();
    if (tabId === 'dashboard') showBonusPulse();
};

/* The dashboard: managers see this month's commissions in a few figures; an employee sees their own card */
async function showBonusPulse() {
    if (!ME) return;
    const box = $id('bonusPulse');
    try {
        if (ME.role === 'manager') {
            const s = await api('GET', '/api/admin/bonuses/summary');
            if (!s.set_up) { box.hidden = true; return; }
            const st = s.stats;
            box.innerHTML = `<div class="my-bonus-card"><div class="my-bonus-head"><span><i class="fas fa-sack-dollar"></i> <b>العمولات — ${esc(s.period.name)}</b></span>
                <small class="status-text">متبقٍ ${bDays(s.period.days_left)} — <a href="#" onclick="switchTab('bonuses'); return false">الكشف الكامل</a></small></div>
                <div class="my-bonus-figs"><span>حققوا الهدف <b>${st.reached} / ${st.with_target}</b></span>${st.avg_progress != null ? `<span>متوسط التحقيق <b>${st.avg_progress}%</b></span>` : ''}
                    <span>المبيعات <b>${bMoney(s.totals.sales)}</b></span><span class="pos">العمولات حتى الآن <b>${bMoney(s.totals.commission)} ر.ع</b></span>
                    ${st.projected_commission != null ? `<span class="status-text">المتوقع ≈ ${bMoney(st.projected_commission)}</span>` : ''}</div>
                ${st.best.length ? `<div class="bonus-best">${st.best.map((b, i) => `<span>${['🥇', '🥈', '🥉'][i]} ${esc(b.name)} <b>${b.progress}%</b></span>`).join('')}</div>` : ''}</div>`;
            box.hidden = false;
        } else {
            const m = await loadMyBonus();
            box.innerHTML = myBonusHtml(m);
            box.hidden = !m;
        }
    } catch { box.hidden = true; }
}

// The dashboard opens without switchTab (it is the first tab): show the card whenever it loads
if (typeof loadDashboard === 'function') {
    const loadDashboardBeforeBonuses = loadDashboard;
    loadDashboard = async function (...args) {
        const r = await loadDashboardBeforeBonuses(...args);
        showBonusPulse();
        return r;
    };
}
