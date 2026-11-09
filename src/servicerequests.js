/* =============================================================
   Appointment requests from customers (installation, maintenance,
   inspection / measuring).
   - The customer asks the AI assistant on WhatsApp or the website (or the
     office enters it after a call): what is needed, where, a preferred day
     and part of the day.
   - The responsible employee (the «أوامر العمل» section) approves it with
     an appointment — which makes a work order — or turns it down with a
     reason. The customer is told on WhatsApp either way, and again if the
     office moves or cancels the appointment.
   - On WhatsApp the customer can ask the assistant «متى موعدي؟»: only the
     requests and work orders of their own number are read (the number
     WhatsApp gives, never one typed in a chat).
   ============================================================= */
const leads = require('./leads');
const mailer = require('./mailer');
const workorders = require('./workorders');
const { getSettings } = require('./db');

const KINDS = workorders.KINDS;
const STATUSES = { pending: 'بانتظار الموافقة', approved: 'تمت الموافقة', rejected: 'مرفوض', cancelled: 'ملغى' };
const PERIODS = { morning: 'صباحاً', evening: 'مساءً', any: 'أي وقت' };
const MAX_PENDING_PER_PHONE = 3;
const MAX_DAYS_AHEAD = 120;

const err = (status, message) => Object.assign(new Error(message), { status });
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));
const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const dayName = (date) => DAYS[new Date(date + 'T00:00:00Z').getUTCDay()];
const when = (date, time) => `${dayName(date)} ${date}${time ? ' — ' + time : ''}`;

function normalizePhone(phone) {
    let d = String(phone || '').replace(/\D/g, '').replace(/^00/, '');
    if (/^[79]\d{7}$/.test(d)) d = '968' + d;
    return d;
}

function nextRef(db, year) {
    const prefix = `SR-${year}-`;
    const last = db.prepare('SELECT MAX(CAST(substr(ref, ?) AS INTEGER)) AS n FROM service_requests WHERE ref LIKE ?').get(prefix.length + 1, prefix + '%').n || 0;
    return prefix + String(last + 1).padStart(4, '0');
}

const view = (r) => r && ({
    ...r,
    kind_label: KINDS[r.kind] || r.kind,
    status_label: STATUSES[r.status] || r.status,
    period_label: r.preferred_period ? PERIODS[r.preferred_period] || r.preferred_period : null
});

function get(db, id) {
    const r = db.prepare(`SELECT s.*, w.number AS work_order_number, w.scheduled_date, w.scheduled_time, w.status AS work_order_status
                          FROM service_requests s LEFT JOIN work_orders w ON w.id = s.work_order_id WHERE s.id = ?`).get(Number(id));
    return view(r);
}

function list(db, { status = '', q = '' } = {}) {
    const where = [];
    const args = [];
    if (status) { where.push('s.status = ?'); args.push(status); }
    if (q) {
        where.push('(s.ref LIKE ? OR s.customer_name LIKE ? OR s.customer_phone LIKE ? OR IFNULL(s.location, \'\') LIKE ?)');
        const like = `%${clip(q, 60)}%`;
        args.push(like, like, `%${String(q).replace(/\D/g, '') || q}%`, like);
    }
    return db.prepare(`SELECT s.*, w.number AS work_order_number, w.scheduled_date, w.scheduled_time FROM service_requests s
                       LEFT JOIN work_orders w ON w.id = s.work_order_id
                       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                       ORDER BY CASE s.status WHEN 'pending' THEN 0 ELSE 1 END, IFNULL(s.preferred_date, '9999'), s.id DESC LIMIT 300`)
        .all(...args).map(view);
}

const pendingCount = (db) => db.prepare("SELECT COUNT(*) AS n FROM service_requests WHERE status = 'pending'").get().n;

const logToLead = (db, phone, text) => {
    const lead = db.prepare('SELECT * FROM leads WHERE phone = ?').get(phone);
    if (lead) leads.addMessage(db, lead, 'system', text);
};

/**
 * input: { kind, customer_name, customer_phone, location?, address?, preferred_date?, preferred_period?, description }
 * source: 'mazbot' | 'whatsapp' | 'website' | 'staff'
 */
function create(db, input, { source = 'staff', author = null, today = leads.localToday() } = {}) {
    const kind = KINDS[input.kind] ? input.kind : 'maintenance';
    const phone = normalizePhone(input.customer_phone);
    const name = clip(input.customer_name, 120);
    const description = clip(input.description, 2000);
    if (!/^\d{8,15}$/.test(phone)) throw err(400, 'رقم جوال العميل غير صالح');
    if (!name) throw err(400, 'اسم العميل مطلوب');
    if (!description) throw err(400, 'اكتب المطلوب (مثلاً: صيانة محرك بوابة رول شتر لا يعمل)');
    let date = input.preferred_date ? String(input.preferred_date).slice(0, 10) : null;
    if (date && !isDate(date)) throw err(400, 'تاريخ الموعد المفضل غير صالح (YYYY-MM-DD)');
    if (date && date < today) throw err(400, `التاريخ المفضل مضى — اليوم ${today}`);
    if (date && date > addDays(today, MAX_DAYS_AHEAD)) throw err(400, `التاريخ المفضل بعيد جداً (حتى ${MAX_DAYS_AHEAD} يوماً)`);
    const period = PERIODS[input.preferred_period] ? input.preferred_period : null;
    const open = db.prepare("SELECT COUNT(*) AS n FROM service_requests WHERE customer_phone = ? AND status = 'pending'").get(phone).n;
    if (open >= MAX_PENDING_PER_PHONE) throw err(429, 'لدى العميل طلبات بانتظار الموافقة — سيتواصل الفريق معه قريباً');

    db.exec('BEGIN IMMEDIATE');
    let id;
    try {
        const ref = nextRef(db, today.slice(0, 4));
        id = Number(db.prepare(`INSERT INTO service_requests (ref, kind, customer_name, customer_phone, location, address, preferred_date, preferred_period, description, source, decided_by)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`)
            .run(ref, kind, name, phone, clip(input.location, 120) || null, clip(input.address, 200) || null, date, period, description, clip(source, 20) || null).lastInsertRowid);
        require('./customers').ensure(db, { phone, name, city: clip(input.location, 120) || null });
        logToLead(db, phone, `📅 طلب ${KINDS[kind]} ${ref}${date ? ` — يفضّل ${when(date)}${period ? ' ' + PERIODS[period] : ''}` : ''}${author ? ` (${author})` : ''}`);
        db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return get(db, id);
}

/* ------------------------------ Messages to the customer ------------------------------ */

function companyLine(db) {
    const s = getSettings(db);
    return s.company_name ? `\n\n${s.company_name}` : '';
}

const approvedText = (db, r, o) => [
    `مرحباً ${r.customer_name} 👋`,
    r.preferred_date && r.preferred_date !== o.scheduled_date
        ? `بخصوص طلب ${r.kind_label} (${r.ref}): التاريخ الذي طلبته غير متاح، وحددنا لك أقرب موعد:`
        : `تم تأكيد موعد ${r.kind_label} (${r.ref}) ✅`,
    `📅 ${when(o.scheduled_date, o.scheduled_time)}`,
    o.location || o.address ? `📍 ${[o.location, o.address].filter(Boolean).join(' — ')}` : null,
    r.decision_note ? `ملاحظة: ${r.decision_note}` : null,
    'إذا لم يناسبك الموعد فرد على هذه الرسالة ونرتب موعداً آخر.'
].filter(Boolean).join('\n') + companyLine(db);

const rejectedText = (db, r) => [
    `مرحباً ${r.customer_name}،`,
    `نعتذر، لم نتمكن من جدولة طلب ${r.kind_label} (${r.ref}).`,
    r.decision_note ? `السبب: ${r.decision_note}` : null,
    'يسعدنا خدمتك — رد على هذه الرسالة لأي استفسار.'
].filter(Boolean).join('\n') + companyLine(db);

const movedText = (db, o) => [
    `مرحباً ${o.customer_name}،`,
    `تم تغيير موعد ${o.kind_label} (${o.number}):`,
    `📅 ${o.scheduled_date ? when(o.scheduled_date, o.scheduled_time) : 'سنتواصل معك لتحديد الموعد'}`,
    'إذا لم يناسبك الموعد فرد على هذه الرسالة.'
].join('\n') + companyLine(db);

const cancelledText = (db, o, reason) => [
    `مرحباً ${o.customer_name}،`,
    `تم إلغاء موعد ${o.kind_label} (${o.number}).`,
    reason ? `السبب: ${reason}` : null,
    'لأي استفسار رد على هذه الرسالة.'
].filter(Boolean).join('\n') + companyLine(db);

/* Send through MazBot (the company's WhatsApp number) or, without it, the direct Cloud API.
   WhatsApp accepts free text only within 24 hours of the customer's last message: a failure is
   returned (and shown to the employee), never thrown — the appointment itself is already saved. */
async function sendToCustomer(db, phone, text, { mazbot = require('./mazbot'), whatsapp = require('./whatsapp') } = {}) {
    try {
        if (mazbot.hasLogin()) {
            const r = await mazbot.sendTextToPhone(phone, text);
            if (!r.ok) return { ok: false, error: r.error };
        } else if (whatsapp.isConfigured()) {
            await whatsapp.sendText(phone, text);
        } else {
            return { ok: false, error: 'واتساب غير مربوط (MazBot أو WhatsApp Cloud API)' };
        }
    } catch (e) {
        return { ok: false, error: e.message };
    }
    logToLead(db, phone, `📤 أُرسل للعميل:\n${text}`);
    return { ok: true };
}

const noticeText = (r) => (r.ok ? 'sent' : `failed: ${String(r.error || '').slice(0, 300)}`);

/* ------------------------------ The employee's decision ------------------------------ */

/**
 * Approve with an appointment: a work order is made (scheduled when a technician is chosen), and the
 * customer is told. patch: { scheduled_date, scheduled_time?, technician_id?, note?, kind?, description?, address?, map_url?, notify? }
 */
async function approve(db, id, patch, author, deps = {}) {
    const r = get(db, id);
    if (!r) throw err(404, 'الطلب غير موجود');
    if (r.status !== 'pending') throw err(400, 'تم البت في هذا الطلب سابقاً');
    const date = String(patch.scheduled_date || '').slice(0, 10);
    if (!isDate(date)) throw err(400, 'حدد تاريخ الموعد');
    if (date < leads.localToday()) throw err(400, 'تاريخ الموعد مضى');
    const description = clip(patch.description, 3000) || r.description;
    const order = workorders.create(db, {
        kind: KINDS[patch.kind] ? patch.kind : r.kind,
        customer_name: r.customer_name, customer_phone: r.customer_phone,
        location: r.location, address: patch.address !== undefined ? patch.address : r.address, map_url: patch.map_url,
        scheduled_date: date, scheduled_time: patch.scheduled_time, technician_id: patch.technician_id,
        description: `${description}\n\n(من طلب العميل ${r.ref})`
    }, author);
    const note = clip(patch.note, 500) || null;
    db.prepare(`UPDATE service_requests SET status = 'approved', work_order_id = ?, decision_note = ?, decided_by = ?, decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
        .run(order.id, note, clip(author, 80) || null, r.id);
    let notice = null;
    if (patch.notify !== false) {
        notice = await sendToCustomer(db, r.customer_phone, approvedText(db, { ...r, decision_note: note }, order), deps);
        db.prepare('UPDATE service_requests SET customer_notice = ? WHERE id = ?').run(noticeText(notice), r.id);
    }
    return { request: get(db, r.id), order: workorders.get(db, order.id), notice };
}

async function reject(db, id, { reason, notify = true } = {}, author, deps = {}) {
    const r = get(db, id);
    if (!r) throw err(404, 'الطلب غير موجود');
    if (r.status !== 'pending') throw err(400, 'تم البت في هذا الطلب سابقاً');
    const why = clip(reason, 500);
    if (!why) throw err(400, 'اكتب السبب (يصل للعميل)');
    db.prepare(`UPDATE service_requests SET status = 'rejected', decision_note = ?, decided_by = ?, decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
        .run(why, clip(author, 80) || null, r.id);
    logToLead(db, r.customer_phone, `📅 رُفض طلب ${r.kind_label} ${r.ref}: ${why}`);
    let notice = null;
    if (notify !== false) {
        notice = await sendToCustomer(db, r.customer_phone, rejectedText(db, { ...r, decision_note: why }), deps);
        db.prepare('UPDATE service_requests SET customer_notice = ? WHERE id = ?').run(noticeText(notice), r.id);
    }
    return { request: get(db, r.id), notice };
}

/* The office moved or cancelled an appointment: tell the customer (when asked to) */
const notifyMoved = (db, order, deps) => sendToCustomer(db, order.customer_phone, movedText(db, order), deps);
const notifyCancelled = (db, order, reason, deps) => sendToCustomer(db, order.customer_phone, cancelledText(db, order, reason), deps);

/* ------------------------------ Staff alert ------------------------------ */

function requestText(r) {
    return [
        `📅 طلب موعد ${r.kind_label} — ${r.ref}`,
        `العميل: ${r.customer_name} — +${r.customer_phone}`,
        r.location ? `الموقع: ${[r.location, r.address].filter(Boolean).join(' — ')}` : null,
        `الموعد المفضل: ${r.preferred_date ? when(r.preferred_date) : 'غير محدد'}${r.period_label ? ' ' + r.period_label : ''}`,
        '',
        r.description,
        '',
        'للموافقة وتحديد الموعد: «أوامر العمل» ← «طلبات المواعيد»'
    ].filter((l) => l !== null).join('\n');
}

/* The sales numbers on WhatsApp, and by email whoever runs the work orders (managers and staff with that section) */
async function notifyStaff(db, r, { mazbot = require('./mazbot'), whatsapp = require('./whatsapp') } = {}) {
    const text = requestText(r);
    const settings = getSettings(db);
    for (const to of mazbot.parseRecipients(settings.mazbot_recipients)) {
        const res = await mazbot.sendTextToPhone(to, text).catch((e) => ({ ok: false, error: e.message }));
        if (!res.ok) console.error('[requests] alert', to, res.error);
    }
    if (process.env.WHATSAPP_NOTIFY_TO && whatsapp.isConfigured()) await whatsapp.sendText(process.env.WHATSAPP_NOTIFY_TO, text).catch(() => {});
    if (!mailer.isConfigured()) return;
    const to = db.prepare("SELECT email, role, permissions_json FROM staff_users WHERE active = 1 AND email IS NOT NULL AND role != 'technician'").all()
        .filter((u) => u.role === 'manager' || JSON.parse(u.permissions_json || '[]').includes('work_orders')).map((u) => u.email);
    if (!to.length) return;
    await mailer.send({ to: [...new Set(to)].join(', '), subject: `📅 طلب موعد ${r.kind_label}: ${r.customer_name}`, text })
        .catch((e) => console.error('[requests] email', e.message));
}

/* ------------------------------ For the AI assistant ------------------------------ */

/* Everything open for this customer's number (and the other number on their record): requests
   still waiting, and work orders not done yet. Nothing of anyone else's. */
function forCustomer(db, phone, { today = leads.localToday() } = {}) {
    const p = normalizePhone(phone);
    if (!p) return { requests: [], appointments: [] };
    const c = require('./customers').byPhone(db, p);
    const phones = [...new Set([p, c && c.phone, c && c.phone2].filter(Boolean))];
    const marks = phones.map(() => '?').join(', ');
    const requests = db.prepare(`SELECT * FROM service_requests WHERE customer_phone IN (${marks}) AND status = 'pending' ORDER BY id DESC LIMIT 5`).all(...phones)
        .map(view).map((r) => ({ ref: r.ref, service: r.kind_label, status: 'بانتظار موافقة الفريق وتحديد الموعد',
            preferred: r.preferred_date ? `${when(r.preferred_date)}${r.period_label ? ' ' + r.period_label : ''}` : null, requested_on: r.created_at.slice(0, 10) }));
    const appointments = db.prepare(`SELECT * FROM work_orders WHERE customer_phone IN (${marks})
                                     AND (status IN ('new', 'scheduled', 'in_progress') OR (status IN ('done', 'cancelled') AND updated_at >= datetime('now', '-14 days')))
                                     ORDER BY IFNULL(scheduled_date, '9999'), id LIMIT 8`).all(...phones)
        .map((o) => ({
            number: o.number, service: KINDS[o.kind] || o.kind,
            status: o.status === 'done' ? 'مكتمل' : o.status === 'cancelled' ? 'ملغى'
                : o.status === 'in_progress' ? 'الفني يعمل عليه الآن'
                    : o.scheduled_date ? (o.scheduled_date < today ? 'موعده مضى ولم يُغلق — سيتواصل الفريق' : 'مؤكد') : 'بانتظار تحديد الموعد',
            date: o.scheduled_date ? when(o.scheduled_date, o.scheduled_time) : null,
            location: [o.location, o.address].filter(Boolean).join(' — ') || null
        }));
    const rejected = db.prepare(`SELECT * FROM service_requests WHERE customer_phone IN (${marks}) AND status = 'rejected' AND decided_at >= datetime('now', '-14 days') ORDER BY id DESC LIMIT 3`).all(...phones)
        .map(view).map((r) => ({ ref: r.ref, service: r.kind_label, status: 'لم تتم جدولته', reason: r.decision_note }));
    return { today: when(today), requests, appointments, ...(rejected.length ? { recently_declined: rejected } : {}) };
}

module.exports = {
    create, list, get, approve, reject, pendingCount, forCustomer, notifyStaff, notifyMoved, notifyCancelled, sendToCustomer,
    requestText, approvedText, KINDS, STATUSES, PERIODS, MAX_PENDING_PER_PHONE
};
