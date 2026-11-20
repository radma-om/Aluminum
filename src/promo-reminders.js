/* =============================================================
   «تذكير بانتهاء العرض» — the customers whose quote used the running
   promotion (or gift) hear, on WhatsApp, how much it saves them and the
   day it ends, with the link to their quote (review and accept).
   - Sent only when the manager presses «إرسال التذكير» in
     «العروض والهدايا»; the list shows first who will get it, and after,
     who got it (or why not).
   - Who: a quote of the last 90 days with this promotion's name (or this
     gift), still «جديد» or «تم التواصل», not invoiced, with a valid mobile;
     one reminder per number per promotion (its latest quote).
   - The promotion must have a last day; the quote's validity is extended
     to that day, so the link still lets the customer accept.
   - Template (approved, the templates account):
       MAZBOT_PROMO_REMINDER_TEMPLATE_ID
       {{1}} name {{2}} quote no. {{3}} saving (ر.ع) {{4}} the offer {{5}} last day {{6}} link
   ============================================================= */
const mazbot = require('./mazbot');
const { getSettings } = require('./db');

const money = (n) => Number(n || 0).toFixed(3);
const mobileOf = (phone) => { const d = String(phone || '').replace(/\D/g, '').replace(/^00/, ''); return d.length === 8 ? '968' + d : d; };
const localToday = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
const templateId = () => String(process.env.MAZBOT_PROMO_REMINDER_TEMPLATE_ID || '').trim();
const err = (status, message) => Object.assign(new Error(message), { status, expose: true });

let sender = null; // tests
const setSenderForTests = (fn) => { sender = fn; };

const ready = new WeakSet();
function ensureTable(db) {
    if (ready.has(db)) return;
    ready.add(db);
    db.exec(`CREATE TABLE IF NOT EXISTS promo_reminders (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        promo_key  TEXT NOT NULL,
        quote_id   INTEGER NOT NULL,
        phone      TEXT NOT NULL,
        ok         INTEGER NOT NULL,
        error      TEXT,
        sent_by    TEXT,
        sent_at    TEXT NOT NULL DEFAULT (datetime('now'))
    ); CREATE INDEX IF NOT EXISTS promo_reminders_key ON promo_reminders (promo_key, phone);`);
}

/* The running promotion and gift that have a last day: what a reminder can be about */
function running(settings, today = localToday()) {
    const on = (enabled, until) => Boolean(enabled) && Boolean(until) && String(until) >= today;
    const promo = on(settings.promo_enabled && Number(settings.promo_percent) > 0, settings.promo_until)
        ? { label: String(settings.promo_label || '').trim() || 'خصم', until: settings.promo_until } : null;
    const gift = on(settings.gift_enabled && String(settings.gift_name || '').trim(), settings.gift_until)
        ? { name: String(settings.gift_name).trim(), until: settings.gift_until } : null;
    // One key per promotion: a new promotion (another name or day) reminds again
    const key = [promo && `p:${promo.label}:${promo.until}`, gift && `g:${gift.name}:${gift.until}`].filter(Boolean).join('|');
    return { promo, gift, key };
}

/* Who would get the reminder now (one per number: its latest quote), and who already got it */
function list(db) {
    ensureTable(db);
    const s = getSettings(db);
    const r = running(s);
    const out = { template: Boolean(templateId()), login: mazbot.templatesAccount().client.hasLogin(), promo: r.promo, gift: r.gift, candidates: [], sent: [] };
    if (!r.key) return out;
    const rows = db.prepare(`SELECT q.id, q.ref, q.customer_name, q.customer_phone, q.total, q.valid_until, q.access_key, q.status,
                                    json_extract(q.details_json, '$.promo_label') AS promo_label, json_extract(q.details_json, '$.gift_name') AS gift_name,
                                    json_extract(q.details_json, '$.discount_total') AS saving
                             FROM quotes q
                             WHERE q.status IN ('new', 'contacted') AND q.access_key IS NOT NULL
                             AND q.created_at >= datetime('now', '-90 days')
                             AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.quote_id = q.id AND i.status = 'issued')
                             ORDER BY q.id DESC`).all();
    const done = new Map(db.prepare('SELECT phone, ok, error, sent_at, quote_id FROM promo_reminders WHERE promo_key = ? ORDER BY id').all(r.key).map((x) => [x.phone, x]));
    const seen = new Set();
    for (const q of rows) {
        const withPromo = r.promo && q.promo_label && String(q.promo_label).trim() === r.promo.label;
        const withGift = r.gift && q.gift_name && String(q.gift_name).trim() === r.gift.name;
        if (!withPromo && !withGift) continue;
        const phone = mobileOf(q.customer_phone);
        if (!/^968[79]\d{7}$/.test(phone) || seen.has(phone)) continue;
        seen.add(phone);
        // The offer named in the message, and its last day (the earlier one when the quote has both)
        const parts = [withPromo && r.promo.label, withGift && `هدية ${r.gift.name}`].filter(Boolean);
        const until = [withPromo && r.promo.until, withGift && r.gift.until].filter(Boolean).sort()[0];
        const item = { quote_id: q.id, ref: q.ref, customer_name: q.customer_name, phone, total: q.total, saving: Number(q.saving) || 0,
            offer: parts.join(' و'), until, valid_until: q.valid_until, access_key: q.access_key };
        const prev = done.get(phone);
        if (prev && prev.ok) out.sent.push({ ...item, sent_at: prev.sent_at });
        else out.candidates.push({ ...item, last_error: prev ? prev.error : null });
    }
    out.key = r.key;
    return out;
}

/* What a send needs before anything goes out: a running offer with a last day, the template, the system's
   public address (for the links), and the templates account. Throws 400 with what is missing. */
function ready_(l, origin) {
    if (!l.key) throw err(400, 'لا يوجد عرض أو هدية يعمل الآن بتاريخ انتهاء — حدّد «آخر يوم» للعرض أولاً');
    if (!l.template) throw err(400, 'قالب التذكير غير مضبوط (MAZBOT_PROMO_REMINDER_TEMPLATE_ID) — أضفه بعد اعتماده من Meta');
    if (!/^https:\/\//.test(String(origin || '')) && !/^http:\/\/(localhost|127\.)/.test(String(origin || ''))) {
        throw err(400, 'رابط النظام العام غير مضبوط — حدده في الإعدادات (رابط النظام) حتى يصل العميل رابط عرضه');
    }
    if (!sender && !mazbot.templatesAccount().client.hasLogin()) throw err(400, 'حساب القوالب في MazBot غير مضبوط');
}

/* One customer of the list: the quote holds until the offer's last day, the template goes out (MazBot's
   «success» decides), the attempt is recorded, and the customer's log says so. Returns { ref, phone, ok, error }. */
async function sendOne(db, l, c, { origin, by }) {
    if (!c.valid_until || c.valid_until < c.until) db.prepare('UPDATE quotes SET valid_until = ? WHERE id = ?').run(c.until, c.quote_id);
    const id = templateId();
    const name = String(c.customer_name || '').trim().split(/\s+/)[0] || 'عميلنا العزيز';
    const values = [name, c.ref, money(c.saving), c.offer, c.until, `${origin}/q/${c.access_key}`];
    let r;
    try { r = sender ? await sender({ mobile: c.phone, templateId: id, values }) : await mazbot.templatesAccount().client.sendTemplate(c.phone, values, id); } catch (e) { r = { ok: false, error: e.message }; }
    const ok = Boolean(r && r.ok);
    const error = ok ? null : String((r && r.error) || 'failed').slice(0, 300);
    db.prepare('INSERT INTO promo_reminders (promo_key, quote_id, phone, ok, error, sent_by) VALUES (?, ?, ?, ?, ?, ?)').run(l.key, c.quote_id, c.phone, ok ? 1 : 0, error, by);
    if (ok) {
        const lead = db.prepare('SELECT * FROM leads WHERE phone = ?').get(c.phone);
        if (lead) require('./leads').addMessage(db, lead, 'system', `⏰ أُرسل تذكير بانتهاء «${c.offer}» في ${c.until} — عرض السعر ${c.ref}`, { author: by });
    } else {
        console.error('[promo-reminders]', c.ref, error);
    }
    return { ref: c.ref, phone: c.phone, ok, error };
}

/**
 * Send the reminder to everyone on the list now (the manager pressed the button). origin: the system's public
 * address for the quote links. Returns { sent, failed, results }.
 */
async function send(db, { origin, by = null }) {
    const l = list(db);
    ready_(l, origin);
    const results = [];
    for (const c of l.candidates) results.push(await sendOne(db, l, c, { origin, by }));
    return { sent: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length, results };
}

/**
 * The reminder to one customer of the list (the button on their row). Refused, with the reason, when the
 * quote is not on the list: already reminded for this offer, invoiced, declined / accepted, of another offer,
 * or an older quote of a number whose latest one is listed. Returns { ref, phone, ok, error }.
 */
async function sendQuote(db, quoteId, { origin, by = null }) {
    const l = list(db);
    ready_(l, origin);
    const qid = Number(quoteId);
    const c = l.candidates.find((x) => x.quote_id === qid);
    if (c) return sendOne(db, l, c, { origin, by });
    const q = db.prepare('SELECT id, ref, customer_phone, status FROM quotes WHERE id = ?').get(qid);
    if (!q) throw err(404, 'عرض السعر غير موجود');
    const phone = mobileOf(q.customer_phone);
    const got = l.sent.find((x) => x.phone === phone);
    if (got) throw err(409, `وصل هذا الرقم تذكير «${got.offer}» في ${String(got.sent_at).slice(0, 16)} — مرة واحدة لكل رقم في كل عرض`);
    if (db.prepare("SELECT 1 FROM invoices WHERE quote_id = ? AND status = 'issued'").get(qid)) throw err(400, `عرض السعر ${q.ref} صدرت له فاتورة — لا حاجة للتذكير`);
    if (!['new', 'contacted'].includes(q.status)) throw err(400, `عرض السعر ${q.ref} ليس «جديد» أو «تم التواصل» — لا يُرسل له تذكير`);
    const newer = l.candidates.find((x) => x.phone === phone);
    if (newer) throw err(400, `لهذا الرقم عرض أحدث في القائمة (${newer.ref}) — أرسل التذكير من صفه`);
    throw err(400, `عرض السعر ${q.ref} ليس ضمن العرض الحالي (أو أقدم من 90 يوماً، أو رقمه غير صالح)`);
}

module.exports = { ensureTable, running, list, send, sendQuote, setSenderForTests };
