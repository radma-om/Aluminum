/* =============================================================
   Notices from the manager to everyone who uses the panel (staff and
   technicians), and the app's version history.
   Kinds:
   - info:        a message, shown as a bar until the user closes it;
   - update:      «a new version is available» — a bar with «حدّث الآن»;
   - force:       a forced update — the panel is covered until the user
                  presses «حدّث الآن» (once per device);
   - maintenance: the app is stopped for staff (e.g. during a deploy or a
                  data fix) — covered until the manager ends it.
                  Managers are not blocked, so one of them can end it.
   Each new notice is also pushed (🔔) to every signed-up device.
   The app also finds a new version by itself: the page knows the version
   it was loaded with and compares it with the server's.
   ============================================================= */
const KINDS = { info: 'إشعار عام', update: 'تحديث متاح', force: 'تحديث إجباري', maintenance: 'إيقاف التطبيق مؤقتاً (صيانة)' };
const ENDS = new Set(['force', 'maintenance']); // stay until the manager ends them
const SHOW_DAYS = 7;                            // info / update notices are shown for a week
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const err = (status, message) => Object.assign(new Error(message), { status });

function ensureTable(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS app_notices (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        kind        TEXT NOT NULL,
        title       TEXT NOT NULL,
        body        TEXT,
        version     TEXT,
        active      INTEGER NOT NULL DEFAULT 1,
        created_by  TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at    TEXT,
        ended_by    TEXT
    )`);
}

const view = (r) => ({ ...r, active: Boolean(r.active), kind_label: KINDS[r.kind] || r.kind });

function create(db, input, author, version) {
    ensureTable(db);
    const kind = KINDS[input.kind] ? input.kind : null;
    if (!kind) throw err(400, 'اختر نوع الإشعار');
    const title = clip(input.title, 120) || KINDS[kind];
    const body = clip(input.body, 1000) || null;
    // One forced update / one stop at a time: a new one replaces the previous
    if (ENDS.has(kind)) {
        db.prepare("UPDATE app_notices SET active = 0, ended_at = datetime('now'), ended_by = ? WHERE kind = ? AND active = 1").run(author, kind);
    }
    const info = db.prepare('INSERT INTO app_notices (kind, title, body, version, created_by) VALUES (?, ?, ?, ?, ?)')
        .run(kind, title, body, version, author);
    return view(db.prepare('SELECT * FROM app_notices WHERE id = ?').get(info.lastInsertRowid));
}

function end(db, id, author) {
    ensureTable(db);
    const row = db.prepare('SELECT * FROM app_notices WHERE id = ?').get(Number(id));
    if (!row) throw err(404, 'الإشعار غير موجود');
    if (row.active) db.prepare("UPDATE app_notices SET active = 0, ended_at = datetime('now'), ended_by = ? WHERE id = ?").run(author, row.id);
    return view(db.prepare('SELECT * FROM app_notices WHERE id = ?').get(row.id));
}

function list(db, limit = 30) {
    ensureTable(db);
    return db.prepare('SELECT * FROM app_notices ORDER BY id DESC LIMIT ?').all(Math.min(100, Number(limit) || 30)).map(view);
}

/* What the panel shows now: forced update / stop while active, info / update for a week */
function current(db) {
    ensureTable(db);
    return db.prepare(`SELECT * FROM app_notices WHERE active = 1
                       AND (kind IN ('force', 'maintenance') OR created_at >= datetime('now', ?))
                       ORDER BY id DESC`).all(`-${SHOW_DAYS} days`).map(view);
}

/* The notification on the phones (🔔) */
function pushMessage(n) {
    const lead = { info: '🔔', update: '🆕', force: '⚠️', maintenance: '⛔' }[n.kind] || '🔔';
    return { title: `${lead} ${n.title}`.slice(0, 80), body: n.body || KINDS[n.kind], url: '/admin', tag: `app-notice-${n.kind}` };
}

module.exports = { KINDS, create, end, list, current, pushMessage, ensureTable };
