/* =============================================================
   Staff accounts and permissions.
   - The general manager logs in with ADMIN_TOKEN (as before) and sees
     everything; other managers can be added as accounts.
   - Each employee has a username and password, the panel sections
     they may open, and for the customer follow-up either all customers
     or only their own (plus the unassigned ones, to pick from).
   - Passwords are stored as scrypt hashes; sessions as SHA-256 of a
     random token, valid 14 days from the last use.
   - Every admin API route is mapped to a section and checked on the
     server, so hiding a tab is never the only protection.
   ============================================================= */
const crypto = require('node:crypto');
const totp = require('./totp');

const SECTIONS = {
    dashboard: 'لوحة المؤشرات',
    leads: 'متابعة العملاء',
    quotes: 'طلبات العروض',
    invoices: 'الفواتير والمدفوعات',
    work_orders: 'أوامر العمل (التركيب والصيانة)',
    pricing: 'حاسبة التسعير',
    weight: 'حاسبة الوزن',
    products: 'المنتجات والأسعار',
    purchases: 'أسعار الشراء',
    doors: 'بوابات الشتر',
    overhead: 'بوابات الأوفرهيد',
    motors: 'مكائن البوابات',
    agent: 'المساعد الذكي',
    integrations: 'الربط والإعدادات'
};
const ROLES = { staff: 'موظف', manager: 'مدير', technician: 'فني تركيب وصيانة' };
const SCOPES = { all: 'كل العملاء', mine: 'عملاؤه فقط (وغير المُسندين)' };
const SESSION_DAYS = 14;
const OWNER = { id: null, username: '', display_name: 'المدير العام', role: 'manager', permissions: Object.keys(SECTIONS), leads_scope: 'all', owner: true };

const err = (status, message) => Object.assign(new Error(message), { status });
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ------------------------------ Passwords ------------------------------ */

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, 64);
    return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function checkPassword(password, stored) {
    const [kind, saltHex, hashHex] = String(stored || '').split('$');
    if (kind !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
}

function validatePassword(p) {
    if (String(p || '').length < 8) throw err(400, 'كلمة المرور يجب أن تكون 8 أحرف على الأقل');
    if (String(p).length > 200) throw err(400, 'كلمة المرور طويلة جداً');
}

/* ------------------------------ Users ------------------------------ */

const toUser = (row) => (row ? {
    id: row.id, username: row.username, display_name: row.display_name, role: row.role,
    // A technician only works on the work orders assigned to them
    permissions: row.role === 'manager' ? Object.keys(SECTIONS) : row.role === 'technician' ? ['work_orders']
        : JSON.parse(row.permissions_json || '[]').filter((s) => SECTIONS[s]),
    leads_scope: row.role === 'manager' ? 'all' : (SCOPES[row.leads_scope] ? row.leads_scope : 'all'),
    active: Boolean(row.active), created_at: row.created_at, last_login_at: row.last_login_at,
    email: row.email || '',
    totp_enabled: Boolean(row.totp_secret),
    // Managers must turn on two-step sign-in before they can use the panel
    must_setup_2fa: row.role === 'manager' && !row.totp_secret
} : null);

const list = (db) => db.prepare('SELECT * FROM staff_users ORDER BY active DESC, display_name').all().map(toUser);

function clean(db, input, { existing = null } = {}) {
    const username = String(input.username ?? existing?.username ?? '').trim().toLowerCase();
    const display = String(input.display_name ?? existing?.display_name ?? '').trim().slice(0, 80);
    if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw err(400, 'اسم المستخدم: 3 إلى 40 حرفاً إنجليزياً صغيراً أو أرقاماً (مثل salem أو mariam.k)');
    if (!display) throw err(400, 'اكتب اسم الموظف كما يظهر في التقارير');
    const taken = db.prepare('SELECT id FROM staff_users WHERE username = ? AND id != ?').get(username, existing ? existing.id : 0);
    if (taken) throw err(400, 'اسم المستخدم مستخدم لموظف آخر');
    const role = ROLES[input.role] ? input.role : existing?.role || 'staff';
    const permissions = Array.isArray(input.permissions) ? [...new Set(input.permissions.filter((s) => SECTIONS[s]))]
        : existing ? JSON.parse(existing.permissions_json || '[]') : [];
    if (role === 'staff' && !permissions.length) throw err(400, 'اختر قسماً واحداً على الأقل يعمل فيه الموظف');
    if (role === 'technician') permissions.length = 0; // fixed: their own work orders
    const leadsScope = SCOPES[input.leads_scope] ? input.leads_scope : existing?.leads_scope || 'all';
    const active = input.active === undefined ? (existing ? existing.active : 1) : (input.active ? 1 : 0);
    const email = String(input.email ?? existing?.email ?? '').trim().toLowerCase().slice(0, 120);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw err(400, 'البريد الإلكتروني غير صالح');
    if (email && db.prepare('SELECT id FROM staff_users WHERE lower(email) = ? AND id != ?').get(email, existing ? existing.id : 0)) {
        throw err(400, 'هذا البريد مستخدم لحساب آخر');
    }
    return { username, display_name: display, role, permissions_json: JSON.stringify(permissions), leads_scope: leadsScope, active, email: email || null };
}

function create(db, input) {
    const u = clean(db, input);
    validatePassword(input.password);
    const info = db.prepare(`INSERT INTO staff_users (username, display_name, role, permissions_json, leads_scope, active, email, password_hash)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(u.username, u.display_name, u.role, u.permissions_json, u.leads_scope, u.active, u.email, hashPassword(input.password));
    return toUser(db.prepare('SELECT * FROM staff_users WHERE id = ?').get(Number(info.lastInsertRowid)));
}

/* All-or-nothing: an account change and the end of its sessions happen together, or not at all */
function tx(db, fn) {
    db.exec('BEGIN');
    try {
        const r = fn();
        db.exec('COMMIT');
        return r;
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
}

function update(db, id, input) {
    const existing = db.prepare('SELECT * FROM staff_users WHERE id = ?').get(Number(id));
    if (!existing) throw err(404, 'المستخدم غير موجود');
    // Everything is checked before anything is written (no half-updated account)
    const u = clean(db, input, { existing });
    if (input.password) validatePassword(input.password);
    const hash = input.password ? hashPassword(input.password) : null;
    tx(db, () => {
        db.prepare(`UPDATE staff_users SET username = ?, display_name = ?, role = ?, permissions_json = ?, leads_scope = ?, active = ?, email = ? WHERE id = ?`)
            .run(u.username, u.display_name, u.role, u.permissions_json, u.leads_scope, u.active, u.email, existing.id);
        if (hash) db.prepare('UPDATE staff_users SET password_hash = ? WHERE id = ?').run(hash, existing.id);
        // A new password (or a changed email) makes earlier reset links useless
        if (hash || (u.email || '') !== (existing.email || '')) db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(existing.id);
        // Lost phone: the manager turns two-step sign-in off; it is set up again at the next sign-in
        if (input.reset_2fa) db.prepare('UPDATE staff_users SET totp_secret = NULL, totp_pending = NULL WHERE id = ?').run(existing.id);
        // New permissions apply at once; a deactivated account, a new password or a 2FA reset signs out everywhere
        if (!u.active || hash || input.reset_2fa) db.prepare('DELETE FROM staff_sessions WHERE user_id = ?').run(existing.id);
    });
    return toUser(db.prepare('SELECT * FROM staff_users WHERE id = ?').get(existing.id));
}

function remove(db, id) {
    db.prepare('DELETE FROM staff_sessions WHERE user_id = ?').run(Number(id));
    if (!db.prepare('DELETE FROM staff_users WHERE id = ?').run(Number(id)).changes) throw err(404, 'المستخدم غير موجود');
}

/* The employee's own new password ends ALL their sessions (this one too): they sign in again */
function changeOwnPassword(db, user, current, next) {
    if (!user.id) throw err(400, 'كلمة مرور المدير العام تُغيَّر من متغير البيئة ADMIN_TOKEN في الاستضافة');
    const row = db.prepare('SELECT * FROM staff_users WHERE id = ?').get(user.id);
    if (!row || !checkPassword(current, row.password_hash)) throw err(400, 'كلمة المرور الحالية غير صحيحة');
    validatePassword(next);
    if (String(next) === String(current)) throw err(400, 'كلمة المرور الجديدة مطابقة للحالية — اختر كلمة مختلفة');
    const hash = hashPassword(next);
    const ended = tx(db, () => {
        db.prepare('UPDATE staff_users SET password_hash = ? WHERE id = ?').run(hash, row.id);
        db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(row.id);
        return Number(db.prepare('DELETE FROM staff_sessions WHERE user_id = ?').run(row.id).changes);
    });
    return { signed_out: true, sessions_ended: ended };
}

/* ------------------------------ Sessions ------------------------------ */

/* Password, then (when turned on) the 6-digit code.
   Returns { token, user }, { need_code: true } (password right, code still needed),
   { bad_code: true }, or null (wrong username or password). */
function login(db, username, password, code) {
    const row = db.prepare('SELECT * FROM staff_users WHERE username = ?').get(String(username || '').trim().toLowerCase());
    // Same work and the same answer whether or not the user exists
    const ok = row ? checkPassword(password, row.password_hash) : (checkPassword(password, hashPassword('x')), false);
    if (!ok) return null;
    if (!row.active) throw err(403, 'هذا الحساب موقوف — راجع المدير العام');
    if (row.totp_secret) {
        if (!String(code || '').trim()) return { need_code: true };
        const step = totp.verify(row.totp_secret, code, { lastStep: row.totp_last_step });
        if (step === null) return { bad_code: true, user_id: row.id };
        db.prepare('UPDATE staff_users SET totp_last_step = ? WHERE id = ?').run(step, row.id);
    }
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare(`INSERT INTO staff_sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`)
        .run(sha256(token), row.id);
    db.prepare("UPDATE staff_users SET last_login_at = datetime('now') WHERE id = ?").run(row.id);
    db.prepare("DELETE FROM staff_sessions WHERE expires_at < datetime('now')").run();
    return { token, user: toUser(row) };
}

/* The account behind a session token (sliding expiry), or null */
function fromToken(db, token) {
    if (!token || token.length < 20) return null;
    const hash = sha256(token);
    const row = db.prepare(`SELECT u.* FROM staff_sessions s JOIN staff_users u ON u.id = s.user_id
                            WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.active = 1`).get(hash);
    if (!row) return null;
    db.prepare(`UPDATE staff_sessions SET expires_at = datetime('now', '+${SESSION_DAYS} days') WHERE token_hash = ?`).run(hash);
    return toUser(row);
}

/* ------------------------------ Forgotten password (email link) ------------------------------ */

const RESET_MINUTES = 30;
const RESETS_PER_HOUR = 3; // per account, so the inbox is not flooded

/* By username or email. Returns { user, token } to email, or null (no such active account with an
   email, or too many requests) — the caller answers the same either way. */
function requestReset(db, identifier, ip) {
    const id = String(identifier || '').trim().toLowerCase().slice(0, 120);
    if (!id) return null;
    const row = db.prepare('SELECT * FROM staff_users WHERE (username = ? OR lower(email) = ?) AND active = 1').get(id, id);
    if (!row || !row.email) return null;
    const recent = db.prepare("SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND created_at > datetime('now', '-1 hour')").get(row.id).n;
    if (recent >= RESETS_PER_HOUR) return null;
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare(`INSERT INTO password_resets (token_hash, user_id, expires_at, ip) VALUES (?, ?, datetime('now', '+${RESET_MINUTES} minutes'), ?)`)
        .run(sha256(token), row.id, ip ? String(ip).replace(/^::ffff:/, '') : null);
    return { user: toUser(row), token };
}

/* The link's code + a new password. Ends every session; two-step sign-in stays as it is. */
function resetPassword(db, token, password) {
    const hash = sha256(String(token || ''));
    const reset = db.prepare(`SELECT r.*, u.active FROM password_resets r JOIN staff_users u ON u.id = r.user_id
                              WHERE r.token_hash = ?`).get(hash);
    if (!reset || reset.used_at || !reset.active || db.prepare("SELECT datetime('now') >= ? AS late").get(reset.expires_at).late) {
        throw err(400, 'رابط الاستعادة غير صالح أو منتهي (صالح 30 دقيقة ولمرة واحدة) — اطلب رابطاً جديداً');
    }
    validatePassword(password);
    const newHash = hashPassword(password);
    tx(db, () => {
        db.prepare('UPDATE staff_users SET password_hash = ? WHERE id = ?').run(newHash, reset.user_id);
        db.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE token_hash = ?").run(hash);
        db.prepare('DELETE FROM password_resets WHERE user_id = ? AND token_hash != ?').run(reset.user_id, hash);
        db.prepare('DELETE FROM staff_sessions WHERE user_id = ?').run(reset.user_id);
    });
    return toUser(db.prepare('SELECT * FROM staff_users WHERE id = ?').get(reset.user_id));
}

/* ------------------------------ Two-step sign-in ------------------------------ */

const ISSUER = 'Radma';

/* A new secret waits (totp_pending) until the first code from the phone confirms it */
function setup2fa(db, user) {
    if (!user.id) throw err(400, 'المدير العام (ADMIN_TOKEN) لا يستخدم التحقق بخطوتين — أنشئ لنفسك حساب «مدير» من «المستخدمون والصلاحيات»');
    const secret = totp.generateSecret();
    db.prepare('UPDATE staff_users SET totp_pending = ? WHERE id = ?').run(secret, user.id);
    const uri = totp.otpauthUri({ issuer: ISSUER, account: user.username, secret });
    return { secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri, qr_svg: totp.qrSvg(uri) };
}

/* The first code proves the phone has the secret. Other devices sign out (this one stays). */
function enable2fa(db, user, code, keepTokenHash) {
    const row = user.id && db.prepare('SELECT * FROM staff_users WHERE id = ?').get(user.id);
    if (!row || !row.totp_pending) throw err(400, 'ابدأ بالضغط على «تفعيل التحقق بخطوتين» لعرض رمز QR');
    const step = totp.verify(row.totp_pending, code);
    if (step === null) throw err(400, 'الرمز غير صحيح — اكتب الرمز الظاهر الآن في التطبيق (6 أرقام)، وتأكد أن وقت الجوال تلقائي');
    tx(db, () => {
        db.prepare('UPDATE staff_users SET totp_secret = totp_pending, totp_pending = NULL, totp_last_step = ? WHERE id = ?').run(step, row.id);
        db.prepare('DELETE FROM staff_sessions WHERE user_id = ? AND token_hash != ?').run(row.id, keepTokenHash || '');
    });
    return toUser(db.prepare('SELECT * FROM staff_users WHERE id = ?').get(row.id));
}

/* Employees may turn it off with their password; for managers it is required */
function disable2fa(db, user, password) {
    const row = user.id && db.prepare('SELECT * FROM staff_users WHERE id = ?').get(user.id);
    if (!row) throw err(400, 'هذا الإجراء لحسابات الموظفين');
    if (row.role === 'manager') throw err(400, 'التحقق بخطوتين إلزامي لحسابات المديرين ولا يمكن إيقافه');
    if (!checkPassword(password, row.password_hash)) throw err(400, 'كلمة المرور غير صحيحة');
    db.prepare('UPDATE staff_users SET totp_secret = NULL, totp_pending = NULL WHERE id = ?').run(row.id);
    return toUser(db.prepare('SELECT * FROM staff_users WHERE id = ?').get(row.id));
}

/* Routes a manager who has not set up two-step sign-in yet may still use */
const SETUP_2FA_PATHS = new Set(['/me', '/me/2fa/setup', '/me/2fa/enable', '/me/password']);

const logout = (db, token) => db.prepare('DELETE FROM staff_sessions WHERE token_hash = ?').run(sha256(String(token || '')));

/* ------------------------------ Permissions ------------------------------ */

const can = (user, section) => user.role === 'manager' || user.permissions.includes(section);

/* Which sections may use an admin route: a list (any of them), 'any' (every signed-in user),
   or 'manager'. Unknown routes are for managers only. */
function sectionsFor(method, path) {
    const p = path.replace(/\/+$/, '');
    const rules = [
        [/^\/me(\/|$)/, 'any'],
        [/^\/settings$/, method === 'GET' ? 'any' : 'settings'],
        [/^\/dashboard$/, ['dashboard']],
        [/^\/leads(\/|$)/, ['leads']],
        [/^\/quotes\/\d+\/pdf$/, ['quotes', 'leads']],
        [/^\/quotes\/\d+\/invoice$/, ['invoices']],
        // Deleting a payment or cancelling an invoice: managers only
        [/^\/invoices\/\d+\/(payments\/\d+|cancel)$/, method === 'GET' ? ['invoices'] : 'manager'],
        [/^\/invoices(\/|$)/, ['invoices']],
        [/^\/work-orders(\/|$)/, ['work_orders']],
        [/^\/quotes(\/|$)/, ['quotes']],
        [/^\/products$/, method === 'GET' ? ['products', 'purchases'] : ['products']],
        [/^\/(products|price-list\.txt)(\/|$)/, ['products']],
        [/^\/purchases(\/|$)/, ['purchases']],
        [/^\/regions\/\d+$/, method === 'PUT' ? 'regions' : ['doors']],
        [/^\/(configurator|shutter-types|accessory-groups|regions|governorates)(\/|$)/, ['doors']],
        [/^\/overhead(\/|$)/, ['overhead']],
        [/^\/motors(\/|$)/, ['motors']],
        [/^\/(agent|knowledge)(\/|$)/, ['agent']],
        [/^\/(mazbot|whatsapp)(\/|$)/, ['integrations']]
        // /webhooks: managers only (falls through) — every quote with the customer's details goes to them
    ];
    for (const [re, rule] of rules) if (re.test(p)) return rule;
    return 'manager'; // users, backups, restore and anything new
}

/* Settings each section may change (the rest belong to «الربط والإعدادات»; staff names to managers) */
const SETTING_SECTIONS = {
    lme: 'pricing', manufacturing: 'pricing', painting: 'pricing', exchange_rate: 'pricing', profit_percent: 'pricing',
    vat_percent: 'pricing', tax_mode: 'pricing', slat_thicknesses: 'pricing',
    agent_knowledge: 'agent', agent_instructions: 'agent',
    motors_profit_percent: 'motors',
    staff_members: 'manager',
    // Where customers and sales alerts are sent: an employee changing these could divert both to their own number
    company_whatsapp: 'manager', mazbot_recipients: 'manager', public_base_url: 'manager',
    follow_up_stale_days: 'manager', follow_up_emails: 'manager', quote_validity_days: 'manager'
};
function allowedSettings(user, body) {
    const out = {};
    for (const [k, v] of Object.entries(body || {})) {
        const section = SETTING_SECTIONS[k] || 'integrations';
        if (user.role === 'manager' || (section !== 'manager' && can(user, section))) out[k] = v;
    }
    return out;
}

/* A wilayah's fees: shutter staff change all of them; overhead / motors staff only their own fee */
function allowedRegionFields(user, body) {
    if (can(user, 'doors')) return true;
    const keys = Object.keys(body || {});
    const mine = [...(can(user, 'overhead') ? ['overhead_installation_fee'] : []), ...(can(user, 'motors') ? ['motor_installation_fee'] : [])];
    return keys.length > 0 && keys.every((k) => mine.includes(k));
}

/* Follow-up limited to one's own customers: assigned to them, or not assigned yet */
const seesLead = (user, lead) => user.leads_scope !== 'mine' || !lead.assigned_to || lead.assigned_to === user.display_name;

/* The same scope covers the customer's quotes, in every section (follow-up, quote requests, PDFs):
   a quote belongs to the customer(s) with its phone; with no such customer it counts as unassigned.
   Conflicting ownership fails closed: an unassigned duplicate must never unlock another employee’s quote */
function seesQuote(db, user, quote) {
    if (user.leads_scope !== 'mine') return true;
    const owners = db.prepare('SELECT assigned_to FROM leads WHERE phone = ?').all(String(quote.customer_phone || ''));
    return !owners.length || owners.every((l) => seesLead(user, l));
}

module.exports = {
    setup2fa, enable2fa, disable2fa, SETUP_2FA_PATHS, sha256, requestReset, resetPassword, RESET_MINUTES,
    SECTIONS, ROLES, SCOPES, OWNER, hashPassword, checkPassword, list, create, update, remove, changeOwnPassword,
    login, fromToken, logout, can, sectionsFor, allowedSettings, allowedRegionFields, seesLead, seesQuote
};
