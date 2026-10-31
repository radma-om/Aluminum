/* =============================================================
   Dashboard figures for the admin panel: quote requests, their value,
   status, calculator, channel and wilayah; and the customer follow-up.
   All over one period (last N days) compared with the period before.
   ============================================================= */
const leads = require('./leads');

const CALCULATORS = { rolling_shutter: 'رولينج شتر', overhead: 'أوفرهيد', motors: 'مكائن البوابات', other: 'أخرى' };
const SOURCES = { web: 'الحاسبات', mazbot: 'واتساب', whatsapp: 'واتساب', website: 'دردشة الموقع', admin: 'لوحة الإدارة' };
const QUOTE_STATUSES = { new: 'جديد', contacted: 'تم التواصل', accepted: 'مقبول', done: 'منفّذ', rejected: 'مرفوض' };

const day = (d) => d.toISOString().slice(0, 10);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function calculatorOf(details) {
    if (details.calculator && CALCULATORS[details.calculator]) return details.calculator;
    return details.width_cm || details.shutter_type ? 'rolling_shutter' : 'other';
}

/* Sorted [{ key, label, value }] from a count map, largest first */
const ranked = (counts, labels = {}) => Object.entries(counts)
    .map(([key, value]) => ({ key, label: labels[key] || key, value }))
    .sort((a, b) => b.value - a.value);

function build(db, { days = 30 } = {}) {
    const n = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
    const today = new Date();
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (n - 1)));
    const prevStart = new Date(start.getTime() - n * 86400000);

    const rows = db.prepare('SELECT id, total, status, source, customer_city, details_json, created_at FROM quotes WHERE created_at >= ? ORDER BY id')
        .all(day(prevStart) + ' 00:00:00')
        .map((q) => ({ ...q, details: JSON.parse(q.details_json || '{}') || {}, date: q.created_at.slice(0, 10) }));
    const current = rows.filter((q) => q.date >= day(start));
    const previous = rows.filter((q) => q.date < day(start));

    // Requests and value per day (every day of the period, zeros included)
    const perDay = [];
    for (let i = 0; i < n; i++) {
        const d = day(new Date(start.getTime() + i * 86400000));
        const list = current.filter((q) => q.date === d);
        perDay.push({ date: d, count: list.length, value: round2(list.reduce((s, q) => s + q.total, 0)) });
    }

    const count = (list, keyOf) => list.reduce((m, q) => { const k = keyOf(q); m[k] = (m[k] || 0) + 1; return m; }, {});
    const sum = (list) => round2(list.reduce((s, q) => s + q.total, 0));
    const won = (list) => list.filter((q) => q.status === 'accepted' || q.status === 'done');
    const rate = (list) => (list.length ? Math.round((won(list).length / list.length) * 1000) / 10 : 0);
    const sourceKey = (q) => (q.source === 'whatsapp' ? 'mazbot' : q.source);
    const placeOf = (q) => q.details.region || (q.customer_city || '').split('،')[0].trim() || 'غير محدد';

    // Follow-up: open customers by status and by employee, and follow-ups due
    const leadRows = db.prepare('SELECT status, assigned_to, next_follow_up, channel, created_at FROM leads').all();
    const open = leadRows.filter((l) => leads.OPEN_STATUSES.includes(l.status));
    const todayStr = day(today);
    const newLeads = (from, to) => leadRows.filter((l) => l.created_at.slice(0, 10) >= from && (!to || l.created_at.slice(0, 10) < to)).length;

    return {
        days: n,
        from: day(start),
        to: todayStr,
        kpis: {
            quotes: { value: current.length, previous: previous.length },
            value: { value: sum(current), previous: sum(previous) },
            won_value: { value: sum(won(current)), previous: sum(won(previous)) },
            win_rate: { value: rate(current), previous: rate(previous) },
            average: {
                value: current.length ? round2(sum(current) / current.length) : 0,
                previous: previous.length ? round2(sum(previous) / previous.length) : 0
            },
            new_customers: { value: newLeads(day(start)), previous: newLeads(day(prevStart), day(start)) },
            open_leads: { value: open.length },
            needs_staff: { value: open.filter((l) => l.status === 'needs_staff').length },
            due_follow_ups: { value: open.filter((l) => l.next_follow_up && l.next_follow_up <= todayStr).length },
            unassigned: { value: open.filter((l) => !l.assigned_to).length }
        },
        per_day: perDay,
        by_calculator: ranked(count(current, (q) => calculatorOf(q.details)), CALCULATORS),
        by_source: ranked(count(current, sourceKey), SOURCES),
        by_status: Object.keys(QUOTE_STATUSES).map((k) => ({ key: k, label: QUOTE_STATUSES[k], value: current.filter((q) => q.status === k).length })),
        by_place: ranked(count(current, placeOf)).slice(0, 8),
        leads_by_status: Object.entries(leads.STATUSES).map(([key, label]) => ({ key, label, value: leadRows.filter((l) => l.status === key).length })),
        leads_by_staff: ranked(open.reduce((m, l) => { const k = l.assigned_to || 'غير مُسند'; m[k] = (m[k] || 0) + 1; return m; }, {}))
    };
}

module.exports = { build };
