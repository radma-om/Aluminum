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

const SECTIONS = {
    dashboard: 'لوحة المؤشرات',
    leads: 'متابعة العملاء',
    quotes: 'طلبات العروض',
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
const ROLES = { staff: 'موظف', manager: 'مدير' };
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
    permissions: row.role === 'manager' ? Object.keys(SECTIONS) : JSON.parse(row.permissions_json || '[]').filter((s) => SECTIONS[s]),
    leads_scope: row.role === 'manager' ? 'all' : (SCOPES[row.leads_scope] ? row.leads_scope : 'all'),
    active: Boolean(row.active), created_at: row.created_at, last_login_at: row.last_login_at
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
    const leadsScope = SCOPES[input.leads_scope] ? input.leads_scope : existing?.leads_scope || 'all';
    const active = input.active === undefined ? (existing ? existing.active : 1) : (input.active ? 1 : 0);
    return { username, display_name: display, role, permissions_json: JSON.stringify(permissions), leads_scope: leadsScope, active };
}

function create(db, input) {
    const u = clean(db, input);
    validatePassword(input.password);
    const info = db.prepare(`INSERT INTO staff_users (username, display_name, role, permissions_json, leads_scope, active, password_hash)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(u.username, u.display_name, u.role, u.permissions_json, u.leads_scope, u.active, hashPassword(input.password));
    return toUser(db.prepare('SELECT * FROM staff_users WHERE id = ?').get(Number(info.lastInsertRowid)));
}

function update(db, id, input) {
    const existing = db.prepare('SELECT * FROM staff_users WHERE id = ?').get(Number(id));
    if (!existing) throw err(404, 'المستخدم غير موجود');
    const u = clean(db, input, { existing });
    db.prepare(`UPDATE staff_users SET username = ?, display_name = ?, role = ?, permissions_json = ?, leads_scope = ?, active = ? WHERE id = ?`)
        .run(u.username, u.display_name, u.role, u.permissions_json, u.leads_scope, u.active, existing.id);
    if (input.password) {
        validatePassword(input.password);
        db.prepare('UPDATE staff_users SET password_hash = ? WHERE id = ?').run(hashPassword(input.password), existing.id);
    }
    // New permissions apply at once; a deactivated account or a new password signs out everywhere
    if (!u.active || input.password) db.prepare('DELETE FROM staff_sessions WHERE user_id = ?').run(existing.id);
    return toUser(db.prepare('SELECT * FROM staff_users WHERE id = ?').get(existing.id));
}

function remove(db, id) {
    db.prepare('DELETE FROM staff_sessions WHERE user_id = ?').run(Number(id));
    if (!db.prepare('DELETE FROM staff_users WHERE id = ?').run(Number(id)).changes) throw err(404, 'المستخدم غير موجود');
}

function changeOwnPassword(db, user, current, next) {
    if (!user.id) throw err(400, 'كلمة مرور المدير العام تُغيَّر من متغير البيئة ADMIN_TOKEN في الاستضافة');
    const row = db.prepare('SELECT * FROM staff_users WHERE id = ?').get(user.id);
    if (!row || !checkPassword(current, row.password_hash)) throw err(400, 'كلمة المرور الحالية غير صحيحة');
    validatePassword(next);
    db.prepare('UPDATE staff_users SET password_hash = ? WHERE id = ?').run(hashPassword(next), row.id);
}

/* ------------------------------ Sessions ------------------------------ */

function login(db, username, password) {
    const row = db.prepare('SELECT * FROM staff_users WHERE username = ?').get(String(username || '').trim().toLowerCase());
    // Same work and the same answer whether or not the user exists
    const ok = row ? checkPassword(password, row.password_hash) : (checkPassword(password, hashPassword('x')), false);
    if (!ok) return null;
    if (!row.active) throw err(403, 'هذا الحساب موقوف — راجع المدير العام');
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
        [/^\/quotes(\/|$)/, ['quotes']],
        [/^\/products$/, method === 'GET' ? ['products', 'purchases'] : ['products']],
        [/^\/(products|price-list\.txt)(\/|$)/, ['products']],
        [/^\/purchases(\/|$)/, ['purchases']],
        [/^\/regions\/\d+$/, method === 'PUT' ? 'regions' : ['doors']],
        [/^\/(configurator|shutter-types|accessory-groups|regions|governorates)(\/|$)/, ['doors']],
        [/^\/overhead(\/|$)/, ['overhead']],
        [/^\/motors(\/|$)/, ['motors']],
        [/^\/(agent|knowledge)(\/|$)/, ['agent']],
        [/^\/(mazbot|webhooks|whatsapp)(\/|$)/, ['integrations']]
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
    staff_members: 'manager'
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

module.exports = {
    SECTIONS, ROLES, SCOPES, OWNER, hashPassword, checkPassword, list, create, update, remove, changeOwnPassword,
    login, fromToken, logout, can, sectionsFor, allowedSettings, allowedRegionFields, seesLead
};
