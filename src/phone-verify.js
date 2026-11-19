/* =============================================================
   Confirming the customer's mobile in the calculators, on WhatsApp
   (no code to type, no template, nothing paid):
   1. The page asks for a 4-digit code (start) and opens WhatsApp with a
      ready message «رمز تأكيد الرقم: 4827» to the templates number.
   2. The customer sends it: the templates account's webhook finds the
      code, checks it came from the number typed, and marks it confirmed
      (a short reply tells them to go back to the page).
   3. The page asks every few seconds (status) and sends the request with
      the token; the server accepts it for 30 days for that number.
   - Off until the manager switches it on (settings: calculator_verify_phone),
     and never on without the templates account's webhook (it would stop
     every request).
   - A code lives 15 minutes; a number gets at most 5 codes an hour.
   ============================================================= */
const crypto = require('node:crypto');
const { getSettings } = require('./db');

const CODE_MINUTES = 15;
const VALID_DAYS = 30;
const mobileOf = (phone) => { const d = String(phone || '').replace(/\D/g, '').replace(/^00/, ''); return d.length === 8 ? '968' + d : d; };
const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

function ensureTable(db) {
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
    ); CREATE INDEX IF NOT EXISTS phone_verifications_code ON phone_verifications (code, status);`);
}

/* The number customers write to, and whether the confirmation is asked for */
function config(db) {
    const s = getSettings(db);
    const hook = String(process.env.MAZBOT_TEMPLATES_WEBHOOK_SECRET || '').trim().length >= 16;
    const number = String(s.verify_whatsapp_number || '').replace(/\D/g, '');
    return { required: Boolean(s.calculator_verify_phone) && hook && number.length >= 8, number: number ? mobileOf(number) : null, webhook: hook };
}

/* A new code for this number: the page shows it and opens WhatsApp with it */
function start(db, phone) {
    ensureTable(db);
    const p = mobileOf(phone);
    if (!/^968[79]\d{7}$/.test(p)) throw err(400, 'يرجى إدخال رقم جوال عماني صالح (مثال: 9XXXXXXX).');
    const recent = db.prepare("SELECT COUNT(*) AS n FROM phone_verifications WHERE phone = ? AND created_at > datetime('now', '-1 hour')").get(p).n;
    if (recent >= 5) throw err(429, 'تم طلب رموز كثيرة لهذا الرقم — حاول بعد ساعة.');
    // A code not in use by another number right now (4 digits)
    let code;
    for (let i = 0; i < 20; i++) {
        code = String(crypto.randomInt(1000, 10000));
        if (!db.prepare("SELECT 1 FROM phone_verifications WHERE code = ? AND status = 'pending' AND expires_at > datetime('now')").get(code)) break;
    }
    const token = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO phone_verifications (phone, code, token, expires_at) VALUES (?, ?, ?, ?)').run(p, code, token, sqlTime(Date.now() + CODE_MINUTES * 60_000));
    const c = config(db);
    const text = `رمز تأكيد الرقم: ${code}`;
    return { token, code, phone: p, expires_in: CODE_MINUTES * 60, wa_url: c.number ? `https://wa.me/${c.number}?text=${encodeURIComponent(text)}` : null, text };
}

/* The page asks: is it confirmed yet? */
function status(db, token) {
    ensureTable(db);
    const r = db.prepare('SELECT phone, status, expires_at, verified_until FROM phone_verifications WHERE token = ?').get(String(token || ''));
    if (!r) return { status: 'unknown' };
    if (r.status === 'verified') return { status: 'verified', phone: r.phone, until: r.verified_until };
    if (r.expires_at <= sqlTime(Date.now())) return { status: 'expired' };
    return { status: 'pending' };
}

/* A WhatsApp message to the templates number: a code it is waiting for? Returns null when it holds no code. */
function confirmFromWhatsApp(db, senderPhone, text) {
    ensureTable(db);
    const m = /(^|\D)(\d{4})(\D|$)/.exec(String(text || '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))));
    if (!m || !/رمز|تأكيد|code/i.test(text) && String(text).trim().length > 8) return null;
    const code = m[2];
    const row = db.prepare("SELECT * FROM phone_verifications WHERE code = ? AND status = 'pending' AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1").get(code);
    if (!row) return { result: 'unknown_code' };
    if (row.phone !== mobileOf(senderPhone)) return { result: 'other_number', phone: row.phone };
    db.prepare("UPDATE phone_verifications SET status = 'verified', verified_at = datetime('now'), verified_until = ? WHERE id = ?")
        .run(sqlTime(Date.now() + VALID_DAYS * 86400_000), row.id);
    return { result: 'verified', phone: row.phone };
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
        throw err(403, 'يرجى تأكيد رقم الجوال عبر واتساب أولاً', { need_verification: true });
    }
}

module.exports = { ensureTable, config, start, status, confirmFromWhatsApp, check, require: require_, mobileOf, CODE_MINUTES, VALID_DAYS };
