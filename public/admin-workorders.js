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
        loadWoBoard();
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
            o.status === 'scheduled' ? `<button class="btn btn-outline" onclick="woOnTheWay(${o.id}, this)"><i class="fas fa-truck"></i> في الطريق</button>` : '',
            o.status === 'scheduled' ? `<button class="btn btn-primary" onclick="woMove(${o.id}, 'in_progress')"><i class="fas fa-play"></i> بدأت العمل</button>` : '',
            `<button class="btn btn-outline" onclick="woService(${o.id})"><i class="fas fa-screwdriver-wrench"></i> إضافة خدمة</button>`,
            `<button class="btn btn-primary" style="background:var(--success);border-color:var(--success)" onclick="woMove(${o.id}, 'done')"><i class="fas fa-check"></i> اكتمل</button>`,
            `<button class="btn btn-outline" onclick="woMove(${o.id}, 'new')">تعذّر — موعد جديد</button>`
        ].join('') : '';
        const officeActions = !isTech() && open ? [
            `<button class="btn btn-outline btn-sm" onclick="editWorkOrder(${o.id})">تعديل / جدولة</button>`,
            `<button class="btn btn-outline btn-sm" onclick="woService(${o.id})">إضافة خدمة</button>`,
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
            ${!isTech() && o.tech_last_text ? `<div class="wo-report"><i class="fas fa-helmet-safety"></i> <b>آخر تقرير من الفني</b>
                <small>${esc(o.tech_last_author || '')} — ${esc(woAgo(o.tech_last_at))}${o.tech_reports > 1 ? ` — ${o.tech_reports} تقارير` : ''}</small>
                <div>${esc(o.tech_last_text)}</div></div>` : ''}
            ${o.invoice_number ? `<div class="wo-line"><i class="fas fa-receipt"></i> الفاتورة ${esc(o.invoice_number)}</div>` : ''}
            <div class="wo-actions">
                ${techActions}${officeActions}${!isTech() && o.status === 'done' ? `<button class="btn btn-outline btn-sm" onclick="woService(${o.id})">إضافة خدمة</button>` : ''}
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
        note = await askText('ما الذي تم إنجازه؟ (مثلاً: رُكّبت البوابة وجُرّبت مع العميل وسُلّم الريموت)', '', { multiline: true, okLabel: 'اكتمل' });
        if (note === null || !note.trim()) return;
    } else if (status === 'new') {
        note = await askText('سبب الحاجة لموعد جديد (مثلاً: العميل غير موجود، الموقع غير جاهز):', '', { multiline: true });
        if (note === null || !note.trim()) return;
    }
    try {
        await api('POST', `/api/admin/work-orders/${id}/status`, { status, note: note.trim() });
        await loadWorkOrders();
    } catch (err) { alert(err.message); }
}

/* After a service is saved: the invoice, its PDF and the WhatsApp message to the customer */
function serviceResult(r, again) {
    const link = location.origin + (r.invoice.track_url || r.invoice.pdf_url);
    const pdf = location.origin + r.invoice.pdf_url;
    const phone = String(r.invoice.customer_phone || '').replace(/\D/g, '');
    const wa = `https://wa.me/${encodeURIComponent(phone)}?text=${encodeURIComponent(`فاتورة رقم ${r.invoice.number} — الإجمالي ${Number(r.invoice.total).toFixed(3)} ر.ع\nتتبع طلبك والفاتورة: ${link}`)}`;
    const added = (r.lines || [r.line]).reduce((s, l) => s + Number(l.line_total || 0), 0);
    return `
        <p class="status-text ok" style="font-weight:700">✓ أُضيفت الخدمة إلى الفاتورة ${esc(r.invoice.number)}</p>
        <div class="money-grid">
            <div><small>الخدمة</small><strong>${added.toFixed(3)}</strong></div>
            <div><small>إجمالي الفاتورة (شامل الضريبة)</small><strong>${Number(r.invoice.total).toFixed(3)}</strong></div>
            <div><small>المتبقي على العميل</small><strong>${Number(r.invoice.balance).toFixed(3)}</strong></div>
        </div>
        <div class="form-buttons stack-mobile">
            <a class="btn btn-primary" href="${esc(pdf)}" target="_blank" rel="noopener"><i class="fas fa-file-pdf"></i> فتح الفاتورة PDF</a>
            ${r.order ? `<button class="btn btn-outline" type="button" onclick="woSendInvoice(${r.order.id}, ${r.invoice.id}, this)"><i class="fab fa-whatsapp"></i> إرسال للعميل من رقم الشركة</button>` : ''}
            <a class="btn btn-outline" href="${esc(wa)}" target="_blank" rel="noopener"><i class="fab fa-whatsapp"></i> واتساب من جوالي</a>
            <button class="btn btn-outline" type="button" onclick="${again}">خدمة أخرى</button>
        </div>`;
}

/* The invoice to the customer from the company's number (MazBot) */
async function woSendInvoice(orderId, invoiceId, btn) {
    btn.disabled = true;
    try {
        const r = await api('POST', `/api/admin/work-orders/${orderId}/whatsapp`, { invoice_id: invoiceId });
        if (r.ok) btn.innerHTML = '<i class="fab fa-whatsapp"></i> أُرسلت للعميل ✓';
        else { btn.disabled = false; await tell(`لم تُرسل: ${r.error}\n\nأرسلها من جوالك بزر «واتساب من جوالي».`); }
    } catch (err) { btn.disabled = false; tell(err.message); }
}

/* ---- A service call for a new or known customer (no work order yet) ---- */
let svTimer = null;
function newServiceVisit() {
    $id('svForm').reset();
    $id('svForm').hidden = false;
    $id('svDoneBox').hidden = true;
    $id('svKnown').textContent = '';
    $id('svLines').innerHTML = '';
    $id('svDone').checked = true;
    $id('svSave').disabled = false;
    setStatus('svStatus', '');
    svAddLine();
    $id('svSheet').hidden = false;
    setTimeout(() => $id('svPhone').focus(), 50);
}
function svAddLine() {
    const box = document.createElement('div');
    box.className = 'sv-line';
    box.innerHTML = `
        <div class="form-group"><label>اسم الخدمة</label><input type="text" data-f="title" maxlength="120" value="خدمة" placeholder="مثلاً: صيانة محرك، تغيير ريموت"></div>
        <div class="form-group"><label>وصف الخدمة <span class="unit">(يظهر للعميل في الفاتورة)</span></label><textarea data-f="description" rows="2" maxlength="1000" placeholder="ما الذي تم عمله؟"></textarea></div>
        <div class="form-grid two">
            <div class="form-group"><label>الكمية</label><input type="number" data-f="quantity" min="0.01" step="0.01" value="1" inputmode="decimal"></div>
            <div class="form-group"><label>السعر <span class="unit">(ر.ع — قبل الضريبة)</span></label><input type="number" data-f="unit_price" min="0.01" step="0.01" inputmode="decimal"></div>
        </div>
        ${$id('svLines').children.length ? '<button type="button" class="link-btn" onclick="this.closest(\'.sv-line\').remove(); svSum()">حذف هذه الخدمة</button>' : ''}`;
    box.addEventListener('input', svSum);
    $id('svLines').appendChild(box);
    svSum();
}
const svServices = () => [...$id('svLines').querySelectorAll('.sv-line')].map((b) => ({
    title: b.querySelector('[data-f="title"]').value.trim(),
    description: b.querySelector('[data-f="description"]').value.trim(),
    quantity: Number(b.querySelector('[data-f="quantity"]').value) || 1,
    unit_price: Number(b.querySelector('[data-f="unit_price"]').value) || 0
}));
function svSum() {
    const t = svServices().reduce((s, l) => s + l.quantity * l.unit_price, 0);
    $id('svTotal').textContent = t > 0 ? `المجموع ${t.toFixed(3)} ر.ع قبل الضريبة` : '';
}
function svLookupSoon() { clearTimeout(svTimer); svTimer = setTimeout(svLookup, 400); }
async function svLookup() {
    const phone = $id('svPhone').value.replace(/\D/g, '');
    if (phone.length < 8) { $id('svKnown').textContent = ''; return; }
    try {
        const r = await api('GET', '/api/admin/work-orders/customer-lookup?phone=' + encodeURIComponent(phone));
        if (r.found) {
            $id('svKnown').textContent = '✓ عميل موجود في السجل';
            if (!$id('svName').value) $id('svName').value = r.name || '';
            if (!$id('svCity').value) $id('svCity').value = r.city || '';
            if (!$id('svAddress').value) $id('svAddress').value = r.address || '';
        } else {
            $id('svKnown').textContent = 'عميل جديد — يُضاف إلى السجل';
        }
    } catch { /* the save checks it anyway */ }
}
async function submitServiceVisit() {
    const services = svServices();
    if (services.some((l) => !l.description)) return setStatus('svStatus', 'اكتب وصف الخدمة', 'err');
    if (services.some((l) => !(l.unit_price > 0))) return setStatus('svStatus', 'اكتب سعر الخدمة', 'err');
    $id('svSave').disabled = true;
    setStatus('svStatus', 'جاري الحفظ...');
    try {
        const r = await api('POST', '/api/admin/work-orders/service-visit', {
            customer: { phone: $id('svPhone').value, name: $id('svName').value.trim(), city: $id('svCity').value.trim(), address: $id('svAddress').value.trim() },
            services, done: $id('svDone').checked
        });
        $id('svForm').hidden = true;
        $id('svDoneBox').innerHTML = serviceResult(r, 'newServiceVisit()').replace('✓ أُضيفت الخدمة إلى الفاتورة', '✓ صدرت الفاتورة')
            + `<p class="status-text">أمر العمل ${esc(r.order.number)} — ${esc(r.order.status_label)}${r.new_customer ? ' — أُضيف العميل إلى السجل' : ''}</p>`;
        $id('svDoneBox').hidden = false;
        loadWorkOrders().catch(() => {});
    } catch (err) {
        setStatus('svStatus', err.message, 'err');
        $id('svSave').disabled = false;
    }
}

/* ---- A service done on site: its description and price go on the order's invoice, then the PDF ---- */
let woServiceOrder = null;
function woService(id) {
    woServiceOrder = woOrders.find((o) => o.id === id) || { id };
    const o = woServiceOrder;
    $id('woServiceFor').textContent = `${o.number || ''} — ${o.customer_name || ''}` + (o.invoice_number ? '' : ' — تُصدر لها فاتورة جديدة');
    // With an invoice already: on it, or a service invoice of its own
    $id('wsWhere').hidden = !o.invoice_number;
    $id('wsInvNo').textContent = o.invoice_number || '';
    document.querySelector('input[name="wsWhere"][value="same"]').checked = true;
    woServiceWhere();
    $id('wsTitle').value = 'خدمة';
    $id('wsDesc').value = '';
    $id('wsQty').value = '1';
    $id('wsPrice').value = '';
    $id('woServiceForm').hidden = false;
    $id('woServiceDone').hidden = true;
    $id('wsSave').disabled = false;
    setStatus('wsStatus', '');
    woServiceTotal();
    $id('woServiceSheet').hidden = false;
    setTimeout(() => $id('wsDesc').focus(), 50);
}
const woServiceSeparate = () => !$id('wsWhere').hidden && document.querySelector('input[name="wsWhere"]:checked').value === 'separate';
function woServiceWhere() {
    $id('wsSave').innerHTML = woServiceSeparate() || $id('wsWhere').hidden
        ? '<i class="fas fa-file-invoice"></i> إصدار فاتورة الخدمة' : '<i class="fas fa-file-invoice"></i> إضافة إلى الفاتورة';
}
function woServiceTotal() {
    const t = (Number($id('wsQty').value) || 0) * (Number($id('wsPrice').value) || 0);
    $id('wsTotal').textContent = t > 0 ? `المجموع ${t.toFixed(3)} ر.ع قبل الضريبة` : '';
}
async function submitWoService() {
    const body = { title: $id('wsTitle').value.trim(), description: $id('wsDesc').value.trim(), quantity: Number($id('wsQty').value), unit_price: Number($id('wsPrice').value), separate: woServiceSeparate() };
    if (!body.description) return setStatus('wsStatus', 'اكتب وصف الخدمة', 'err');
    if (!(body.unit_price > 0)) return setStatus('wsStatus', 'اكتب سعر الخدمة', 'err');
    $id('wsSave').disabled = true;
    setStatus('wsStatus', 'جاري الحفظ...');
    try {
        const r = await api('POST', `/api/admin/work-orders/${woServiceOrder.id}/services`, body);
        $id('woServiceForm').hidden = true;
        $id('woServiceDone').innerHTML = r.separate
            ? serviceResult(r, `woService(${woServiceOrder.id})`).replace('✓ أُضيفت الخدمة إلى الفاتورة', '✓ صدرت فاتورة خدمة منفصلة')
            : serviceResult(r, `woService(${woServiceOrder.id})`);
        $id('woServiceDone').hidden = false;
        if (!r.separate) woServiceOrder = { ...woServiceOrder, invoice_number: r.invoice.number };
        loadWorkOrders().catch(() => {});
    } catch (err) {
        setStatus('wsStatus', err.message, 'err');
        $id('wsSave').disabled = false;
    }
}

async function woNote(id) {
    const text = await askText('الملاحظة:', '', { multiline: true });
    if (!text || !text.trim()) return;
    try { await api('POST', `/api/admin/work-orders/${id}/notes`, { text: text.trim() }); await woHistory(id, null, true); } catch (err) { alert(err.message); }
}

async function woHistory(id, btn, forceOpen = false) {
    const box = $id('woEvents' + id);
    if (!forceOpen && !box.hidden) { box.hidden = true; return; }
    try {
        const o = await api('GET', `/api/admin/work-orders/${id}`);
        const when = (s) => new Date(String(s).replace(' ', 'T') + 'Z').toLocaleString(APP_LOCALE, { dateStyle: 'medium', timeStyle: 'short' });
        box.innerHTML = o.events.map((e) => `<div class="wo-ev ${e.by_technician ? 'tech' : ''}">${e.by_technician ? '<i class="fas fa-helmet-safety"></i> ' : '• '}${esc(when(e.created_at))}${e.author ? ' — ' + esc(e.author) : ''}: ${esc(e.text)}</div>`).join('');
        box.hidden = false;
    } catch (err) { alert(err.message); }
}

async function woCancel(id) {
    const reason = await askText('سبب إلغاء أمر العمل:');
    if (!reason || !reason.trim()) return;
    const notify = await askYes('إبلاغ العميل بالإلغاء على واتساب؟ (السبب يصله في الرسالة)');
    try {
        const r = await api('POST', `/api/admin/work-orders/${id}/cancel`, { reason: reason.trim(), notify_customer: notify });
        woNoticeAlert(r.notice);
        await loadWorkOrders();
    } catch (err) { alert(err.message); }
}

/* «في الطريق»: the customer is told on WhatsApp (when its template is set) */
async function woOnTheWay(id, btn) {
    btn.disabled = true;
    try {
        const r = await api('POST', `/api/admin/work-orders/${id}/on-the-way`, {});
        btn.innerHTML = r.notice && r.notice.ok ? '<i class="fas fa-truck"></i> أُبلغ العميل ✓' : '<i class="fas fa-truck"></i> سُجّل ✓';
        if (r.notice && !r.notice.ok && !r.notice.skipped) await tell(`سُجّل أنك في الطريق، لكن لم تصل رسالة للعميل: ${r.notice.error}`);
    } catch (err) { btn.disabled = false; tell(err.message); }
}

/* What happened to the WhatsApp message to the customer (the change itself is saved either way) */
function woNoticeAlert(notice) {
    if (notice && notice.skipped && !notice.error) return; // nothing to send (no template, switched off)
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
    $id('woNotifyRow').hidden = false;
    $id('woNotify').checked = true;
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
            woNoticeAlert((await api('POST', '/api/admin/work-orders', { ...body, invoice_id: woSourceRef.invoice.id, notify_customer: $id('woNotify').checked })).notice);
        } else {
            woNoticeAlert((await api('POST', '/api/admin/work-orders', { ...body, customer_name: $id('woName').value.trim(), customer_phone: $id('woPhone').value.trim(), notify_customer: $id('woNotify').checked })).notice);
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
    const reason = await askText('سبب الرفض (يصل للعميل في رسالة واتساب):');
    if (!reason || !reason.trim()) return;
    const notify = await askYes('إرسال الرسالة للعميل على واتساب الآن؟');
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


/* ---------------- Board: the technician's most important jobs (time left); the office follows the technicians ---------------- */
let woBoardData = null;
let woBoardTick = null;
const WO_SEEN_KEY = 'woReportsSeen';

function woAgo(at) {
    if (!at) return '';
    const min = Math.round((Date.now() - Date.parse(String(at).replace(' ', 'T') + (String(at).includes('Z') ? '' : 'Z'))) / 60000);
    if (min < 1) return 'الآن';
    if (min < 60) return `قبل ${min} د`;
    if (min < 24 * 60) return `قبل ${Math.round(min / 60)} س`;
    return `قبل ${Math.round(min / 1440)} يوم`;
}

/* «متبقٍ 2 س 15 د» / «بعد 3 أيام» / «متأخر 1 س» — counted live from the due time */
function woLeft(o) {
    if (o.status === 'in_progress') return { text: 'قيد التنفيذ الآن', cls: 'run' };
    if (!o.due_at) return { text: 'بلا موعد', cls: 'none' };
    const min = Math.round((Date.parse(o.due_at) - Date.now()) / 60000);
    const span = (m) => {
        const a = Math.abs(m);
        if (a < 60) return `${a} د`;
        if (a < 24 * 60) return `${Math.floor(a / 60)} س${a % 60 ? ` ${a % 60} د` : ''}`;
        const d = Math.round(a / 1440);
        return d === 1 ? 'يوم' : d === 2 ? 'يومين' : `${d} أيام`;
    };
    if (o.late || min < 0) return { text: `متأخر ${span(min)}`, cls: 'late' };
    if (!o.due_exact) {
        const days = Math.round((Date.parse(o.scheduled_date) - Date.parse(woBoardData.today)) / 86400000);
        return { text: days <= 0 ? 'اليوم' : days === 1 ? 'غداً' : `بعد ${days} أيام`, cls: days <= 0 ? 'soon' : '' };
    }
    return { text: `متبقٍ ${span(min)}`, cls: min <= 120 ? 'soon' : '' };
}

async function loadWoBoard() {
    try {
        woBoardData = await api('GET', '/api/admin/work-orders/board');
        // The technician's own commission this month (when the manager set a %)
        if (isTech() && typeof loadMyBonus === 'function') woBoardData.my_bonus = await loadMyBonus();
        renderWoBoard();
        clearInterval(woBoardTick);
        woBoardTick = setInterval(() => { if (document.visibilityState === 'visible' && $id('tab-work_orders').classList.contains('active')) renderWoBoard(); }, 30000);
    } catch { /* the list below still works */ }
}

function renderWoBoard() {
    const b = woBoardData;
    if (!b) return;
    const c = b.counts;
    const tile = (n, label, cls, filter) => `<button type="button" class="wo-tile ${cls} ${n ? '' : 'zero'}" ${filter ? `onclick="woFilter='${filter}'; renderWoChips(); loadWorkOrders()"` : ''}><strong>${n}</strong><span>${label}</span></button>`;
    const tiles = `<div class="wo-tiles">
        ${tile(c.in_progress, 'قيد التنفيذ', 'run', 'in_progress')}
        ${tile(c.late, 'متأخرة', 'late', 'open')}
        ${tile(c.today, 'اليوم', 'soon', 'scheduled')}
        ${tile(c.week, 'خلال 7 أيام', '', 'scheduled')}
        ${isTech() ? '' : tile(c.unscheduled, 'بلا موعد', 'none', 'new')}
    </div>`;
    const jobs = b.top.length ? b.top.map((o) => {
        const left = woLeft(o);
        return `<button type="button" class="wo-job ${left.cls}" onclick="woFocus('${esc(o.number)}')">
            <span class="wo-left">${esc(left.text)}</span>
            <span class="wo-job-main"><b>${esc(o.kind_label)} — ${esc(o.customer_name)}</b>
                <small>${esc([o.location, o.scheduled_date ? o.scheduled_date + (o.scheduled_time ? ' ' + o.scheduled_time : '') : ''].filter(Boolean).join(' — '))}${!isTech() && o.technician_name ? ' — ' + esc(o.technician_name) : ''}</small></span>
            <span class="wo-job-no">${esc(o.number)}</span>
        </button>`;
    }).join('') : `<p class="status-text" style="margin:4px 0">${isTech() ? 'لا أعمال قريبة — يومك خفيف 👍' : 'لا أعمال مفتوحة خلال الأيام القادمة'}</p>`;
    let feed = '';
    if (!isTech()) {
        let seen = 0;
        try { seen = Number(localStorage.getItem(WO_SEEN_KEY)) || 0; } catch { /* private mode */ }
        const fresh = b.feed.filter((e) => e.id > seen).length;
        feed = `<details class="wo-feed" ${fresh ? 'open' : ''} ontoggle="if (this.open) woMarkSeen()">
            <summary><i class="fas fa-helmet-safety"></i> متابعة الفنيين — آخر التقارير والتحديثات ${fresh ? `<span class="badge" style="background:#e67e22;color:#fff">${fresh} جديد</span>` : ''}</summary>
            ${b.feed.length ? b.feed.map((e) => `<button type="button" class="wo-feed-row ${e.id > seen ? 'new' : ''}" onclick="woFocus('${esc(e.number)}')">
                <span class="wo-feed-meta"><b>${esc(e.author || 'الفني')}</b> — ${esc(woAgo(e.created_at))} — ${esc(e.number)} — ${esc(e.customer_name)} <span class="badge wo-${esc(e.status)}">${esc(e.status_label)}</span></span>
                <span class="wo-feed-text">${esc(e.text)}</span></button>`).join('')
                : '<p class="status-text" style="margin:6px 0">لم يكتب الفنيون تقارير بعد. تظهر هنا عندما يبدأ الفني العمل أو ينهيه أو يكتب ملاحظة.</p>'}
        </details>`;
    }
    $id('woBoard').innerHTML = `<div class="wo-board-head">${isTech() ? `<i class="fas fa-gauge-high"></i> لوحتي — أهم الأعمال الآن` : `<i class="fas fa-gauge-high"></i> الأعمال المفتوحة`}</div>
        ${tiles}<div class="wo-jobs">${jobs}</div>${feed}${isTech() && b.my_bonus && typeof myBonusHtml === 'function' ? `<div class="my-bonus" style="margin-top:10px">${myBonusHtml(b.my_bonus)}</div>` : ''}`;
}

function woMarkSeen() {
    if (!woBoardData || !woBoardData.feed.length) return;
    try { localStorage.setItem(WO_SEEN_KEY, String(woBoardData.feed[0].id)); } catch { /* private mode */ }
    setTimeout(renderWoBoard, 4000);
}

/* Open one order in the list below (with its history) */
function woFocus(number) {
    woFilter = '';
    renderWoChips();
    $id('woSearch').value = number;
    loadWorkOrders().then(() => {
        const o = woOrders.find((x) => x.number === number);
        if (!o) return;
        woHistory(o.id, null, true).then(() => {
            const card = $id('woEvents' + o.id);
            if (card) card.closest('.wo-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    });
}
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && $id('tab-work_orders').classList.contains('active')) loadWoBoard();
});
