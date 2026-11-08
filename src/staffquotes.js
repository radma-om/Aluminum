/* =============================================================
   Quotes built by an employee (without the customer calculators).
   - Lines from the product catalog (the price comes from the catalog and
     cannot be typed over) or free lines (a service, a special item: name,
     quantity, unit, unit price).
   - A discount on any line and on the whole quote, as an amount or a %.
   - The total discount, as a % of the price before discounts, is limited
     per employee (their own limit, or the general one); managers have no
     limit. The same limit applies when an invoice lowers the amount.
   ============================================================= */
const { unitSellPrice, round2 } = require('./pricing');

const UNITS = ['meter', 'piece', 'm2', 'set', 'kg', 'service'];
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

/**
 * input: { items: [{ product_id? | name, type?, unit?, quantity, unit_price?, discount: { type, value }? }], discount?: { type, value } }
 * Returns { items, subtotal, vat_percent, vat, total, pricing } — pricing = gross, discounts and the % for the limit.
 */
function price(db, input, settings) {
    const lines = Array.isArray(input.items) ? input.items : [];
    if (!lines.length) throw err(400, 'أضف بنداً واحداً على الأقل');
    if (lines.length > 100) throw err(400, 'عدد البنود كبير جداً');
    const items = lines.map((line, i) => {
        const where = `البند ${i + 1}`;
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
        return {
            ...item, quantity,
            gross,
            ...(d.amount ? { discount: d } : {}),
            line_total: round2(gross - d.amount)
        };
    });
    const grossSubtotal = round2(items.reduce((s, i) => s + i.gross, 0));
    const linesTotal = round2(items.reduce((s, i) => s + i.line_total, 0));
    const quoteDiscount = discountOf(input.discount, linesTotal, 'خصم الإجمالي');
    const subtotal = round2(linesTotal - quoteDiscount.amount);
    const vatPercent = Number(settings.vat_percent) || 0;
    const vat = round2(subtotal * vatPercent / 100);
    const discountTotal = round2(grossSubtotal - subtotal);
    return {
        items, subtotal, vat_percent: vatPercent, vat, total: round2(subtotal + vat),
        pricing: {
            gross_subtotal: grossSubtotal,
            lines_discount: round2(grossSubtotal - linesTotal),
            quote_discount: quoteDiscount.amount ? quoteDiscount : null,
            discount_total: discountTotal,
            discount_percent: grossSubtotal > 0 ? Math.round((discountTotal / grossSubtotal) * 10000) / 100 : 0
        }
    };
}

/* The employee's limit in % (null = no limit: managers and the general manager) */
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

module.exports = { price, discountOf, limitFor, checkLimit, UNITS };
