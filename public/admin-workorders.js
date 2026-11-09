/* =============================================================
   «أوامر العمل»: the office creates, schedules and assigns jobs; a
   technician sees only their own (phone first, no prices), starts the
   job, writes what was done and closes it — or sends it back for a new
   appointment. Uses api(), $id(), esc(), setStatus(), ME, canSee(),
   closeSheet() from the other admin scripts.
   ============================================================= */

let woMeta = { kinds: {}, statuses: {}, technicians: [] };
let woFilter = 'open';
let woOrders = [];
let woEditing = null;   // order being edited, or null for a new one
let woSourceRef = null; // { invoice } when made from an invoice

const isTech = () => ME && ME.role === 'technician';
let woPendingRequests = 0;
const WO_CHIPS = [['requests', 'طلبات المواعيد'], ['open', 'المفتوحة'], ['new', 'بانتظار الجدولة'], ['scheduled', 'مجدول'], ['in_progress', 'قيد التنفيذ'], ['done', 'مكتمل'], ['cancelled', 'ملغى'], ['', 'الكل']];

function renderWoChips() {
    $id('woChips').innerHTML = WO_CHIPS.filter(([k]) => k !== 'requests' || !isTech()).map(([k, label]) =>
        `<button type="button" class="chip ${woFilter === k ? 'on' : ''}" onclick="woFilter='${k}'; renderWoChips(); loadWorkOrders()">${esc(label)}${k === 'requests' && woPendingRequests ? ` <span class="badge" style="background:#e67e22;color:#fff">${woPendingRequests}</span>` : ''}</button>`).join('');
}

let woTimer = null;
function debouncedWorkOrders() { clearTimeout(woTimer); woTimer = setTimeout(loadWorkOrders, 250); }

async function loadWorkOrders() {
    if (!online) return;
    if (woFilter === 'requests' && !isTech()) return loadRequests();
    $id('srNew').hidden = true;
    const p = new URLSearchParams();
    if (woFilter === 'open') p.set('open', '1');
    else if (woFilter) p.set('status', woFilter);
    if (!isTech() && $id('woTech').value) p.set('technician', $id('woTech').value);
    if ($id('woSearch').value.trim()) p.set('q', $id('woSearch').value.trim());
    try {
        const r = await api('GET', '/api/admin/work-orders?' + p);
        const keep = $id('woTech').value;
        woMeta = { kinds: r.kinds, statuses: r.statuses, technicians: r.technicians };
        if (!isTech()) {
            $id('woTech').innerHTML = '<option value="">كل الفنيين</option><option value="-">بدون فني</option>'
                + r.technicians.filter((t) => t.active).map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
            $id('woTech').value = keep;
        }
        $id('woTitle').textContent = isTech() ? 'أعمالي' : 'أوامر العمل — التركيب والصيانة';
        woOrders = r.orders;
        if (woPendingRequests !== (r.pending_requests || 0)) { woPendingRequests = r.pending_requests || 0; renderWoChips(); }
        renderWorkOrders();
        setStatus('woStatus', '');
    } catch (err) {
        setStatus('woStatus', err.message, 'err');
    }
}

function renderWorkOrders() {
    const today = new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
    $id('woList').innerHTML = woOrders.map((o) => {
        const phone = String(o.customer_phone).replace(/\D/g, '');
        const late = o.scheduled_date && o.scheduled_date < today && ['scheduled', 'in_progress'].includes(o.status);
        const open = ['new', 'scheduled', 'in_progress'].includes(o.status);
        const techActions = isTech() && open ? [
            o.status === 'scheduled' ? `<button class="btn btn-primary" onclick="woMove(${o.id}, 'in_progress')"><i class="fas fa-play"></i> بدأت العمل</button>` : '',
            `<button class="btn btn-primary" style="background:var(--success);border-color:var(--success)" onclick="woMove(${o.id}, 'done')"><i class="fas fa-check"></i> اكتمل</button>`,
            `<button class="btn btn-outline" onclick="woMove(${o.id}, 'new')">تعذّر — موعد جديد</button>`
        ].join('') : '';
        const officeActions = !isTech() && open ? [
            `<button class="btn btn-outline btn-sm" onclick="editWorkOrder(${o.id})">تعديل / جدولة</button>`,
            `<button class="btn btn-outline btn-sm" onclick="woMove(${o.id}, 'done')">تسجيل الإنجاز</button>`,
            `<button class="btn btn-outline btn-sm" style="color:#a93226" onclick="woCancel(${o.id})">إلغاء</button>`
        ].join('') : '';
        return `<div class="wo-card ${esc(o.status)}">
            <div class="wo-head">
                <strong>${esc(o.number)}</strong>
                <span class="badge">${esc(o.kind_label)}</span>
                <span class="badge wo-${esc(o.status)}">${esc(o.status_label)}</span>
                ${late ? '<span class="badge" style="background:#fdecea;color:#a93226">متأخر</span>' : ''}
            </div>
            <div class="wo-line"><i class="fas fa-user"></i> <strong>${esc(o.customer_name)}</strong>
                — <a href="tel:+${esc(phone)}" dir="ltr">+${esc(phone)}</a>
                — <a href="https://wa.me/${esc(phone)}" target="_blank" rel="noopener">واتساب</a></div>
            <div class="wo-line"><i class="fas fa-location-dot"></i> ${esc([o.location, o.address].filter(Boolean).join(' — ') || '—')}
                ${o.map_url ? ` — <a href="${esc(o.map_url)}" target="_blank" rel="noopener">فتح الخريطة</a>` : ''}</div>
            <div class="wo-line"><i class="fas fa-calendar"></i> ${o.scheduled_date ? esc(o.scheduled_date + (o.scheduled_time ? ' — ' + o.scheduled_time : '')) : '<span style="color:#8a5a00">لم يُحدد موعد</span>'}
                ${!isTech() ? ` — <i class="fas fa-helmet-safety"></i> ${esc(o.technician_name || 'بدون فني')}` : ''}</div>
            <div class="wo-desc">${esc(o.description)}</div>
            ${o.completion_note ? `<div class="wo-line"><i class="fas fa-check"></i> ما تم: ${esc(o.completion_note)}</div>` : ''}
            <div class="wo-actions">
                ${techActions}${officeActions}
                <button class="btn btn-outline btn-sm" onclick="woNote(${o.id})">ملاحظة</button>
                <button class="btn btn-outline btn-sm" onclick="woHistory(${o.id}, this)">السجل</button>
            </div>
            <div class="wo-events" id="woEvents${o.id}" hidden></div>
        </div>`;
    }).join('') || `<div class="empty-chart" style="padding:30px 10px">${isTech() ? 'لا توجد أعمال مسندة إليك الآن 👍' : 'لا توجد أوامر عمل بهذا التصنيف'}</div>`;
}

async function woMove(id, status) {
    let note = '';
    if (status === 'done') {
        note = prompt('ما الذي تم إنجازه؟ (مثلاً: رُكّبت البوابة وجُرّبت مع العميل وسُلّم الريموت)');
        if (note === null || !note.trim()) return;
    } else if (status === 'new') {
        note = prompt('سبب الحاجة لموعد جديد (مثلاً: العميل غير موجود، الموقع غير جاهز):');
        if (note === null || !note.trim()) return;
    }
    try {
        await api('POST', `/api/admin/work-orders/${id}/status`, { status, note: note.trim() });
        await loadWorkOrders();
    } catch (err) { alert(err.message); }
}

async function woNote(id) {
    const text = prompt('الملاحظة:');
    if (!text || !text.trim()) return;
    try { await api('POST', `/api/admin/work-orders/${id}/notes`, { text: text.trim() }); await woHistory(id, null, true); } catch (err) { alert(err.message); }
}

async function woHistory(id, btn, forceOpen = false) {
    const box = $id('woEvents' + id);
    if (!forceOpen && !box.hidden) { box.hidden = true; return; }
    try {
        const o = await api('GET', `/api/admin/work-orders/${id}`);
        const when = (s) => new Date(String(s).replace(' ', 'T') + 'Z').toLocaleString('ar-OM', { dateStyle: 'medium', timeStyle: 'short' });
        box.innerHTML = o.events.map((e) => `• ${esc(when(e.created_at))}${e.author ? ' — ' + esc(e.author) : ''}: ${esc(e.text)}`).join('<br>');
        box.hidden = false;
    } catch (err) { alert(err.message); }
}

async function woCancel(id) {
    const reason = prompt('سبب إلغاء أمر العمل:');
    if (!reason || !reason.trim()) return;
    const notify = confirm('إبلاغ العميل بالإلغاء على واتساب؟ (السبب يصله في الرسالة)');
    try {
        const r = await api('POST', `/api/admin/work-orders/${id}/cancel`, { reason: reason.trim(), notify_customer: notify });
        woNoticeAlert(r.notice);
        await loadWorkOrders();
    } catch (err) { alert(err.message); }
}

/* What happened to the WhatsApp message to the customer (the change itself is saved either way) */
function woNoticeAlert(notice) {
    if (notice && !notice.ok) alert(`تم الحفظ ✓ لكن لم تصل رسالة واتساب للعميل:\n${notice.error}\n\nإذا مرّ أكثر من 24 ساعة على آخر رسالة منه فواتساب لا يسمح إلا بالقوالب — اتصل به أو راسله يدوياً.`);
}

/* ---- Create / edit (office) ---- */

async function ensureWoMeta() {
    if (Object.keys(woMeta.kinds).length) return;
    const r = await api('GET', '/api/admin/work-orders?status=none');
    woMeta = { kinds: r.kinds, statuses: r.statuses, technicians: r.technicians };
}

function fillWoSelects(order) {
    $id('woKind').innerHTML = Object.entries(woMeta.kinds).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
    $id('woTechSel').innerHTML = '<option value="">— بدون فني الآن —</option>'
        + woMeta.technicians.filter((t) => t.active || (order && order.technician_id === t.id))
            .map((t) => `<option value="${t.id}">${esc(t.name)}${t.has_email ? '' : ' (بلا بريد)'}</option>`).join('');
}

async function newWorkOrder(source = null) {
    try { await ensureWoMeta(); } catch (err) { return alert(err.message); }
    woEditing = null;
    woSourceRef = source;
    fillWoSelects(null);
    const inv = source && source.invoice;
    const cust = source && source.customer;
    $id('woSheetTitle').textContent = 'أمر عمل جديد';
    $id('woSource').textContent = inv ? `من الفاتورة ${inv.number} — ${inv.customer_name} (+${inv.customer_phone}). المطلوب يُكتب تلقائياً من بنود الفاتورة (بدون أسعار) — عدّله إن أردت.` : 'زيارة صيانة أو معاينة لعميل: اكتب بياناته.';
    document.querySelectorAll('.wo-manual').forEach((el) => { el.hidden = Boolean(inv); });
    $id('woKind').value = 'installation';
    for (const id of ['woName', 'woPhone', 'woAddress', 'woMap', 'woDate', 'woTime', 'woDesc']) $id(id).value = '';
    $id('woLocation').value = inv ? (inv.customer_city || '') : '';
    $id('woAddress').value = inv ? (inv.customer_address || '') : '';
    if (cust) {
        $id('woSource').textContent = `زيارة صيانة أو معاينة لـ ${cust.name || ''} (+${cust.phone}).`;
        $id('woName').value = cust.name || '';
        $id('woPhone').value = cust.phone;
        $id('woLocation').value = cust.city || '';
        $id('woAddress').value = cust.address || '';
        $id('woMap').value = cust.map_url || '';
        $id('woKind').value = 'maintenance';
    }
    $id('woTechSel').value = '';
    $id('woSubmit').textContent = 'إنشاء أمر العمل';
    $id('woNotifyRow').hidden = true;
    setStatus('woSheetStatus', '');
    $id('woSheet').hidden = false;
}

async function editWorkOrder(id) {
    try { await ensureWoMeta(); } catch (err) { return alert(err.message); }
    const o = woOrders.find((x) => x.id === id);
    if (!o) return;
    woEditing = o;
    woSourceRef = null;
    fillWoSelects(o);
    $id('woSheetTitle').textContent = `تعديل / جدولة ${o.number}`;
    $id('woSource').textContent = `${o.customer_name} — +${o.customer_phone}`;
    document.querySelectorAll('.wo-manual').forEach((el) => { el.hidden = true; });
    $id('woKind').value = o.kind;
    $id('woLocation').value = o.location || '';
    $id('woAddress').value = o.address || '';
    $id('woMap').value = o.map_url || '';
    $id('woDate').value = o.scheduled_date || '';
    $id('woTime').value = o.scheduled_time || '';
    $id('woTechSel').value = o.technician_id || '';
    $id('woDesc').value = o.description;
    $id('woSubmit').textContent = 'حفظ';
    $id('woNotifyRow').hidden = false;
    $id('woNotify').checked = Boolean(o.scheduled_date);
    setStatus('woSheetStatus', '');
    $id('woSheet').hidden = false;
}

async function submitWorkOrder() {
    const body = {
        kind: $id('woKind').value, location: $id('woLocation').value.trim(), address: $id('woAddress').value.trim(),
        map_url: $id('woMap').value.trim(), scheduled_date: $id('woDate').value || null, scheduled_time: $id('woTime').value.trim(),
        technician_id: $id('woTechSel').value ? Number($id('woTechSel').value) : null
    };
    if ($id('woDesc').value.trim() || woEditing) body.description = $id('woDesc').value.trim();
    try {
        if (woEditing) {
            const r = await api('PATCH', `/api/admin/work-orders/${woEditing.id}`, { ...body, notify_customer: $id('woNotify').checked });
            woNoticeAlert(r.notice);
        } else if (woSourceRef && woSourceRef.invoice) {
            await api('POST', '/api/admin/work-orders', { ...body, invoice_id: woSourceRef.invoice.id });
        } else {
            await api('POST', '/api/admin/work-orders', { ...body, customer_name: $id('woName').value.trim(), customer_phone: $id('woPhone').value.trim() });
        }
        closeSheet('woSheet');
        if (document.querySelector('#tab-work_orders.active')) await loadWorkOrders();
        else switchTab('work_orders');
    } catch (err) {
        setStatus('woSheetStatus', err.message, 'err');
    }
}

const switchTabBeforeWorkOrders = window.switchTab;
window.switchTab = function (tabId) {
    switchTabBeforeWorkOrders(tabId);
    if (online && tabId === 'work_orders') { renderWoChips(); loadWorkOrders(); }
};

/* ==================== Appointment requests from customers ====================
   The AI assistant (WhatsApp / website) or the office records a request; the responsible employee
   approves it with an appointment (→ a work order, the customer is told on WhatsApp) or declines it. */
let srList = [];
let srMeta = { kinds: {}, periods: {} };
let srFilter = 'pending';
let srApproving = null;
const SR_SOURCES = { mazbot: 'واتساب (المساعد)', whatsapp: 'واتساب (المساعد)', website: 'الموقع (المساعد)', staff: 'المكتب' };
const DAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const srDay = (d) => (d ? `${DAY_NAMES[new Date(d + 'T00:00:00Z').getUTCDay()]} ${d}` : '');

async function loadRequests() {
    $id('srNew').hidden = false;
    const p = new URLSearchParams();
    if (srFilter) p.set('status', srFilter);
    if ($id('woSearch').value.trim()) p.set('q', $id('woSearch').value.trim());
    try {
        const r = await api('GET', '/api/admin/service-requests?' + p);
        srMeta = { kinds: r.kinds, periods: r.periods };
        srList = r.requests;
        const pending = srFilter === 'pending' ? srList.length : woPendingRequests;
        if (pending !== woPendingRequests) { woPendingRequests = pending; renderWoChips(); }
        renderRequests();
        setStatus('woStatus', '');
    } catch (err) { setStatus('woStatus', err.message, 'err'); }
}

function renderRequests() {
    const tabs = [['pending', 'بانتظار الموافقة'], ['approved', 'تمت الموافقة'], ['rejected', 'مرفوض'], ['', 'الكل']].map(([k, l]) =>
        `<button type="button" class="chip ${srFilter === k ? 'on' : ''}" onclick="srFilter='${k}'; loadRequests()">${l}</button>`).join('');
    const notice = (r) => !r.customer_notice ? '' : r.customer_notice === 'sent'
        ? '<span class="status-text" style="color:var(--success)">✓ أُبلغ العميل على واتساب</span>'
        : `<span class="status-text" style="color:#a93226">⚠️ لم تصل رسالة واتساب للعميل — تواصل معه</span>`;
    $id('woList').innerHTML = `<div class="check-row" style="margin:0 0 10px; gap:6px">${tabs}</div>` + (srList.map((r) => {
        const phone = String(r.customer_phone).replace(/\D/g, '');
        return `<div class="wo-card ${r.status === 'pending' ? '' : 'done'}">
            <div class="wo-head"><strong>${esc(r.ref)}</strong> <span class="badge">${esc(r.kind_label)}</span>
                <span class="badge" style="${r.status === 'pending' ? 'background:#fff4e5;color:#8a5a00' : ''}">${esc(r.status_label)}</span>
                <span class="status-text">${esc(SR_SOURCES[r.source] || r.source || '')} — ${esc(String(r.created_at).slice(0, 16))}</span></div>
            <div class="wo-line"><i class="fas fa-user"></i> <strong>${esc(r.customer_name)}</strong>
                — <a href="tel:+${esc(phone)}" dir="ltr">+${esc(phone)}</a>
                — <a href="https://wa.me/${esc(phone)}" target="_blank" rel="noopener">واتساب</a></div>
            <div class="wo-line"><i class="fas fa-location-dot"></i> ${esc([r.location, r.address].filter(Boolean).join(' — ') || '—')}</div>
            <div class="wo-line"><i class="fas fa-calendar"></i> يفضّل: ${r.preferred_date ? esc(srDay(r.preferred_date)) : 'غير محدد'}${r.period_label ? ' — ' + esc(r.period_label) : ''}</div>
            <div class="wo-desc">${esc(r.description)}</div>
            ${r.status === 'approved' ? `<div class="wo-line"><i class="fas fa-check"></i> الموعد: ${esc(srDay(r.scheduled_date))}${r.scheduled_time ? ' — ' + esc(r.scheduled_time) : ''} — أمر العمل ${esc(r.work_order_number || '')}${r.decided_by ? ' — ' + esc(r.decided_by) : ''}</div>` : ''}
            ${r.status === 'rejected' ? `<div class="wo-line"><i class="fas fa-xmark"></i> السبب: ${esc(r.decision_note || '')}${r.decided_by ? ' — ' + esc(r.decided_by) : ''}</div>` : ''}
            ${notice(r)}
            ${r.status === 'pending' ? `<div class="wo-actions">
                <button class="btn btn-primary btn-sm" onclick="openApprove(${r.id})"><i class="fas fa-calendar-check"></i> موافقة وتحديد الموعد</button>
                <button class="btn btn-outline btn-sm" style="color:#a93226" onclick="rejectRequest(${r.id})">رفض</button>
            </div>` : ''}
        </div>`;
    }).join('') || '<div class="empty-chart" style="padding:30px 10px">لا توجد طلبات بهذا التصنيف</div>');
}

async function openApprove(id) {
    try { await ensureWoMeta(); } catch (err) { return alert(err.message); }
    const r = srList.find((x) => x.id === id);
    if (!r) return;
    srApproving = r;
    $id('srTitle').textContent = `موافقة على ${r.ref} — ${r.kind_label}`;
    $id('srInfo').textContent = `${r.customer_name} (+${r.customer_phone}) — يفضّل ${r.preferred_date ? srDay(r.preferred_date) : 'أي يوم'}${r.period_label ? ' ' + r.period_label : ''}`;
    $id('srKind').innerHTML = Object.entries(woMeta.kinds).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
    $id('srKind').value = r.kind;
    $id('srTech').innerHTML = '<option value="">— بدون فني الآن —</option>' + woMeta.technicians.filter((t) => t.active).map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
    $id('srDate').value = r.preferred_date || '';
    $id('srTime').value = r.preferred_period === 'morning' ? '9 صباحاً' : r.preferred_period === 'evening' ? '4 مساءً' : '';
    $id('srAddress').value = r.address || '';
    $id('srMap').value = '';
    $id('srDesc').value = r.description;
    $id('srNote').value = '';
    $id('srNotify').checked = true;
    setStatus('srStatus', '');
    $id('srSheet').hidden = false;
}

async function submitApprove() {
    const r = srApproving;
    try {
        const out = await api('POST', `/api/admin/service-requests/${r.id}/approve`, {
            kind: $id('srKind').value, scheduled_date: $id('srDate').value, scheduled_time: $id('srTime').value.trim(),
            technician_id: $id('srTech').value ? Number($id('srTech').value) : null, address: $id('srAddress').value.trim(),
            map_url: $id('srMap').value.trim(), description: $id('srDesc').value.trim(), note: $id('srNote').value.trim(),
            notify: $id('srNotify').checked
        });
        closeSheet('srSheet');
        if (out.notice && out.notice.ok) alert(`تم ✓ أمر العمل ${out.order.number}، وأُرسل تأكيد الموعد للعميل على واتساب.`);
        else if (out.notice) woNoticeAlert(out.notice);
        else alert(`تم ✓ أمر العمل ${out.order.number}.`);
        await loadRequests();
    } catch (err) { setStatus('srStatus', err.message, 'err'); }
}

async function rejectRequest(id) {
    const reason = prompt('سبب الرفض (يصل للعميل في رسالة واتساب):');
    if (!reason || !reason.trim()) return;
    const notify = confirm('إرسال الرسالة للعميل على واتساب الآن؟');
    try {
        const out = await api('POST', `/api/admin/service-requests/${id}/reject`, { reason: reason.trim(), notify });
        woNoticeAlert(out.notice);
        await loadRequests();
    } catch (err) { alert(err.message); }
}

/* The office records a request taken by phone (then approves it like any other) */
async function newRequest() {
    try { await ensureWoMeta(); } catch (err) { return alert(err.message); }
    $id('srnKind').innerHTML = Object.entries(woMeta.kinds).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
    $id('srnKind').value = 'maintenance';
    for (const id of ['srnName', 'srnPhone', 'srnLocation', 'srnAddress', 'srnDate', 'srnDesc']) $id(id).value = '';
    $id('srnPeriod').value = '';
    setStatus('srnStatus', '');
    $id('srnSheet').hidden = false;
}

async function submitNewRequest() {
    try {
        await api('POST', '/api/admin/service-requests', {
            kind: $id('srnKind').value, customer_name: $id('srnName').value.trim(), customer_phone: $id('srnPhone').value.trim(),
            location: $id('srnLocation').value.trim(), address: $id('srnAddress').value.trim(),
            preferred_date: $id('srnDate').value || null, preferred_period: $id('srnPeriod').value || null, description: $id('srnDesc').value.trim()
        });
        closeSheet('srnSheet');
        srFilter = 'pending';
        await loadRequests();
    } catch (err) { setStatus('srnStatus', err.message, 'err'); }
}
