/* =============================================================
   «تتبع الفريق» — where the technicians and marketers are, on a map, for
   the managers (and an employee given the «تتبع الفريق» section).
   - Shared only during the working day: the technician / marketer presses
     «بدء الدوام» (the first time after reading what is shared and agreeing),
     and their phone sends its place every minute while the system is open
     on its screen (a web page cannot send it from the background), until
     «إنهاء الدوام».
   - A snapshot with each step of a work order («في الطريق», «بدأ العمل»,
     «تم») and with each customer visit a marketer records.
   - Kept 30 days, then deleted by itself (personal data: no longer than needed).
   ============================================================= */
const leads = require('./leads');

const TRACKED_ROLES = { technician: 'فني', marketer: 'مسوق' };
const KINDS = { live: 'موقع مباشر', shift_start: 'بدء الدوام', shift_end: 'إنهاء الدوام', event: 'خطوة عمل', visit: 'زيارة عميل' };
const RETENTION_DAYS = 30;
const LIVE_MIN_SECONDS = 20;   // a phone sending faster is ignored (one place per 20 s at most)
const LIVE_FRESH_MINUTES = 3;  // a place newer than this: «مباشر الآن»
const TZ = '+4 hours';

const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, expose: true, ...extra });
const clip = (s, n) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, n);
const sqlNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const tracked = (user) => Boolean(user && TRACKED_ROLES[user.role]);

const ready = new WeakSet();
function ensureTable(db) {
    if (ready.has(db)) return;
    ready.add(db);
    db.exec(`CREATE TABLE IF NOT EXISTS staff_locations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        lat        REAL NOT NULL,
        lng        REAL NOT NULL,
        accuracy   REAL,
        kind       TEXT NOT NULL,
        label      TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS staff_locations_user ON staff_locations (user_id, created_at);
    CREATE INDEX IF NOT EXISTS staff_locations_at ON staff_locations (created_at);`);
    const cols = db.prepare('PRAGMA table_info(staff_users)').all().map((c) => c.name);
    if (!cols.includes('location_consent_at')) db.exec('ALTER TABLE staff_users ADD COLUMN location_consent_at TEXT');
    if (!cols.includes('on_shift_since')) db.exec('ALTER TABLE staff_users ADD COLUMN on_shift_since TEXT');
}

/* A place from the phone: real coordinates, and how sure the phone is (metres) */
function coords(b) {
    const lat = Number(b && b.lat);
    const lng = Number(b && b.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
        throw err(400, 'الموقع غير صالح — تأكد من السماح للمتصفح بالوصول إلى الموقع');
    }
    const acc = Number(b.accuracy);
    return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, accuracy: Number.isFinite(acc) && acc >= 0 ? Math.min(Math.round(acc), 100000) : null };
}

function insert(db, userId, c, kind, label = null) {
    db.prepare('INSERT INTO staff_locations (user_id, lat, lng, accuracy, kind, label) VALUES (?, ?, ?, ?, ?, ?)')
        .run(userId, c.lat, c.lng, c.accuracy, kind, label ? clip(label, 120) : null);
}

const row = (db, id) => db.prepare('SELECT id, display_name, role, active, location_consent_at, on_shift_since FROM staff_users WHERE id = ?').get(Number(id));

/* This account's sharing: whether it shares at all, agreed, and is on shift now */
function mine(db, user) {
    ensureTable(db);
    if (!tracked(user) || !user.id) return { tracked: false };
    const u = row(db, user.id);
    return { tracked: true, consent: Boolean(u && u.location_consent_at), on_shift_since: (u && u.on_shift_since) || null, every_seconds: 60 };
}

/**
 * «بدء الدوام» / «إنهاء الدوام». Starting needs the account's agreement once (consent: true after reading the
 * notice); refused with need_consent otherwise. The place at that moment is recorded when the phone gives it.
 */
function shift(db, user, b = {}) {
    ensureTable(db);
    if (!tracked(user) || !user.id) throw err(403, 'مشاركة الموقع للفنيين والمسوقين فقط');
    const u = row(db, user.id);
    const on = Boolean(b.on);
    if (on) {
        if (!u.location_consent_at && b.consent !== true) throw err(400, 'يلزم موافقتك على مشاركة موقعك أثناء الدوام', { need_consent: true });
        if (!u.location_consent_at) db.prepare('UPDATE staff_users SET location_consent_at = ? WHERE id = ?').run(sqlNow(), u.id);
        if (!u.on_shift_since) db.prepare('UPDATE staff_users SET on_shift_since = ? WHERE id = ?').run(sqlNow(), u.id);
    } else {
        db.prepare('UPDATE staff_users SET on_shift_since = NULL WHERE id = ?').run(u.id);
    }
    if (b.lat !== undefined) {
        try { insert(db, u.id, coords(b), on ? 'shift_start' : 'shift_end'); } catch { /* the shift changes even without a place */ }
    }
    return mine(db, user);
}

/**
 * A place from the phone: kind «live» (every minute during the shift) or «event» (a work order step, with
 * its label). A live place off shift, or sooner than 20 s after the last, is not kept ({ kept: false }).
 */
function record(db, user, b = {}) {
    ensureTable(db);
    if (!tracked(user) || !user.id) throw err(403, 'مشاركة الموقع للفنيين والمسوقين فقط');
    const kind = b.kind === 'event' ? 'event' : 'live';
    const c = coords(b);
    const u = row(db, user.id);
    if (kind === 'live') {
        if (!u.on_shift_since) return { kept: false, reason: 'off_shift' };
        const last = db.prepare("SELECT created_at FROM staff_locations WHERE user_id = ? AND kind = 'live' ORDER BY id DESC LIMIT 1").get(u.id);
        if (last && Date.now() - Date.parse(last.created_at.replace(' ', 'T') + 'Z') < LIVE_MIN_SECONDS * 1000) return { kept: false, reason: 'too_soon' };
    } else if (!u.location_consent_at) {
        return { kept: false, reason: 'no_consent' };
    }
    insert(db, u.id, c, kind, kind === 'event' ? clip(b.label, 120) || 'خطوة عمل' : null);
    return { kept: true };
}

/**
 * A marketer's customer visit: the customer joins «متابعة العملاء» (a new one is theirs to follow), the visit
 * is written in the customer's log with a map link, and its place is kept for the map.
 */
function visit(db, user, b = {}) {
    ensureTable(db);
    if (!user || user.role !== 'marketer' || !user.id) throw err(403, 'تسجيل الزيارات للمسوقين');
    const name = clip(b.name, 120);
    const phone = String(b.phone || '').replace(/[^\d+]/g, '').slice(0, 20);
    const note = clip(b.note, 1000);
    if (!name && !phone) throw err(400, 'اكتب اسم العميل أو رقمه');
    let c = null;
    try { c = coords(b); } catch { c = null; }
    const key = leads.phoneKey(phone) || `visit:${user.id}:${Date.now()}`;
    let lead = leads.touch(db, { key, channel: 'field', name: name || null, phone: phone || null });
    if (!lead.assigned_to) lead = { ...lead, ...leads.update(db, lead.id, { assigned_to: user.display_name }, user.display_name) };
    const where = c ? `\n📍 الموقع: https://www.google.com/maps?q=${c.lat},${c.lng}` : '';
    leads.staffMessage(db, lead.id, `🚶 زيارة ميدانية${note ? `: ${note}` : ''}${where}`, user.display_name);
    if (c) insert(db, user.id, c, 'visit', name || phone);
    return { lead_id: lead.id, located: Boolean(c) };
}

/* The team now: each active technician / marketer, their last place and whether it is live */
function overview(db) {
    ensureTable(db);
    const users = db.prepare(`SELECT id, display_name, role, location_consent_at, on_shift_since FROM staff_users
                              WHERE active = 1 AND role IN (${Object.keys(TRACKED_ROLES).map(() => '?').join(', ')}) ORDER BY role, display_name`).all(...Object.keys(TRACKED_ROLES));
    const lastOf = db.prepare('SELECT lat, lng, accuracy, kind, label, created_at AS at FROM staff_locations WHERE user_id = ? ORDER BY id DESC LIMIT 1');
    const freshMs = LIVE_FRESH_MINUTES * 60_000;
    return {
        people: users.map((u) => {
            const last = lastOf.get(u.id) || null;
            const age = last ? Date.now() - Date.parse(last.at.replace(' ', 'T') + 'Z') : Infinity;
            const state = !u.on_shift_since ? 'off' : age <= freshMs ? 'live' : 'quiet';
            return { id: u.id, name: u.display_name, role: u.role, role_label: TRACKED_ROLES[u.role], consent: Boolean(u.location_consent_at),
                on_shift_since: u.on_shift_since || null, state, last: last && { ...last, kind_label: KINDS[last.kind] || last.kind } };
        }),
        kinds: KINDS,
        retention_days: RETENTION_DAYS,
        maps_key: String(process.env.GOOGLE_MAPS_API_KEY || '').trim() || null
    };
}

/* One person's day (Muscat time): every place in order, for the path and its stops */
function day(db, userId, date) {
    ensureTable(db);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : leads.localToday();
    const u = row(db, userId);
    if (!u || !TRACKED_ROLES[u.role]) throw err(404, 'الموظف غير موجود');
    const points = db.prepare(`SELECT lat, lng, accuracy, kind, label, created_at AS at FROM staff_locations
                               WHERE user_id = ? AND date(created_at, '${TZ}') = ? ORDER BY id LIMIT 3000`).all(u.id, d);
    return { user: { id: u.id, name: u.display_name, role: u.role, role_label: TRACKED_ROLES[u.role] }, date: d,
        points: points.map((p) => ({ ...p, kind_label: KINDS[p.kind] || p.kind })) };
}

/* Older than 30 days: deleted (run with the daily clean-up) */
function prune(db) {
    ensureTable(db);
    return Number(db.prepare("DELETE FROM staff_locations WHERE created_at < datetime('now', ?)").run(`-${RETENTION_DAYS} days`).changes);
}

module.exports = { TRACKED_ROLES, KINDS, RETENTION_DAYS, ensureTable, mine, shift, record, visit, overview, day, prune };
