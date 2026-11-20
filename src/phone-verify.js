/* =============================================================
   Confirming the customer's mobile in the calculators with a code sent
   by WhatsApp from the company (an approved MazBot template):
   1. The page asks for a code (start): the server sends «رمز التحقق»
      to the number typed — the template MAZBOT_VERIFY_TEMPLATE_ID
      ({{1}} the code) through the templates account.
   2. The customer types the 4 digits in the page (confirm).
   3. The request goes through with the token; accepted 30 days for that number.
   - Off until the manager switches it on (settings: calculator_verify_phone),
     and never on without the template and the account's sign-in (it would
     stop every request).
   - A code lives 15 minutes, 5 wrong tries end it; a number gets at most
     5 codes an hour.
   ============================================================= */
const crypto = require('node:crypto');
const { getSettings } = require('./db');
const mazbot = require('./mazbot');

const CODE_MINUTES = 15;
const VALID_DAYS = 30;
const MAX_TRIES = 5;
const mobileOf = (phone) => { const d = String(phone || '').replace(/\D/g, '').replace(/^00/, ''); return d.length === 8 ? '968' + d : d; };
const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const digits = (s) => String(s || '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/\D/g, '');

let sender = null; // tests
const setSenderForTests = (fn) => { sender = fn; };

const ready = new WeakSet(); // once per database, not on every request
function ensureTable(db) {
    if (ready.has(db)) return;
    ready.add(db);
    db.exec(`CREATE TABLE IF NOT EXISTS phone_verifications (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        phone          TEXT NOT NULL,
        code           TEXT NOT NULL,
        token          TEXT NOT NULL UNIQUE,
        status         TEXT NOT NULL DEFAULT 'pending',
        expires_at     TEXT NOT NULL,
        verified_at    TEXT,
        verified_until TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
    const cols = db.prepare('PRAGMA table_info(phone_verifications)').all().map((c) => c.name);
    if (!cols.includes('tries')) db.exec('ALTER TABLE phone_verifications ADD COLUMN tries INTEGER NOT NULL DEFAULT 0');
    if (!cols.includes('send_error')) db.exec('ALTER TABLE phone_verifications ADD COLUMN send_error TEXT');
}

const templateId = () => String(process.env.MAZBOT_VERIFY_TEMPLATE_ID || '').trim();

/* Whether the confirmation is asked for: switched on, with the template and the account to send it */
function config(db) {
    const s = getSettings(db);
    const template = Boolean(templateId());
    const login = mazbot.templatesAccount().client.hasLogin();
    return { required: Boolean(s.calculator_verify_phone) && template && login, enabled: Boolean(s.calculator_verify_phone), template, login };
}

/* The last 24 hours, for «الربط»: codes sent, confirmed, failed, and why the latest one failed */
function recent(db) {
    ensureTable(db);
    const r = db.prepare(`SELECT COUNT(*) AS total, IFNULL(SUM(status = 'verified'), 0) AS verified, IFNULL(SUM(status = 'failed'), 0) AS failed
                          FROM phone_verifications WHERE created_at >= datetime('now', '-1 day')`).get();
    const last = db.prepare("SELECT created_at AS at, send_error AS error FROM phone_verifications WHERE status = 'failed' AND created_at >= datetime('now', '-1 day') ORDER BY id DESC LIMIT 1").get();
    return { last_24h: { sent: r.total - r.failed, verified: r.verified, failed: r.failed }, last_error: last ? { at: last.at, error: last.error } : null };
}

/* A new code, sent to the number on WhatsApp. Returns { token, phone, expires_in } — never the code. */
async function start(db, phone) {
    ensureTable(db);
    const p = mobileOf(phone);
    if (!/^968[79]\d{7}$/.test(p)) throw err(400, 'يرجى إدخال رقم جوال عماني صالح (مثال: 9XXXXXXX).');
    const recent = db.prepare("SELECT COUNT(*) AS n FROM phone_verifications WHERE phone = ? AND created_at > datetime('now', '-1 hour')").get(p).n;
    if (recent >= 5) throw err(429, 'تم طلب رموز كثيرة لهذا الرقم — حاول بعد ساعة.');
    const code = String(crypto.randomInt(1000, 10000));
    const token = crypto.randomBytes(16).toString('hex');
    const info = db.prepare('INSERT INTO phone_verifications (phone, code, token, expires_at) VALUES (?, ?, ?, ?)')
        .run(p, code, token, sqlTime(Date.now() + CODE_MINUTES * 60_000));
    // An Authentication template takes the code twice: in its text ({{1}}) and in its «نسخ الرمز» button
    const r = sender ? await sender(p, [code], { buttons: [code] })
        : await mazbot.templatesAccount().client.sendTemplate(p, [code], templateId(), { buttons: [code] });
    if (!r || !r.ok) {
        // Why, in MazBot's words — never the code itself (MazBot may echo the values back)
        const why = String((r && r.error) || 'send_failed').split(code).join('****').slice(0, 300);
        console.error('[phone-verify] the code was not sent:', why);
        db.prepare("UPDATE phone_verifications SET status = 'failed', send_error = ? WHERE id = ?").run(why, info.lastInsertRowid);
        throw err(502, 'تعذر إرسال رمز التحقق على واتساب — تأكد من الرقم أو حاول بعد قليل.', { expose: true });
    }
    return { token, phone: p, expires_in: CODE_MINUTES * 60 };
}

/* The customer types the code. Returns { status: 'verified', until } or throws 400 with how it went. */
function confirm(db, token, code) {
    ensureTable(db);
    const row = db.prepare('SELECT * FROM phone_verifications WHERE token = ?').get(String(token || ''));
    if (!row || row.status === 'failed') throw err(400, 'اطلب رمزاً جديداً.', { verify: 'unknown' });
    if (row.status === 'verified') return { status: 'verified', phone: row.phone, until: row.verified_until };
    if (row.status !== 'pending' || row.expires_at <= sqlTime(Date.now())) throw err(400, 'انتهت صلاحية الرمز — اطلب رمزاً جديداً.', { verify: 'expired' });
    if (digits(code) !== row.code) {
        const tries = row.tries + 1;
        db.prepare(`UPDATE phone_verifications SET tries = ?${tries >= MAX_TRIES ? ", status = 'expired'" : ''} WHERE id = ?`).run(tries, row.id);
        if (tries >= MAX_TRIES) throw err(400, 'محاولات خاطئة كثيرة — اطلب رمزاً جديداً.', { verify: 'expired' });
        throw err(400, `الرمز غير صحيح — بقيت ${MAX_TRIES - tries} محاولات.`, { verify: 'wrong' });
    }
    const until = sqlTime(Date.now() + VALID_DAYS * 86400_000);
    db.prepare("UPDATE phone_verifications SET status = 'verified', verified_at = datetime('now'), verified_until = ? WHERE id = ?").run(until, row.id);
    return { status: 'verified', phone: row.phone, until };
}

/* A calculator request: its token must be a confirmed one, for this number, still within the 30 days */
function check(db, token, phone) {
    ensureTable(db);
    const r = db.prepare("SELECT phone, verified_until FROM phone_verifications WHERE token = ? AND status = 'verified'").get(String(token || ''));
    return Boolean(r && r.phone === mobileOf(phone) && r.verified_until > sqlTime(Date.now()));
}

/* For the quote endpoints: throws 403 (need_verification) when the confirmation is asked for and missing */
function require_(db, body, phone) {
    if (!config(db).required) return;
    if (!check(db, body.verify_token, phone)) {
        throw err(403, 'يرجى تأكيد رقم الجوال أولاً', { need_verification: true });
    }
}

module.exports = { ensureTable, config, recent, start, confirm, check, require: require_, mobileOf, setSenderForTests, CODE_MINUTES, VALID_DAYS, MAX_TRIES };
