/* «طلبات نموذج واتساب» (the quotes tab): what customers sent in the WhatsApp form «طلب عرض سعر – بوابات ردما».
   Each row: the answers as read, the raw event as MazBot sent it, «تسعير الآن» (the quote builder filled from the
   form), the customer in «متابعة العملاء», «إعادة المعالجة» (read the raw event again) and its status. */
let waForms = null;
const waRaw = new Map(); // id → the raw event, once opened

async function loadWaForms() {
    if (!canSee('quotes') && !canSee('leads')) return;
    const f = $id('waFormsFilter');
    try { waForms = await api('GET', '/api/admin/whatsapp-forms' + (f && f.value ? '?status=' + encodeURIComponent(f.value) : '')); } catch (err) { setStatus('waFormsStatus', err.message, 'err'); return; }
    const total = Object.values(waForms.counts).reduce((a, b) => a + b, 0);
    $id('waFormsCard').hidden = !total;
    const waiting = waForms.counts.new || 0;
    $id('waFormsSummary').textContent = waiting ? `— ${waiting} جديد` : '';
    renderWaForms();
}

function renderWaForms() {
    const rows = waForms ? waForms.submissions : [];
    if (!rows.length) { $id('waFormsRows').innerHTML = '<tr><td colspan="7" class="empty">لا توجد طلبات بهذه الحالة</td></tr>'; return; }
    const opts = (s) => Object.entries(waForms.statuses).filter(([k]) => k !== 'error' || s.status === 'error')
        .map(([k, v]) => `<option value="${k}" ${k === s.status ? 'selected' : ''}>${esc(v)}</option>`).join('');
    $id('waFormsRows').innerHTML = rows.map((s) => `<tr${s.status === 'new' ? ' style="background:#f2fdf6"' : ''}>
        <td data-label="وصل"><small dir="ltr">${esc(muscatTime(s.received_at))}</small></td>
        <td data-label="العميل">${esc(s.name || '—')}${s.phone ? `<br><a href="https://wa.me/${esc(s.phone)}" target="_blank" rel="noopener" dir="ltr"><small>${esc(s.phone)}</small></a>` : ''}</td>
        <td data-label="الولاية/المنطقة">${esc(s.region || s.region_text || '—')}${s.region_text && !s.region ? '<br><small class="muted">لم تُطابق ولاية واحدة</small>' : ''}</td>
        <td data-label="البوابة">${esc(s.gate_label || '—')}${s.width_cm ? `<br><small>العرض ${esc(s.width_cm)} سم</small>` : ''}</td>
        <td data-label="المعاينة والملاحظات">${s.inspection == null ? '' : s.inspection ? `🔎 يريد معاينة${s.service_request ? ` <small>(${esc(s.service_request.ref)})</small>` : ''}` : 'بلا معاينة'}
            ${s.notes ? `<br><small>${esc(s.notes)}</small>` : ''}
            ${s.unmatched.length ? `<br><small class="muted">لم يُفهم: ${s.unmatched.map((u) => esc(`${u.label}: ${u.value}`)).join(' / ')}</small>` : ''}
            ${s.error ? `<br><small style="color:var(--danger,#c0392b)">⚠️ ${esc(s.error)}</small>` : ''}</td>
        <td data-label="الحالة"><select onchange="setWaFormStatus(${Number(s.id)}, this.value)">${opts(s)}</select>
            ${s.quote ? `<br><button class="link-btn" style="margin:0" onclick="viewQuote(${Number(s.quote.id)})">${esc(s.quote.ref)}</button>` : ''}</td>
        <td data-label="">
            ${s.phone && canSee('quotes') ? `<button class="btn btn-primary btn-sm" onclick="priceWaForm(${Number(s.id)})"><i class="fas fa-calculator"></i> تسعير الآن</button>` : ''}
            ${s.lead_id && canSee('leads') ? `<button class="btn btn-outline btn-sm" onclick="openWaFormLead(${Number(s.lead_id)})">فتح العميل</button>` : ''}
            <button class="btn btn-outline btn-sm" onclick="toggleWaRaw(${Number(s.id)})">الحدث الخام</button>
            <button class="btn btn-outline btn-sm" onclick="reprocessWaForm(${Number(s.id)})">إعادة المعالجة</button>
        </td></tr>
        <tr id="waRaw-${Number(s.id)}" hidden><td colspan="7"><pre dir="ltr" style="white-space:pre-wrap;word-break:break-all;max-height:360px;overflow:auto;background:#f6f8fa;padding:10px;border-radius:8px;margin:0;text-align:left"></pre></td></tr>`).join('');
    for (const [id, raw] of waRaw) { const row = $id(`waRaw-${id}`); if (row) { row.hidden = false; row.querySelector('pre').textContent = raw; } }
}

async function toggleWaRaw(id) {
    if (waRaw.has(id)) { waRaw.delete(id); $id(`waRaw-${id}`).hidden = true; return; }
    try {
        const s = await api('GET', `/api/admin/whatsapp-forms/${id}`);
        waRaw.set(id, JSON.stringify(s.raw, null, 2));
        renderWaForms();
    } catch (err) { setStatus('waFormsStatus', err.message, 'err'); }
}

async function reprocessWaForm(id) {
    try {
        const s = await api('POST', `/api/admin/whatsapp-forms/${id}/reprocess`);
        setStatus('waFormsStatus', s.status === 'error' ? s.error : 'أُعيدت قراءة النموذج', s.status === 'error' ? 'err' : 'ok');
        loadWaForms();
    } catch (err) { setStatus('waFormsStatus', err.message, 'err'); }
}

async function setWaFormStatus(id, status) {
    try { await api('PATCH', `/api/admin/whatsapp-forms/${id}`, { status }); loadWaForms(); } catch (err) { setStatus('waFormsStatus', err.message, 'err'); loadWaForms(); }
}

function openWaFormLead(leadId) {
    switchTab('leads');
    openLead(leadId);
}

/* The quote builder for this customer, with the gate of the form and its width (the height is the office's) */
async function priceWaForm(id) {
    const s = waForms && waForms.submissions.find((x) => x.id === id);
    if (!s) return;
    await openQuoteBuilder({ customer: { name: s.name || '', phone: s.phone, city: s.region || s.region_text || '' } });
    if (s.region_id && $id('qbRegion').querySelector(`option[value="${Number(s.region_id)}"]`)) $id('qbRegion').value = String(s.region_id);
    const c = qbCatalog && qbCatalog.calculators;
    if (!s.gate_type || !c || !c[s.gate_type]) return;
    qbAddCalc(s.gate_type);
    const line = qbLines[qbLines.length - 1];
    if (s.width_cm) {
        if (s.gate_type === 'rolling_shutter') line.params.width_cm = s.width_cm;
        else if (s.gate_type === 'overhead') {
            // Overhead widths are a list per type and height: the smallest one that covers the opening (else the
            // widest), in any type — the office checks it and picks the height
            const all = c.overhead.gate_types.flatMap((t) => t.heights.flatMap((h) => h.widths.map((w) => ({ t: t.name, h: h.height_cm, w: Number(w) }))));
            const covers = all.filter((x) => x.w >= s.width_cm).sort((a, b) => a.w - b.w);
            const pick = covers[0] || all.sort((a, b) => b.w - a.w)[0];
            if (pick) Object.assign(line.params, { gate_type: pick.t, height_cm: pick.h, width_cm: pick.w });
        }
    }
    if (s.notes) $id('qbNotes').value = s.notes;
    renderQbLines();
    qbSchedule();
}
