/* =============================================================
   «عرض سعر جديد» by an employee. The section is chosen first:
   - a roller shutter gate, an overhead gate or a gate motor: the same
     choices as the customer calculator, priced by the server with the
     installation and delivery of the customer's wilayah;
   - a part from the product list (price from the list) or a free line.
   A discount per line / gate and on the total (amount or %), live totals
   from the server (the same calculation that is saved), and the
   employee's discount limit. Uses api(), $id(), esc(), setStatus(),
   canSee(), closeSheet(), openQuotePdf(), loadQuotes().
   ============================================================= */

let qbCatalog = null;
let qbLines = [];
let qbCustomer = null;   // a customer record chosen (from the profile or the suggestions)
let qbEditing = null;    // the quote whose lines are being changed
let qbTimer = null;
let qbLastPreview = null;
let qbCostOnly = false;  // «حاسبة التكلفة والربح»: no customer, nothing saved

const QB_UNITS = { meter: 'متر', piece: 'قطعة', m2: 'متر مربع', set: 'طقم', kg: 'كجم', service: 'خدمة' };
const QB_CATS = { slat: 'الشرائح', accessory: 'الإكسسوارات', machine: 'المكائن' };
const qbMoney = (n) => Number(n || 0).toFixed(2);
const QB_CALCS = { rolling_shutter: 'بوابة رول شتر', overhead: 'بوابة أوفرهيد', motors: 'مكينة بوابة' };
const QB_ICONS = { rolling_shutter: 'fa-warehouse', overhead: 'fa-door-closed', motors: 'fa-cogs' };

async function openQuoteBuilder({ customer = null, quote = null, costOnly = false } = {}) {
    try {
        qbCatalog = await api('GET', '/api/admin/quotes/catalog');
    } catch (err) { return alert(err.message); }
    qbEditing = quote;
    qbCustomer = customer;
    qbCostOnly = costOnly && qbCatalog.sees_cost;
    $id('qbTitle').textContent = qbCostOnly ? 'حاسبة التكلفة والربح' : quote ? `تعديل بنود العرض ${quote.ref}` : 'عرض سعر جديد';
    qbApplyMode();
    $id('qbExtraCost').value = '';
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
        const groups = Array.isArray(d.calc_groups) ? d.calc_groups : [];
        const seen = new Set();
        qbLines = [];
        for (const i of quote.items) {
            if (i.group !== undefined && groups[i.group]) {
                if (seen.has(i.group)) continue;
                seen.add(i.group);
                const g = groups[i.group];
                qbLines.push({ calc: g.calc, params: qbScreenParams(g.calc, g.params || {}), price_level: g.price_level || 'from',
                    disc_type: g.discount ? g.discount.type : '', disc_value: g.discount ? g.discount.value : '' });
                continue;
            }
            qbLines.push({
                product_id: i.product_id || '', name: i.name, type: i.type || '', unit: i.unit, quantity: i.quantity,
                unit_price: i.unit_price, disc_type: i.discount ? i.discount.type : '', disc_value: i.discount ? i.discount.value : '',
                catalog: Boolean(i.product_id)
            });
        }
        if (d.quote_discount) { $id('qbDiscType').value = d.quote_discount.type; $id('qbDiscValue').value = d.quote_discount.value; }
        $id('qbNotes').value = quote.notes || '';
    } else {
        qbLines = [];
    }
    qbFillRegions(quote ? (quote.details || {}).region_id : null, quote ? null : (customer && customer.city));
    qbFillAddButtons();
    // The manager's promotion is applied by itself to the gates / motors it covers
    const pr = qbCatalog.promotion;
    $id('qbPromo').hidden = !pr;
    if (pr) $id('qbPromo').textContent = `🎁 ${pr.label}: خصم ${pr.percent}% يُطبَّق تلقائياً على ${pr.applies_to.map((a) => a.name).join('، ')}${pr.until ? ` حتى ${pr.until}` : ''} — ولا يُحسب من حد خصمك.`;
    renderQbLines();
    setStatus('qbStatus', '');
    qbApplyMode();
    $id('qbSheet').hidden = false;
    qbPreview();
}

/* A saved gate / motor (as the server keeps it) → the screen's form: one accessory per group, parts by id */
function qbScreenParams(calc, saved) {
    const p = structuredClone(saved);
    if (calc === 'rolling_shutter') {
        const ids = (p.option_ids || []).map(String);
        p.option_ids = qbCatalog.calculators.rolling_shutter.accessory_groups.map((g) => {
            const o = g.options.find((x) => ids.includes(String(x.id)));
            return o ? o.id : '';
        });
        p.color_id = p.color_id || '';
    }
    if (calc === 'motors') {
        p.parts = Object.fromEntries((Array.isArray(p.parts) ? p.parts : []).map((x) => [x.id, x.qty]));
        p.kit_id = p.kit_id || '';
        p.installation = p.installation !== false;
    }
    return p;
}

/* The cost calculator hides what only a quote needs (the customer, validity, notes, saving) */
function qbApplyMode() {
    document.querySelectorAll('#qbSheet .qb-quote-only').forEach((el) => { el.hidden = qbCostOnly; });
    $id('qbCostIntro').hidden = !qbCostOnly;
    $id('qbSave').hidden = qbCostOnly;
    $id('qbToQuote').hidden = !qbCostOnly;
    $id('qbCostBox').hidden = !qbCatalog.sees_cost;
    if (qbCostOnly) { $id('qbCustFields').hidden = true; $id('qbCustFixed').hidden = true; }
}

/* From the cost calculator to a quote with the same gates: only the customer is left to fill in */
function qbConvertToQuote() {
    qbCostOnly = false;
    $id('qbTitle').textContent = 'عرض سعر جديد';
    $id('qbCustFields').hidden = Boolean(qbCustomer);
    $id('qbCustFixed').hidden = !qbCustomer;
    qbApplyMode();
    $id('qbPhone').focus();
}

const qbBlankLine = (catalog) => ({ product_id: '', name: '', type: '', unit: 'piece', quantity: 1, unit_price: '', disc_type: '', disc_value: '', catalog });

/* The wilayah list (as in the customer calculators); a customer's city picks it when the name matches */
function qbFillRegions(regionId, city) {
    const sel = $id('qbRegion');
    sel.innerHTML = '<option value="">— اختر الولاية —</option>' + (qbCatalog.locations || []).map((g) =>
        `<optgroup label="${esc(g.name)}">${g.wilayat.map((w) => `<option value="${w.id}">${esc(w.name)}</option>`).join('')}</optgroup>`).join('');
    let id = regionId || '';
    if (!id && city) {
        const c = String(city).trim();
        for (const g of qbCatalog.locations || []) for (const w of g.wilayat) if (w.name === c || c.includes(w.name)) id = id || w.id;
    }
    sel.value = id ? String(id) : '';
}

/* One add button per section; a calculator with nothing set up yet is left out */
function qbFillAddButtons() {
    const c = qbCatalog.calculators || {};
    const has = {
        rolling_shutter: c.rolling_shutter && c.rolling_shutter.shutter_types.length,
        overhead: c.overhead && c.overhead.gate_types.length && c.overhead.motors.length,
        motors: c.motors && c.motors.sections.length
    };
    $id('qbAdd').innerHTML = Object.entries(QB_CALCS).filter(([k]) => has[k]).map(([k, label]) =>
        `<button type="button" class="btn btn-outline btn-sm" onclick="qbAddCalc('${k}')"><i class="fas ${QB_ICONS[k]}"></i> ${label}</button>`).join('')
        + (qbCatalog.products.length ? `<button type="button" class="btn btn-outline btn-sm" onclick="qbAddLine(true)"><i class="fas fa-puzzle-piece"></i> قطعة من المنتجات</button>` : '')
        + `<button type="button" class="btn btn-outline btn-sm" onclick="qbAddLine(false)"><i class="fas fa-pen"></i> بند حر</button>`;
}

function qbAddLine(catalog) { qbLines.push(qbBlankLine(catalog)); renderQbLines(); qbSchedule(); }
function qbRemoveLine(i) { qbLines.splice(i, 1); renderQbLines(); qbSchedule(); }

/* A new gate / motor with the first choices filled in, as the customer calculators start */
function qbAddCalc(calc) {
    const c = qbCatalog.calculators;
    let params = {};
    if (calc === 'rolling_shutter') {
        const t = c.rolling_shutter.shutter_types[0];
        const v = t.variants[0];
        params = { shutter_type_id: t.id, variant_id: v.id, color_id: v.colors[0] ? v.colors[0].id : '', width_cm: '', height_cm: '', count: 1,
            option_ids: c.rolling_shutter.accessory_groups.map((g) => (g.allow_none ? '' : g.options[0].id)) };
    } else if (calc === 'overhead') {
        const t = c.overhead.gate_types[0];
        params = { gate_type: t.name, height_cm: t.heights[0].height_cm, width_cm: t.heights[0].widths[0], motor_id: c.overhead.motors[0].id };
    } else {
        const sec = c.motors.sections[0];
        params = { section_id: sec.id, kit_id: sec.kits[0] ? sec.kits[0].id : '', kit_count: 1, parts: {}, installation: true };
    }
    qbLines.push({ calc, params, price_level: 'from', disc_type: '', disc_value: '' });
    renderQbLines();
    qbSchedule();
}

const qbOpts = (list, value, label = (x) => x.name, id = (x) => x.id) =>
    list.map((x) => `<option value="${esc(id(x))}" ${String(id(x)) === String(value) ? 'selected' : ''}>${esc(label(x))}</option>`).join('');
const qbField = (label, html, cls = '') => `<div class="${cls}"><label>${label}</label>${html}</div>`;

/* The choices of one gate / motor, like the customer calculator */
function qbCalcFields(l) {
    const c = qbCatalog.calculators;
    const p = l.params;
    if (l.calc === 'rolling_shutter') {
        const types = c.rolling_shutter.shutter_types;
        const t = types.find((x) => String(x.id) === String(p.shutter_type_id)) || types[0];
        const v = t.variants.find((x) => String(x.id) === String(p.variant_id)) || t.variants[0];
        return qbField('نوع البوابة', `<select data-p="shutter_type_id">${qbOpts(types, t.id)}</select>`)
            + qbField('السماكة', `<select data-p="variant_id">${qbOpts(t.variants, v.id, (x) => x.label)}</select>`)
            + (v.colors.length ? qbField('اللون', `<select data-p="color_id">${qbOpts(v.colors, p.color_id)}</select>`) : '')
            + qbField('العرض (سم)', `<input type="number" data-p="width_cm" min="1" step="1" value="${esc(p.width_cm)}">`)
            + qbField('الارتفاع (سم)', `<input type="number" data-p="height_cm" min="1" step="1" value="${esc(p.height_cm)}">`)
            + qbField('العدد', `<input type="number" data-p="count" min="1" max="50" step="1" value="${esc(p.count)}">`)
            + c.rolling_shutter.accessory_groups.map((g, gi) => qbField(esc(g.name), `<select data-acc="${gi}">
                ${g.allow_none ? `<option value="">${esc(g.none_label || 'بدون')}</option>` : ''}
                ${qbOpts(g.options, p.option_ids[gi], (o) => `${o.label} (${qbMoney(o.unit_price)})`)}</select>`)).join('');
    }
    if (l.calc === 'overhead') {
        const types = c.overhead.gate_types;
        const t = types.find((x) => x.name === p.gate_type) || types[0];
        const h = t.heights.find((x) => String(x.height_cm) === String(p.height_cm)) || t.heights[0];
        return qbField('نوع البوابة', `<select data-p="gate_type">${qbOpts(types, t.name, (x) => x.name, (x) => x.name)}</select>`)
            + qbField('الارتفاع (سم)', `<select data-p="height_cm">${qbOpts(t.heights, h.height_cm, (x) => x.height_cm, (x) => x.height_cm)}</select>`)
            + qbField('العرض (سم)', `<select data-p="width_cm">${qbOpts(h.widths, p.width_cm, (x) => x, (x) => x)}</select>`)
            + qbField('المحرك', `<select data-p="motor_id">${qbOpts(c.overhead.motors, p.motor_id)}</select>`)
            + qbField('السعر', `<select data-k="price_level"><option value="from" ${l.price_level !== 'to' ? 'selected' : ''}>بداية النطاق (من)</option><option value="to" ${l.price_level === 'to' ? 'selected' : ''}>نهاية النطاق (إلى)</option></select>`);
    }
    const secs = c.motors.sections;
    const sec = secs.find((x) => String(x.id) === String(p.section_id)) || secs[0];
    return qbField('نوع البوابة', `<select data-p="section_id">${qbOpts(secs, sec.id)}</select>`)
        + (sec.kits.length ? qbField('الطقم', `<select data-p="kit_id"><option value="">بدون طقم</option>${qbOpts(sec.kits, p.kit_id)}</select>`)
            + qbField('عدد الأطقم', `<input type="number" data-p="kit_count" min="1" max="20" step="1" value="${esc(p.kit_count)}" ${p.kit_id ? '' : 'disabled'}>`) : '')
        + sec.parts.map((x) => qbField(`${esc(x.name)} <span class="unit">(${esc(x.unit)})</span>`,
            `<input type="number" data-part="${x.id}" min="0" max="100" step="1" value="${esc(p.parts[x.id] || '')}" placeholder="0">`)).join('')
        + qbField('التركيب', `<select data-p="installation"><option value="1" ${p.installation ? 'selected' : ''}>مع التركيب</option><option value="0" ${p.installation ? '' : 'selected'}>بدون تركيب (توريد فقط)</option></select>`);
}

function renderQbCalc(l, i) {
    return `<div class="qb-group" data-i="${i}">
        <div class="qb-group-head"><strong><i class="fas ${QB_ICONS[l.calc]}"></i> ${QB_CALCS[l.calc]}</strong>
            <span class="qb-total" id="qbLineTotal${i}">—</span>
            <button type="button" class="btn btn-outline btn-sm" onclick="qbRemoveLine(${i})" title="حذف">×</button></div>
        <div class="qb-group-fields">${qbCalcFields(l)}
            ${qbField('خصم', `<select data-k="disc_type"><option value="">بدون</option><option value="amount" ${l.disc_type === 'amount' ? 'selected' : ''}>مبلغ</option><option value="percent" ${l.disc_type === 'percent' ? 'selected' : ''}>%</option></select>`)}
            ${qbField('قيمته', `<input type="number" data-k="disc_value" min="0" step="0.01" value="${esc(l.disc_value)}" ${l.disc_type ? '' : 'disabled'}>`)}
        </div>
        <div class="qb-group-items" id="qbGroupItems${i}"></div>
    </div>`;
}

function renderQbLines() {
    if (!qbLines.length) {
        $id('qbLines').innerHTML = '<p class="status-text">اختر القسم أولاً من الأزرار بالأسفل لإضافة بوابة أو مكينة أو قطعة.</p>';
        return;
    }
    const groups = {};
    for (const p of qbCatalog.products) (groups[p.category] = groups[p.category] || []).push(p);
    const productOptions = Object.entries(groups).map(([cat, list]) => `<optgroup label="${esc(QB_CATS[cat] || cat)}">${list.map((p) =>
        `<option value="${p.id}">${esc(p.name)}${p.type ? ' — ' + esc(p.type) : ''} (${qbMoney(p.unit_price)} / ${esc(QB_UNITS[p.unit] || p.unit)})</option>`).join('')}</optgroup>`).join('');
    $id('qbLines').innerHTML = qbLines.map((l, i) => {
        if (l.calc) return renderQbCalc(l, i);
        const free = !l.product_id && !l.catalog;
        return `<div class="qb-line" data-i="${i}">
            ${free ? `<div class="qb-prod"><label>بند حر</label><input type="text" data-k="name" maxlength="200" placeholder="اسم البند (مثلاً: صيانة محرك، قطعة خاصة)" value="${esc(l.name)}"></div>`
                : `<div class="qb-prod"><label>قطعة من المنتجات</label><select data-k="product_id"><option value="">— اختر —</option>${productOptions}</select></div>`}
            <div><label>الكمية</label><input type="number" data-k="quantity" min="0" step="0.01" value="${esc(l.quantity)}"></div>
            <div><label>الوحدة</label><select data-k="unit" ${free ? '' : 'disabled'}>${Object.entries(QB_UNITS).map(([k, v]) => `<option value="${k}" ${k === l.unit ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
            <div><label>سعر الوحدة</label><input type="number" data-k="unit_price" min="0" step="0.01" value="${esc(l.unit_price)}" ${free ? '' : 'readonly title="السعر من قائمة المنتجات — للتخفيض استخدم الخصم"'}></div>
            <div><label>خصم البند</label><select data-k="disc_type"><option value="">بدون</option><option value="amount" ${l.disc_type === 'amount' ? 'selected' : ''}>مبلغ</option><option value="percent" ${l.disc_type === 'percent' ? 'selected' : ''}>%</option></select></div>
            <div><label>قيمته</label><input type="number" data-k="disc_value" min="0" step="0.01" value="${esc(l.disc_value)}" ${l.disc_type ? '' : 'disabled'}></div>
            <div><label>المجموع</label><div class="qb-total" id="qbLineTotal${i}">—</div></div>
            <div><button type="button" class="btn btn-outline btn-sm" onclick="qbRemoveLine(${i})" title="حذف البند">×</button></div>
        </div>`;
    }).join('');
    $id('qbLines').querySelectorAll('.qb-line').forEach((row) => {
        const sel = row.querySelector('[data-k="product_id"]');
        if (sel) sel.value = qbLines[Number(row.dataset.i)].product_id || '';
    });
}

/* Any change in a line: keep the state; a product chosen fills its price and unit */
$id('qbLines').addEventListener('input', qbOnChange);
$id('qbLines').addEventListener('change', qbOnChange);
function qbOnChange(e) {
    const card = e.target.closest('.qb-group');
    if (card) return qbOnCalcChange(e, qbLines[Number(card.dataset.i)]);
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
for (const id of ['qbDiscType', 'qbDiscValue', 'qbExtraCost']) $id(id).addEventListener('input', () => qbSchedule());
$id('qbRegion').addEventListener('change', () => qbSchedule());

/* A choice changed in a gate / motor card; a parent choice (type, thickness, height, section) resets what depends on it */
function qbOnCalcChange(e, l) {
    const t = e.target;
    const p = l.params;
    const c = qbCatalog.calculators;
    let redraw = false;
    if (t.dataset.k) {
        l[t.dataset.k] = t.value;
        if (t.dataset.k === 'disc_type' && e.type === 'change') { if (!l.disc_type) l.disc_value = ''; redraw = true; }
    } else if (t.dataset.acc !== undefined) {
        p.option_ids[Number(t.dataset.acc)] = t.value ? Number(t.value) : '';
    } else if (t.dataset.part !== undefined) {
        p.parts[t.dataset.part] = t.value;
    } else if (t.dataset.p) {
        const k = t.dataset.p;
        p[k] = k === 'installation' ? t.value === '1' : t.value;
        if (e.type !== 'change') return qbSchedule();
        if (l.calc === 'rolling_shutter' && (k === 'shutter_type_id' || k === 'variant_id')) {
            const type = c.rolling_shutter.shutter_types.find((x) => String(x.id) === String(p.shutter_type_id));
            if (k === 'shutter_type_id') p.variant_id = type.variants[0].id;
            const v = type.variants.find((x) => String(x.id) === String(p.variant_id)) || type.variants[0];
            if (!v.colors.some((x) => String(x.id) === String(p.color_id))) p.color_id = v.colors[0] ? v.colors[0].id : '';
            redraw = true;
        }
        if (l.calc === 'overhead' && (k === 'gate_type' || k === 'height_cm')) {
            const type = c.overhead.gate_types.find((x) => x.name === p.gate_type);
            if (k === 'gate_type') p.height_cm = type.heights[0].height_cm;
            const h = type.heights.find((x) => String(x.height_cm) === String(p.height_cm)) || type.heights[0];
            if (!h.widths.some((w) => String(w) === String(p.width_cm))) p.width_cm = h.widths[0];
            redraw = true;
        }
        if (l.calc === 'motors' && k === 'section_id') {
            const sec = c.motors.sections.find((x) => String(x.id) === String(p.section_id));
            Object.assign(p, { kit_id: sec.kits[0] ? sec.kits[0].id : '', kit_count: 1, parts: {} });
            redraw = true;
        }
        if (l.calc === 'motors' && k === 'kit_id') redraw = true;
    }
    if (redraw) renderQbLines();
    qbSchedule();
}

/* What the server gets for a gate / motor */
function qbCalcParams(l) {
    const p = l.params;
    if (l.calc === 'rolling_shutter') {
        return { shutter_type_id: Number(p.shutter_type_id), variant_id: Number(p.variant_id), color_id: p.color_id ? Number(p.color_id) : null,
            width_cm: p.width_cm === '' ? '' : Number(p.width_cm), height_cm: p.height_cm === '' ? '' : Number(p.height_cm),
            count: Number(p.count) || 1, option_ids: p.option_ids.filter(Boolean).map(Number) };
    }
    if (l.calc === 'overhead') return { gate_type: p.gate_type, height_cm: Number(p.height_cm), width_cm: Number(p.width_cm), motor_id: Number(p.motor_id) };
    return { section_id: Number(p.section_id), kit_id: p.kit_id ? Number(p.kit_id) : null, kit_count: Number(p.kit_count) || 1,
        parts: Object.entries(p.parts).filter(([, q]) => Number(q) > 0).map(([id, q]) => ({ id: Number(id), qty: Number(q) })),
        installation: p.installation !== false };
}

/* Still being filled in: left out of the live total (saving shows what is missing) */
function qbCalcMissing(l) {
    const p = qbCalcParams(l);
    if (l.calc === 'rolling_shutter' && !(p.width_cm > 0 && p.height_cm > 0)) return 'اكتب العرض والارتفاع';
    if (l.calc === 'motors' && !p.kit_id && !p.parts.length) return 'اختر طقماً أو قطعاً';
    return '';
}
const qbUsed = (l) => (l.calc ? !qbCalcMissing(l) : l.product_id || String(l.name).trim() || l.unit_price !== '');

function qbPayload(all = false) {
    const items = qbLines.filter((l) => (all && l.calc) || qbUsed(l)).map((l) => ({
        ...(l.calc ? { calc: l.calc, params: qbCalcParams(l), price_level: l.price_level === 'to' ? 'to' : 'from' }
            : l.product_id ? { product_id: Number(l.product_id), quantity: Number(l.quantity) }
                : { name: l.name, unit: l.unit, unit_price: l.unit_price === '' ? '' : Number(l.unit_price), quantity: Number(l.quantity) }),
        ...(l.disc_type && l.disc_value !== '' ? { discount: { type: l.disc_type, value: Number(l.disc_value) } } : {})
    }));
    const t = $id('qbDiscType').value;
    const region = $id('qbRegion').value;
    return { items, ...(region ? { region_id: Number(region) } : {}),
        ...(t && $id('qbDiscValue').value !== '' ? { discount: { type: t, value: Number($id('qbDiscValue').value) } } : {}) };
}

function qbSchedule() { clearTimeout(qbTimer); qbTimer = setTimeout(qbPreview, 300); }

async function qbPreview() {
    const body = { ...qbPayload(), ...(qbCatalog.sees_cost ? { extra_cost: Number($id('qbExtraCost').value) || 0 } : {}) };
    qbLines.forEach((l, i) => {
        if (!l.calc) return;
        const miss = qbCalcMissing(l);
        if (miss) { $id('qbLineTotal' + i).textContent = '—'; $id('qbGroupItems' + i).innerHTML = `<span class="status-text">${miss}</span>`; }
    });
    if (!body.items.length) { $id('qbTotals').innerHTML = '<span class="status-text">أضف بنداً لحساب الإجمالي.</span>'; qbLastPreview = null; return; }
    try {
        const r = await api('POST', '/api/admin/quotes/preview', body);
        qbLastPreview = r;
        // Walk the priced lines in order: a gate / motor takes all its lines (the same group), a part takes one
        let n = 0;
        let g = 0;
        qbLines.forEach((l, i) => {
            if (!qbUsed(l)) return;
            const el = $id('qbLineTotal' + i);
            if (l.calc) {
                const lines = [];
                while (r.items[n] && r.items[n].group === g) lines.push(r.items[n++]);
                if (el) el.textContent = r.groups[g] ? qbMoney(r.groups[g].total) : '—';
                const box = $id('qbGroupItems' + i);
                if (box) box.innerHTML = lines.map((it) => `<div class="row"><span>${esc(it.name)}${it.type ? ' — ' + esc(it.type) : ''}${it.quantity !== 1 ? ` × ${esc(it.quantity)}` : ''}</span><span>${qbMoney(it.gross)}</span></div>`).join('');
                g++;
            } else {
                if (el) el.textContent = r.items[n] ? qbMoney(r.items[n].line_total) : '—';
                n++;
            }
        });
        const p = r.pricing;
        const limit = r.discount_limit;
        $id('qbTotals').innerHTML = `
            ${p.discount_total > 0 ? `<div class="row"><span>المجموع قبل الخصم</span><span>${qbMoney(p.gross_subtotal)}</span></div>` : ''}
            ${p.promo_amount ? `<div class="row" style="color:var(--success)"><span>🎁 ${esc(p.promo_label)} — ${esc(p.promo_percent)}% (تلقائي)</span><span>-${qbMoney(p.promo_amount)}</span></div>` : ''}
            ${p.staff_discount > 0 ? `<div class="row"><span>خصمك (${p.discount_percent}%)</span><span>-${qbMoney(p.staff_discount)}</span></div>` : ''}
            <div class="row"><span>المجموع قبل الضريبة</span><span>${qbMoney(r.subtotal)}</span></div>
            <div class="row"><span>ضريبة القيمة المضافة ${esc(r.vat_percent)}%</span><span>${qbMoney(r.vat)}</span></div>
            <div class="row grand"><span>الإجمالي (ر.ع)</span><span>${qbMoney(r.total)}</span></div>
            ${limit !== null ? `<div class="status-text" style="color:${r.over_limit ? '#a93226' : 'inherit'}">${r.over_limit ? '⚠️ ' : ''}حد الخصم المسموح لك: ${esc(limit)}%${p.promo_amount ? ' (فوق العرض الترويجي)' : ''}${r.over_limit ? ' — قلّل الخصم أو اطلب من المدير' : ''}</div>` : ''}`;
        $id('qbSave').disabled = Boolean(r.over_limit);
        renderQbCost(r.cost);
        setStatus('qbStatus', '');
    } catch (err) {
        qbLastPreview = null;
        $id('qbTotals').innerHTML = `<span style="color:#a93226">${esc(err.message)}</span>`;
        renderQbCost(null);
    }
}

/* Cost, selling price (before VAT, after every discount) and profit — per gate / line and in total */
function renderQbCost(c) {
    if (!c) { $id('qbCost').innerHTML = ''; return; }
    const cls = (n) => (n < 0 ? 'neg' : 'pos');
    const pctTxt = (n) => (n === null || n === undefined ? '—' : `${n}%`);
    const rows = c.lines.map((l) => `<tr><td>${esc(l.label)}${l.missing.length ? ' <span title="بدون تكلفة مسجلة" style="color:#a93226">⚠️</span>' : ''}</td>
        <td>${qbMoney(l.cost)}</td><td>${qbMoney(l.revenue)}</td><td class="${cls(l.profit)}">${qbMoney(l.profit)}</td><td class="${cls(l.profit)}">${pctTxt(l.margin_percent)}</td></tr>`).join('');
    const quoteDisc = qbLastPreview && qbLastPreview.pricing.quote_discount ? qbLastPreview.pricing.quote_discount.amount : 0;
    $id('qbCost').innerHTML = `<div style="overflow-x:auto"><table>
        <thead><tr><th>البند</th><th>التكلفة</th><th>البيع</th><th>الربح</th><th>هامش الربح</th></tr></thead>
        <tbody>${rows}
            ${quoteDisc ? `<tr><td>خصم على الإجمالي</td><td>—</td><td class="neg">-${qbMoney(quoteDisc)}</td><td class="neg">-${qbMoney(quoteDisc)}</td><td></td></tr>` : ''}
            ${c.extra_cost ? `<tr><td>تكلفة التركيب والنقل</td><td>${qbMoney(c.extra_cost)}</td><td>—</td><td class="neg">-${qbMoney(c.extra_cost)}</td><td></td></tr>` : ''}
            <tr class="sum"><td>الإجمالي (قبل الضريبة)</td><td>${qbMoney(c.total_cost)}</td><td>${qbMoney(c.revenue)}</td><td class="${cls(c.profit)}">${qbMoney(c.profit)}</td><td class="${cls(c.profit)}">${pctTxt(c.margin_percent)}</td></tr>
        </tbody></table></div>
        <div class="status-text" style="margin-top:6px">هامش الربح = الربح ÷ سعر البيع. نسبة الربح على التكلفة: <b>${pctTxt(c.markup_percent)}</b>. البيع بعد العرض الترويجي وكل الخصومات، وقبل الضريبة.</div>
        ${c.missing.length ? `<div class="status-text" style="color:#a93226;margin-top:4px">⚠️ بدون تكلفة مسجلة (حُسبت صفراً، فالربح الفعلي أقل): ${c.missing.map(esc).join('، ')}</div>` : ''}
        <div class="status-text" style="margin-top:4px">التركيب والتوصيل ورسوم الألوان تُحسب في البيع بلا تكلفة — اكتب تكلفتها الفعلية في الحقل أعلاه.</div>`;
}

async function saveBuiltQuote() {
    const body = { ...qbPayload(true), notes: $id('qbNotes').value.trim() };
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
        if (c) {
            $id('qbPhone').value = c.phone; $id('qbName').value = c.name || ''; $id('qbCity').value = c.city || '';
            if (!$id('qbRegion').value && c.city) { qbFillRegions(null, c.city); qbSchedule(); }
        }
    });
}
