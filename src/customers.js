/* =============================================================
   Customers: one record per customer, with everything linked to them.
   - The phone number is the key (the same one that already links the
     follow-up, quotes, invoices and work orders); a second phone also
     links its records. Name, email, wilayah, address, map link, notes.
   - Built from the existing data on first start; afterwards every new
     customer (WhatsApp, the calculators, a manual work order) is added
     automatically. A name typed by an employee is never overwritten.
   - The profile: follow-up, quotes, invoices (paid / owed), work orders.
   ============================================================= */

const err = (status, message) => Object.assign(new Error(message), { status });
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/* Same rule as WhatsApp numbers: digits only; an 8-digit Omani number gets 968 */
function normalizePhone(phone) {
    let d = String(phone || '').replace(/\D/g, '').replace(/^00/, '');
    if (d.length === 8) d = '968' + d;
    return d;
}

/* Called whenever a customer shows up with a phone: creates the record, or fills what is missing */
function ensure(db, { phone, name = null, city = null } = {}) {
    const p = normalizePhone(phone);
    if (p.length < 8) return null;
    const row = db.prepare('SELECT * FROM customers WHERE phone = ? OR phone2 = ?').get(p, p);
    if (!row) {
        db.prepare('INSERT INTO customers (phone, name, city) VALUES (?, ?, ?)').run(p, clip(name, 120) || null, clip(city, 120) || null);
        return db.prepare('SELECT * FROM customers WHERE phone = ?').get(p);
    }
    const fill = {};
    if (name && !row.name) fill.name = clip(name, 120);
    if (city && !row.city) fill.city = clip(city, 120);
    if (Object.keys(fill).length) {
        db.prepare(`UPDATE customers SET ${Object.keys(fill).map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
            .run(...Object.values(fill), row.id);
    }
    return { ...row, ...fill };
}

/* First start: one customer per phone found anywhere, named after their latest quote */
function backfill(db) {
    if (db.prepare('SELECT COUNT(*) AS n FROM customers').get().n) return 0;
    const ins = db.prepare("INSERT OR IGNORE INTO customers (phone, name, city, created_at) VALUES (?, NULLIF(?, ''), NULLIF(?, ''), ?)");
    let n = 0;
    const add = (rows) => { for (const r of rows) { const p = normalizePhone(r.phone); if (p.length >= 8) n += Number(ins.run(p, clip(r.name, 120), clip(r.city, 120), r.at || new Date().toISOString().replace('T', ' ').slice(0, 19)).changes); } };
    add(db.prepare('SELECT customer_phone AS phone, customer_name AS name, customer_city AS city, created_at AS at FROM quotes ORDER BY id DESC').all());
    add(db.prepare("SELECT customer_phone AS phone, customer_name AS name, customer_city AS city, created_at AS at FROM invoices ORDER BY id DESC").all());
    add(db.prepare('SELECT customer_phone AS phone, customer_name AS name, location AS city, created_at AS at FROM work_orders ORDER BY id DESC').all());
    add(db.prepare('SELECT phone, name, NULL AS city, created_at AS at FROM leads WHERE phone IS NOT NULL ORDER BY id DESC').all());
    // A name only the follow-up knows (WhatsApp profile name)
    db.exec(`UPDATE customers SET name = (SELECT name FROM leads WHERE leads.phone = customers.phone AND name IS NOT NULL LIMIT 1)
             WHERE name IS NULL`);
    return n;
}

const phonesOf = (c) => [c.phone, c.phone2].filter(Boolean);
const inList = (c) => phonesOf(c).map(() => '?').join(', ');

const AGG = (c) => `
    (SELECT COUNT(*) FROM quotes WHERE customer_phone IN (${inList(c)})) AS quote_count,
    (SELECT IFNULL(SUM(total), 0) FROM invoices WHERE status = 'issued' AND customer_phone IN (${inList(c)})) AS invoiced,
    (SELECT IFNULL(SUM(p.amount), 0) FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE i.status = 'issued' AND i.customer_phone IN (${inList(c)})) AS paid,
    (SELECT COUNT(*) FROM work_orders WHERE status IN ('new', 'scheduled', 'in_progress') AND customer_phone IN (${inList(c)})) AS open_jobs`;

function withFigures(db, c) {
    const ph = phonesOf(c);
    const f = db.prepare(`SELECT ${AGG(c)}`).get(...ph, ...ph, ...ph, ...ph);
    const last = db.prepare(`SELECT MAX(t) AS t FROM (
            SELECT MAX(created_at) AS t FROM quotes WHERE customer_phone IN (${inList(c)})
            UNION ALL SELECT MAX(last_activity_at) FROM leads WHERE phone IN (${inList(c)})
            UNION ALL SELECT MAX(updated_at) FROM work_orders WHERE customer_phone IN (${inList(c)})
            UNION ALL SELECT MAX(created_at) FROM invoices WHERE customer_phone IN (${inList(c)}))`).get(...ph, ...ph, ...ph, ...ph).t;
    return { ...c, quote_count: f.quote_count, invoiced: round2(f.invoiced), paid: round2(f.paid), balance: round2(f.invoiced - f.paid), open_jobs: f.open_jobs, last_activity: last || c.created_at };
}

function list(db, { q = '', owes = false, limit = 300 } = {}) {
    const where = [];
    const args = [];
    if (q) {
        const like = `%${clip(q, 60)}%`;
        const digits = String(q).replace(/\D/g, '');
        where.push(`(IFNULL(name, '') LIKE ? OR IFNULL(city, '') LIKE ? OR IFNULL(email, '') LIKE ?${digits ? ' OR phone LIKE ? OR IFNULL(phone2, \'\') LIKE ?' : ''})`);
        args.push(like, like, like, ...(digits ? [`%${digits}%`, `%${digits}%`] : []));
    }
    const rows = db.prepare(`SELECT * FROM customers ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC, id DESC LIMIT 2000`).all(...args)
        .map((c) => withFigures(db, c))
        .filter((c) => !owes || c.balance > 0.0005)
        .sort((a, b) => String(b.last_activity).localeCompare(String(a.last_activity)));
    return rows.slice(0, limit);
}

/* Everything about one customer */
function profile(db, id, { invoicesLib, workordersLib }) {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(id));
    if (!c) throw err(404, 'العميل غير موجود');
    const ph = phonesOf(c);
    const today = new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
    return {
        customer: withFigures(db, c),
        leads: db.prepare(`SELECT id, channel, status, assigned_to, next_follow_up, last_message, last_activity_at FROM leads WHERE phone IN (${inList(c)}) ORDER BY last_activity_at DESC`).all(...ph),
        quotes: db.prepare(`SELECT id, ref, total, status, created_at, valid_until, details_json FROM quotes WHERE customer_phone IN (${inList(c)}) ORDER BY id DESC LIMIT 100`).all(...ph)
            .map(({ details_json, ...q }) => {
                const d = details_json ? JSON.parse(details_json) : {};
                const inv = invoicesLib.activeForQuote(db, q.id);
                return {
                    ...q, total_to: d && d.range ? d.range.total_to : null,
                    expired: Boolean(q.valid_until && q.valid_until < today && ['new', 'contacted'].includes(q.status)),
                    invoice: inv ? { id: inv.id, number: inv.number } : null
                };
            }),
        invoices: db.prepare(`SELECT id FROM invoices WHERE customer_phone IN (${inList(c)}) ORDER BY id DESC LIMIT 100`).all(...ph)
            .map((r) => {
                const inv = invoicesLib.get(db, r.id);
                return { id: inv.id, number: inv.number, issue_date: inv.issue_date, due_date: inv.due_date, total: inv.total, paid: inv.paid, balance: inv.balance, state: inv.state, state_label: inv.state_label };
            }),
        work_orders: db.prepare(`SELECT id FROM work_orders WHERE customer_phone IN (${inList(c)}) ORDER BY id DESC LIMIT 100`).all(...ph)
            .map((r) => {
                const o = workordersLib.get(db, r.id);
                return { id: o.id, number: o.number, kind_label: o.kind_label, status: o.status, status_label: o.status_label, scheduled_date: o.scheduled_date, technician_name: o.technician_name, completed_at: o.completed_at };
            })
    };
}

function cleanEmail(v) {
    const e = clip(v, 120).toLowerCase();
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw err(400, 'البريد الإلكتروني غير صالح');
    return e || null;
}
function cleanMap(v) {
    const s = clip(v, 500);
    if (!s) return null;
    let u;
    try { u = new URL(s); } catch { throw err(400, 'رابط الموقع على الخريطة غير صالح'); }
    if (!['https:', 'http:'].includes(u.protocol)) throw err(400, 'رابط الموقع يجب أن يبدأ بـ https');
    return u.href;
}
function cleanSecondPhone(db, v, ownId, mainPhone) {
    const p = normalizePhone(v);
    if (!p) return null;
    if (p.length < 8) throw err(400, 'الرقم الثاني غير صالح');
    if (p === mainPhone) return null;
    if (db.prepare('SELECT id FROM customers WHERE (phone = ? OR phone2 = ?) AND id != ?').get(p, p, ownId || 0)) throw err(400, 'الرقم الثاني مسجّل لعميل آخر');
    return p;
}

function create(db, input) {
    const phone = normalizePhone(input.phone);
    if (phone.length < 8) throw err(400, 'اكتب رقم جوال العميل');
    if (db.prepare('SELECT id FROM customers WHERE phone = ? OR phone2 = ?').get(phone, phone)) throw err(400, 'هذا الرقم مسجّل لعميل موجود — ابحث عنه في القائمة');
    const name = clip(input.name, 120);
    if (!name) throw err(400, 'اكتب اسم العميل');
    const phone2 = cleanSecondPhone(db, input.phone2, 0, phone);
    const info = db.prepare(`INSERT INTO customers (phone, phone2, name, email, city, address, map_url, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(phone, phone2, name, cleanEmail(input.email), clip(input.city, 120) || null, clip(input.address, 200) || null, cleanMap(input.map_url), clip(input.notes, 2000) || null);
    return db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(info.lastInsertRowid));
}

/* The main phone stays (it links the history); everything else can change. The name follows into the follow-up. */
function update(db, id, input) {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(id));
    if (!c) throw err(404, 'العميل غير موجود');
    const set = {};
    if (input.name !== undefined) { set.name = clip(input.name, 120); if (!set.name) throw err(400, 'اسم العميل لا يكون فارغاً'); }
    if (input.phone2 !== undefined) set.phone2 = cleanSecondPhone(db, input.phone2, c.id, c.phone);
    if (input.email !== undefined) set.email = cleanEmail(input.email);
    if (input.city !== undefined) set.city = clip(input.city, 120) || null;
    if (input.address !== undefined) set.address = clip(input.address, 200) || null;
    if (input.map_url !== undefined) set.map_url = cleanMap(input.map_url);
    if (input.notes !== undefined) set.notes = clip(input.notes, 2000) || null;
    if (!Object.keys(set).length) return c;
    db.prepare(`UPDATE customers SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(set), c.id);
    if (set.name) db.prepare(`UPDATE leads SET name = ? WHERE phone IN (${inList(c)})`).run(set.name, ...phonesOf(c));
    return db.prepare('SELECT * FROM customers WHERE id = ?').get(c.id);
}

/* Only a customer with nothing linked (e.g. added by mistake) */
function remove(db, id) {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(id));
    if (!c) throw err(404, 'العميل غير موجود');
    const f = withFigures(db, c);
    const ph = phonesOf(c);
    const linked = f.quote_count + db.prepare(`SELECT COUNT(*) AS n FROM invoices WHERE customer_phone IN (${inList(c)})`).get(...ph).n
        + db.prepare(`SELECT COUNT(*) AS n FROM work_orders WHERE customer_phone IN (${inList(c)})`).get(...ph).n;
    if (linked) throw err(400, 'لا يُحذف عميل له عروض أو فواتير أو أوامر عمل');
    db.prepare('DELETE FROM customers WHERE id = ?').run(c.id);
}

/* The same customer on two numbers (two records): the other record's number becomes this one's second
   number — its quotes, invoices, orders and chats join by that number — empty fields are filled, and
   the other record goes. */
function merge(db, keepId, otherPhone) {
    const keep = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(keepId));
    if (!keep) throw err(404, 'العميل غير موجود');
    const p = normalizePhone(otherPhone);
    const other = p ? db.prepare('SELECT * FROM customers WHERE (phone = ? OR phone2 = ?) AND id != ?').get(p, p, keep.id) : null;
    if (!other) throw err(400, 'لا يوجد عميل آخر بهذا الرقم');
    if (keep.phone2 || other.phone2) throw err(400, 'لأحد العميلين رقم ثانٍ بالفعل — يُدمج عميلان لكل منهما رقم واحد فقط');
    const fill = {};
    for (const k of ['email', 'city', 'address', 'map_url']) if (!keep[k] && other[k]) fill[k] = other[k];
    const notes = [keep.notes, other.notes].filter(Boolean).join('\n');
    db.exec('BEGIN IMMEDIATE');
    try {
        db.prepare('DELETE FROM customers WHERE id = ?').run(other.id);
        db.prepare(`UPDATE customers SET phone2 = ?, name = COALESCE(name, ?), notes = ?${Object.keys(fill).map((k) => `, ${k} = ?`).join('')},
                        updated_at = datetime('now') WHERE id = ?`)
            .run(other.phone, other.name, notes || null, ...Object.values(fill), keep.id);
        db.exec('COMMIT');
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
    return db.prepare('SELECT * FROM customers WHERE id = ?').get(keep.id);
}

const byPhone = (db, phone) => {
    const p = normalizePhone(phone);
    return p ? db.prepare('SELECT * FROM customers WHERE phone = ? OR phone2 = ?').get(p, p) || null : null;
};

module.exports = { ensure, backfill, list, profile, create, update, remove, merge, byPhone, normalizePhone };
