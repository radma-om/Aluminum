/* =============================================================
   «العملاء»: one record per customer with everything linked to them
   (follow-up, quotes, invoices, work orders). Uses api(), $id(), esc(),
   setStatus(), ME, canSee(), closeSheet(), STATUS_NAMES and the open*()
   helpers of the other admin scripts.
   ============================================================= */

let custCurrent = null;
let custEditing = null;
const custMoney = (n) => Number(n || 0).toFixed(2);
const CUST_LEAD_STATUS = { new: 'جديد', needs_staff: 'يطلب موظفاً', following: 'قيد المتابعة', waiting: 'بانتظار العميل', won: 'تم البيع', lost: 'لم يتم' };
const custWhen = (s) => (s ? new Date(String(s).replace(' ', 'T') + 'Z').toLocaleDateString('ar-OM', { dateStyle: 'medium' }) : '—');

let custTimer = null;
function debouncedCustomers() { clearTimeout(custTimer); custTimer = setTimeout(loadCustomers, 250); }

async function loadCustomers() {
    if (!online) return;
    const p = new URLSearchParams();
    if ($id('custSearch').value.trim()) p.set('q', $id('custSearch').value.trim());
    if ($id('custOwes').checked) p.set('owes', '1');
    try {
        const r = await api('GET', '/api/admin/customers?' + p);
        $id('custBody').innerHTML = r.customers.map((c) => `
            <tr>
                <td data-label="العميل"><strong>${esc(c.name || '—')}</strong></td>
                <td data-label="الجوال" dir="ltr">+${esc(c.phone)}${c.phone2 ? `<br><small>+${esc(c.phone2)}</small>` : ''}</td>
                <td data-label="المنطقة">${esc(c.city || '—')}</td>
                <td data-label="العروض">${esc(c.quote_count)}</td>
                <td data-label="الفواتير">${c.invoiced ? custMoney(c.invoiced) : '—'}</td>
                <td data-label="المتبقي">${c.balance > 0.0005 ? `<strong style="color:#a93226">${custMoney(c.balance)}</strong>` : '—'}</td>
                <td data-label="أعمال مفتوحة">${c.open_jobs || '—'}</td>
                <td data-label="آخر نشاط"><small>${esc(custWhen(c.last_activity))}</small></td>
                <td data-label=""><button class="btn btn-outline btn-sm" onclick="openCustomer(${c.id})">الملف</button></td>
            </tr>`).join('') || '<tr><td colspan="9">لا يوجد عملاء بهذا البحث.</td></tr>';
        setStatus('custStatus', r.customers.length >= 300 ? 'تظهر أحدث 300 — استخدم البحث للوصول لغيرهم' : '');
    } catch (err) {
        setStatus('custStatus', err.message, 'err');
    }
}

async function openCustomer(id) {
    try {
        const r = await api('GET', `/api/admin/customers/${id}`);
        custCurrent = r;
        renderCustomer(r);
        $id('custSheet').hidden = false;
    } catch (err) { alert(err.message); }
}

function renderCustomer({ customer: c, leads, quotes, invoices, work_orders: orders, agent_stop: stop }) {
    const phone = String(c.phone).replace(/\D/g, '');
    const section = (title, body) => `<p class="sub-heading">${title}</p>${body}`;
    const table = (head, rows, empty) => rows.length
        ? `<div class="table-wrapper"><table class="stack-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
        : `<p class="status-text">${empty}</p>`;
    $id('custDetail').innerHTML = `
        <h3><i class="fas fa-address-book"></i> ${esc(c.name || 'عميل')}
            ${stop && stop.kind === 'manual' ? '<span class="badge" title="المساعد الذكي لا يرد على هذا الرقم">بلا رد آلي</span>' : ''}</h3>
        <div class="wo-line"><i class="fas fa-phone"></i> <a href="tel:+${esc(phone)}" dir="ltr">+${esc(phone)}</a>
            — <a href="https://wa.me/${esc(phone)}" target="_blank" rel="noopener">واتساب</a>
            ${c.phone2 ? ` — <span dir="ltr">+${esc(c.phone2)}</span>` : ''}${c.email ? ` — <a href="mailto:${esc(c.email)}" dir="ltr">${esc(c.email)}</a>` : ''}</div>
        <div class="wo-line"><i class="fas fa-location-dot"></i> ${esc([c.city, c.address].filter(Boolean).join(' — ') || '—')}
            ${c.map_url ? ` — <a href="${esc(c.map_url)}" target="_blank" rel="noopener">فتح الخريطة</a>` : ''}</div>
        ${c.notes ? `<div class="wo-desc">${esc(c.notes)}</div>` : ''}
        <div class="money-grid">
            <div><small>عروض الأسعار</small><strong>${esc(c.quote_count)}</strong></div>
            <div><small>إجمالي الفواتير</small><strong>${custMoney(c.invoiced)}</strong></div>
            <div><small>المدفوع</small><strong>${custMoney(c.paid)}</strong></div>
            <div><small>المتبقي</small><strong style="color:${c.balance > 0.0005 ? '#a93226' : 'inherit'}">${custMoney(c.balance)}</strong></div>
        </div>
        <div class="form-buttons" style="margin-top:0">
            <button class="btn btn-outline btn-sm" onclick="editCustomer(custCurrent.customer)">تعديل البيانات</button>
            ${!c.phone2 ? `<button class="btn btn-outline btn-sm" onclick="mergeCustomer()" title="نفس العميل مسجّل برقم آخر">دمج مع رقم آخر…</button>` : ''}
            ${canSee('quotes') ? `<button class="btn btn-primary btn-sm" onclick="closeSheet('custSheet'); openQuoteBuilder({ customer: custCurrent.customer })"><i class="fas fa-plus"></i> عرض سعر جديد</button>` : ''}
            ${canSee('work_orders') && ME.role !== 'technician' ? `<button class="btn btn-outline btn-sm" onclick="closeSheet('custSheet'); newWorkOrder({ customer: custCurrent.customer })"><i class="fas fa-screwdriver-wrench"></i> أمر صيانة / معاينة</button>` : ''}
            ${ME.role === 'manager' && !c.quote_count && !invoices.length && !orders.length ? `<button class="btn btn-outline btn-sm" style="color:#a93226" onclick="deleteCustomer()">حذف</button>` : ''}
        </div>
        ${section('<i class="fas fa-headset"></i> المتابعة والمحادثات', table(['القناة', 'الحالة', 'الموظف', 'آخر رسالة', ''],
            leads.map((l) => `<tr><td data-label="القناة">${esc({ whatsapp: 'واتساب', website: 'الموقع', calculator: 'الحاسبة' }[l.channel] || l.channel)}</td>
                <td data-label="الحالة">${esc(CUST_LEAD_STATUS[l.status] || l.status)}</td>
                <td data-label="الموظف">${esc(l.assigned_to || '—')}</td>
                <td data-label="آخر رسالة"><small>${esc(String(l.last_message || '').slice(0, 80))}</small></td>
                <td data-label="">${canSee('leads') ? `<button class="btn btn-outline btn-sm" onclick="closeSheet('custSheet'); switchTab('leads'); openLead(${l.id})">فتح</button>` : ''}</td></tr>`),
            'لا توجد محادثات مسجّلة.'))}
        ${section('<i class="fas fa-file-invoice-dollar"></i> عروض الأسعار', table(['الرقم', 'التاريخ', 'الإجمالي', 'الحالة', 'الفاتورة', ''],
            quotes.map((q) => `<tr><td data-label="الرقم"><strong>${esc(q.ref)}</strong></td>
                <td data-label="التاريخ"><small>${esc(String(q.created_at).slice(0, 10))}${q.expired ? ' <span class="badge" style="background:#fdecea;color:#a93226">منتهي</span>' : ''}</small></td>
                <td data-label="الإجمالي">${custMoney(q.total)}${q.total_to ? ' – ' + custMoney(q.total_to) : ''}</td>
                <td data-label="الحالة">${esc(STATUS_NAMES[q.status] || q.status)}</td>
                <td data-label="الفاتورة">${q.invoice ? (canSee('invoices') ? `<button class="btn btn-outline btn-sm" onclick="openInvoice(${q.invoice.id})">${esc(q.invoice.number)}</button>` : esc(q.invoice.number)) : '—'}</td>
                <td data-label="">${canSee('quotes') || canSee('leads') ? `<button class="btn btn-outline btn-sm" onclick="openQuotePdf(${q.id})">PDF</button>` : ''}</td></tr>`),
            'لا توجد عروض أسعار.'))}
        ${section('<i class="fas fa-receipt"></i> الفواتير', table(['الرقم', 'التاريخ', 'الإجمالي', 'المدفوع', 'المتبقي', 'الحالة', ''],
            invoices.map((i) => `<tr><td data-label="الرقم"><strong>${esc(i.number)}</strong></td>
                <td data-label="التاريخ"><small>${esc(i.issue_date)}</small></td>
                <td data-label="الإجمالي">${custMoney(i.total)}</td><td data-label="المدفوع">${custMoney(i.paid)}</td>
                <td data-label="المتبقي"><strong>${custMoney(i.balance)}</strong></td>
                <td data-label="الحالة"><span class="badge st-${esc(i.state)}">${esc(i.state_label)}</span></td>
                <td data-label="">${canSee('invoices') ? `<button class="btn btn-outline btn-sm" onclick="openInvoice(${i.id})">عرض</button>` : ''}</td></tr>`),
            'لا توجد فواتير.'))}
        ${section('<i class="fas fa-screwdriver-wrench"></i> أوامر العمل', table(['الرقم', 'النوع', 'الحالة', 'الموعد', 'الفني'],
            orders.map((o) => `<tr><td data-label="الرقم"><strong>${esc(o.number)}</strong></td><td data-label="النوع">${esc(o.kind_label)}</td>
                <td data-label="الحالة"><span class="badge wo-${esc(o.status)}">${esc(o.status_label)}</span></td>
                <td data-label="الموعد">${esc(o.scheduled_date || '—')}</td><td data-label="الفني">${esc(o.technician_name || '—')}</td></tr>`),
            'لا توجد أوامر عمل.'))}`;
}

function editCustomer(c) {
    custEditing = c;
    $id('custEditTitle').textContent = c ? `تعديل: ${c.name || ''}` : 'عميل جديد';
    $id('cuPhone').disabled = Boolean(c);
    $id('cuPhoneNote').textContent = c ? '(الرقم الأساسي يربط السجل ولا يُغيَّر — أضف الجديد كرقم ثانٍ)' : '';
    $id('cuName').value = c ? c.name || '' : '';
    $id('cuPhone').value = c ? '+' + c.phone : '';
    $id('cuPhone2').value = c && c.phone2 ? c.phone2 : '';
    $id('cuEmail').value = c ? c.email || '' : '';
    $id('cuCity').value = c ? c.city || '' : '';
    $id('cuAddress').value = c ? c.address || '' : '';
    $id('cuMap').value = c ? c.map_url || '' : '';
    $id('cuNotes').value = c ? c.notes || '' : '';
    setStatus('custEditStatus', '');
    $id('custEditSheet').hidden = false;
}

async function submitCustomer() {
    const body = {
        name: $id('cuName').value.trim(), phone2: $id('cuPhone2').value.trim(), email: $id('cuEmail').value.trim(),
        city: $id('cuCity').value.trim(), address: $id('cuAddress').value.trim(), map_url: $id('cuMap').value.trim(), notes: $id('cuNotes').value.trim()
    };
    try {
        let id;
        if (custEditing) {
            id = (await api('PATCH', `/api/admin/customers/${custEditing.id}`, body)).id;
        } else {
            id = (await api('POST', '/api/admin/customers', { ...body, phone: $id('cuPhone').value.trim() })).id;
        }
        closeSheet('custEditSheet');
        loadCustomers().catch(() => {});
        openCustomer(id);
    } catch (err) {
        setStatus('custEditStatus', err.message, 'err');
    }
}

/* The same customer registered under another number: join the two records */
async function mergeCustomer() {
    const phone = prompt('رقم العميل الآخر (نفس الشخص مسجّل بهذا الرقم):\nسيصبح رقماً ثانياً لهذا العميل، وتنضم إليه عروضه وفواتيره ومحادثاته.');
    if (!phone || !phone.trim()) return;
    try {
        await api('POST', `/api/admin/customers/${custCurrent.customer.id}/merge`, { phone: phone.trim() });
        loadCustomers().catch(() => {});
        openCustomer(custCurrent.customer.id);
    } catch (err) { alert(err.message); }
}

async function deleteCustomer() {
    if (!confirm('حذف هذا العميل من السجل؟ (لا توجد له عروض أو فواتير أو أوامر عمل)')) return;
    try {
        await api('DELETE', `/api/admin/customers/${custCurrent.customer.id}`);
        closeSheet('custSheet');
        loadCustomers();
    } catch (err) { alert(err.message); }
}

const switchTabBeforeCustomers = window.switchTab;
window.switchTab = function (tabId) {
    switchTabBeforeCustomers(tabId);
    if (online && tabId === 'customers') loadCustomers();
};
