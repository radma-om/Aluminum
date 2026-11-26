/* =============================================================
   The customer hears how their work order goes, on WhatsApp, with a
   link to «تتبع طلبي» (like a car service centre):
     scheduled   📅 the appointment (day, time, technician) — when the
                    office sets or moves it and ticks «إبلاغ العميل»
     on_the_way  🚚 the technician presses «في الطريق»
     started     🔧 the technician starts the work
     done        ✅ the work is done (with what is left to pay)
   - Approved templates only (they reach the customer any time): sent
     through the templates account when it is set (MAZBOT_TEMPLATES_*).
     A notice whose template is not set is simply not sent.
       MAZBOT_WO_SCHEDULED_TEMPLATE_ID  {{1}} name {{2}} the work {{3}} when {{4}} technician {{5}} link
       MAZBOT_WO_ONTHEWAY_TEMPLATE_ID   {{1}} name {{2}} technician {{3}} the work {{4}} link
       MAZBOT_WO_STARTED_TEMPLATE_ID    {{1}} name {{2}} technician {{3}} the work {{4}} link
       MAZBOT_WO_DONE_TEMPLATE_ID       {{1}} name {{2}} the work {{3}} balance {{4}} link
     Each template ends with the quick-reply button «إيقاف الإشعارات 48 ساعة».
   - The manager can switch all of them off (settings: wo_customer_notices).
   - «إيقاف الإشعارات 48 ساعة»: the customer's press (the templates
     account's webhook) mutes that number for 48 hours.
   - Every notice is written in the work order's log (✓ or ✗ and why).
   ============================================================= */
const crypto = require('node:crypto');
const mazbot = require('./mazbot');
const { getSettings } = require('./db');

const EVENTS = {
    scheduled: { env: 'MAZBOT_WO_SCHEDULED_TEMPLATE_ID', label: 'موعد التركيب' },
    on_the_way: { env: 'MAZBOT_WO_ONTHEWAY_TEMPLATE_ID', label: 'الفني في الطريق' },
    started: { env: 'MAZBOT_WO_STARTED_TEMPLATE_ID', label: 'بدء العمل' },
    done: { env: 'MAZBOT_WO_DONE_TEMPLATE_ID', label: 'اكتمال العمل' }
};
/* «the work» in a sentence: «تم تحديد موعد تركيب البوابة» */
const WORK = { installation: 'تركيب البوابة', maintenance: 'الصيانة', inspection: 'المعاينة والقياس', service: 'الخدمة' };
const MUTE_HOURS = 48;
const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const money = (n) => Number(n || 0).toFixed(3);
const companyName = (db) => getSettings(db).company_name || 'ردما للبوابات الإلكترونية';

let sender = null; // tests
const setSenderForTests = (fn) => { sender = fn; };

function ensureTables(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS notify_mutes (phone TEXT PRIMARY KEY, until TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));`);
    const cols = db.prepare('PRAGMA table_info(work_orders)').all().map((c) => c.name);
    if (!cols.includes('access_key')) db.exec('ALTER TABLE work_orders ADD COLUMN access_key TEXT');
}

const templateId = (event) => String(process.env[EVENTS[event].env] || '').trim();
const mobileOf = (phone) => { const d = String(phone || '').replace(/\D/g, '').replace(/^00/, ''); return d.length === 8 ? '968' + d : d; };

/* What is ready, for the «الربط» tab */
function status(db) {
    const on = getSettings(db).wo_customer_notices !== false;
    return { enabled: on, login: mazbot.templatesAccount().client.hasLogin(), ...Object.fromEntries(Object.keys(EVENTS).map((e) => [e, Boolean(templateId(e))])) };
}

/* ---- «إيقاف الإشعارات 48 ساعة» ---- */
function mute(db, phone, hours = MUTE_HOURS) {
    ensureTables(db);
    const until = new Date(Date.now() + hours * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
    db.prepare('INSERT INTO notify_mutes (phone, until) VALUES (?, ?) ON CONFLICT(phone) DO UPDATE SET until = excluded.until').run(mobileOf(phone), until);
    return until;
}
function isMuted(db, phone) {
    ensureTables(db);
    const r = db.prepare("SELECT until FROM notify_mutes WHERE phone = ? AND until > datetime('now')").get(mobileOf(phone));
    return r ? r.until : null;
}

/* The customer's page: the invoice's when the order has one, else the order's own */
function trackPath(db, order) {
    ensureTables(db);
    if (order.invoice_id) {
        const inv = db.prepare("SELECT access_key FROM invoices WHERE id = ? AND status = 'issued'").get(order.invoice_id);
        if (inv) return `/t/${inv.access_key}`;
    }
    let key = (db.prepare('SELECT access_key FROM work_orders WHERE id = ?').get(order.id) || {}).access_key;
    if (!key) {
        key = crypto.randomBytes(16).toString('hex');
        db.prepare('UPDATE work_orders SET access_key = ? WHERE id = ?').run(key, order.id);
    }
    return `/t/${key}`;
}

function when(order) {
    if (!order.scheduled_date) return 'سيُحدَّد قريباً';
    const t = Date.parse(order.scheduled_date + 'T00:00:00Z');
    const day = Number.isNaN(t) ? '' : DAYS[new Date(t).getUTCDay()] + ' ';
    return `${day}${order.scheduled_date}${order.scheduled_time ? ` — ${order.scheduled_time}` : ''}`;
}

function values(db, order, event, link) {
    const name = String(order.customer_name || '').trim().split(/\s+/)[0] || 'عميلنا العزيز';
    const work = WORK[order.kind] || 'العمل';
    const tech = order.technician_name || `فريق ${companyName(db)}`;
    if (event === 'scheduled') return [name, work, when(order), tech, link];
    if (event === 'on_the_way' || event === 'started') return [name, tech, work, link];
    const inv = order.invoice_id ? require('./invoices').get(db, order.invoice_id) : null;
    return [name, work, money(inv && inv.status === 'issued' ? inv.balance : 0), link];
}

/**
 * Tell the customer about their order. Never throws: returns { sent, skipped?, error? }, and writes the
 * outcome in the order's log. origin: this system's public address (for the tracking link).
 */
async function notify(db, order, event, { origin = '', by = null } = {}) {
    try {
        ensureTables(db);
        if (!EVENTS[event]) return { sent: false, skipped: 'unknown' };
        if (getSettings(db).wo_customer_notices === false) return { sent: false, skipped: 'off' };
        const id = templateId(event);
        if (!id) return { sent: false, skipped: 'no_template' };
        const acct = mazbot.templatesAccount();
        if (!sender && !acct.client.hasLogin()) return { sent: false, skipped: 'no_login' };
        const mobile = mobileOf(order.customer_phone);
        if (mobile.length < 11) return { sent: false, skipped: 'no_phone' };
        if (isMuted(db, mobile)) {
            log(db, order, `🔕 لم يُرسل «${EVENTS[event].label}» للعميل — أوقف الإشعارات مؤقتاً`, by);
            return { sent: false, skipped: 'muted' };
        }
        if (!/^https:\/\//.test(origin) && !/^http:\/\/(localhost|127\.)/.test(origin)) return { sent: false, skipped: 'no_origin' };
        const vals = values(db, order, event, origin + trackPath(db, order));
        let r;
        try { r = sender ? await sender({ event, mobile, templateId: id, values: vals }) : await acct.client.sendTemplate(mobile, vals, id); } catch (e) { r = { ok: false, error: e.message }; }
        const ok = Boolean(r && r.ok);
        const error = ok ? null : String((r && r.error) || 'failed').slice(0, 200);
        log(db, order, ok ? `📤 أُرسل للعميل على واتساب: ${EVENTS[event].label}` : `⚠️ لم يصل للعميل «${EVENTS[event].label}»: ${error}`, by);
        return ok ? { sent: true } : { sent: false, error };
    } catch (e) {
        console.error('[order-notify]', e.message);
        return { sent: false, error: e.message };
    }
}

function log(db, order, text, by) {
    db.prepare('INSERT INTO work_order_events (order_id, author, text, by_technician) VALUES (?, ?, ?, 0)').run(order.id, by || 'النظام', text);
}

/* ---- The templates account's webhook: the customer pressed a button, or wrote to that number ---- */

const MUTE_RE = /إيقاف الإشعارات|ايقاف الاشعارات|^\s*stop\s*$/i;
const TRACK_RE = /تتبع|track/i;

/* The customer's numbers: the one they wrote from, and the other on their record */
function phonesOf(db, phone) {
    const p = mobileOf(phone);
    const c = db.prepare('SELECT phone, phone2 FROM customers WHERE phone = ? OR phone2 = ?').get(p, p);
    return [...new Set([p, c && c.phone, c && c.phone2].filter(Boolean).map(mobileOf))];
}

/* The customer's recent invoices, open orders without invoice, and quotes not invoiced yet (last 90 days),
   as links: the tracking page, or the quote's PDF */
function trackingFor(db, phone, origin) {
    ensureTables(db);
    const phones = phonesOf(db, phone);
    const marks = phones.map(() => '?').join(', ');
    const today = new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
    const invs = db.prepare(`SELECT i.id, i.number, i.access_key, i.total, IFNULL((SELECT SUM(amount) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid
                             FROM invoices i WHERE i.customer_phone IN (${marks}) AND i.status = 'issued' ORDER BY i.id DESC LIMIT 3`).all(...phones);
    const orders = db.prepare(`SELECT * FROM work_orders WHERE customer_phone IN (${marks}) AND invoice_id IS NULL AND status IN ('new', 'scheduled', 'in_progress') ORDER BY id DESC LIMIT 3`).all(...phones);
    const quotes = db.prepare(`SELECT q.ref, q.access_key, q.total, q.valid_until FROM quotes q
                               WHERE q.customer_phone IN (${marks}) AND q.status IN ('new', 'contacted', 'accepted') AND q.access_key IS NOT NULL
                               AND q.created_at >= datetime('now', '-90 days')
                               AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.quote_id = q.id AND i.status = 'issued')
                               ORDER BY q.id DESC LIMIT 3`).all(...phones);
    // One block per item: the title, the amount in an Arabic sentence (WhatsApp keeps «363.960 ر.ع» in order),
    // and the link on a line of its own (blocks are separated by an empty line)
    const balance = (i) => Math.max(0, i.total - i.paid);
    return [
        ...invs.map((i) => `🧾 فاتورة ${i.number}\nالمبلغ: ${money(i.total)} ر.ع — ${balance(i) > 0.0005 ? `المتبقي: ${money(balance(i))} ر.ع` : 'مدفوعة بالكامل ✅'}\n${origin}/t/${i.access_key}`),
        ...orders.map((o) => `🔧 طلب ${WORK[o.kind] || 'عمل'} ${o.number}\n${o.scheduled_date ? `الموعد: ${when(o)}` : 'الموعد: سيُحدَّد قريباً'}\n${origin}${trackPath(db, o)}`),
        ...quotes.map((q) => `📄 عرض سعر ${q.ref}\nالمبلغ: ${money(q.total)} ر.ع${q.valid_until && q.valid_until < today ? ' — انتهت صلاحيته، راسلونا لتحديث السعر' : q.valid_until ? ` — ساري حتى ${q.valid_until}` : ''}\n${origin}/q/${q.access_key}`)
    ];
}

/**
 * One event from the templates account. Returns { action, reply } and sends the reply (inside the
 * 24 hours the customer just opened). client: who sends it (the templates account; tests pass one).
 */
async function handleTemplatesEvent(db, event, { origin = '', client = null } = {}) {
    if (!event || !['message.received', 'interactive.selected'].includes(event.type)) return { action: 'ignored' };
    const d = event.data || {};
    const phone = String((d.contact && d.contact.phone) || '').replace(/\D/g, '');
    if (!phone) return { action: 'ignored' };
    const m = d.message || {};
    const said = String(m.value || (d.selection && (d.selection.id || d.selection.title)) || d.title || '').trim();
    let action = 'ignored';
    let reply = null;
    // The answer to «تذكير العملاء بلا عرض سعر» (its two buttons only, after a recent reminder: src/lead-reminders.js)
    const answered = require('./lead-reminders').handle(db, phone, said, { origin });
    // A rating («5 ممتاز»…) or the comment after a low one (src/ratings.js)
    const rated = answered ? null : require('./ratings').handle(db, phone, said);
    if (answered) {
        action = answered.action;
        reply = answered.reply;
    } else if (rated) {
        action = rated.action;
        reply = rated.reply;
    } else if (MUTE_RE.test(said)) {
        mute(db, phone);
        action = 'muted';
        reply = `تم إيقاف إشعارات الطلبات لمدة ${MUTE_HOURS} ساعة 🔕\nلمعرفة حالة طلبكم في أي وقت اكتبوا «تتبع».`;
    } else if (TRACK_RE.test(said)) {
        const lines = trackingFor(db, phone, origin);
        action = lines.length ? 'track' : 'track_none';
        reply = lines.length
            ? `طلباتكم لدى ${companyName(db)} 👇\n\n${lines.join('\n\n')}\n\nللاستفسار راسلونا على 90660001.`
            : 'لم نجد طلبات مسجلة بهذا الرقم. إذا كان الطلب برقم آخر راسلونا منه، أو تواصلوا مع خدمة العملاء على 90660001.';
    }
    let replyOk = null;
    let replyError = null;
    if (reply) {
        const c = client || mazbot.templatesAccount().client;
        const r = await c.sendTextToPhone(phone, reply).catch((e) => ({ ok: false, error: e.message }));
        replyOk = Boolean(r && r.ok);
        if (!replyOk) { replyError = (r && r.error) || 'failed'; console.error('[order-notify] reply', replyError); }
    }
    return { action, reply, reply_ok: replyOk, reply_error: replyError };
}

module.exports = { EVENTS, ensureTables, status, notify, mute, isMuted, trackPath, trackingFor, phonesOf, handleTemplatesEvent, setSenderForTests, MUTE_HOURS };
