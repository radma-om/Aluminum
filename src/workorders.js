/* =============================================================
   Work orders for the installation and maintenance team.
   - Made from an invoice or a quote (customer, location and the job —
     items and sizes — are copied, never the prices), or entered by hand
     for a maintenance or inspection visit.
   - The office schedules it (date, time) and assigns a technician; the
     technician (an account with the «فني تركيب وصيانة» role) sees only
     their own orders, starts the job, writes what was done and closes it,
     or sends it back for a new appointment (customer absent…).
   - new → scheduled → in_progress → done; cancelled by the office.
   - Every change is kept in work_order_events (who, what, when).
   - Emails: the technician on assignment; the managers when a job is done.
   ============================================================= */
const leads = require('./leads');
const mailer = require('./mailer');
const { getSettings } = require('./db');

const KINDS = { installation: 'تركيب', maintenance: 'صيانة', inspection: 'معاينة / قياس' };
const STATUSES = { new: 'بانتظار الجدولة', scheduled: 'مجدول', in_progress: 'قيد التنفيذ', done: 'مكتمل', cancelled: 'ملغى' };
/* What a technician may do with their own order */
const TECH_MOVES = { in_progress: ['scheduled'], done: ['scheduled', 'in_progress'], new: ['scheduled', 'in_progress'] };

const err = (status, message) => Object.assign(new Error(message), { status });
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));

function tx(db, fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

const event = (db, orderId, text, author) => {
    db.prepare('INSERT INTO work_order_events (order_id, author, text) VALUES (?, ?, ?)').run(orderId, clip(author, 80) || null, clip(text, 2000));
    db.prepare("UPDATE work_orders SET updated_at = datetime('now') WHERE id = ?").run(orderId);
};

function technicians(db) {
    return db.prepare("SELECT id, display_name, email, active FROM staff_users WHERE role = 'technician' ORDER BY active DESC, display_name").all()
        .map((t) => ({ id: t.id, name: t.display_name, has_email: Boolean(t.email), active: Boolean(t.active) }));
}

function get(db, id) {
    const row = db.prepare(`SELECT w.*, u.display_name AS technician_name FROM work_orders w
                            LEFT JOIN staff_users u ON u.id = w.technician_id WHERE w.id = ?`).get(Number(id));
    if (!row) return null;
    return {
        ...row,
        kind_label: KINDS[row.kind] || row.kind,
        status_label: STATUSES[row.status] || row.status,
        quote_ref: row.quote_id ? (db.prepare('SELECT ref FROM quotes WHERE id = ?').get(row.quote_id) || {}).ref || null : null,
        invoice_number: row.invoice_id ? (db.prepare('SELECT number FROM invoices WHERE id = ?').get(row.invoice_id) || {}).number || null : null,
        events: db.prepare('SELECT * FROM work_order_events WHERE order_id = ? ORDER BY id DESC').all(row.id)
    };
}

/* The job, in words the technician needs (items and sizes — never prices) */
function describe(items, details) {
    const d = details || {};
    const lines = (items || []).filter((i) => !i.optional || i.quantity).map((i) => {
        const q = Math.round(Number(i.quantity) * 100) / 100;
        return `• ${q} × ${i.name}${i.type ? ' — ' + i.type : ''}`;
    });
    if (d.width_cm) lines.unshift(`المقاس: العرض ${d.width_cm} سم × الارتفاع ${d.height_cm} سم${d.count > 1 ? ` — عدد ${d.count}` : ''}`);
    if (d.shutter_type) lines.unshift(`نوع البوابة: ${[d.shutter_type, d.variant].filter(Boolean).join(' — ')}`);
    return lines.join('\n');
}

function cleanMapUrl(v) {
    const s = clip(v, 500);
    if (!s) return null;
    let u;
    try { u = new URL(s); } catch { throw err(400, 'رابط الموقع على الخريطة غير صالح (انسخه من خرائط Google)'); }
    if (!['https:', 'http:'].includes(u.protocol)) throw err(400, 'رابط الموقع يجب أن يبدأ بـ https');
    return u.href;
}

function cleanSchedule(input, out) {
    if (input.scheduled_date !== undefined) {
        const d = input.scheduled_date ? String(input.scheduled_date).slice(0, 10) : null;
        if (d && !isDate(d)) throw err(400, 'تاريخ الموعد غير صالح');
        out.scheduled_date = d;
    }
    if (input.scheduled_time !== undefined) out.scheduled_time = clip(input.scheduled_time, 40) || null;
    return out;
}

function checkTechnician(db, id) {
    if (id === null || id === undefined || id === '') return null;
    const t = db.prepare("SELECT * FROM staff_users WHERE id = ? AND role = 'technician' AND active = 1").get(Number(id));
    if (!t) throw err(400, 'الفني غير موجود أو حسابه موقوف');
    return t.id;
}

function nextNumber(db, year) {
    const prefix = `WO-${year}-`;
    const last = db.prepare('SELECT MAX(CAST(substr(number, ?) AS INTEGER)) AS n FROM work_orders WHERE number LIKE ?').get(prefix.length + 1, prefix + '%').n || 0;
    return prefix + String(last + 1).padStart(4, '0');
}

/**
 * input: { kind, invoice_id? | quote_id? | customer_name + customer_phone, location?, address?, map_url?,
 *          scheduled_date?, scheduled_time?, technician_id?, description? }
 */
function create(db, input, author, { source = null } = {}) {
    const kind = KINDS[input.kind] ? input.kind : 'installation';
    let base = { customer_name: clip(input.customer_name, 120), customer_phone: String(input.customer_phone || '').replace(/\D/g, '').slice(0, 20), location: clip(input.location, 120) || null };
    let quoteId = null;
    let invoiceId = null;
    let description = clip(input.description, 3000);
    if (source && source.invoice) {
        const inv = source.invoice;
        if (inv.status === 'cancelled') throw err(400, 'الفاتورة ملغاة');
        invoiceId = inv.id;
        quoteId = inv.quote_id || null;
        base = { customer_name: inv.customer_name, customer_phone: inv.customer_phone, location: inv.customer_city || null };
        if (!input.address && inv.customer_address) input.address = inv.customer_address;
        if (!description) description = describe(inv.items, inv.details);
    } else if (source && source.quote) {
        const q = source.quote;
        quoteId = q.id;
        base = { customer_name: q.customer_name, customer_phone: q.customer_phone, location: q.customer_city || (q.details || {}).region || null };
        if (!description) description = describe(q.items, q.details);
    }
    if (!base.customer_name) throw err(400, 'اكتب اسم العميل');
    if (base.customer_phone.length < 8) throw err(400, 'اكتب رقم جوال العميل');
    if (!description) throw err(400, 'اكتب المطلوب من الفني (وصف العمل)');
    const sched = cleanSchedule(input, {});
    const techId = checkTechnician(db, input.technician_id);
    const status = techId && sched.scheduled_date ? 'scheduled' : 'new';
    const id = tx(db, () => {
        const number = nextNumber(db, leads.localToday().slice(0, 4));
        const info = db.prepare(`INSERT INTO work_orders (number, kind, quote_id, invoice_id, customer_name, customer_phone, location, address, map_url,
                                    scheduled_date, scheduled_time, technician_id, description, status, created_by)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(number, kind, quoteId, invoiceId, base.customer_name, base.customer_phone, base.location,
                clip(input.address, 200) || null, cleanMapUrl(input.map_url), sched.scheduled_date || null, sched.scheduled_time || null,
                techId, description, status, clip(author, 80) || null);
        const orderId = Number(info.lastInsertRowid);
        require('./customers').ensure(db, { phone: base.customer_phone, name: base.customer_name, city: base.location });
        event(db, orderId, `أُنشئ أمر ${KINDS[kind]}${techId ? ` وأُسند إلى ${techName(db, techId)}` : ''}`, author);
        const lead = db.prepare('SELECT * FROM leads WHERE phone = ?').get(base.customer_phone);
        if (lead) leads.addMessage(db, lead, 'system', `🔧 أمر ${KINDS[kind]} ${number}${sched.scheduled_date ? ` — موعد ${sched.scheduled_date}` : ''}`);
        return orderId;
    });
    const order = get(db, id);
    if (techId) notifyTechnician(db, order).catch(() => {});
    return order;
}

const techName = (db, id) => (db.prepare('SELECT display_name FROM staff_users WHERE id = ?').get(id) || {}).display_name || '';

/* The office: schedule, assign, edit the details */
function update(db, id, patch, author) {
    const order = get(db, id);
    if (!order) throw err(404, 'أمر العمل غير موجود');
    if (['done', 'cancelled'].includes(order.status)) throw err(400, 'أمر العمل مغلق — لا يُعدَّل');
    const set = cleanSchedule(patch, {});
    if (patch.address !== undefined) set.address = clip(patch.address, 200) || null;
    if (patch.location !== undefined) set.location = clip(patch.location, 120) || null;
    if (patch.map_url !== undefined) set.map_url = cleanMapUrl(patch.map_url);
    if (patch.description !== undefined) {
        set.description = clip(patch.description, 3000);
        if (!set.description) throw err(400, 'وصف العمل لا يكون فارغاً');
    }
    if (patch.kind !== undefined && KINDS[patch.kind]) set.kind = patch.kind;
    if (patch.technician_id !== undefined) set.technician_id = checkTechnician(db, patch.technician_id);
    if (!Object.keys(set).length) return order;
    const next = { ...order, ...set };
    if (order.status === 'new' && next.technician_id && next.scheduled_date) set.status = 'scheduled';
    if (order.status === 'scheduled' && (!next.technician_id || !next.scheduled_date)) set.status = 'new';
    db.prepare(`UPDATE work_orders SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(set), order.id);
    const changes = [];
    if ('technician_id' in set && set.technician_id !== order.technician_id) changes.push(set.technician_id ? `أُسند إلى ${techName(db, set.technician_id)}` : 'أُلغي إسناد الفني');
    if (('scheduled_date' in set && set.scheduled_date !== order.scheduled_date) || ('scheduled_time' in set && set.scheduled_time !== order.scheduled_time)) {
        changes.push(`الموعد: ${next.scheduled_date || 'غير محدد'}${next.scheduled_time ? ' ' + next.scheduled_time : ''}`);
    }
    if (['address', 'location', 'map_url', 'description', 'kind'].some((k) => k in set && set[k] !== order[k])) changes.push('عُدّلت تفاصيل العمل');
    if (changes.length) event(db, order.id, changes.join(' — '), author);
    const updated = get(db, order.id);
    // A newly assigned technician, or a new appointment for the same one, is told by email
    const reassigned = set.technician_id && set.technician_id !== order.technician_id;
    const moved = updated.technician_id && changes.some((c) => c.startsWith('الموعد'));
    if (reassigned || moved) notifyTechnician(db, updated, { rescheduled: !reassigned }).catch(() => {});
    return updated;
}

/* Status by the technician (their own order) or the office */
function setStatus(db, id, status, note, user) {
    const order = get(db, id);
    if (!order) throw err(404, 'أمر العمل غير موجود');
    const tech = user.role === 'technician';
    if (tech && order.technician_id !== user.id) throw err(404, 'أمر العمل غير موجود');
    if (!STATUSES[status] || status === 'cancelled') throw err(400, 'الحالة غير صالحة');
    if (['done', 'cancelled'].includes(order.status)) throw err(400, 'أمر العمل مغلق');
    if (tech && !(TECH_MOVES[status] || []).includes(order.status)) throw err(400, 'لا يمكن هذا التغيير الآن');
    const text = clip(note, 2000);
    if (status === 'done' && !text) throw err(400, 'اكتب ما تم إنجازه (مثلاً: رُكّبت البوابة وجُرّبت مع العميل)');
    if (status === 'new' && tech && !text) throw err(400, 'اكتب سبب إعادة الجدولة (مثلاً: العميل غير موجود)');
    const author = user.display_name;
    tx(db, () => {
        db.prepare(`UPDATE work_orders SET status = ?${status === 'done' ? ", completion_note = ?, completed_at = datetime('now')" : ''} WHERE id = ?`)
            .run(...(status === 'done' ? [status, text, order.id] : [status, order.id]));
        event(db, order.id, `الحالة: ${STATUSES[order.status]} ← ${STATUSES[status]}${text ? `\n${text}` : ''}`, author);
        if (status === 'done') {
            // An installation done is the quote done; the customer hears about it in the follow-up log
            if (order.quote_id && order.kind === 'installation') db.prepare("UPDATE quotes SET status = 'done' WHERE id = ? AND status != 'rejected'").run(order.quote_id);
            const lead = db.prepare('SELECT * FROM leads WHERE phone = ?').get(order.customer_phone);
            if (lead) leads.addMessage(db, lead, 'system', `✅ اكتمل أمر ${order.kind_label} ${order.number}${author ? ` (${author})` : ''}`);
        }
    });
    const updated = get(db, order.id);
    if (status === 'done') notifyDone(db, updated).catch(() => {});
    return updated;
}

function addNote(db, id, text, user) {
    const order = get(db, id);
    if (!order || (user.role === 'technician' && order.technician_id !== user.id)) throw err(404, 'أمر العمل غير موجود');
    const t = clip(text, 2000);
    if (!t) throw err(400, 'اكتب الملاحظة');
    event(db, order.id, t, user.display_name);
    return get(db, order.id);
}

function cancel(db, id, reason, author) {
    const order = get(db, id);
    if (!order) throw err(404, 'أمر العمل غير موجود');
    if (['done', 'cancelled'].includes(order.status)) throw err(400, 'أمر العمل مغلق');
    const why = clip(reason, 500);
    if (!why) throw err(400, 'اكتب سبب الإلغاء');
    db.prepare("UPDATE work_orders SET status = 'cancelled' WHERE id = ?").run(order.id);
    event(db, order.id, `أُلغي: ${why}`, author);
    return get(db, order.id);
}

/* The list: a technician sees only theirs; open orders by date first */
function list(db, { status = '', technician = '', q = '', open = false, user = null } = {}) {
    const where = [];
    const args = [];
    if (user && user.role === 'technician') { where.push('w.technician_id = ?'); args.push(user.id); }
    if (status) { where.push('w.status = ?'); args.push(status); }
    if (open) where.push("w.status IN ('new', 'scheduled', 'in_progress')");
    if (technician === '-') where.push('w.technician_id IS NULL');
    else if (technician) { where.push('w.technician_id = ?'); args.push(Number(technician)); }
    if (q) {
        where.push('(w.number LIKE ? OR w.customer_name LIKE ? OR w.customer_phone LIKE ? OR IFNULL(w.location, \'\') LIKE ?)');
        const like = `%${clip(q, 60)}%`;
        args.push(like, like, `%${q.replace(/\D/g, '') || q}%`, like);
    }
    return db.prepare(`SELECT w.*, u.display_name AS technician_name FROM work_orders w LEFT JOIN staff_users u ON u.id = w.technician_id
                       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                       ORDER BY CASE w.status WHEN 'in_progress' THEN 0 WHEN 'scheduled' THEN 1 WHEN 'new' THEN 2 ELSE 3 END,
                                IFNULL(w.scheduled_date, '9999'), w.id DESC LIMIT 300`).all(...args)
        .map((r) => ({ ...r, kind_label: KINDS[r.kind] || r.kind, status_label: STATUSES[r.status] || r.status }));
}

/* ------------------------------ Emails ------------------------------ */

function panelLink(db) {
    const base = String(getSettings(db).public_base_url || '').trim().replace(/\/+$/, '');
    return /^https?:\/\//.test(base) ? `${base}/admin` : null;
}

function orderLines(o) {
    return [
        `${o.kind_label} — ${o.number}`,
        `العميل: ${o.customer_name} — +${o.customer_phone}`,
        `الموقع: ${[o.location, o.address].filter(Boolean).join(' — ') || '—'}`,
        o.map_url ? `الخريطة: ${o.map_url}` : null,
        `الموعد: ${o.scheduled_date || 'لم يُحدد بعد'}${o.scheduled_time ? ' ' + o.scheduled_time : ''}`,
        '',
        'المطلوب:',
        o.description
    ].filter((l) => l !== null);
}

async function notifyTechnician(db, order, { rescheduled = false } = {}) {
    require('./push').workOrderAssigned(db, order, { rescheduled }).catch(() => {});
    const tech = order.technician_id && db.prepare('SELECT * FROM staff_users WHERE id = ? AND active = 1').get(order.technician_id);
    if (!tech || !tech.email || !mailer.isConfigured()) return false;
    const link = panelLink(db);
    await mailer.send({
        to: tech.email,
        subject: `🔧 ${rescheduled ? 'موعد جديد لأمر عمل' : 'أمر عمل جديد'}: ${order.customer_name}${order.scheduled_date ? ` — ${order.scheduled_date}` : ''}`,
        text: [`مرحباً ${tech.display_name}،`, '', ...orderLines(order), '', link ? `افتح «أوامر العمل»: ${link}` : ''].join('\n')
    }).catch((e) => { console.error('[work-orders] email', e.message); throw e; });
    return true;
}

async function notifyDone(db, order) {
    if (!mailer.isConfigured()) return false;
    const to = [...new Set([
        ...db.prepare("SELECT email FROM staff_users WHERE role = 'manager' AND active = 1 AND email IS NOT NULL").all().map((r) => r.email),
        ...String(process.env.ALERT_EMAIL_TO || process.env.BACKUP_EMAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean)
    ])];
    if (!to.length) return false;
    await mailer.send({
        to: to.join(', '),
        subject: `✅ اكتمل ${order.kind_label}: ${order.customer_name} — ${order.number}`,
        text: [...orderLines(order), '', `الفني: ${order.technician_name || '—'}`, `ما تم: ${order.completion_note || '—'}`].join('\n')
    }).catch((e) => console.error('[work-orders] email', e.message));
    return true;
}

/* Morning list for each technician with an email: today's jobs, and anything overdue still open */
function technicianDigests(db, { today = leads.localToday() } = {}) {
    const techs = db.prepare("SELECT * FROM staff_users WHERE role = 'technician' AND active = 1 AND email IS NOT NULL").all();
    const out = [];
    for (const t of techs) {
        const orders = db.prepare(`SELECT * FROM work_orders WHERE technician_id = ? AND status IN ('scheduled', 'in_progress')
                                   AND scheduled_date IS NOT NULL AND scheduled_date <= ? ORDER BY scheduled_date, IFNULL(scheduled_time, '')`).all(t.id, today)
            .map((o) => ({ ...o, kind_label: KINDS[o.kind] || o.kind }));
        if (orders.length) out.push({ to: t.email, name: t.display_name, orders });
    }
    return out;
}

async function sendTechnicianDigests(db) {
    const link = panelLink(db);
    let sent = 0;
    for (const d of technicianDigests(db)) {
        const blocks = d.orders.map((o, i) => [`${i + 1}) ${o.scheduled_date < leads.localToday() ? '⏰ متأخر — ' : ''}${orderLines(o).join('\n')}`].join('\n'));
        try {
            await mailer.send({
                to: d.to,
                subject: `🔧 أعمالك اليوم: ${d.orders.length}`,
                text: [`صباح الخير ${d.name}،`, '', `أعمالك لليوم (${d.orders.length}):`, '', blocks.join('\n\n———\n\n'), '', link ? `افتح «أوامر العمل»: ${link}` : ''].join('\n')
            });
            sent++;
        } catch (e) {
            console.error('[work-orders] digest', e.message);
        }
    }
    return sent;
}

/* For the weekly report */
function weekFigures(db, fromUtc, toUtc) {
    return {
        done: db.prepare("SELECT COUNT(*) AS n FROM work_orders WHERE status = 'done' AND completed_at BETWEEN ? AND ?").get(fromUtc, toUtc).n,
        open: db.prepare("SELECT COUNT(*) AS n FROM work_orders WHERE status IN ('new', 'scheduled', 'in_progress')").get().n,
        unscheduled: db.prepare("SELECT COUNT(*) AS n FROM work_orders WHERE status = 'new'").get().n
    };
}

module.exports = {
    create, update, setStatus, addNote, cancel, list, get, technicians, describe,
    technicianDigests, sendTechnicianDigests, weekFigures, KINDS, STATUSES
};
