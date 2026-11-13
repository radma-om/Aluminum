/* =============================================================
   Phone / desktop notifications (Web Push) for the admin app.
   - Each device that allows notifications is saved with the account it
     belongs to (the general manager, or an employee account).
   - The keys that sign the notifications (VAPID) are made once and kept
     in the database (app_secrets: never in a backup file and never in
     Git), unless VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are set.
   - Who is told what:
     • a quote from a customer (calculators, WhatsApp, website) →
       managers and staff with «طلبات العروض» who may see that customer;
     • a customer handed to an employee → that employee;
     • a customer asking for a person → their employee, or the managers
       and staff with «متابعة العملاء» when nobody follows them;
     • a work order assigned / moved → its technician;
     • an appointment request → managers and staff with «أوامر العمل».
   - Sending never blocks or breaks the action that caused it; a device
     the push service no longer knows (404 / 410) is removed.
   ============================================================= */
const webpush = require('web-push');

const OWNER_KEY = 'owner';
const keyOf = (user) => (user && user.owner ? OWNER_KEY : user && user.id ? `u:${user.id}` : null);
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

let sender = (subscription, payload, options) => webpush.sendNotification(subscription, payload, options);
function setSenderForTests(fn) { sender = fn; }

function ensureTables(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS app_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS push_subscriptions (
                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                 user_key TEXT NOT NULL,
                 endpoint TEXT NOT NULL UNIQUE,
                 p256dh TEXT NOT NULL,
                 auth TEXT NOT NULL,
                 device TEXT,
                 created_at TEXT NOT NULL DEFAULT (datetime('now')),
                 last_sent_at TEXT
             );
             CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions (user_key);`);
    // What the push service answered last time (shown in the bell window to find why nothing arrives)
    const cols = db.prepare('PRAGMA table_info(push_subscriptions)').all().map((c) => c.name);
    if (!cols.includes('last_error')) db.exec('ALTER TABLE push_subscriptions ADD COLUMN last_error TEXT');
    if (!cols.includes('last_error_at')) db.exec('ALTER TABLE push_subscriptions ADD COLUMN last_error_at TEXT');
}

/* The signing keys: from the environment, or made once and kept in the database */
function vapid(db) {
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
    }
    ensureTables(db);
    const row = db.prepare("SELECT value FROM app_secrets WHERE key = 'vapid'").get();
    if (row) return JSON.parse(row.value);
    const keys = webpush.generateVAPIDKeys();
    db.prepare("INSERT OR IGNORE INTO app_secrets (key, value) VALUES ('vapid', ?)").run(JSON.stringify(keys));
    return JSON.parse(db.prepare("SELECT value FROM app_secrets WHERE key = 'vapid'").get().value);
}

/* Who the push services may contact about these notifications (a URL of this system) */
function subject(db) {
    if (process.env.VAPID_SUBJECT) return process.env.VAPID_SUBJECT;
    const base = String(require('./db').getSettings(db).public_base_url || '').trim().replace(/\/+$/, '');
    return /^https:\/\//.test(base) ? base : 'mailto:notifications@example.invalid';
}

const publicKey = (db) => vapid(db).publicKey;

/* A device's subscription (from the browser) → saved for this account */
function subscribe(db, user, sub, device = '') {
    ensureTables(db);
    const key = keyOf(user);
    const endpoint = String(sub && sub.endpoint || '');
    const keys = (sub && sub.keys) || {};
    if (!key) throw Object.assign(new Error('الحساب غير معروف'), { status: 400 });
    let url;
    try { url = new URL(endpoint); } catch { url = null; }
    if (!url || url.protocol !== 'https:' || endpoint.length > 1000) throw Object.assign(new Error('اشتراك الإشعارات غير صالح'), { status: 400 });
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(String(keys.p256dh || '')) || !/^[A-Za-z0-9_-]{8,100}$/.test(String(keys.auth || ''))) {
        throw Object.assign(new Error('اشتراك الإشعارات غير صالح'), { status: 400 });
    }
    // The same device signing in with another account now belongs to that account
    db.prepare(`INSERT INTO push_subscriptions (user_key, endpoint, p256dh, auth, device) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(endpoint) DO UPDATE SET user_key = excluded.user_key, p256dh = excluded.p256dh, auth = excluded.auth,
                device = excluded.device, created_at = datetime('now')`)
        .run(key, endpoint, keys.p256dh, keys.auth, clip(device, 120) || null);
    return devices(db, user);
}

function unsubscribe(db, user, endpoint) {
    ensureTables(db);
    db.prepare('DELETE FROM push_subscriptions WHERE user_key = ? AND endpoint = ?').run(keyOf(user), String(endpoint || ''));
    return devices(db, user);
}

function devices(db, user) {
    ensureTables(db);
    const SERVICES = [[/push\.apple\.com$/, 'Apple'], [/googleapis\.com$/, 'Google'], [/mozilla\.com$/, 'Mozilla'], [/notify\.windows\.com$/, 'Microsoft']];
    return db.prepare(`SELECT id, device, endpoint, created_at, last_sent_at, last_error, last_error_at FROM push_subscriptions
                       WHERE user_key = ? ORDER BY id`).all(keyOf(user)).map(({ endpoint, ...d }) => {
        const host = (() => { try { return new URL(endpoint).hostname; } catch { return ''; } })();
        const svc = SERVICES.find(([re]) => re.test(host));
        // The endpoint itself is a secret address: only its last characters, to tell this device apart
        return { ...d, service: svc ? svc[1] : host, tail: endpoint.slice(-12) };
    });
}

/* The push service's answer in words an employee can act on */
function explain(err) {
    const code = err && err.statusCode;
    const body = String((err && err.body) || '').replace(/\s+/g, ' ').slice(0, 160);
    if (code === 403) return `403 — رفضت خدمة الإشعارات مفتاح الخادم (VAPID)${body ? ': ' + body : ''}. أوقف الإشعارات على هذا الجهاز ثم فعّلها من جديد.`;
    if (code === 400) return `400 — رفضت خدمة الإشعارات الطلب${body ? ': ' + body : ''}`;
    if (code === 413) return '413 — الرسالة أطول من المسموح';
    if (code === 429) return '429 — طلبات كثيرة، تُعاد لاحقاً';
    if (code) return `${code} — ${body || 'خطأ من خدمة الإشعارات'}`;
    const m = String((err && (err.code || err.message)) || 'خطأ غير معروف');
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|socket|network|timeout/i.test(m)) {
        return `لم يصل الخادم إلى خدمة الإشعارات (${m}) — قد تكون الاستضافة تمنع الاتصال الخارجي بخوادم Apple / Google`;
    }
    return m.slice(0, 200);
}

/**
 * Send { title, body, url, tag } to these accounts' devices. Never throws; returns how many devices got it.
 * userKeys: 'owner' and / or 'u:<id>' (duplicates are fine). The last error of each device is kept.
 */
async function send(db, userKeys, message, { report = null } = {}) {
    try {
        ensureTables(db);
        const keys = [...new Set(userKeys.filter(Boolean))];
        if (!keys.length) return 0;
        const subs = db.prepare(`SELECT * FROM push_subscriptions WHERE user_key IN (${keys.map(() => '?').join(', ')})`).all(...keys);
        if (!subs.length) return 0;
        const { publicKey: pub, privateKey } = vapid(db);
        const payload = JSON.stringify({
            title: clip(message.title, 80), body: clip(message.body, 240),
            url: String(message.url || '/admin').startsWith('/admin') ? String(message.url || '/admin') : '/admin',
            tag: clip(message.tag, 60) || undefined
        });
        const options = { vapidDetails: { subject: subject(db), publicKey: pub, privateKey }, TTL: 24 * 3600, urgency: 'high' };
        let ok = 0;
        await Promise.all(subs.map(async (s) => {
            try {
                await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, options);
                db.prepare("UPDATE push_subscriptions SET last_sent_at = datetime('now'), last_error = NULL WHERE id = ?").run(s.id);
                ok++;
            } catch (err) {
                const why = explain(err);
                if (report) report.push({ device: s.device, error: why });
                // The browser was uninstalled or the permission withdrawn: forget the device
                if (err && (err.statusCode === 404 || err.statusCode === 410)) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
                else {
                    db.prepare("UPDATE push_subscriptions SET last_error = ?, last_error_at = datetime('now') WHERE id = ?").run(why, s.id);
                    console.error('[push]', why);
                }
            }
        }));
        return ok;
    } catch (err) {
        console.error('[push]', err.message);
        return 0;
    }
}

/* ------------------------------ Who receives what ------------------------------ */

/* Active accounts (as staff.js users) that pass a test, plus the general manager when asked */
function accounts(db, test, { owner = true } = {}) {
    const users = db.prepare('SELECT * FROM staff_users WHERE active = 1').all().map(toUser).filter(test);
    return [...(owner ? [OWNER_KEY] : []), ...users.map((u) => `u:${u.id}`)];
}
function toUser(row) {
    const { SECTIONS } = require('./staff');
    return {
        id: row.id, display_name: row.display_name, role: row.role,
        permissions: row.role === 'manager' ? Object.keys(SECTIONS) : row.role === 'technician' ? ['work_orders'] : JSON.parse(row.permissions_json || '[]'),
        leads_scope: row.role === 'manager' ? 'all' : row.leads_scope || 'all'
    };
}
const userKeyByName = (db, name) => {
    const row = name && db.prepare('SELECT id FROM staff_users WHERE display_name = ? AND active = 1').get(name);
    return row ? `u:${row.id}` : null;
};

const money = (n) => Number(n || 0).toFixed(2);
const SOURCES = { mazbot: 'واتساب', whatsapp: 'واتساب', website: 'دردشة الموقع', web: 'الحاسبة', calculator: 'الحاسبة' };

/* A quote a customer made (calculators, WhatsApp, website chat) */
function quoteFromCustomer(db, quote) {
    if (!quote || ['staff', 'agent-test'].includes(quote.source)) return Promise.resolve(0);
    const { seesQuote } = require('./staff');
    const keys = accounts(db, (u) => u.permissions.includes('quotes') && seesQuote(db, u, quote));
    return send(db, keys, {
        title: '📄 عرض سعر جديد من عميل',
        body: `${quote.ref} — ${quote.customer_name} — ${money(quote.total)} ر.ع${SOURCES[quote.source] ? ` (${SOURCES[quote.source]})` : ''}`,
        url: '/admin#tab=quotes', tag: 'quote-' + quote.ref
    });
}

/* A customer handed to an employee */
function leadAssigned(db, lead, by) {
    const key = userKeyByName(db, lead && lead.assigned_to);
    if (!key || (by && by === lead.assigned_to)) return Promise.resolve(0);
    return send(db, [key], {
        title: '👤 أُسند إليك عميل',
        body: `${lead.name || (lead.phone ? '+' + lead.phone : 'عميل')}${by ? ` — من ${by}` : ''}`,
        url: `/admin#lead=${lead.id}`, tag: 'lead-' + lead.id
    });
}

/* A customer asked to talk to a person */
function humanRequested(db, lead, summary) {
    if (!lead) return Promise.resolve(0);
    const assigned = userKeyByName(db, lead.assigned_to);
    const keys = assigned ? [assigned] : accounts(db, (u) => u.permissions.includes('leads'));
    return send(db, keys, {
        title: '🙋 عميل يطلب التواصل مع موظف',
        body: `${lead.name || (lead.phone ? '+' + lead.phone : 'عميل')}: ${clip(summary, 160)}`,
        url: `/admin#lead=${lead.id}`, tag: 'lead-' + lead.id
    });
}

/* A work order given to a technician (or moved to a new date) */
function workOrderAssigned(db, order, { rescheduled = false } = {}) {
    if (!order || !order.technician_id) return Promise.resolve(0);
    return send(db, [`u:${order.technician_id}`], {
        title: rescheduled ? '🔧 موعد جديد لأمر عمل' : '🔧 أمر عمل جديد',
        body: `${order.kind_label || ''} ${order.number} — ${order.customer_name}${order.scheduled_date ? ` — ${order.scheduled_date}${order.scheduled_time ? ' ' + order.scheduled_time : ''}` : ''}`,
        url: '/admin#tab=work_orders', tag: 'wo-' + order.number
    });
}

/* The technician started, finished, asked for a new date or wrote a report: the office (work orders staff and managers) */
function workOrderReport(db, order, { title, text = '', author = '' }) {
    const keys = accounts(db, (u) => u.role !== 'technician' && u.permissions.includes('work_orders'));
    return send(db, keys, {
        title,
        body: `${order.number} — ${order.customer_name}${author ? ` — ${author}` : ''}${text ? `\n${String(text).slice(0, 160)}` : ''}`,
        url: '/admin#tab=work_orders', tag: 'wo-report-' + order.number
    });
}

/* An appointment request waiting for approval */
function serviceRequest(db, r) {
    const keys = accounts(db, (u) => u.role !== 'technician' && u.permissions.includes('work_orders'));
    return send(db, keys, {
        title: '📅 طلب موعد ينتظر موافقتك',
        body: `${r.kind_label || ''} ${r.ref} — ${r.customer_name}${r.preferred_date ? ` — يفضّل ${r.preferred_date}` : ''}`,
        url: '/admin#tab=work_orders&requests=1', tag: 'sr-' + r.ref
    });
}

module.exports = {
    publicKey, subscribe, unsubscribe, devices, send, keyOf, setSenderForTests, accountsOf: accounts,
    quoteFromCustomer, leadAssigned, humanRequested, workOrderAssigned, workOrderReport, serviceRequest
};
