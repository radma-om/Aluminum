/* =============================================================
   «عرض سعر جديد» by an employee: lines from the catalog (price from the
   list) or free lines, a discount per line and on the total (amount or
   %), live totals from the server (the same calculation that is saved),
   and the employee's discount limit. Uses api(), $id(), esc(),
   setStatus(), canSee(), closeSheet(), openQuotePdf(), loadQuotes().
   ============================================================= */

let qbCatalog = null;
let qbLines = [];
let qbCustomer = null;   // a customer record chosen (from the profile or the suggestions)
let qbEditing = null;    // the quote whose lines are being changed
let qbTimer = null;
let qbLastPreview = null;

const QB_UNITS = { meter: 'متر', piece: 'قطعة', m2: 'متر مربع', set: 'طقم', kg: 'كجم', service: 'خدمة' };
const QB_CATS = { slat: 'الشرائح', accessory: 'الإكسسوارات', machine: 'المكائن' };
const qbMoney = (n) => Number(n || 0).toFixed(2);

async function openQuoteBuilder({ customer = null, quote = null } = {}) {
    try {
        qbCatalog = await api('GET', '/api/admin/quotes/catalog');
    } catch (err) { return alert(err.message); }
    qbEditing = quote;
    qbCustomer = customer;
    $id('qbTitle').textContent = quote ? `تعديل بنود العرض ${quote.ref}` : 'عرض سعر جديد';
    const fixed = quote || customer;
    $id('qbCustFields').hidden = Boolean(fixed);
    $id('qbCustFixed').hidden = !fixed;
    $id('qbCustFixed').textContent = quote ? `${quote.customer_name} — +${quote.customer_phone}${quote.customer_city ? ' — ' + quote.customer_city : ''}`
        : customer ? `${customer.name || ''} — +${customer.phone}${customer.city ? ' — ' + customer.city : ''}` : '';
    for (const id of ['qbPhone', 'qbName', 'qbCity', 'qbNotes', 'qbDiscValue']) $id(id).value = '';
    $id('qbDiscType').value = '';
    $id('qbValidity').value = qbCatalog.validity_days;
    $id('qbValidity').disabled = Boolean(quote);
    if (quote) {
        const d = quote.details || {};
        qbLines = quote.items.map((i) => ({
            product_id: i.product_id || '', name: i.name, type: i.type || '', unit: i.unit, quantity: i.quantity,
            unit_price: i.unit_price, disc_type: i.discount ? i.discount.type : '', disc_value: i.discount ? i.discount.value : ''
        }));
        if (d.quote_discount) { $id('qbDiscType').value = d.quote_discount.type; $id('qbDiscValue').value = d.quote_discount.value; }
        $id('qbNotes').value = quote.notes || '';
    } else {
        qbLines = [qbBlankLine()];
    }
    renderQbLines();
    setStatus('qbStatus', '');
    $id('qbSheet').hidden = false;
    qbPreview();
}

const qbBlankLine = () => ({ product_id: '', name: '', type: '', unit: 'piece', quantity: 1, unit_price: '', disc_type: '', disc_value: '' });
function qbAddLine() { qbLines.push(qbBlankLine()); renderQbLines(); }
function qbRemoveLine(i) { qbLines.splice(i, 1); if (!qbLines.length) qbLines.push(qbBlankLine()); renderQbLines(); qbSchedule(); }

function renderQbLines() {
    const groups = {};
    for (const p of qbCatalog.products) (groups[p.category] = groups[p.category] || []).push(p);
    const productOptions = Object.entries(groups).map(([cat, list]) => `<optgroup label="${esc(QB_CATS[cat] || cat)}">${list.map((p) =>
        `<option value="${p.id}">${esc(p.name)}${p.type ? ' — ' + esc(p.type) : ''} (${qbMoney(p.unit_price)} / ${esc(QB_UNITS[p.unit] || p.unit)})</option>`).join('')}</optgroup>`).join('');
    $id('qbLines').innerHTML = qbLines.map((l, i) => {
        const free = !l.product_id;
        return `<div class="qb-line" data-i="${i}">
            <div class="qb-prod"><label>البند ${i + 1}</label><select data-k="product_id"><option value="">— بند حر —</option>${productOptions}</select></div>
            <div><label>الكمية</label><input type="number" data-k="quantity" min="0" step="0.01" value="${esc(l.quantity)}"></div>
            <div><label>الوحدة</label><select data-k="unit" ${free ? '' : 'disabled'}>${Object.entries(QB_UNITS).map(([k, v]) => `<option value="${k}" ${k === l.unit ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
            <div><label>سعر الوحدة</label><input type="number" data-k="unit_price" min="0" step="0.01" value="${esc(l.unit_price)}" ${free ? '' : 'readonly title="السعر من قائمة المنتجات — للتخفيض استخدم الخصم"'}></div>
            <div><label>خصم البند</label><select data-k="disc_type"><option value="">بدون</option><option value="amount" ${l.disc_type === 'amount' ? 'selected' : ''}>مبلغ</option><option value="percent" ${l.disc_type === 'percent' ? 'selected' : ''}>%</option></select></div>
            <div><label>قيمته</label><input type="number" data-k="disc_value" min="0" step="0.01" value="${esc(l.disc_value)}" ${l.disc_type ? '' : 'disabled'}></div>
            <div><label>المجموع</label><div class="qb-total" id="qbLineTotal${i}">—</div></div>
            <div><button type="button" class="btn btn-outline btn-sm" onclick="qbRemoveLine(${i})" title="حذف البند">×</button></div>
            ${free ? `<div class="qb-free"><input type="text" data-k="name" maxlength="200" placeholder="اسم البند (مثلاً: تركيب، صيانة محرك، قطعة خاصة)" value="${esc(l.name)}"></div>` : ''}
        </div>`;
    }).join('');
    $id('qbLines').querySelectorAll('.qb-line').forEach((row) => {
        const i = Number(row.dataset.i);
        row.querySelector('[data-k="product_id"]').value = qbLines[i].product_id || '';
    });
}

/* Any change in a line: keep the state; a product chosen fills its price and unit */
$id('qbLines').addEventListener('input', qbOnChange);
$id('qbLines').addEventListener('change', qbOnChange);
function qbOnChange(e) {
    const row = e.target.closest('.qb-line');
    const k = e.target.dataset.k;
    if (!row || !k) return;
    const l = qbLines[Number(row.dataset.i)];
    l[k] = e.target.value;
    if (k === 'product_id' && e.type === 'change') {
        const p = qbCatalog.products.find((x) => String(x.id) === String(l.product_id));
        if (p) { l.unit = p.unit; l.unit_price = p.unit_price; l.name = p.name; } else { l.unit_price = ''; l.name = ''; }
        renderQbLines();
    }
    if (k === 'disc_type' && e.type === 'change') { if (!l.disc_type) l.disc_value = ''; renderQbLines(); }
    qbSchedule();
}
for (const id of ['qbDiscType', 'qbDiscValue']) $id(id).addEventListener('input', () => qbSchedule());

function qbPayload() {
    const items = qbLines.filter((l) => l.product_id || String(l.name).trim() || l.unit_price !== '').map((l) => ({
        ...(l.product_id ? { product_id: Number(l.product_id) } : { name: l.name, unit: l.unit, unit_price: l.unit_price === '' ? '' : Number(l.unit_price) }),
        quantity: Number(l.quantity),
        ...(l.disc_type && l.disc_value !== '' ? { discount: { type: l.disc_type, value: Number(l.disc_value) } } : {})
    }));
    const t = $id('qbDiscType').value;
    return { items, ...(t && $id('qbDiscValue').value !== '' ? { discount: { type: t, value: Number($id('qbDiscValue').value) } } : {}) };
}

function qbSchedule() { clearTimeout(qbTimer); qbTimer = setTimeout(qbPreview, 300); }

async function qbPreview() {
    const body = qbPayload();
    if (!body.items.length) { $id('qbTotals').innerHTML = '<span class="status-text">أضف بنداً لحساب الإجمالي.</span>'; qbLastPreview = null; return; }
    try {
        const r = await api('POST', '/api/admin/quotes/preview', body);
        qbLastPreview = r;
        let n = 0;
        qbLines.forEach((l, i) => {
            const used = l.product_id || String(l.name).trim() || l.unit_price !== '';
            const el = $id('qbLineTotal' + i);
            if (el) el.textContent = used && r.items[n] ? qbMoney(r.items[n].line_total) : '—';
            if (used) n++;
        });
        const p = r.pricing;
        const limit = r.discount_limit;
        $id('qbTotals').innerHTML = `
            ${p.discount_total > 0 ? `<div class="row"><span>المجموع قبل الخصم</span><span>${qbMoney(p.gross_subtotal)}</span></div>
                <div class="row"><span>الخصم (${p.discount_percent}%)</span><span>-${qbMoney(p.discount_total)}</span></div>` : ''}
            <div class="row"><span>المجموع قبل الضريبة</span><span>${qbMoney(r.subtotal)}</span></div>
            <div class="row"><span>ضريبة القيمة المضافة ${esc(r.vat_percent)}%</span><span>${qbMoney(r.vat)}</span></div>
            <div class="row grand"><span>الإجمالي (ر.ع)</span><span>${qbMoney(r.total)}</span></div>
            ${limit !== null ? `<div class="status-text" style="color:${r.over_limit ? '#a93226' : 'inherit'}">${r.over_limit ? '⚠️ ' : ''}حد الخصم المسموح لك: ${esc(limit)}%${r.over_limit ? ' — قلّل الخصم أو اطلب من المدير' : ''}</div>` : ''}`;
        $id('qbSave').disabled = Boolean(r.over_limit);
        setStatus('qbStatus', '');
    } catch (err) {
        qbLastPreview = null;
        $id('qbTotals').innerHTML = `<span style="color:#a93226">${esc(err.message)}</span>`;
    }
}

async function saveBuiltQuote() {
    const body = { ...qbPayload(), notes: $id('qbNotes').value.trim() };
    try {
        let q;
        if (qbEditing) {
            q = await api('PUT', `/api/admin/quotes/${qbEditing.id}`, body);
        } else {
            if (qbCustomer) body.customer_id = qbCustomer.id;
            else Object.assign(body, { customer_phone: $id('qbPhone').value.trim(), customer_name: $id('qbName').value.trim(), customer_city: $id('qbCity').value.trim() });
            body.validity_days = Number($id('qbValidity').value);
            q = await api('POST', '/api/admin/quotes', body);
        }
        closeSheet('qbSheet');
        if (document.querySelector('#tab-quotes.active')) loadQuotes().catch(() => {});
        else switchTab('quotes');
        if (confirm(`تم حفظ العرض ${q.ref} ✓ — الإجمالي ${qbMoney(q.total)} ر.ع\nفتح ملف PDF الآن؟`)) openQuotePdf(q.id);
    } catch (err) {
        setStatus('qbStatus', err.message, 'err');
    }
}

/* Customer suggestions while typing the phone or the name (with the customers permission) */
let qbCustTimer = null;
let qbCustResults = [];
for (const id of ['qbPhone', 'qbName']) {
    $id(id).addEventListener('input', () => {
        if (!canSee('customers')) return;
        clearTimeout(qbCustTimer);
        qbCustTimer = setTimeout(async () => {
            const q = $id(id).value.trim();
            if (q.length < 3) return;
            try {
                qbCustResults = (await api('GET', '/api/admin/customers?q=' + encodeURIComponent(q))).customers.slice(0, 8);
                $id('qbCustList').innerHTML = qbCustResults.map((c) => `<option value="${esc(c.phone)}">${esc(c.name || '')}</option>`).join('');
                $id('qbCustNames').innerHTML = qbCustResults.map((c) => `<option value="${esc(c.name || '')}">+${esc(c.phone)}</option>`).join('');
            } catch { /* suggestions are optional */ }
        }, 250);
    });
    $id(id).addEventListener('change', () => {
        const v = $id(id).value.trim();
        const c = qbCustResults.find((x) => x.phone === v.replace(/\D/g, '') || x.name === v);
        if (c) { $id('qbPhone').value = c.phone; $id('qbName').value = c.name || ''; $id('qbCity').value = c.city || ''; }
    });
}
