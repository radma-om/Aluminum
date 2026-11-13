/* =============================================================
   Monthly commissions (المكافآت والعمولات)
   - Sales staff: a monthly target and a %. Their sales = the invoices
     whose payments reached half of their total (50%) in the month —
     counted in the month that happened, whenever the invoice was issued;
     cancelled ones out — before VAT, without the installation and
     delivery share. An invoice paid less than half waits. The commission is the % of what
     goes over the target: target 7000, sales 8000, 2.5% → 25.
     An invoice belongs to the quote's owner (who priced it), otherwise
     to whoever issued it — as in «أداء الموظفين».
   - Technicians: when the installation is finished: a % of the installation fee of each installation
     order they completed in the month (from its invoice, or its quote),
     each invoice / quote counted once.
   - The share of a line in an amount after discounts is taken in
     proportion: installation 10% of the lines = 10% of the subtotal.
   - A month the manager approves is saved as it was (later edits to
     invoices or targets do not change it); approval can be withdrawn.
   ============================================================= */
const TZ = '+4 hours';
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const err = (status, message) => Object.assign(new Error(message), { status });
const parse = (s, fallback) => { try { return JSON.parse(s) ?? fallback; } catch { return fallback; } };
const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
const thisMonth = (nowMs = Date.now()) => new Date(nowMs + 4 * 3600_000).toISOString().slice(0, 7);
const addMonths = (month, n) => { const [y, m] = month.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const monthName = (month) => `${MONTHS_AR[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

/* The month runs from its 1st to its last day (Muscat days); for the current month: how far into it we are */
function period(month, nowMs = Date.now()) {
    const [y, m] = month.split('-').map(Number);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const today = new Date(nowMs + 4 * 3600_000).toISOString().slice(0, 10);
    const cur = thisMonth(nowMs);
    const passed = month < cur ? days : month > cur ? 0 : Number(today.slice(8, 10));
    return { month, name: monthName(month), from: `${month}-01`, to: `${month}-${String(days).padStart(2, '0')}`, days,
        days_passed: passed, days_left: days - passed, current: month === cur, ended: month < cur };
}

const isInstallation = (i) => i.part === 'installation' || /^التركيب/.test(String(i.name || ''));
const isDelivery = (i) => i.part === 'delivery' || /^التوصيل/.test(String(i.name || ''));

/* The share (0–1) of some lines in all the lines (gift lines are 0 and change nothing) */
function share(items, pick) {
    const list = Array.isArray(items) ? items : [];
    const all = list.reduce((s, i) => s + Math.max(0, Number(i.line_total) || 0), 0);
    if (all <= 0) return 0;
    return list.filter(pick).reduce((s, i) => s + Math.max(0, Number(i.line_total) || 0), 0) / all;
}

/* ------------------------------ Figures ------------------------------ */

/* An invoice counts towards its salesperson once this share of its total is paid */
const PAID_SHARE = 0.5;

/* Every issued invoice, with the day its payments reached half of its total (null: not yet) */
function invoicesWithPayments(db) {
    const pays = new Map();
    for (const p of db.prepare('SELECT invoice_id, amount, paid_on FROM payments ORDER BY paid_on, id').all()) {
        if (!pays.has(p.invoice_id)) pays.set(p.invoice_id, []);
        pays.get(p.invoice_id).push(p);
    }
    return db.prepare("SELECT id, number, customer_name, issue_date, subtotal, total, items_json, details_json, created_by FROM invoices WHERE status = 'issued' ORDER BY issue_date, id")
        .all().map((r) => {
            let paid = 0;
            let qualified = null;
            for (const p of pays.get(r.id) || []) {
                paid += Number(p.amount) || 0;
                if (!qualified && paid >= r.total * PAID_SHARE - 0.005) qualified = p.paid_on;
            }
            const items = parse(r.items_json, []);
            const excluded = round2(r.subtotal * share(items, (i) => isInstallation(i) || isDelivery(i)));
            return {
                id: r.id, number: r.number, customer_name: r.customer_name, date: r.issue_date, qualified_on: qualified,
                owner: (parse(r.details_json, {}) || {}).created_by || r.created_by || null,
                total: round2(r.total), paid: round2(paid), paid_percent: r.total > 0 ? Math.round((paid / r.total) * 1000) / 10 : 0,
                subtotal: round2(r.subtotal), excluded, base: round2(r.subtotal - excluded)
            };
        });
}

function installationsOf(db, month) {
    const rows = db.prepare(`SELECT id, number, customer_name, technician_id, quote_id, invoice_id, date(completed_at, '${TZ}') AS date
                             FROM work_orders WHERE status = 'done' AND kind = 'installation' AND technician_id IS NOT NULL
                             AND strftime('%Y-%m', completed_at, '${TZ}') = ? ORDER BY completed_at, id`).all(month);
    // An invoice / quote whose installation was already counted (in this month or before) counts once
    const counted = new Set(db.prepare(`SELECT IFNULL('i' || invoice_id, 'q' || quote_id) AS k FROM work_orders
                                        WHERE status = 'done' AND kind = 'installation' AND (invoice_id IS NOT NULL OR quote_id IS NOT NULL)
                                        AND strftime('%Y-%m', completed_at, '${TZ}') < ?`).all(month).map((r) => r.k));
    return rows.map((o) => {
        let fee = 0;
        let note = '';
        const key = o.invoice_id ? 'i' + o.invoice_id : o.quote_id ? 'q' + o.quote_id : null;
        const src = o.invoice_id ? db.prepare("SELECT subtotal, items_json, status FROM invoices WHERE id = ?").get(o.invoice_id)
            : o.quote_id ? db.prepare('SELECT subtotal, items_json FROM quotes WHERE id = ?').get(o.quote_id) : null;
        if (!src) note = 'بلا فاتورة أو عرض — لا مبلغ تركيب';
        else if (src.status === 'cancelled') note = 'الفاتورة ملغاة';
        else if (counted.has(key)) note = 'تركيب هذه الفاتورة احتُسب في أمر سابق';
        else {
            fee = round2(src.subtotal * share(parse(src.items_json, []), isInstallation));
            if (!fee) note = 'لا يوجد بند تركيب';
        }
        if (key) counted.add(key);
        return { id: o.id, number: o.number, customer_name: o.customer_name, date: o.date, technician_id: o.technician_id, fee, note };
    });
}

/* ------------------------------ Statement ------------------------------ */

function compute(db, month, nowMs = Date.now()) {
    const per = period(month, nowMs);
    // At this pace until the month ends (current month only, from the 3rd day: earlier is noise)
    const pace = (v) => (per.current && per.days_passed >= 3 ? round2(v / per.days_passed * per.days) : null);
    const users = db.prepare("SELECT id, display_name, role, active, bonus_target, bonus_percent FROM staff_users ORDER BY role = 'technician', display_name").all();
    const all = invoicesWithPayments(db);
    // Counted in the month half of it was paid; still waiting: issued up to the month's end, under half paid now
    const sales = all.filter((i) => i.qualified_on && i.qualified_on.slice(0, 7) === month);
    const waiting = per.ended ? [] : all.filter((i) => !i.qualified_on && i.date <= per.to);
    const installs = installationsOf(db, month);
    const named = new Set(users.map((u) => u.display_name));
    const people = users.map((u) => {
        const percent = Number(u.bonus_percent) || 0;
        if (u.role === 'technician') {
            const orders = installs.filter((o) => o.technician_id === u.id);
            const base = round2(orders.reduce((s, o) => s + o.fee, 0));
            const projected = pace(base);
            return { user_id: u.id, name: u.display_name, role: u.role, active: Boolean(u.active), kind: 'technician',
                target: null, percent, base, over: null, commission: round2(base * percent / 100), count: orders.length,
                projected, projected_commission: projected == null ? null : round2(projected * percent / 100), orders };
        }
        const invoices = sales.filter((i) => i.owner === u.display_name);
        const pending = waiting.filter((i) => i.owner === u.display_name);
        const base = round2(invoices.reduce((s, i) => s + i.base, 0));
        const target = Number(u.bonus_target) || 0;
        const over = round2(Math.max(0, base - target));
        const projected = pace(base);
        return { user_id: u.id, name: u.display_name, role: u.role, active: Boolean(u.active), kind: 'sales',
            target, percent, base, over, commission: round2(over * percent / 100),
            reached: target > 0 ? base >= target : null, progress: target > 0 ? Math.round((base / target) * 1000) / 10 : null,
            left_to_target: target > 0 ? round2(Math.max(0, target - base)) : null,
            projected, projected_commission: projected == null ? null : round2(Math.max(0, projected - target) * percent / 100),
            count: invoices.length, invoices,
            // Issued but under half paid: they count when the customer pays half
            pending: pending.length, pending_base: round2(pending.reduce((s, i) => s + i.base, 0)), pending_invoices: pending };
    }).filter((p) => p.active || p.count || p.pending);
    // Invoices of no employee account (e.g. issued with the general manager's password)
    const unassigned = sales.filter((i) => !i.owner || !named.has(i.owner));
    const waitingTotal = round2(waiting.filter((i) => i.owner && named.has(i.owner)).reduce((s, i) => s + i.base, 0));
    const withTarget = people.filter((p) => p.kind === 'sales' && p.target > 0);
    return {
        month, period: per, people, unassigned,
        stats: {
            with_target: withTarget.length,
            reached: withTarget.filter((p) => p.reached).length,
            avg_progress: withTarget.length ? Math.round(withTarget.reduce((s, p) => s + p.progress, 0) / withTarget.length * 10) / 10 : null,
            earning: people.filter((p) => p.commission > 0).length,
            waiting_base: waitingTotal, waiting_count: waiting.filter((i) => i.owner && named.has(i.owner)).length,
            projected_commission: per.current && per.days_passed >= 3 ? round2(people.reduce((s, p) => s + (p.projected_commission || 0), 0)) : null,
            best: [...withTarget].sort((a, b) => b.progress - a.progress).slice(0, 3).map((p) => ({ name: p.name, progress: p.progress, commission: p.commission }))
        },
        totals: {
            sales: round2(people.filter((p) => p.kind === 'sales').reduce((s, p) => s + p.base, 0)),
            installations: round2(people.filter((p) => p.kind === 'technician').reduce((s, p) => s + p.base, 0)),
            commission: round2(people.reduce((s, p) => s + p.commission, 0))
        }
    };
}

function statement(db, month = thisMonth()) {
    if (!isMonth(month)) throw err(400, 'الشهر غير صالح');
    const saved = db.prepare('SELECT * FROM bonus_months WHERE month = ?').get(month);
    if (saved) return { ...parse(saved.data_json, {}), period: period(month), approved: { by: saved.approved_by, at: saved.approved_at } };
    return { ...compute(db, month), approved: null };
}

/* The last months side by side (approved months as they were saved) */
function history(db, month = thisMonth(), n = 6) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
        const m = addMonths(month, -i);
        const s = statement(db, m);
        out.push({ month: m, name: monthName(m), sales: s.totals.sales, installations: s.totals.installations, commission: s.totals.commission,
            reached: s.stats ? s.stats.reached : null, with_target: s.stats ? s.stats.with_target : null, approved: Boolean(s.approved) });
    }
    return out;
}

/* When a month ends it closes by itself: its statement is approved as it stood (once; the manager can reopen it),
   managers and each employee who earned something are told on their phone */
function closeEndedMonth(db, nowMs = Date.now()) {
    const prev = addMonths(thisMonth(nowMs), -1);
    const done = db.prepare("SELECT last_key FROM scheduled_runs WHERE name = 'bonus_close'").get();
    if (done && done.last_key >= prev) return null;
    // Nothing to close before the commissions were set up
    const anyPlan = db.prepare('SELECT COUNT(*) AS n FROM staff_users WHERE bonus_percent > 0').get().n;
    if (!anyPlan) return null;
    const s = db.prepare('SELECT 1 FROM bonus_months WHERE month = ?').get(prev) ? statement(db, prev) : approve(db, prev, 'إغلاق تلقائي بنهاية الشهر');
    // Mark it only after a statement exists. A first run with no plans must
    // not permanently skip the previous month if plans are added later.
    db.prepare(`INSERT INTO scheduled_runs (name, last_key, at) VALUES ('bonus_close', ?, datetime('now'))
                ON CONFLICT(name) DO UPDATE SET last_key = excluded.last_key, at = excluded.at`).run(prev);
    const push = require('./push');
    push.send(db, push.accountsOf(db, (u) => u.role === 'manager'), {
        title: `💰 أُغلق كشف عمولات ${monthName(prev)}`,
        body: `إجمالي العمولات ${s.totals.commission.toFixed(2)} ر.ع — حقق الهدف ${s.stats ? s.stats.reached : 0} من ${s.stats ? s.stats.with_target : 0}`,
        url: '/admin#tab=bonuses', tag: 'bonus-' + prev
    }).catch(() => {});
    for (const p of s.people.filter((x) => x.commission > 0)) {
        push.send(db, [`u:${p.user_id}`], {
            title: `💰 عمولتك لشهر ${monthName(prev)}`,
            body: `${p.commission.toFixed(2)} ر.ع${p.kind === 'sales' ? ` — حققت ${p.progress}% من هدفك` : ` — ${p.count} تركيبات`}`,
            url: '/admin', tag: 'bonus-' + prev
        }).catch(() => {});
    }
    return s;
}

function approve(db, month, by) {
    if (!isMonth(month)) throw err(400, 'الشهر غير صالح');
    if (month > thisMonth()) throw err(400, 'لا يُعتمد شهر لم يبدأ بعد');
    if (db.prepare('SELECT 1 FROM bonus_months WHERE month = ?').get(month)) throw err(400, 'هذا الشهر معتمد من قبل');
    db.prepare("INSERT INTO bonus_months (month, data_json, approved_by, approved_at) VALUES (?, ?, ?, datetime('now'))")
        .run(month, JSON.stringify(compute(db, month)), String(by || '').slice(0, 80) || null);
    return statement(db, month);
}

function unapprove(db, month) {
    if (!isMonth(month)) throw err(400, 'الشهر غير صالح');
    db.prepare('DELETE FROM bonus_months WHERE month = ?').run(month);
    return statement(db, month);
}

/* The manager sets an employee's target and % (a technician: the % of installation only) */
function setPlan(db, userId, { target, percent }) {
    const u = db.prepare('SELECT id, role FROM staff_users WHERE id = ?').get(Number(userId));
    if (!u) throw err(404, 'الموظف غير موجود');
    const num = (v, label, max) => {
        if (v === '' || v === null || v === undefined) return null;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > max) throw err(400, `${label} غير صالح`);
        return round2(n);
    };
    const p = num(percent, 'النسبة', 100);
    const t = u.role === 'technician' ? null : num(target, 'الهدف', 10_000_000);
    db.prepare('UPDATE staff_users SET bonus_target = ?, bonus_percent = ? WHERE id = ?').run(t, p, u.id);
    return { user_id: u.id, target: t, percent: p };
}

/* What an employee sees of their own month: their target, how far they are, their commission so far */
function mine(db, user, month = thisMonth()) {
    if (!user || user.owner || !user.id) return null;
    const s = statement(db, month);
    const me = s.people.find((p) => p.user_id === user.id);
    if (!me || (!me.percent && !me.target)) return null;
    const { invoices, orders, pending_invoices: pendingInvoices, ...summary } = me;
    const before = statement(db, addMonths(month, -1)).people.find((p) => p.user_id === user.id);
    return { month, period: s.period || period(month), approved: Boolean(s.approved), ...summary,
        previous: before ? { month: addMonths(month, -1), name: monthName(addMonths(month, -1)), commission: before.commission, progress: before.progress ?? null } : null };
}

module.exports = { PAID_SHARE, statement, approve, unapprove, setPlan, mine, compute, history, closeEndedMonth, period, share, isInstallation, isDelivery, thisMonth, addMonths };
