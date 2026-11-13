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
        ? (p.invoices.length ? `<table class="bonus-sub"><thead><tr><th>الفاتورة</th><th>العميل</th><th>التاريخ</th><th>قبل الضريبة</th><th>تركيب وتوصيل</th><th>تُحتسب</th></tr></thead><tbody>
            ${p.invoices.map((i) => `<tr><td>${esc(i.number)}</td><td>${esc(i.customer_name)}</td><td>${esc(i.date)}</td><td>${bMoney(i.subtotal)}</td><td>${i.excluded ? '−' + bMoney(i.excluded) : '—'}</td><td><b>${bMoney(i.base)}</b></td></tr>`).join('')}
            </tbody></table>` : '<p class="status-text">لا فواتير هذا الشهر.</p>')
        : (p.orders.length ? `<table class="bonus-sub"><thead><tr><th>أمر العمل</th><th>العميل</th><th>اكتمل</th><th>مبلغ التركيب</th><th></th></tr></thead><tbody>
            ${p.orders.map((o) => `<tr><td>${esc(o.number)}</td><td>${esc(o.customer_name)}</td><td>${esc(o.date)}</td><td><b>${bMoney(o.fee)}</b></td><td class="status-text">${esc(o.note || '')}</td></tr>`).join('')}
            </tbody></table>` : '<p class="status-text">لم يُكمل تركيبات هذا الشهر.</p>');
    const row = (p, cells) => `<tr class="bonus-row" onclick="if (!event.target.closest('input')) this.nextElementSibling.hidden = !this.nextElementSibling.hidden">${cells}</tr>
        <tr class="bonus-detail" hidden><td colspan="9">${details(p)}</td></tr>`;
    $id('bonusBody').innerHTML = `
        <div class="kpi-row bonus-kpis">
            <div class="kpi"><small>مبيعات الموظفين (بدون تركيب وتوصيل)</small><strong>${bMoney(b.totals.sales)}</strong></div>
            <div class="kpi"><small>قيمة التركيبات المنجزة</small><strong>${bMoney(b.totals.installations)}</strong></div>
            <div class="kpi good"><small>إجمالي العمولات</small><strong>${bMoney(b.totals.commission)} ر.ع</strong></div>
        </div>
        <p class="sub-heading">الموظفون — عمولة بعد الهدف</p>
        <div class="table-wrapper"><table class="bonus-table"><thead><tr><th>الموظف</th><th>الهدف (ر.ع)</th><th>النسبة %</th><th>المبيعات</th><th>التقدّم</th><th>فوق الهدف</th><th>العمولة</th><th>فواتير</th></tr></thead><tbody>
        ${sales.map((p) => row(p, `<td><b>${esc(p.name)}</b>${p.role === 'manager' ? ' <small class="status-text">مدير</small>' : ''}</td>
            <td>${input(p, 'target', p.target || null, 100, '100')}</td><td>${input(p, 'percent', p.percent || null, 70, '0.1')}</td>
            <td><b>${bMoney(p.base)}</b></td><td class="bonus-progress">${bar(p)}</td><td>${p.over ? bMoney(p.over) : '—'}</td>
            <td class="bonus-commission ${p.commission ? 'pos' : ''}">${bMoney(p.commission)}</td><td>${p.count} <i class="fas fa-chevron-down status-text"></i></td>`)).join('') || '<tr><td colspan="8" class="status-text">لا يوجد موظفون.</td></tr>'}
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
    const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
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
    if (m.kind === 'technician') {
        return `<div class="my-bonus-card"><div><i class="fas fa-sack-dollar"></i> <b>عمولتي هذا الشهر</b> <small class="status-text">${m.percent}% من التركيب</small></div>
            <div class="my-bonus-figs"><span>تركيبات منجزة <b>${m.count}</b></span><span>مبلغ التركيب <b>${bMoney(m.base)}</b></span><span class="pos">العمولة <b>${bMoney(m.commission)} ر.ع</b></span></div></div>`;
    }
    const left = m.target ? Math.max(0, m.target - m.base) : 0;
    return `<div class="my-bonus-card"><div><i class="fas fa-bullseye"></i> <b>هدفي هذا الشهر</b> <small class="status-text">${m.target ? bMoney(m.target) + ' ر.ع' : 'بلا هدف'} — ${m.percent}% بعد الهدف (بدون التركيب والتوصيل)</small></div>
        ${m.target ? `<div class="bonus-bar big ${m.reached ? 'ok' : ''}"><span style="width:${Math.min(100, m.progress)}%"></span></div>` : ''}
        <div class="my-bonus-figs"><span>مبيعاتي <b>${bMoney(m.base)}</b></span>
            ${m.reached ? `<span class="pos">تجاوزت الهدف بـ <b>${bMoney(m.over)}</b></span>` : m.target ? `<span>متبقٍ للهدف <b>${bMoney(left)}</b></span>` : ''}
            <span class="pos">عمولتي <b>${bMoney(m.commission)} ر.ع</b></span></div></div>`;
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
};
