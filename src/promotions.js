/* =============================================================
   Customer offers the manager switches on.
   1) A promotion: a % off the price before VAT, for the chosen
      calculators and, in each, only the chosen parts (e.g. the slats of
      a roller shutter, or an overhead gate without its motor and
      installation). A name ("عرض اليوم الوطني") and an optional last day.
   2) A gift (e.g. a GSM opener): shown as a line with its price and taken
      off in full (100%), so the customer sees what it is worth. It joins
      the total discount. One per gate (a motor kit counts as one gate).
   Both are applied at the end of each pricing engine, so the calculators,
   the saved quotes, the PDF and the AI assistant show the same price; an
   employee's quote applies them per gate (staffquotes.js), and neither
   counts towards the employee's own discount limit.
   ============================================================= */
const { round2 } = require('./pricing');

const KINDS = { rolling_shutter: 'بوابات الرول شتر', overhead: 'بوابات الأوفرهيد', motors: 'مكائن البوابات' };
/* What each calculator's lines are made of (engines tag every line with one of these) */
const PARTS = {
    rolling_shutter: { slats: 'الشرائح', accessories: 'الإكسسوارات', motor: 'المحرك', installation: 'التركيب', delivery: 'التوصيل' },
    overhead: { gate: 'البوابة', motor: 'المحرك', installation: 'التركيب' },
    motors: { kit: 'المكينة (الطقم)', parts: 'القطع الإضافية', installation: 'التركيب', delivery: 'التوصيل' }
};
const MAX_PERCENT = 50;
const MAX_GIFT_PRICE = 1000;

const localToday = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
const ended = (until, today) => Boolean(until) && String(until) < today;

/* The parts of a calculator a promotion covers (all of them when the manager chose none) */
function partsOf(settings, kind) {
    const all = Object.keys(PARTS[kind] || {});
    const chosen = settings && settings.promo_parts && Array.isArray(settings.promo_parts[kind]) ? settings.promo_parts[kind].filter((p) => all.includes(p)) : [];
    return chosen.length ? chosen : all;
}

/* The running promotion for this calculator, or null */
function active(settings, kind, today = localToday()) {
    if (!settings || !settings.promo_enabled) return null;
    const percent = Number(settings.promo_percent);
    if (!(percent > 0 && percent <= MAX_PERCENT)) return null;
    if (ended(settings.promo_until, today)) return null;
    const scope = Array.isArray(settings.promo_scope) ? settings.promo_scope : [];
    if (kind && !scope.includes(kind)) return null;
    return {
        percent, label: String(settings.promo_label || '').trim() || 'خصم', until: settings.promo_until || null, scope,
        ...(kind ? { parts: partsOf(settings, kind) } : {})
    };
}

/* The running gift for this calculator, or null */
function activeGift(settings, kind, today = localToday()) {
    if (!settings || !settings.gift_enabled) return null;
    const price = round2(Number(settings.gift_price));
    const name = String(settings.gift_name || '').trim();
    if (!(price > 0) || !name) return null;
    if (ended(settings.gift_until, today)) return null;
    const scope = Array.isArray(settings.gift_scope) ? settings.gift_scope : [];
    if (kind && !scope.includes(kind)) return null;
    return { name, price, until: settings.gift_until || null, scope };
}

/* The gift line: its full price, given in full */
const giftLine = (gift, units) => ({
    product_id: null, category: 'gift', part: 'gift', gift: true,
    name: `🎁 هدية: ${gift.name}`, type: 'مجاناً مع الطلب', unit: 'piece', quantity: units,
    unit_price: gift.price, line_total: round2(gift.price * units)
});

/* The promotion's amount on a set of lines: the % of the lines in its parts (key: line_total or line_total_to) */
function promoCut(promo, items, key = 'line_total') {
    if (!promo) return 0;
    const base = items.filter((i) => !i.gift && promo.parts.includes(i.part)).reduce((s, i) => s + Number(i[key] ?? i.line_total), 0);
    return round2(base * promo.percent / 100);
}

/**
 * A priced order → the same with the offers applied: the gift line added (and given), and the promotion
 * taken off the lines of its parts. units = how many gates (the gift is one per gate; 0 = none).
 */
function apply(settings, priced, kind, { units = 1 } = {}) {
    if (!priced || !(priced.subtotal > 0)) return priced;
    const promo = active(settings, kind);
    const gift = units > 0 ? activeGift(settings, kind) : null;
    if (!promo && !gift) return priced;
    const vatPercent = Number(priced.vat_percent) || 0;
    const items = gift ? [...priced.items, giftLine(gift, units)] : priced.items;
    const giftAmount = gift ? round2(gift.price * units) : 0;
    const totals = (gross, cut) => {
        const subtotal = round2(gross - cut);
        const vat = round2(subtotal * vatPercent / 100);
        return { subtotal, vat, total: round2(subtotal + vat) };
    };
    const percentAmount = promoCut(promo, priced.items);
    const gross = round2(priced.subtotal + giftAmount);
    const amount = round2(percentAmount + giftAmount);
    const main = totals(gross, amount);
    const out = {
        ...priced, items, subtotal: main.subtotal, vat: main.vat, total: main.total,
        promo: {
            label: promo ? promo.label : 'هدية', percent: promo ? promo.percent : 0, until: promo ? promo.until : (gift && gift.until),
            // Named only when the promotion covers some of the parts, not all of them
            parts: promo && promo.parts.length < Object.keys(PARTS[kind]).length ? promo.parts.map((p) => PARTS[kind][p]) : [],
            gross_subtotal: gross, amount, percent_amount: percentAmount,
            ...(gift ? { gift: { name: gift.name, price: gift.price, quantity: units, amount: giftAmount } } : {})
        }
    };
    if (priced.range && priced.range.subtotal_to != null) {
        const pctTo = promoCut(promo, priced.items, 'line_total_to');
        const grossTo = round2(priced.range.subtotal_to + giftAmount);
        const to = totals(grossTo, pctTo + giftAmount);
        out.range = { subtotal_to: to.subtotal, vat_to: to.vat, total_to: to.total };
        out.promo.gross_subtotal_to = grossTo;
        out.promo.amount_to = round2(pctTo + giftAmount);
        out.promo.percent_amount_to = pctTo;
    }
    return out;
}

/* What a saved quote keeps, so the PDF shows the price before the discount, the promotion and the gift */
function quoteDetails(promo) {
    if (!promo) return {};
    return {
        ...(promo.percent ? { promo_label: promo.label, promo_percent: promo.percent, promo_amount: promo.percent_amount } : {}),
        ...(promo.parts && promo.parts.length ? { promo_parts: promo.parts } : {}),
        ...(promo.gift ? { gift_name: promo.gift.name, gift_amount: promo.gift.amount, gift_quantity: promo.gift.quantity } : {}),
        gross_subtotal: promo.gross_subtotal, discount_total: promo.amount,
        discount_percent: promo.gross_subtotal > 0 ? Math.round((promo.amount / promo.gross_subtotal) * 10000) / 100 : 0,
        ...(promo.gross_subtotal_to != null ? { gross_subtotal_to: promo.gross_subtotal_to, discount_total_to: promo.amount_to } : {})
    };
}

/* For the customer pages and the AI assistant: what is on offer now */
function publicInfo(settings) {
    const p = active(settings, null);
    const g = activeGift(settings, null);
    const promotion = p && p.scope.length ? {
        label: p.label, percent: p.percent, until: p.until,
        applies_to: p.scope.filter((k) => KINDS[k]).map((k) => {
            const parts = partsOf(settings, k);
            const all = parts.length === Object.keys(PARTS[k]).length;
            return { key: k, name: KINDS[k], parts: all ? null : parts.map((x) => PARTS[k][x]) };
        })
    } : null;
    const gift = g && g.scope.length ? { name: g.name, price: g.price, until: g.until, applies_to: g.scope.filter((k) => KINDS[k]).map((k) => ({ key: k, name: KINDS[k] })) } : null;
    if (!promotion && !gift) return null;
    // The promotion's own fields stay at the top level (older pages and the AI read them there)
    return promotion ? { ...promotion, gift } : { label: null, percent: 0, until: null, applies_to: [], gift };
}

module.exports = { active, activeGift, apply, promoCut, giftLine, partsOf, quoteDetails, publicInfo, KINDS, PARTS, MAX_PERCENT, MAX_GIFT_PRICE };
