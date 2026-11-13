/* =============================================================
   For managers:
   - pulse(): what is happening today (quotes, invoices, money received,
     appointments, requests waiting), three rates over the dashboard's
     period, the sales path and the latest events.
   - report(): each employee's work between two dates — follow-up,
     quotes, invoices, money received, work orders — with the same
     period before for comparison, and one employee in detail (day by
     day, their latest actions, the customers waiting for them).
   Days are Muscat days (UTC+4): stored times are shifted before they
   are grouped.
   ============================================================= */
const leads = require('./leads');
const { getSettings } = require('./db');

const TZ = '+4 hours';
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));
const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const parse = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };
const err = (status, message) => Object.assign(new Error(message), { status });
const ms = (s) => Date.parse(String(s).replace(' ', 'T') + 'Z');
const won = (q) => q.status === 'accepted' || q.status === 'done';

const KINDS = { installation: 'تركيب', maintenance: 'صيانة', inspection: 'معاينة' };
const ROLES = { manager: 'مدير', staff: 'موظف', technician: 'فني' };

/* ------------------------------ Dashboard pulse ------------------------------ */

function pulse(db, { days = 30, today = leads.localToday() } = {}) {
    const n = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
    const from = addDays(today, -(n - 1));
    const one = (sql, ...args) => db.prepare(sql).get(...args);
    const yesterday = addDays(today, -1);

    const quotesOn = (d) => one(`SELECT COUNT(*) AS count, IFNULL(SUM(total), 0) AS value FROM quotes WHERE date(created_at, '${TZ}') = ?`, d);
    const invoicesOn = (d) => one("SELECT COUNT(*) AS count, IFNULL(SUM(total), 0) AS value FROM invoices WHERE status = 'issued' AND issue_date = ?", d);
    const paidOn = (d) => one(`SELECT COUNT(*) AS count, IFNULL(SUM(p.amount), 0) AS value FROM payments p JOIN invoices i ON i.id = p.invoice_id
                               WHERE i.status = 'issued' AND p.paid_on = ?`, d);
    const visits = one(`SELECT COUNT(*) AS total, IFNULL(SUM(status = 'done'), 0) AS done, IFNULL(SUM(status = 'in_progress'), 0) AS running
                        FROM work_orders WHERE scheduled_date = ? AND status != 'cancelled'`, today);
    const owed = one(`SELECT IFNULL(SUM(i.total - IFNULL(p.paid, 0)), 0) AS value, COUNT(*) AS count FROM invoices i
                      LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id) p ON p.invoice_id = i.id
                      WHERE i.status = 'issued' AND i.total - IFNULL(p.paid, 0) > 0.005`);
    const tile = (now, before) => ({ count: now.count, value: round2(now.value), previous_count: before.count, previous_value: round2(before.value) });

    // Three rates over the period
    const q = one(`SELECT COUNT(*) AS total, IFNULL(SUM(status IN ('accepted', 'done')), 0) AS won FROM quotes WHERE date(created_at, '${TZ}') >= ?`, from);
    const inv = one(`SELECT COUNT(*) AS count, IFNULL(SUM(i.total), 0) AS total, IFNULL(SUM(MIN(IFNULL(p.paid, 0), i.total)), 0) AS paid,
                            IFNULL(SUM(IFNULL(p.paid, 0) >= i.total - 0.005), 0) AS settled
                     FROM invoices i LEFT JOIN (SELECT invoice_id, SUM(amount) AS paid FROM payments GROUP BY invoice_id) p ON p.invoice_id = i.id
                     WHERE i.status = 'issued' AND i.issue_date >= ?`, from);
    const jobs = one(`SELECT COUNT(*) AS done, IFNULL(SUM(date(completed_at, '${TZ}') <= scheduled_date), 0) AS on_time
                      FROM work_orders WHERE status = 'done' AND scheduled_date IS NOT NULL AND date(completed_at, '${TZ}') >= ?`, from);

    // The latest events, newest first
    const events = [
        ...db.prepare('SELECT ref, customer_name, total, source, details_json, created_at FROM quotes ORDER BY id DESC LIMIT 12').all().map((r) => ({
            at: r.created_at, type: 'quote', who: parse(r.details_json).created_by || null,
            text: `عرض سعر ${r.ref} — ${r.customer_name}`, amount: round2(r.total)
        })),
        ...db.prepare("SELECT number, customer_name, total, created_by, created_at FROM invoices WHERE status = 'issued' ORDER BY id DESC LIMIT 12").all().map((r) => ({
            at: r.created_at, type: 'invoice', who: r.created_by, text: `فاتورة ${r.number} — ${r.customer_name}`, amount: round2(r.total)
        })),
        ...db.prepare(`SELECT p.amount, p.created_by, p.created_at, i.number, i.customer_name FROM payments p JOIN invoices i ON i.id = p.invoice_id
                       ORDER BY p.id DESC LIMIT 12`).all().map((r) => ({
            at: r.created_at, type: 'payment', who: r.created_by, text: `دفعة على ${r.number} — ${r.customer_name}`, amount: round2(r.amount)
        })),
        ...db.prepare(`SELECT w.number, w.kind, w.customer_name, w.completed_at, u.display_name AS tech FROM work_orders w
                       LEFT JOIN staff_users u ON u.id = w.technician_id WHERE w.status = 'done' AND w.completed_at IS NOT NULL
                       ORDER BY w.completed_at DESC LIMIT 12`).all().map((r) => ({
            at: r.completed_at, type: 'job', who: r.tech, text: `اكتمل ${KINDS[r.kind] || r.kind} ${r.number} — ${r.customer_name}`
        })),
        ...db.prepare('SELECT ref, kind, customer_name, created_at FROM service_requests ORDER BY id DESC LIMIT 12').all().map((r) => ({
            at: r.created_at, type: 'request', who: null, text: `طلب موعد ${KINDS[r.kind] || r.kind} ${r.ref} — ${r.customer_name}`
        }))
    ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 12);

    return {
        today,
        quotes: tile(quotesOn(today), quotesOn(yesterday)),
        invoices: tile(invoicesOn(today), invoicesOn(yesterday)),
        collected: tile(paidOn(today), paidOn(yesterday)),
        visits: { total: visits.total, done: visits.done, running: visits.running },
        pending_requests: one("SELECT COUNT(*) AS n FROM service_requests WHERE status = 'pending'").n,
        customer_messages: one(`SELECT COUNT(*) AS n FROM lead_messages WHERE role = 'customer' AND date(created_at, '${TZ}') = ?`, today).n,
        outstanding: { value: round2(owed.value), count: owed.count },
        rates: {
            win: { percent: pct(q.won, q.total), part: q.won, whole: q.total },
            collection: { percent: pct(inv.paid, inv.total), part: round2(inv.paid), whole: round2(inv.total) },
            on_time: { percent: pct(jobs.on_time, jobs.done), part: jobs.on_time, whole: jobs.done }
        },
        funnel: [
            { key: 'quotes', label: 'عروض الأسعار', value: q.total },
            { key: 'won', label: 'عروض مقبولة', value: q.won },
            { key: 'invoices', label: 'فواتير صادرة', value: inv.count },
            { key: 'settled', label: 'فواتير مسددة بالكامل', value: inv.settled }
        ],
        activity: events
    };
}

/* ------------------------------ Employees ------------------------------ */

/* Everything employees did between two Muscat days, as flat rows { name, date, at, … } */
function load(db, from, to) {
    const between = (col) => `date(${col}, '${TZ}') BETWEEN ? AND ?`;
    const quotes = db.prepare(`SELECT id, ref, customer_name, total, status, details_json, created_at, date(created_at, '${TZ}') AS date
                               FROM quotes WHERE ${between('created_at')}`).all(from, to)
        .map((r) => { const d = parse(r.details_json); return { ...r, name: d.created_by || null, discount_percent: Number(d.discount_percent) || 0, staff_quote: Boolean(d.staff_quote) }; })
        .filter((r) => r.name);
    const invoices = db.prepare(`SELECT number, customer_name, total, created_by, details_json, created_at, issue_date AS date
                                 FROM invoices WHERE status = 'issued' AND issue_date BETWEEN ? AND ?`).all(from, to)
        // A manager may issue the invoice of an employee's quote: the sale is the employee's
        .map((r) => ({ ...r, name: parse(r.details_json).created_by || r.created_by })).filter((r) => r.name);
    const payments = db.prepare(`SELECT p.amount, p.created_by AS name, p.created_at, p.paid_on AS date, i.number, i.customer_name
                                 FROM payments p JOIN invoices i ON i.id = p.invoice_id
                                 WHERE i.status = 'issued' AND p.paid_on BETWEEN ? AND ? AND p.created_by IS NOT NULL`).all(from, to);
    const notes = db.prepare(`SELECT n.lead_id, n.kind, n.author AS name, n.text, n.created_at, date(n.created_at, '${TZ}') AS date, l.name AS lead_name, l.phone
                              FROM lead_notes n JOIN leads l ON l.id = n.lead_id
                              WHERE n.author IS NOT NULL AND n.author != 'النظام' AND n.kind != 'handover' AND ${between('n.created_at')}`).all(from, to);
    const replies = db.prepare(`SELECT m.lead_id, m.author AS name, m.text, m.created_at, date(m.created_at, '${TZ}') AS date, l.name AS lead_name, l.phone
                                FROM lead_messages m JOIN leads l ON l.id = m.lead_id
                                WHERE m.role = 'staff' AND m.author IS NOT NULL AND ${between('m.created_at')}`).all(from, to);
    const assignments = db.prepare(`SELECT a.lead_id, a.from_employee, a.to_employee, a.assigned_by, a.created_at, date(a.created_at, '${TZ}') AS date, l.name AS lead_name, l.phone
                                    FROM lead_assignments a JOIN leads l ON l.id = a.lead_id WHERE ${between('a.created_at')}`).all(from, to);
    const jobs = db.prepare(`SELECT w.number, w.kind, w.customer_name, w.scheduled_date, w.completed_at, date(w.completed_at, '${TZ}') AS date, u.display_name AS name
                             FROM work_orders w JOIN staff_users u ON u.id = w.technician_id
                             WHERE w.status = 'done' AND w.completed_at IS NOT NULL AND ${between('w.completed_at')}`).all(from, to);
    const ordersMade = db.prepare(`SELECT created_by AS name, created_at, date(created_at, '${TZ}') AS date FROM work_orders
                                   WHERE created_by IS NOT NULL AND ${between('created_at')}`).all(from, to);
    return { quotes, invoices, payments, notes, replies, assignments, jobs, ordersMade };
}

/* Hours from each assignment to the employee's first own action on that customer (the mean; null when none was answered) */
function responseHours(db, assignments, name, to = null) {
    const first = db.prepare(`SELECT MIN(at) AS at FROM (
        SELECT created_at AS at FROM lead_notes WHERE lead_id = ? AND author = ? AND created_at >= ? AND date(created_at, '${TZ}') <= COALESCE(?, '9999-12-31')
        UNION ALL SELECT created_at FROM lead_messages WHERE lead_id = ? AND role = 'staff' AND author = ? AND created_at >= ? AND date(created_at, '${TZ}') <= COALESCE(?, '9999-12-31'))`);
    const hours = [];
    let waiting = 0;
    for (const a of assignments.filter((x) => x.to_employee === name && x.assigned_by !== name)) {
        const at = first.get(a.lead_id, name, a.created_at, to, a.lead_id, name, a.created_at, to).at;
        if (at) hours.push((ms(at) - ms(a.created_at)) / 3600000); else waiting++;
    }
    return { answered: hours.length, waiting, hours: hours.length ? Math.round((hours.reduce((s, h) => s + h, 0) / hours.length) * 10) / 10 : null };
}

function figures(db, data, name, to = null) {
    const mine = (rows) => rows.filter((r) => r.name === name);
    const quotes = mine(data.quotes);
    const invoices = mine(data.invoices);
    const payments = mine(data.payments);
    const notes = mine(data.notes);
    const replies = mine(data.replies);
    const jobs = mine(data.jobs);
    const discounted = quotes.filter((q) => q.staff_quote && q.discount_percent > 0);
    const sum = (rows, k = 'total') => round2(rows.reduce((s, r) => s + Number(r[k] || 0), 0));
    const days = new Set([...quotes, ...invoices, ...payments, ...notes, ...replies, ...jobs, ...mine(data.ordersMade)].map((r) => r.date));
    const response = responseHours(db, data.assignments, name, to);
    return {
        quote_count: quotes.length, quote_value: sum(quotes),
        accepted_count: quotes.filter(won).length, win_rate: pct(quotes.filter(won).length, quotes.length),
        average_discount: discounted.length ? Math.round((discounted.reduce((s, q) => s + q.discount_percent, 0) / discounted.length) * 10) / 10 : null,
        invoice_count: invoices.length, invoice_value: sum(invoices),
        collected: sum(payments, 'amount'), payment_count: payments.length,
        replies: replies.length, reports: notes.length,
        customers_handled: new Set([...notes, ...replies].map((r) => r.lead_id)).size,
        assignments_received: data.assignments.filter((a) => a.to_employee === name).length,
        assignments_made: data.assignments.filter((a) => a.assigned_by === name && a.to_employee && a.to_employee !== name).length,
        response_hours: response.hours, assignments_answered: response.answered, assignments_waiting: response.waiting,
        jobs_done: jobs.length, jobs_on_time: jobs.filter((j) => j.scheduled_date && j.date <= j.scheduled_date).length,
        orders_created: mine(data.ordersMade).length,
        active_days: days.size
    };
}

const TOTAL_KEYS = ['quote_count', 'quote_value', 'accepted_count', 'invoice_count', 'invoice_value', 'collected', 'replies', 'reports', 'jobs_done', 'assignments_received'];
const totalsOf = (rows) => {
    const t = Object.fromEntries(TOTAL_KEYS.map((k) => [k, round2(rows.reduce((s, r) => s + (r[k] || 0), 0))]));
    const answered = rows.filter((r) => r.response_hours != null);
    const weight = answered.reduce((s, r) => s + r.assignments_answered, 0);
    t.response_hours = weight ? Math.round((answered.reduce((s, r) => s + r.response_hours * r.assignments_answered, 0) / weight) * 10) / 10 : null;
    t.win_rate = pct(t.accepted_count, t.quote_count);
    return t;
};

/**
 * { from, to, employee? } — Muscat days, both included (up to 366 days).
 * Returns the range, the same length before it, a row per employee, team totals for both, and one employee in detail.
 */
function report(db, { from, to, employee = '', today = leads.localToday() } = {}) {
    const end = isDate(to) ? to : today;
    const start = isDate(from) ? from : addDays(end, -29);
    if (start > end) throw err(400, 'تاريخ البداية بعد تاريخ النهاية');
    const length = daysBetween(start, end) + 1;
    if (length > 366) throw err(400, 'الفترة طويلة جداً — اختر سنة على الأكثر');
    const prevEnd = addDays(start, -1);
    const prevStart = addDays(prevEnd, -(length - 1));

    const data = load(db, start, end);
    const before = load(db, prevStart, prevEnd);
    const accounts = db.prepare('SELECT id, username, display_name, role, active, email FROM staff_users ORDER BY active DESC, display_name').all();
    const names = new Map(accounts.map((a) => [a.display_name, a]));
    for (const rows of [data.quotes, data.invoices, data.payments, data.notes, data.replies, data.jobs]) for (const r of rows) if (!names.has(r.name)) names.set(r.name, null);
    for (const a of data.assignments) if (a.to_employee && !names.has(a.to_employee)) names.set(a.to_employee, null);

    const settings = getSettings(db);
    const allLeads = db.prepare('SELECT * FROM leads').all();
    const attention = leads.needingAttention(db, { staleDays: settings.follow_up_stale_days });
    const overdue = leads.overdueAssignments(db);
    const lastSeen = db.prepare('SELECT MAX(at) AS at FROM audit_log WHERE user_id = ?');

    const staff = [...names].map(([name, account]) => {
        const assigned = allLeads.filter((l) => l.assigned_to === name);
        const f = figures(db, data, name, end);
        const p = figures(db, before, name, prevEnd);
        return {
            name, id: account ? account.id : null, username: account ? account.username : null,
            role: account ? account.role : null, role_label: account ? ROLES[account.role] || account.role : 'حساب محذوف',
            active: account ? Boolean(account.active) : false,
            ...f,
            previous: { quote_value: p.quote_value, invoice_value: p.invoice_value, collected: p.collected, replies: p.replies, reports: p.reports, jobs_done: p.jobs_done },
            // Now, whatever the period
            open_customers: assigned.filter((l) => leads.OPEN_STATUSES.includes(l.status)).length,
            needs_attention: attention.filter((l) => l.assigned_to === name).length,
            overdue_48h: overdue.filter((l) => l.assigned_to === name).length,
            last_seen: account ? lastSeen.get(account.id).at : null
        };
    }).filter((s) => s.active || s.quote_count || s.invoice_count || s.collected || s.replies || s.reports || s.jobs_done || s.open_customers)
        .sort((a, b) => b.invoice_value - a.invoice_value || b.quote_value - a.quote_value || (b.replies + b.reports) - (a.replies + a.reports) || a.name.localeCompare(b.name, 'ar'));

    const previousRows = [...names.keys()].map((name) => figures(db, before, name, prevEnd));
    const out = {
        from: start, to: end, days: length, previous_from: prevStart, previous_to: prevEnd,
        staff, totals: totalsOf(staff), previous_totals: totalsOf(previousRows)
    };
    if (employee) out.employee = detail(db, data, String(employee), start, end, { attention, overdue, staff });
    return out;
}

/* One employee: day by day, latest actions, quotes by status, and who is waiting for them now */
function detail(db, data, name, from, to, { attention, overdue, staff }) {
    const row = staff.find((s) => s.name === name);
    if (!row) throw err(404, 'الموظف غير موجود في هذه الفترة');
    const mine = (rows) => rows.filter((r) => r.name === name);
    const perDay = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
        const on = (rows) => mine(rows).filter((r) => r.date === d);
        perDay.push({
            date: d,
            follow_ups: on(data.notes).length + on(data.replies).length,
            quotes: on(data.quotes).length,
            quote_value: round2(on(data.quotes).reduce((s, q) => s + q.total, 0)),
            invoice_value: round2(on(data.invoices).reduce((s, q) => s + q.total, 0)),
            jobs: on(data.jobs).length
        });
    }
    const who = (r) => r.lead_name || (r.phone ? '+' + r.phone : 'عميل');
    const clip = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 140);
    const timeline = [
        ...mine(data.quotes).map((r) => ({ at: r.created_at, type: 'quote', text: `عرض سعر ${r.ref} — ${r.customer_name}`, amount: round2(r.total) })),
        ...mine(data.invoices).map((r) => ({ at: r.created_at, type: 'invoice', text: `فاتورة ${r.number} — ${r.customer_name}`, amount: round2(r.total) })),
        ...mine(data.payments).map((r) => ({ at: r.created_at, type: 'payment', text: `دفعة على ${r.number} — ${r.customer_name}`, amount: round2(r.amount) })),
        ...mine(data.notes).map((r) => ({ at: r.created_at, type: 'report', text: `${leads.NOTE_KINDS[r.kind] || 'ملاحظة'} — ${who(r)}: ${clip(r.text)}` })),
        ...mine(data.replies).map((r) => ({ at: r.created_at, type: 'reply', text: `رد على ${who(r)}: ${clip(r.text)}` })),
        ...mine(data.jobs).map((r) => ({ at: r.completed_at, type: 'job', text: `اكتمل ${KINDS[r.kind] || r.kind} ${r.number} — ${r.customer_name}` })),
        ...data.assignments.filter((a) => a.to_employee === name).map((a) => ({ at: a.created_at, type: 'assigned', text: `أُسند إليه ${who(a)}${a.assigned_by && a.assigned_by !== name ? ` (من ${a.assigned_by})` : ''}` }))
    ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 60);

    const late = new Map(overdue.filter((l) => l.assigned_to === name).map((l) => [l.id, l.assignment_overdue.hours]));
    const waiting = attention.filter((l) => l.assigned_to === name).map((l) => ({
        id: l.id, name: l.name, phone: l.phone, status: l.status, status_label: leads.STATUSES[l.status] || l.status,
        reason: l.attention.reason, days: l.attention.days || null, date: l.attention.date || null, overdue_hours: late.get(l.id) || null
    }));
    for (const l of overdue.filter((x) => x.assigned_to === name && !waiting.some((w) => w.id === x.id))) {
        waiting.push({ id: l.id, name: l.name, phone: l.phone, status: l.status, status_label: leads.STATUSES[l.status] || l.status, reason: 'assigned_overdue', overdue_hours: l.assignment_overdue.hours });
    }
    const statuses = { new: 'جديد', contacted: 'تم التواصل', accepted: 'مقبول', done: 'منفّذ', rejected: 'مرفوض' };
    return {
        ...row,
        per_day: perDay,
        timeline,
        waiting: waiting.slice(0, 40),
        quotes_by_status: Object.entries(statuses).map(([key, label]) => ({ key, label, value: mine(data.quotes).filter((q) => q.status === key).length }))
    };
}

module.exports = { pulse, report };
