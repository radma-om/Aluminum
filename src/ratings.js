/* =============================================================
   «كيف كانت خدمتنا؟» — the customer rates a finished work order on
   WhatsApp (like a car service centre):
   - The day after the work is done, from 10 am (Muscat), an approved
     template goes through the templates account:
       MAZBOT_RATING_TEMPLATE_ID  {{1}} name  {{2}} the work
       quick-reply buttons: «5 ممتاز» «4 جيد جداً» «3 جيد» «2 مقبول» «1 ضعيف»
     Only orders finished in the last 3 days (never a flood of old ones),
     one request per order, and at most one per number a week.
   - The press comes back on the templates account's webhook:
       4–5  thanks, and the Google review link when it is set;
       1–3  an apology asking what went wrong, and the managers are told
            on their phone at once; the customer's next message (within
            48 hours) is kept as the comment and sent to the managers too.
   - Every rating and comment is written in the work order's log and the
     customer's follow-up log.
   - The manager switches it off in «الربط» (settings: wo_rating_requests).
   ============================================================= */
const mazbot = require('./mazbot');
const { getSettings } = require('./db');

const LABELS = { 5: 'ممتاز', 4: 'جيد جداً', 3: 'جيد', 2: 'مقبول', 1: 'ضعيف' };
const WORK = { installation: 'تركيب البوابة', maintenance: 'الصيانة', inspection: 'المعاينة والقياس', service: 'الخدمة' };
const SEND_FROM_HOUR = 10;
const SEND_UNTIL_HOUR = 20; // no message in the evening: the rest waits for the next morning
const RECENT_DAYS = 3;
const COMMENT_HOURS = 48;

const mobileOf = (phone) => { const d = String(phone || '').replace(/\D/g, '').replace(/^00/, ''); return d.length === 8 ? '968' + d : d; };
const localNow = (ms) => new Date(ms + 4 * 3600_000);
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const templateId = () => String(process.env.MAZBOT_RATING_TEMPLATE_ID || '').trim();

let sender = null; // tests
const setSenderForTests = (fn) => { sender = fn; };

const ready = new WeakSet();
function ensureTable(db) {
    if (ready.has(db)) return;
    ready.add(db);
    db.exec(`CREATE TABLE IF NOT EXISTS rating_requests (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id         INTEGER NOT NULL UNIQUE,
        phone            TEXT NOT NULL,
        technician_id    INTEGER,
        status           TEXT NOT NULL,           -- sent | failed | skipped | rated | commented
        error            TEXT,
        sent_at          TEXT NOT NULL DEFAULT (datetime('now')),
        rating           INTEGER,
        rated_at         TEXT,
        comment          TEXT,
        comment_until    TEXT,
        commented_at     TEXT
    ); CREATE INDEX IF NOT EXISTS rating_requests_phone ON rating_requests (phone, sent_at);`);
}

/* What is ready, for «الربط» */
function status(db) {
    ensureTable(db);
    const s = getSettings(db);
    const stats = db.prepare(`SELECT COUNT(*) AS sent, COUNT(rating) AS rated, ROUND(AVG(rating), 2) AS average,
                                     SUM(rating <= 3) AS low
                              FROM rating_requests WHERE status != 'skipped' AND status != 'failed' AND sent_at >= datetime('now', '-30 days')`).get();
    return {
        enabled: s.wo_rating_requests !== false, template: Boolean(templateId()),
        login: mazbot.templatesAccount().client.hasLogin(), google: Boolean(String(s.google_review_url || '').trim()),
        last_30_days: { sent: stats.sent, rated: stats.rated, average: stats.average, low: stats.low || 0 }
    };
}

/* The orders whose request is due now: done before today (Muscat), in the last 3 days, never asked */
function due(db, nowMs = Date.now()) {
    ensureTable(db);
    const today = localNow(nowMs).toISOString().slice(0, 10);
    const from = new Date(Date.parse(today + 'T00:00:00Z') - RECENT_DAYS * 86400_000).toISOString().slice(0, 10);
    return db.prepare(`SELECT w.* FROM work_orders w
                       WHERE w.status = 'done' AND w.completed_at IS NOT NULL
                       AND date(w.completed_at, '+4 hours') < ? AND date(w.completed_at, '+4 hours') >= ?
                       AND (w.invoice_id IS NULL OR w.invoice_id NOT IN (SELECT id FROM invoices WHERE status = 'cancelled'))
                       AND NOT EXISTS (SELECT 1 FROM rating_requests r WHERE r.order_id = w.id)
                       ORDER BY w.completed_at`).all(today, from);
}

/**
 * Send the requests that are due (called every 15 minutes). Returns { sent, failed, skipped }.
 * Nothing before 10 am or after 8 pm, nothing without the template, nothing when switched off.
 */
async function sendDue(db, nowMs = Date.now()) {
    ensureTable(db);
    const out = { sent: 0, failed: 0, skipped: 0 };
    const hour = localNow(nowMs).getUTCHours();
    if (hour < SEND_FROM_HOUR || hour >= SEND_UNTIL_HOUR) return out;
    if (getSettings(db).wo_rating_requests === false) return out;
    const id = templateId();
    if (!id) return out;
    const acct = mazbot.templatesAccount();
    if (!sender && !acct.client.hasLogin()) return out;
    const orderNotify = require('./order-notify');
    const record = db.prepare('INSERT OR IGNORE INTO rating_requests (order_id, phone, technician_id, status, error, sent_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const order of due(db, nowMs)) {
        const mobile = mobileOf(order.customer_phone);
        const skip = (why) => { record.run(order.id, mobile || '-', order.technician_id, 'skipped', why, sqlTime(nowMs)); out.skipped++; };
        if (mobile.length < 11) { skip('no_phone'); continue; }
        // Muted («إيقاف الإشعارات»): wait — it is tried again while the order is within its 3 days
        if (orderNotify.isMuted(db, mobile)) continue;
        // One request a week per number (a customer with two orders is asked once)
        if (db.prepare("SELECT 1 FROM rating_requests WHERE phone = ? AND status != 'skipped' AND sent_at >= datetime(?, '-7 days')").get(mobile, sqlTime(nowMs))) {
            skip('asked_this_week');
            continue;
        }
        const name = String(order.customer_name || '').trim().split(/\s+/)[0] || 'عميلنا العزيز';
        const values = [name, WORK[order.kind] || 'الخدمة'];
        let r;
        try { r = sender ? await sender({ mobile, templateId: id, values, order }) : await acct.client.sendTemplate(mobile, values, id); } catch (e) { r = { ok: false, error: e.message }; }
        const ok = Boolean(r && r.ok);
        record.run(order.id, mobile, order.technician_id, ok ? 'sent' : 'failed', ok ? null : String((r && r.error) || 'failed').slice(0, 200), sqlTime(nowMs));
        log(db, order.id, ok ? '📤 أُرسل للعميل طلب تقييم الخدمة على واتساب' : `⚠️ لم يصل طلب التقييم للعميل: ${String((r && r.error) || 'failed').slice(0, 120)}`);
        if (ok) out.sent++; else out.failed++;
    }
    return out;
}

function log(db, orderId, text) {
    db.prepare("INSERT INTO work_order_events (order_id, author, text, by_technician) VALUES (?, 'النظام', ?, 0)").run(orderId, text);
}
function tellLead(db, phone, text) {
    const lead = db.prepare('SELECT * FROM leads WHERE phone = ?').get(phone);
    if (lead) require('./leads').addMessage(db, lead, 'system', text);
}
function tellManagers(db, title, body, tag) {
    const push = require('./push');
    push.send(db, push.accountsOf(db, (u) => u.role === 'manager'), { title, body, url: '/admin#tab=work_orders', tag }).catch(() => {});
}

/* «5 ممتاز», «5», «٥», «ممتاز» → 5; anything else → null */
function ratingOf(text) {
    const t = String(text || '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).trim();
    const n = /^([1-5])(?:\s|$|[-–—.)])/.exec(t);
    if (n) return Number(n[1]);
    const word = t.replace(/[ًٌٍَُِّْ]/g, '').replace(/\s+/g, ' ');
    const found = Object.entries(LABELS).find(([, w]) => w.replace(/[ًٌٍَُِّْ]/g, '') === word);
    return found ? Number(found[0]) : null;
}

/**
 * A message to the templates number: a rating press, or the comment after a low rating.
 * Returns { action, reply } when it was one, else null (the other handlers go on).
 */
function handle(db, phone, text, nowMs = Date.now()) {
    ensureTable(db);
    const p = mobileOf(phone);
    const now = sqlTime(nowMs);
    const s = getSettings(db);
    // The latest request to this number in the last 7 days
    const row = db.prepare(`SELECT r.*, w.number, w.customer_name, u.display_name AS technician FROM rating_requests r
                            JOIN work_orders w ON w.id = r.order_id LEFT JOIN staff_users u ON u.id = r.technician_id
                            WHERE r.phone = ? AND r.status IN ('sent', 'rated', 'commented') AND r.sent_at >= datetime(?, '-7 days')
                            ORDER BY r.id DESC LIMIT 1`).get(p, now);
    if (!row) return null;
    const rating = ratingOf(text);
    if (rating) {
        db.prepare("UPDATE rating_requests SET rating = ?, rated_at = ?, status = 'rated', comment_until = ? WHERE id = ?")
            .run(rating, now, rating <= 3 ? sqlTime(nowMs + COMMENT_HOURS * 3600_000) : null, row.id);
        const stars = '⭐'.repeat(rating);
        const what = `${stars} تقييم العميل: ${rating} ${LABELS[rating]}`;
        log(db, row.order_id, what);
        tellLead(db, p, `${what} — أمر العمل ${row.number}`);
        if (rating <= 3) {
            tellManagers(db, `⚠️ تقييم منخفض ${rating}/5 — ${row.customer_name || 'عميل'}`,
                `أمر العمل ${row.number}${row.technician ? ` — الفني ${row.technician}` : ''}. تواصل مع العميل.`, `rating-low-${row.order_id}`);
            return { action: 'rated_low', rating, reply: 'نأسف أن الخدمة لم تكن بالمستوى الذي تستحقونه 🙏\nأخبرونا في رسالة بما حدث، وسيتواصل معكم المسؤول لمعالجته.' };
        }
        const google = String(s.google_review_url || '').trim();
        return {
            action: 'rated', rating,
            reply: `شكراً لتقييمكم ${stars}\nسعداء بخدمتكم دائماً.${/^https:\/\//.test(google) ? `\n\nإن أعجبتكم خدمتنا، يسعدنا تقييمكم على Google:\n${google}` : ''}`
        };
    }
    // The comment that follows a low rating
    // («تتبع» and «إيقاف الإشعارات» keep their meaning)
    if (row.status === 'rated' && row.comment_until && row.comment_until > now && String(text || '').trim().length >= 2
        && !/تتبع|track|إيقاف الإشعارات|ايقاف الاشعارات/i.test(String(text))) {
        const comment = String(text).trim().slice(0, 1000);
        db.prepare("UPDATE rating_requests SET comment = ?, commented_at = ?, status = 'commented', comment_until = NULL WHERE id = ?").run(comment, now, row.id);
        log(db, row.order_id, `💬 ملاحظة العميل بعد التقييم: ${comment}`);
        tellLead(db, p, `💬 ملاحظة العميل على أمر العمل ${row.number}: ${comment}`);
        tellManagers(db, `💬 ملاحظة ${row.customer_name || 'العميل'} بعد تقييم ${row.rating}/5`, comment.slice(0, 180), `rating-comment-${row.order_id}`);
        return { action: 'rating_comment', reply: 'شكراً لكم، وصلت ملاحظتكم للمسؤول وسيتواصل معكم قريباً 🙏' };
    }
    return null;
}

function schedule(db) {
    const run = () => sendDue(db).catch((err) => console.error('[ratings]', err.message));
    setTimeout(run, 120_000).unref();
    setInterval(run, 15 * 60_000).unref();
}

module.exports = { LABELS, ensureTable, status, due, sendDue, handle, ratingOf, schedule, setSenderForTests, SEND_FROM_HOUR };
