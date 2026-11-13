/* =============================================================
   Monthly commissions (المكافآت والعمولات)
   - Sales staff: a monthly target and a %. Their sales = the invoices
     issued in the month (cancelled ones out), before VAT, without the
     installation and delivery share. The commission is the % of what
     goes over the target: target 7000, sales 8000, 2.5% → 25.
     An invoice belongs to the quote's owner (who priced it), otherwise
     to whoever issued it — as in «أداء الموظفين».
   - Technicians: a % of the installation fee of each installation
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
const thisMonth = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 7);

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

function salesOf(db, month) {
    return db.prepare("SELECT id, number, customer_name, issue_date, subtotal, items_json, details_json, created_by FROM invoices WHERE status = 'issued' AND issue_date LIKE ? ORDER BY issue_date, id")
        .all(month + '-%').map((r) => {
            const items = parse(r.items_json, []);
            const out = share(items, (i) => isInstallation(i) || isDelivery(i));
            const excluded = round2(r.subtotal * out);
            return {
                id: r.id, number: r.number, customer_name: r.customer_name, date: r.issue_date,
                owner: (parse(r.details_json, {}) || {}).created_by || r.created_by || null,
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

function compute(db, month) {
    const users = db.prepare("SELECT id, display_name, role, active, bonus_target, bonus_percent FROM staff_users ORDER BY role = 'technician', display_name").all();
    const sales = salesOf(db, month);
    const installs = installationsOf(db, month);
    const named = new Set(users.map((u) => u.display_name));
    const people = users.map((u) => {
        const percent = Number(u.bonus_percent) || 0;
        if (u.role === 'technician') {
            const orders = installs.filter((o) => o.technician_id === u.id);
            const base = round2(orders.reduce((s, o) => s + o.fee, 0));
            return { user_id: u.id, name: u.display_name, role: u.role, active: Boolean(u.active), kind: 'technician',
                target: null, percent, base, over: null, commission: round2(base * percent / 100), count: orders.length, orders };
        }
        const invoices = sales.filter((i) => i.owner === u.display_name);
        const base = round2(invoices.reduce((s, i) => s + i.base, 0));
        const target = Number(u.bonus_target) || 0;
        const over = round2(Math.max(0, base - target));
        return { user_id: u.id, name: u.display_name, role: u.role, active: Boolean(u.active), kind: 'sales',
            target, percent, base, over, commission: round2(over * percent / 100),
            reached: target > 0 ? base >= target : null, progress: target > 0 ? Math.round((base / target) * 1000) / 10 : null,
            count: invoices.length, invoices };
    }).filter((p) => p.active || p.count);
    // Invoices of no employee account (e.g. issued with the general manager's password)
    const unassigned = sales.filter((i) => !i.owner || !named.has(i.owner));
    return {
        month, people, unassigned,
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
    if (saved) return { ...parse(saved.data_json, {}), approved: { by: saved.approved_by, at: saved.approved_at } };
    return { ...compute(db, month), approved: null };
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
    const { invoices, orders, ...summary } = me;
    return { month, approved: Boolean(s.approved), ...summary };
}

module.exports = { statement, approve, unapprove, setPlan, mine, compute, share, isInstallation, isDelivery, thisMonth };
