/* =============================================================
   Quotes built by an employee (without the customer calculators).
   - Lines from the product catalog (the price comes from the catalog and
     cannot be typed over) or free lines (a service, a special item: name,
     quantity, unit, unit price).
   - A discount on any line and on the whole quote, as an amount or a %.
   - A customer promotion switched on by the manager is applied by itself
     to the gates and motors it covers, exactly as in the customer
     calculators. It is not the employee's discount.
   - The employee's own discounts, as a % of the price after the
     promotion, are limited per employee (their own limit, or the general
     one); managers have no limit. The same limit applies when an invoice
     lowers the amount.
   ============================================================= */
const { unitSellPrice, round2 } = require('./pricing');
const promotions = require('./promotions');

const UNITS = ['meter', 'piece', 'm2', 'set', 'kg', 'service'];
const CALCS = { rolling_shutter: 'بوابة رول شتر', overhead: 'بوابة أوفرهيد', motors: 'مكينة بوابة' };
const err = (status, message) => Object.assign(new Error(message), { status });
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const num = (v) => (v === '' || v === null || v === undefined ? NaN : Number(v));

/* { type: 'amount' | 'percent', value } on a base amount → the discount amount */
function discountOf(d, base, what) {
    if (!d || d.value === '' || d.value === null || d.value === undefined || Number(d.value) === 0) return { type: null, value: 0, amount: 0 };
    const type = d.type === 'percent' ? 'percent' : 'amount';
    const value = num(d.value);
    if (!Number.isFinite(value) || value < 0) throw err(400, `قيمة الخصم غير صالحة (${what})`);
    if (type === 'percent' && value > 100) throw err(400, `نسبة الخصم لا تتجاوز 100% (${what})`);
    const amount = round2(type === 'percent' ? base * value / 100 : value);
    if (amount > base + 0.0005) throw err(400, `الخصم أكبر من المبلغ (${what})`);
    return { type, value: round2(value), amount };
}

/* A calculator line (a whole gate or motor kit, as the customer calculators price it, with the
   installation of the quote's wilayah) → its priced lines. Prices never come from the screen.
   The lines are the prices before the customer promotion (price() applies it per gate). */
function calcLines(db, line, regionId, where) {
    const pr = line.params || {};
    const num = (v) => (v === '' || v === null || v === undefined ? undefined : Number(v));
    let priced;
    let label;
    if (line.calc === 'rolling_shutter') {
        priced = require('./doors').finalPrice(db, {
            widthCm: num(pr.width_cm), heightCm: num(pr.height_cm), count: Number(pr.count) || 1,
            shutterTypeId: pr.shutter_type_id, variantId: pr.variant_id, colorId: pr.color_id,
            optionIds: Array.isArray(pr.option_ids) ? pr.option_ids.filter(Boolean) : [], regionId
        });
        label = `${Number(pr.width_cm)}×${Number(pr.height_cm)} سم${Number(pr.count) > 1 ? ` × ${Number(pr.count)}` : ''}`;
    } else if (line.calc === 'overhead') {
        priced = require('./overhead').overheadPrice(db, { gateType: pr.gate_type, widthCm: num(pr.width_cm), heightCm: num(pr.height_cm), motorId: pr.motor_id, regionId });
        label = `أوفرهيد ${pr.gate_type} ${Number(pr.width_cm)}×${Number(pr.height_cm)} سم`;
    } else if (line.calc === 'motors') {
        priced = require('./motors').motorPrice(db, {
            sectionId: pr.section_id, kitId: pr.kit_id || null, kitCount: Number(pr.kit_count) || 1,
            parts: Array.isArray(pr.parts) ? pr.parts : [], regionId, installation: pr.installation !== false
        });
        label = (priced.order && priced.order.section_label) || CALCS.motors;
    } else {
        throw err(400, `نوع البند غير معروف (${where})`);
    }
    const high = line.price_level === 'to';
    return { label, items: priced.items.map(({ product_id, category, unit_price_to, line_total_to, ...i }) => ({
        ...i,
        unit_price: high && unit_price_to != null ? unit_price_to : i.unit_price,
        line_total: high && line_total_to != null ? line_total_to : i.line_total
    })) };
}

/* An amount on a whole gate / kit, spread over its lines by their price (the last line takes the rounding) */
function spread(lines, amount, set) {
    const base = round2(lines.reduce((s, l) => s + l.line_total, 0));
    if (!amount || !base) return;
    let left = amount;
    lines.forEach((l, i) => {
        const part = i === lines.length - 1 ? round2(left) : round2(amount * l.line_total / base);
        left = round2(left - part);
        set(l, part);
        l.line_total = round2(l.line_total - part);
    });
}

/**
 * input: { region_id?, items: [{ calc, params, price_level?, discount? } | { product_id? | name, type?, unit?, quantity, unit_price?, discount? }], discount? }
 * Returns { items, subtotal, vat_percent, vat, total, pricing } — pricing = gross, discounts and the % for the limit.
 */
function price(db, input, settings) {
    const lines = Array.isArray(input.items) ? input.items : [];
    if (!lines.length) throw err(400, 'أضف بنداً واحداً على الأقل');
    if (lines.length > 100) throw err(400, 'عدد البنود كبير جداً');
    const hasCalc = lines.some((l) => l && l.calc);
    if (hasCalc && !input.region_id) throw err(400, 'اختر ولاية العميل — التركيب والتوصيل يُحسبان حسبها كما في حاسبة العملاء');
    const groups = [];
    let promoUsed = null;
    const items = lines.flatMap((line, i) => {
        const where = `البند ${i + 1}`;
        if (line && line.calc) {
            const { label, items: calc } = calcLines(db, line, input.region_id, where);
            const g = groups.length;
            const priced = calc.map((it) => ({ ...it, gross: round2(it.line_total), group: g }));
            const gross = round2(priced.reduce((s, l) => s + l.gross, 0));
            // The customer promotion first (same amount as the customer calculator), then the employee's discount on what is left
            const promo = promotions.active(settings, line.calc);
            const promoAmount = promo ? round2(gross * promo.percent / 100) : 0;
            if (promo) { promoUsed = promoUsed || promo; spread(priced, promoAmount, (l, part) => { l.promo = part; }); }
            const d = discountOf(line.discount, round2(gross - promoAmount), where);
            spread(priced, d.amount, (l, part) => { l.discount = { type: d.type, value: d.value, amount: part, group: true }; });
            groups.push({ calc: line.calc, label: `${CALCS[line.calc]} — ${label}`, params: line.params || {}, price_level: line.price_level === 'to' ? 'to' : 'from',
                ...(line.discount && Number(line.discount.value) ? { discount: { type: line.discount.type === 'percent' ? 'percent' : 'amount', value: Number(line.discount.value) } } : {}),
                ...(promoAmount ? { promo: promoAmount } : {}),
                gross, total: round2(priced.reduce((s, l) => s + l.line_total, 0)) });
            return priced;
        }
        const quantity = Math.round(num(line.quantity) * 1000) / 1000;
        if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1e6) throw err(400, `الكمية غير صالحة (${where})`);
        let item;
        if (line.product_id) {
            const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(Number(line.product_id));
            if (!product) throw err(400, `المنتج غير متوفر (${where})`);
            item = { product_id: product.id, category: product.category, name: product.name, type: product.type, unit: product.unit, unit_price: unitSellPrice(product, settings) };
        } else {
            const name = clip(line.name, 200);
            if (!name) throw err(400, `اكتب اسم البند (${where})`);
            const unitPrice = round2(num(line.unit_price));
            if (!Number.isFinite(unitPrice) || unitPrice < 0) throw err(400, `سعر الوحدة غير صالح (${where})`);
            item = { name, type: clip(line.type, 120) || null, unit: UNITS.includes(line.unit) ? line.unit : 'piece', unit_price: unitPrice };
        }
        const gross = round2(item.unit_price * quantity);
        const d = discountOf(line.discount, gross, where);
        return [{
            ...item, quantity,
            gross,
            ...(d.amount ? { discount: d } : {}),
            line_total: round2(gross - d.amount)
        }];
    });
    const grossSubtotal = round2(items.reduce((s, i) => s + i.gross, 0));
    const promoAmount = round2(items.reduce((s, i) => s + (i.promo || 0), 0));
    const afterPromo = round2(grossSubtotal - promoAmount);
    const linesTotal = round2(items.reduce((s, i) => s + i.line_total, 0));
    const quoteDiscount = discountOf(input.discount, linesTotal, 'خصم الإجمالي');
    const subtotal = round2(linesTotal - quoteDiscount.amount);
    const vatPercent = Number(settings.vat_percent) || 0;
    const vat = round2(subtotal * vatPercent / 100);
    const staffDiscount = round2(afterPromo - subtotal);
    return {
        items, subtotal, vat_percent: vatPercent, vat, total: round2(subtotal + vat),
        groups,
        pricing: {
            gross_subtotal: grossSubtotal,
            ...(promoAmount ? { promo_label: promoUsed.label, promo_percent: promoUsed.percent, promo_amount: promoAmount } : {}),
            lines_discount: round2(afterPromo - linesTotal),
            quote_discount: quoteDiscount.amount ? quoteDiscount : null,
            discount_total: round2(grossSubtotal - subtotal),
            staff_discount: staffDiscount,
            // The employee's own discount, from the price after the promotion: this is what the limit checks
            discount_percent: afterPromo > 0 ? Math.round((staffDiscount / afterPromo) * 10000) / 100 : 0
        }
    };
}

/* The employee's limit in % (null = no limit: managers and the general manager) */
/* The price an invoice's lower amount is measured against for the limit: after the customer
   promotion (it is not the employee's discount), before the employee's own discounts */
function limitBase(quote) {
    const d = quote.details || {};
    const gross = Number(d.gross_subtotal ?? quote.subtotal);
    if (d.promo_amount != null) return round2(gross - Number(d.promo_amount));           // employee quote with the promotion
    if (d.promo_label && !d.staff_quote) return Number(quote.subtotal);                    // customer calculator: the promotion is its only discount
    return gross;
}

function limitFor(user, settings) {
    if (!user || user.role === 'manager') return null;
    const own = user.max_discount_percent;
    return own !== null && own !== undefined && own !== '' ? Number(own) : Number(settings.staff_max_discount_percent ?? 10);
}

function checkLimit(user, settings, percent) {
    const limit = limitFor(user, settings);
    if (limit !== null && percent > limit + 0.005) {
        throw err(400, `الخصم ${percent}% أكبر من الحد المسموح لك (${limit}%) — اطلب من المدير اعتماده`);
    }
    return limit;
}

module.exports = { price, discountOf, limitFor, checkLimit, limitBase, UNITS, CALCS };
