/* =============================================================
   Dashboard figures for the admin panel: quote requests, their value,
   status, calculator, channel and wilayah; and the customer follow-up.
   All over one period (last N days) compared with the period before.
   ============================================================= */
const leads = require('./leads');
const { getSettings } = require('./db');

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

const parseJson = (value) => {
    try { return JSON.parse(value || '{}') || {}; } catch { return {}; }
};

const quoteOwner = (quote) => quote.details && quote.details.created_by ? String(quote.details.created_by) : null;
const canFollow = (row) => row.role === 'manager' || parseJson(row.permissions_json).includes('leads');

function build(db, { days = 30, user = null } = {}) {
    const n = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
    // Days are Muscat days (UTC+4): "today" and each stored UTC time are shifted before taking the date
    const today = new Date(Date.now() + 4 * 3600_000);
    const local = (s) => new Date(Date.parse(String(s).replace(' ', 'T') + 'Z') + 4 * 3600_000).toISOString().slice(0, 10);
    const utcOf = (d) => new Date(Date.parse(d + 'T00:00:00Z') - 4 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (n - 1)));
    const prevStart = new Date(start.getTime() - n * 86400000);
    const from = day(start);
    const previousFrom = day(prevStart);
    const tomorrow = day(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1)));
    const employee = user && user.role !== 'manager' ? user.display_name : null;

    const rows = db.prepare('SELECT id, total, status, source, customer_city, details_json, created_at FROM quotes WHERE created_at >= ? ORDER BY id')
        .all(utcOf(previousFrom))
        .map((q) => ({ ...q, details: parseJson(q.details_json), date: local(q.created_at) }))
        .filter((q) => !employee || quoteOwner(q) === employee);
    const current = rows.filter((q) => q.date >= from);
    const previous = rows.filter((q) => q.date < from);

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
    const leadRows = db.prepare('SELECT * FROM leads').all().filter((l) => !employee || l.assigned_to === employee);
    const open = leadRows.filter((l) => leads.OPEN_STATUSES.includes(l.status));
    const todayStr = day(today);
    const newLeads = (fromDate, toDate) => leadRows.filter((l) => local(l.created_at) >= fromDate && (!toDate || local(l.created_at) < toDate)).length;
    const settings = getSettings(db);
    const attention = leads.needingAttention(db, { staleDays: settings.follow_up_stale_days })
        .filter((l) => !employee || l.assigned_to === employee);
    const overdue = leads.overdueAssignments(db, { mineOf: employee });

    const periodEnd = utcOf(tomorrow);
    const periodStart = utcOf(from);
    const assignmentRows = db.prepare('SELECT * FROM lead_assignments WHERE created_at >= ? AND created_at < ? ORDER BY id')
        .all(periodStart, periodEnd);
    const noteRows = db.prepare("SELECT author, kind, created_at FROM lead_notes WHERE author IS NOT NULL AND author != 'النظام' AND created_at >= ? AND created_at < ?")
        .all(periodStart, periodEnd);
    const messageRows = db.prepare("SELECT author, created_at FROM lead_messages WHERE role = 'staff' AND author IS NOT NULL AND created_at >= ? AND created_at < ?")
        .all(periodStart, periodEnd);
    const invoiceRows = db.prepare("SELECT created_by, details_json, total, issue_date FROM invoices WHERE status = 'issued' AND issue_date >= ? AND issue_date < ?")
        .all(from, tomorrow)
        .map((invoice) => ({
            ...invoice,
            // A manager may issue the invoice for an employee's quote. Credit the sale to
            // the employee who created that quote, while keeping a sensible fallback for
            // invoices that did not originate from a staff quote.
            owner: quoteOwner({ details: parseJson(invoice.details_json) }) || invoice.created_by
        }));
    const staffAccounts = db.prepare('SELECT display_name, role, permissions_json FROM staff_users WHERE active = 1').all().filter(canFollow);
    const names = new Set(staffAccounts.map((s) => s.display_name));
    for (const a of assignmentRows) for (const name of [a.from_employee, a.to_employee, a.assigned_by]) if (name) names.add(name);
    for (const n of noteRows) if (n.author) names.add(n.author);
    for (const m of messageRows) if (m.author) names.add(m.author);
    for (const q of current) if (quoteOwner(q)) names.add(quoteOwner(q));
    for (const i of invoiceRows) if (i.owner) names.add(i.owner);
    if (employee) {
        names.clear();
        names.add(employee);
    }
    const allLeads = db.prepare('SELECT * FROM leads').all();
    const allAttention = leads.needingAttention(db, { staleDays: settings.follow_up_stale_days });
    const staff = [...names].map((name) => {
        const assigned = allLeads.filter((l) => l.assigned_to === name);
        const assignedVisible = employee ? assigned.filter((l) => l.assigned_to === employee) : assigned;
        const received = assignmentRows.filter((a) => a.to_employee === name).length;
        const made = assignmentRows.filter((a) => a.assigned_by === name).length;
        const reports = noteRows.filter((n) => n.author === name && n.kind !== 'handover').length;
        const replies = messageRows.filter((m) => m.author === name).length;
        const qRows = current.filter((q) => quoteOwner(q) === name);
        const iRows = invoiceRows.filter((i) => i.owner === name);
        const overdueCount = overdue.filter((l) => l.assigned_to === name).length;
        return {
            name,
            assigned: assignedVisible.length,
            assigned_open: assignedVisible.filter((l) => leads.OPEN_STATUSES.includes(l.status)).length,
            needs_attention: allAttention.filter((l) => l.assigned_to === name).length,
            overdue_48h: overdueCount,
            assignments_received: received,
            assignments_made: made,
            reports,
            replies,
            quote_count: qRows.length,
            quote_value: round2(qRows.reduce((sum, q) => sum + Number(q.total || 0), 0)),
            accepted_quote_count: qRows.filter((q) => q.status === 'accepted' || q.status === 'done').length,
            invoice_count: iRows.length,
            invoice_value: round2(iRows.reduce((sum, i) => sum + Number(i.total || 0), 0))
        };
    }).sort((a, b) => b.invoice_value - a.invoice_value || b.quote_value - a.quote_value || b.assigned_open - a.assigned_open || a.name.localeCompare(b.name, 'ar'));
    const sales = staff.map((s) => ({
        name: s.name, quote_count: s.quote_count, quote_value: s.quote_value,
        accepted_quote_count: s.accepted_quote_count, invoice_count: s.invoice_count, invoice_value: s.invoice_value
    }));

    return {
        days: n,
        from,
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
            new_customers: { value: newLeads(from), previous: newLeads(previousFrom, from) },
            open_leads: { value: open.length },
            needs_staff: { value: open.filter((l) => l.status === 'needs_staff').length },
            // Due or overdue dates, and open customers nobody followed up for a while
            due_follow_ups: { value: attention.length },
            unassigned: { value: open.filter((l) => !l.assigned_to).length },
            overdue_assignments: { value: overdue.length }
        },
        per_day: perDay,
        by_calculator: ranked(count(current, (q) => calculatorOf(q.details)), CALCULATORS),
        by_source: ranked(count(current, sourceKey), SOURCES),
        by_status: Object.keys(QUOTE_STATUSES).map((k) => ({ key: k, label: QUOTE_STATUSES[k], value: current.filter((q) => q.status === k).length })),
        by_place: ranked(count(current, placeOf)).slice(0, 8),
        leads_by_status: Object.entries(leads.STATUSES).map(([key, label]) => ({ key, label, value: leadRows.filter((l) => l.status === key).length })),
        leads_by_staff: ranked(open.reduce((m, l) => { const k = l.assigned_to || 'غير مُسند'; m[k] = (m[k] || 0) + 1; return m; }, {})),
        staff,
        sales_by_staff: sales,
        notifications: {
            overdue_assignments: {
                count: overdue.length,
                items: overdue.slice(0, 30).map((l) => ({
                    id: l.id, name: l.name, phone: l.phone, status: l.status,
                    assigned_to: l.assigned_to, assigned_at: l.assigned_at,
                    hours: l.assignment_overdue.hours, next_follow_up: l.next_follow_up
                }))
            }
        }
    };
}

module.exports = { build };
