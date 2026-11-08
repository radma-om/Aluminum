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
const WO_CHIPS = [['open', 'المفتوحة'], ['new', 'بانتظار الجدولة'], ['scheduled', 'مجدول'], ['in_progress', 'قيد التنفيذ'], ['done', 'مكتمل'], ['cancelled', 'ملغى'], ['', 'الكل']];

function renderWoChips() {
    $id('woChips').innerHTML = WO_CHIPS.map(([k, label]) =>
        `<button type="button" class="chip ${woFilter === k ? 'on' : ''}" onclick="woFilter='${k}'; renderWoChips(); loadWorkOrders()">${esc(label)}</button>`).join('');
}

let woTimer = null;
function debouncedWorkOrders() { clearTimeout(woTimer); woTimer = setTimeout(loadWorkOrders, 250); }

async function loadWorkOrders() {
    if (!online) return;
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
    try { await api('POST', `/api/admin/work-orders/${id}/cancel`, { reason: reason.trim() }); await loadWorkOrders(); } catch (err) { alert(err.message); }
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
            await api('PATCH', `/api/admin/work-orders/${woEditing.id}`, body);
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
