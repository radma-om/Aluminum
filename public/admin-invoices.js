/* =============================================================
   «الفواتير والمدفوعات»: issue an invoice from a quote, record the
   deposit and instalments, share the customer's PDF link, cancel
   (managers). Uses api(), $id(), esc(), setStatus(), ME, canSee() from admin.js.
   ============================================================= */

let invMeta = { methods: {}, states: {} };
let invCurrent = null;
let invQuote = null;
const money2 = (n) => Number(n || 0).toFixed(2);
const todayLocal = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10); // Muscat

function closeSheet(id) { $id(id).hidden = true; }

function fillMethods(selectId) {
    $id(selectId).innerHTML = Object.entries(invMeta.methods).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
}

async function ensureInvMeta() {
    if (Object.keys(invMeta.methods).length) return;
    const r = await api('GET', '/api/admin/invoices?state=none');
    invMeta = { methods: r.methods, states: r.states };
}

let invTimer = null;
function debouncedInvoices() { clearTimeout(invTimer); invTimer = setTimeout(loadInvoices, 250); }

async function loadInvoices() {
    if (!online) return;
    const p = new URLSearchParams();
    if ($id('invSearch').value.trim()) p.set('q', $id('invSearch').value.trim());
    if ($id('invState').value) p.set('state', $id('invState').value);
    try {
        const r = await api('GET', '/api/admin/invoices?' + p);
        invMeta = { methods: r.methods, states: r.states };
        const s = r.summary;
        $id('invSummary').innerHTML = `
            <div><small>فواتير هذا الشهر</small><strong>${esc(s.issued_count)}</strong> — ${money2(s.issued_value)} ر.ع</div>
            <div><small>المحصّل هذا الشهر</small><strong>${money2(s.collected)}</strong> ر.ع</div>
            <div><small>المتبقي على العملاء</small><strong>${money2(s.outstanding)}</strong> ر.ع</div>
            <div><small>متأخرة السداد</small><strong style="color:${s.overdue ? '#a93226' : 'inherit'}">${esc(s.overdue)}</strong></div>`;
        $id('invBody').innerHTML = r.invoices.map((i) => `
            <tr class="${i.state === 'cancelled' ? 'muted-row' : ''}">
                <td data-label="الرقم"><strong>${esc(i.number)}</strong></td>
                <td data-label="التاريخ"><small>${esc(i.issue_date)}${i.due_date ? `<br>يستحق ${esc(i.due_date)}` : ''}</small></td>
                <td data-label="العميل">${esc(i.customer_name)}<br><small dir="ltr">${esc(i.customer_phone)}</small></td>
                <td data-label="الإجمالي">${money2(i.total)}</td>
                <td data-label="المدفوع">${money2(i.paid)}</td>
                <td data-label="المتبقي"><strong>${money2(i.balance)}</strong></td>
                <td data-label="الحالة"><span class="badge st-${esc(i.state)}">${esc(i.state_label)}</span></td>
                <td data-label=""><button class="btn btn-outline btn-sm" onclick="openInvoice(${i.id})">عرض</button></td>
            </tr>`).join('') || '<tr><td colspan="8">لا توجد فواتير بعد — أصدر أول فاتورة من «طلبات العروض».</td></tr>';
        setStatus('invStatus', '');
    } catch (err) {
        setStatus('invStatus', err.message, 'err');
    }
}

/* ---- Issue from a quote ---- */

async function newInvoice(quoteId) {
    try { await ensureInvMeta(); } catch (err) { return alert(err.message); }
    invQuote = (typeof quotesCache !== 'undefined' ? quotesCache : []).find((q) => q.id === quoteId);
    if (!invQuote) return;
    const range = invQuote.details && invQuote.details.range && invQuote.details.range.total_to != null;
    $id('invNewQuote').innerHTML = `عرض <strong>${esc(invQuote.ref)}</strong> — ${esc(invQuote.customer_name)} — `
        + `الإجمالي ${money2(invQuote.total)}${range ? ' – ' + money2(invQuote.details.range.total_to) : ''} ر.ع `
        + `(قبل الضريبة ${money2(invQuote.subtotal)}${range ? ' – ' + money2(invQuote.details.range.subtotal_to) : ''})`
        + (invQuote.expired ? '<br><span style="color:#a93226">⚠️ صلاحية هذا العرض انتهت — تأكد أن السعر ما زال صحيحاً.</span>' : '');
    $id('invFinalLabel').innerHTML = range
        ? 'المبلغ النهائي قبل الضريبة <span class="unit" style="color:#a93226">(مطلوب: سعر العرض نطاق)</span>'
        : 'المبلغ النهائي قبل الضريبة <span class="unit">(اختياري — للخصم)</span>';
    $id('invFinal').required = Boolean(range);
    $id('invIssue').value = todayLocal();
    for (const id of ['invDue', 'invFinal', 'invAddress', 'invNotes', 'invDeposit']) $id(id).value = '';
    fillMethods('invDepositMethod');
    setStatus('invNewStatus', '');
    $id('invNewSheet').hidden = false;
}

async function submitNewInvoice() {
    const body = {
        issue_date: $id('invIssue').value, due_date: $id('invDue').value || null,
        customer_address: $id('invAddress').value.trim(), notes: $id('invNotes').value.trim()
    };
    if ($id('invFinal').value !== '') body.final_subtotal = Number($id('invFinal').value);
    if (Number($id('invDeposit').value) > 0) body.deposit = { amount: Number($id('invDeposit').value), method: $id('invDepositMethod').value, note: 'عربون' };
    try {
        const inv = await api('POST', `/api/admin/quotes/${invQuote.id}/invoice`, body);
        closeSheet('invNewSheet');
        loadQuotes().catch(() => {});
        showInvoice(inv);
    } catch (err) {
        setStatus('invNewStatus', err.message, 'err');
    }
}

/* ---- One invoice ---- */

async function openInvoice(id) {
    try {
        await ensureInvMeta();
        showInvoice(await api('GET', `/api/admin/invoices/${id}`));
    } catch (err) { alert(err.message); }
}

function showInvoice(inv) {
    invCurrent = inv;
    const manager = ME && ME.role === 'manager';
    const link = location.origin + inv.pdf_url;
    const wa = `https://wa.me/${encodeURIComponent(String(inv.customer_phone).replace(/\D/g, ''))}?text=${encodeURIComponent(`فاتورة رقم ${inv.number} — الإجمالي ${money2(inv.total)} ر.ع، المتبقي ${money2(inv.balance)} ر.ع\n${link}`)}`;
    $id('invDetail').innerHTML = `
        <h3><i class="fas fa-receipt"></i> ${esc(inv.number)} <span class="badge st-${esc(inv.state)}">${esc(inv.state_label)}</span></h3>
        <p class="status-text" style="margin:0">${esc(inv.customer_name)} — <span dir="ltr">${esc(inv.customer_phone)}</span>
            ${inv.customer_city ? ' — ' + esc(inv.customer_city) : ''}${inv.customer_address ? '<br>' + esc(inv.customer_address) : ''}<br>
            التاريخ ${esc(inv.issue_date)}${inv.due_date ? ` — يستحق ${esc(inv.due_date)}` : ''}${inv.created_by ? ` — أصدرها ${esc(inv.created_by)}` : ''}</p>
        ${inv.state === 'cancelled' ? `<p style="color:#a93226;font-weight:700">ملغاة: ${esc(inv.cancel_reason || '')}</p>` : ''}
        <div class="money-grid">
            <div><small>الإجمالي</small><strong>${money2(inv.total)}</strong></div>
            <div><small>المدفوع</small><strong>${money2(inv.paid)}</strong></div>
            <div><small>المتبقي</small><strong>${money2(inv.balance)}</strong></div>
        </div>
        ${Math.abs(inv.adjustment) >= 0.005 ? `<p class="status-text" style="margin:0 0 8px">مجموع البنود ${money2(inv.quote_subtotal)} — ${inv.adjustment < 0 ? 'خصم' : 'تعديل'} ${money2(inv.adjustment)} — قبل الضريبة ${money2(inv.subtotal)}</p>` : ''}
        <p class="sub-heading">الدفعات</p>
        ${inv.payments.length ? `<div class="table-wrapper"><table class="stack-table"><thead><tr><th>التاريخ</th><th>المبلغ</th><th>الطريقة</th><th>المرجع / ملاحظة</th><th></th></tr></thead><tbody>
            ${inv.payments.map((p) => `<tr>
                <td data-label="التاريخ">${esc(p.paid_on)}</td>
                <td data-label="المبلغ"><strong>${money2(p.amount)}</strong></td>
                <td data-label="الطريقة">${esc(invMeta.methods[p.method] || p.method)}</td>
                <td data-label="المرجع / ملاحظة"><small>${esc([p.reference, p.note].filter(Boolean).join(' — ') || '—')}${p.created_by ? `<br>سجّلها ${esc(p.created_by)}` : ''}</small></td>
                <td data-label="">${manager ? `<button class="btn btn-outline btn-sm" onclick="deletePayment(${p.id})">حذف</button>` : ''}</td>
            </tr>`).join('')}</tbody></table></div>` : '<p class="status-text">لا توجد دفعات بعد.</p>'}
        <div class="form-buttons">
            <button class="btn btn-outline btn-sm" onclick="downloadInvoicePdf(${inv.id}, '${esc(inv.number)}')">PDF</button>
            <button class="btn btn-outline btn-sm" onclick="copyInvoiceLink()">نسخ رابط العميل</button>
            <a class="btn btn-outline btn-sm" href="${esc(wa)}" target="_blank" rel="noopener">إرسال عبر واتساب</a>
            ${inv.state !== 'cancelled' ? `<button class="btn btn-outline btn-sm" onclick="editInvoice()">تعديل الاستحقاق / الملاحظات</button>` : ''}
            ${manager && inv.state !== 'cancelled' ? `<button class="btn btn-outline btn-sm" style="color:#a93226" onclick="cancelInvoice()">إلغاء الفاتورة</button>` : ''}
        </div>`;
    $id('invPayForm').hidden = inv.state === 'cancelled' || inv.balance <= 0.0005;
    fillMethods('payMethod');
    $id('payAmount').value = inv.balance > 0 ? money2(inv.balance) : '';
    $id('payDate').value = todayLocal();
    $id('payRef').value = '';
    setStatus('payStatus', '');
    $id('invSheet').hidden = false;
}

async function submitPayment() {
    try {
        const inv = await api('POST', `/api/admin/invoices/${invCurrent.id}/payments`, {
            amount: Number($id('payAmount').value), method: $id('payMethod').value, paid_on: $id('payDate').value, reference: $id('payRef').value.trim()
        });
        showInvoice(inv);
        setStatus('payStatus', 'سُجّلت الدفعة ✓', 'ok');
        loadInvoices().catch(() => {});
    } catch (err) {
        setStatus('payStatus', err.message, 'err');
    }
}

async function deletePayment(paymentId) {
    if (!confirm('حذف هذه الدفعة؟ يُسجَّل الحذف في سجل النشاط.')) return;
    try {
        showInvoice(await api('DELETE', `/api/admin/invoices/${invCurrent.id}/payments/${paymentId}`));
        loadInvoices().catch(() => {});
    } catch (err) { alert(err.message); }
}

async function cancelInvoice() {
    const reason = prompt(`سبب إلغاء الفاتورة ${invCurrent.number}؟ (تبقى برقمها في القائمة، ويمكن إصدار فاتورة جديدة للعرض)`);
    if (!reason || !reason.trim()) return;
    try {
        showInvoice(await api('POST', `/api/admin/invoices/${invCurrent.id}/cancel`, { reason: reason.trim() }));
        loadInvoices().catch(() => {});
        loadQuotes().catch(() => {});
    } catch (err) { alert(err.message); }
}

async function editInvoice() {
    const due = prompt('تاريخ الاستحقاق (YYYY-MM-DD) — اتركه فارغاً لإلغائه:', invCurrent.due_date || '');
    if (due === null) return;
    const notes = prompt('ملاحظات على الفاتورة:', invCurrent.notes || '');
    if (notes === null) return;
    try {
        showInvoice(await api('PATCH', `/api/admin/invoices/${invCurrent.id}`, { due_date: due.trim() || null, notes }));
        loadInvoices().catch(() => {});
    } catch (err) { alert(err.message); }
}

async function copyInvoiceLink() {
    const link = location.origin + invCurrent.pdf_url;
    try { await navigator.clipboard.writeText(link); alert('نُسخ الرابط ✓ — يفتح به العميل فاتورته (PDF) دون دخول'); } catch { prompt('انسخ الرابط:', link); }
}

async function downloadInvoicePdf(id, number) {
    try { await saveBlob(await authFetch('GET', `/api/admin/invoices/${id}/pdf`), `invoice-${number}.pdf`); } catch (err) { alert(err.message); }
}

const switchTabBeforeInvoices = window.switchTab;
window.switchTab = function (tabId) {
    switchTabBeforeInvoices(tabId);
    if (online && tabId === 'invoices') loadInvoices();
};
