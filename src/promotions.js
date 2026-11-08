/* =============================================================
   Customer discount (a promotion the manager switches on).
   - A % off the price before VAT, for the chosen calculators (roller
     shutter, overhead, motors), with a name ("عرض الشتاء") and an
     optional last day (Muscat time).
   - Applied at the end of each pricing engine, so the calculators, the
     saved quotes, the PDF and the AI assistant all show the same price.
   - Quotes made by an employee are not touched (they set their own
     discounts within their limit).
   ============================================================= */
const { round2 } = require('./pricing');

const KINDS = { rolling_shutter: 'بوابات الرول شتر', overhead: 'بوابات الأوفرهيد', motors: 'مكائن البوابات' };
const MAX_PERCENT = 50;

const localToday = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);

/* The running promotion for this calculator, or null */
function active(settings, kind, today = localToday()) {
    if (!settings || !settings.promo_enabled) return null;
    const percent = Number(settings.promo_percent);
    if (!(percent > 0 && percent <= MAX_PERCENT)) return null;
    if (settings.promo_until && String(settings.promo_until) < today) return null; // ended
    const scope = Array.isArray(settings.promo_scope) ? settings.promo_scope : [];
    if (kind && !scope.includes(kind)) return null;
    return { percent, label: String(settings.promo_label || '').trim() || 'خصم', until: settings.promo_until || null, scope };
}

/* A priced quote → the same with the promotion taken off the subtotal (and the range, if any) */
function apply(settings, priced, kind) {
    const promo = active(settings, kind);
    if (!promo || !priced || !(priced.subtotal > 0)) return priced;
    const vatPercent = Number(priced.vat_percent) || 0;
    const cut = (gross) => {
        const amount = round2(gross * promo.percent / 100);
        const subtotal = round2(gross - amount);
        const vat = round2(subtotal * vatPercent / 100);
        return { amount, subtotal, vat, total: round2(subtotal + vat) };
    };
    const main = cut(priced.subtotal);
    const out = {
        ...priced, subtotal: main.subtotal, vat: main.vat, total: main.total,
        promo: { label: promo.label, percent: promo.percent, until: promo.until, gross_subtotal: priced.subtotal, amount: main.amount }
    };
    if (priced.range && priced.range.subtotal_to != null) {
        const to = cut(priced.range.subtotal_to);
        out.range = { subtotal_to: to.subtotal, vat_to: to.vat, total_to: to.total };
        out.promo.gross_subtotal_to = priced.range.subtotal_to;
        out.promo.amount_to = to.amount;
    }
    return out;
}

/* What a saved quote keeps, so the PDF shows the price before the discount and the discount */
function quoteDetails(promo) {
    if (!promo) return {};
    return {
        promo_label: promo.label, promo_percent: promo.percent,
        gross_subtotal: promo.gross_subtotal, discount_total: promo.amount,
        discount_percent: promo.percent,
        ...(promo.gross_subtotal_to != null ? { gross_subtotal_to: promo.gross_subtotal_to, discount_total_to: promo.amount_to } : {})
    };
}

/* For the customer pages and the AI assistant: what is on offer now */
function publicInfo(settings) {
    const p = active(settings, null);
    if (!p || !p.scope.length) return null;
    return { label: p.label, percent: p.percent, until: p.until, applies_to: p.scope.filter((k) => KINDS[k]).map((k) => ({ key: k, name: KINDS[k] })) };
}

module.exports = { active, apply, quoteDetails, publicInfo, KINDS, MAX_PERCENT };
