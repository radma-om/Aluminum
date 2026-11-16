/* =============================================================
   Petty cash (العهدة): money an employee or technician holds for work
   expenses — like a cash book.
   - استلام: the office hands over an amount (recorded by a manager, or a
     request the manager approves) → the balance goes up.
   - صرف: the employee spends from it (petrol, food, tools, parts…), with
     a category, details and optionally a photo of the receipt → down.
   - استلمت مبلغ: the employee records money received (from the office or
     a customer, said in the details) → up at once; the managers are told.
   - إرجاع مبلغ للمكتب: cash given back to the office → down, but only once a
     manager confirms receiving it (until then it is «بانتظار تأكيد المدير»
     and does not count). One recorded by a manager counts at once.
   - طلب مبلغ: the employee asks for money; the manager approves it (it
     becomes a «استلام», possibly for another amount) or declines it.
   - Each employee has a lowest balance (their own, or the general one; 0 =
     no warning for them): below it, the managers are told and the panel
     shows a warning. An employee who never had petty cash is never warned.
   Entries are never edited; a manager can cancel one (with the reason),
   and it stays in the book, struck through.
   ============================================================= */
const KINDS = { receive: 'استلام', expense: 'صرف', return: 'إرجاع مبلغ للمكتب' };
const SIGN = { receive: 1, expense: -1, return: -1 };
const DEFAULT_CATEGORIES = ['بترول', 'أكل', 'أدوات', 'منتجات وقطع', 'مواصلات', 'أخرى'];
const MAX_AMOUNT = 10000;
const MAX_RECEIPT = 1_500_000; // bytes, after the phone shrinks the photo

const err = (status, message) => Object.assign(new Error(message), { status });
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const round3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const money = (n) => Number(n || 0).toFixed(2);

function ensureTables(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS wallet_entries (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id      INTEGER NOT NULL,
            kind         TEXT NOT NULL CHECK (kind IN ('receive', 'expense', 'return')),
            amount       REAL NOT NULL CHECK (amount > 0),
            category     TEXT,
            details      TEXT,
            occurred_on  TEXT NOT NULL,
            request_id   INTEGER,
            has_receipt  INTEGER NOT NULL DEFAULT 0,
            created_by   TEXT,
            created_at   TEXT NOT NULL DEFAULT (datetime('now')),
            cancelled_at TEXT,
            cancelled_by TEXT,
            cancel_reason TEXT
        );
        CREATE INDEX IF NOT EXISTS wallet_entries_user ON wallet_entries (user_id, id);
        CREATE TABLE IF NOT EXISTS wallet_receipts (
            entry_id INTEGER PRIMARY KEY,
            mime     TEXT NOT NULL,
            data     BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS wallet_requests (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER NOT NULL,
            amount      REAL NOT NULL CHECK (amount > 0),
            reason      TEXT,
            status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
            decided_by  TEXT,
            decided_at  TEXT,
            note        TEXT,
            entry_id    INTEGER,
            created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
    `);
    const cols = db.prepare('PRAGMA table_info(staff_users)').all().map((c) => c.name);
    if (!cols.includes('wallet_min')) db.exec('ALTER TABLE staff_users ADD COLUMN wallet_min REAL');
    // A return the manager has not yet confirmed: pending = 1, not counted in the balance
    const ecols = db.prepare('PRAGMA table_info(wallet_entries)').all().map((c) => c.name);
    if (!ecols.includes('pending')) db.exec('ALTER TABLE wallet_entries ADD COLUMN pending INTEGER NOT NULL DEFAULT 0');
    if (!ecols.includes('confirmed_by')) db.exec('ALTER TABLE wallet_entries ADD COLUMN confirmed_by TEXT');
    if (!ecols.includes('confirmed_at')) db.exec('ALTER TABLE wallet_entries ADD COLUMN confirmed_at TEXT');
}

const localNow = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');

function account(db, userId) {
    const u = db.prepare('SELECT id, display_name, role, active, wallet_min FROM staff_users WHERE id = ?').get(Number(userId));
    if (!u) throw err(404, 'الموظف غير موجود');
    return u;
}

function balanceOf(db, userId) {
    ensureTables(db);
    const r = db.prepare(`SELECT IFNULL(SUM(CASE kind WHEN 'receive' THEN amount ELSE -amount END), 0) AS b
                          FROM wallet_entries WHERE user_id = ? AND cancelled_at IS NULL AND pending = 0`).get(Number(userId));
    return round3(r.b);
}

/* The lowest balance before the managers are warned: the employee's own, or the general one (0 = none).
   Only for an account that uses petty cash — it has entries, or the manager gave it a limit of its own:
   others are not warned at all. */
const lowFor = (min, balance, used) => used && min > 0 && balance < min;
/* The lowest balance before the managers are warned: the employee's own, or the general one (0 = none) */
const minOf = (u, settings) => (u.wallet_min != null ? Number(u.wallet_min) : Number(settings.wallet_min_default) || 0);

function categories(settings) {
    const list = Array.isArray(settings.wallet_categories) ? settings.wallet_categories.map((c) => clip(c, 40)).filter(Boolean) : [];
    return list.length ? list : DEFAULT_CATEGORIES;
}

const view = (e) => ({ ...e, kind_label: KINDS[e.kind] || e.kind, signed: round3((SIGN[e.kind] || 0) * e.amount), cancelled: Boolean(e.cancelled_at), pending: Boolean(e.pending) && !e.cancelled_at, has_receipt: Boolean(e.has_receipt) });

/* One employee's book: the entries (newest first) with the balance after each, and the requests */
function book(db, userId, settings, { limit = 200 } = {}) {
    ensureTables(db);
    const u = account(db, userId);
    const all = db.prepare('SELECT * FROM wallet_entries WHERE user_id = ? ORDER BY occurred_on, id').all(u.id);
    let running = 0;
    const entries = all.map((e) => {
        if (!e.cancelled_at && !e.pending) running = round3(running + SIGN[e.kind] * e.amount);
        return { ...view(e), balance_after: running };
    }).reverse().slice(0, limit);
    const month = localNow().slice(0, 7);
    const spentMonth = round3(all.filter((e) => !e.cancelled_at && !e.pending && e.kind === 'expense' && e.occurred_on.slice(0, 7) === month).reduce((s, e) => s + e.amount, 0));
    const min = minOf(u, settings);
    return {
        user: { id: u.id, name: u.display_name, role: u.role, active: Boolean(u.active) },
        balance: running, min, pending_return: round3(all.filter((e) => e.pending && !e.cancelled_at).reduce((s, e) => s + e.amount, 0)), low: lowFor(min, running, all.length > 0 || Number(u.wallet_min) > 0), spent_this_month: spentMonth,
        entries,
        requests: db.prepare('SELECT * FROM wallet_requests WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(u.id),
        categories: categories(settings)
    };
}

/* Every account (managers' view): balance, lowest balance, last entry, open requests */
function overview(db, settings) {
    ensureTables(db);
    const users = db.prepare("SELECT id, display_name, role, active, wallet_min FROM staff_users ORDER BY active DESC, role = 'technician' DESC, display_name").all();
    const rows = users.map((u) => {
        const balance = balanceOf(db, u.id);
        const last = db.prepare('SELECT kind, amount, occurred_on, category, details FROM wallet_entries WHERE user_id = ? AND cancelled_at IS NULL AND pending = 0 ORDER BY occurred_on DESC, id DESC LIMIT 1').get(u.id);
        const count = db.prepare('SELECT COUNT(*) AS n FROM wallet_entries WHERE user_id = ?').get(u.id).n;
        const pending = db.prepare("SELECT COUNT(*) AS n FROM wallet_requests WHERE user_id = ? AND status = 'pending'").get(u.id).n
            + db.prepare('SELECT COUNT(*) AS n FROM wallet_entries WHERE user_id = ? AND pending = 1 AND cancelled_at IS NULL').get(u.id).n;
        const min = minOf(u, settings);
        return { id: u.id, name: u.display_name, role: u.role, active: Boolean(u.active), balance, min, own_min: u.wallet_min, low: lowFor(min, balance, count > 0 || Number(u.wallet_min) > 0),
            last: last ? { ...last, kind_label: KINDS[last.kind] } : null, entries: count, pending };
    }).filter((r) => r.active || r.entries || r.balance);
    const requests = db.prepare(`SELECT r.*, u.display_name AS name FROM wallet_requests r JOIN staff_users u ON u.id = r.user_id
                                 WHERE r.status = 'pending' ORDER BY r.id`).all();
    const returns = db.prepare(`SELECT e.*, u.display_name AS name FROM wallet_entries e JOIN staff_users u ON u.id = e.user_id
                                WHERE e.pending = 1 AND e.cancelled_at IS NULL ORDER BY e.id`).all().map((e) => ({ ...view(e), name: e.name }));
    return {
        accounts: rows, requests, returns,
        total_out: round3(rows.reduce((s, r) => s + Math.max(0, r.balance), 0)),
        min_default: Number(settings.wallet_min_default) || 0,
        categories: categories(settings)
    };
}

/* Low balances, for the warning at the top of the managers' panel */
function lowAccounts(db, settings) {
    return overview(db, settings).accounts.filter((a) => a.active && a.low);
}

function cleanAmount(v) {
    const n = round3(Number(v));
    if (!(n > 0 && n <= MAX_AMOUNT)) throw err(400, 'اكتب المبلغ (أكبر من صفر)');
    return n;
}
function cleanDay(v) {
    if (!v) return localNow();
    const s = String(v).replace('T', ' ').slice(0, 16);
    if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(s) || Number.isNaN(Date.parse(s.slice(0, 10) + 'T00:00:00Z'))) throw err(400, 'التاريخ غير صالح');
    if (s.slice(0, 10) > localNow().slice(0, 10)) throw err(400, 'التاريخ في المستقبل');
    return s.length === 10 ? s + ' 00:00' : s;
}

/**
 * A new entry. kind: receive | expense | return. The employee's own «receive» needs its source
 * (details); their own «return» waits for a manager's confirmation (pending).
 * Returns { entry, balance, before, crossed } — crossed: the balance just went below the lowest allowed.
 */
function add(db, userId, input, actor, settings) {
    ensureTables(db);
    const u = account(db, userId);
    const kind = KINDS[input.kind] ? input.kind : null;
    if (!kind) throw err(400, 'نوع العملية غير صالح');
    const self = Number(actor.id) === u.id;
    if (!actor.manager && !self) throw err(403, 'العهدة لصاحبها والإدارة');
    const amount = cleanAmount(input.amount);
    const category = kind === 'expense' ? clip(input.category, 40) || 'أخرى' : null;
    const details = clip(input.details, 500) || null;
    if (kind === 'expense' && !details && category === 'أخرى') throw err(400, 'اكتب تفاصيل الصرف');
    if (kind === 'receive' && !actor.manager && !details) throw err(400, 'اكتب ممن استلمت المبلغ (مثلاً: من المدير، أو من العميل فلان)');
    // A manager confirms a return when they record it themselves
    const pending = kind === 'return' && !actor.manager ? 1 : 0;
    const before = balanceOf(db, u.id);
    const info = db.prepare(`INSERT INTO wallet_entries (user_id, kind, amount, category, details, occurred_on, request_id, created_by, pending,
                                                         confirmed_by, confirmed_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END)`)
        .run(u.id, kind, amount, category, details, cleanDay(input.occurred_on), input.request_id || null, actor.name, pending,
            kind === 'return' && !pending ? actor.name : null, kind === 'return' && !pending ? actor.name : null);
    const entry = view(db.prepare('SELECT * FROM wallet_entries WHERE id = ?').get(info.lastInsertRowid));
    const balance = balanceOf(db, u.id);
    const min = minOf(u, settings);
    return { entry, balance, before, min, crossed: min > 0 && before >= min && balance < min, user: u };
}

/* A manager confirms receiving the cash of a pending return: it now counts in the balance */
function confirm(db, entryId, actor, settings) {
    ensureTables(db);
    const e = db.prepare('SELECT * FROM wallet_entries WHERE id = ?').get(Number(entryId));
    if (!e) throw err(404, 'العملية غير موجودة');
    if (e.cancelled_at) throw err(400, 'العملية ملغاة');
    if (!e.pending) throw err(400, 'العملية مؤكدة من قبل');
    const u = account(db, e.user_id);
    const before = balanceOf(db, u.id);
    db.prepare("UPDATE wallet_entries SET pending = 0, confirmed_by = ?, confirmed_at = datetime('now') WHERE id = ?").run(actor.name, e.id);
    const balance = balanceOf(db, u.id);
    const min = minOf(u, settings);
    return { entry: view(db.prepare('SELECT * FROM wallet_entries WHERE id = ?').get(e.id)), balance, before, min, crossed: min > 0 && before >= min && balance < min, user: u };
}

function cancel(db, entryId, reason, actor) {
    ensureTables(db);
    const e = db.prepare('SELECT * FROM wallet_entries WHERE id = ?').get(Number(entryId));
    if (!e) throw err(404, 'العملية غير موجودة');
    if (e.cancelled_at) throw err(400, 'العملية ملغاة من قبل');
    const why = clip(reason, 300);
    if (!why) throw err(400, 'اكتب سبب الإلغاء');
    db.prepare("UPDATE wallet_entries SET cancelled_at = datetime('now'), cancelled_by = ?, cancel_reason = ? WHERE id = ?").run(actor.name, why, e.id);
    return view(db.prepare('SELECT * FROM wallet_entries WHERE id = ?').get(e.id));
}

function entry(db, id) {
    ensureTables(db);
    const e = db.prepare('SELECT * FROM wallet_entries WHERE id = ?').get(Number(id));
    return e ? view(e) : null;
}

function saveReceipt(db, entryId, mime, data) {
    if (!/^image\/(jpeg|png|webp)$/.test(String(mime))) throw err(400, 'الصورة يجب أن تكون JPEG أو PNG');
    if (!data || !data.length) throw err(400, 'الصورة فارغة');
    if (data.length > MAX_RECEIPT) throw err(400, 'الصورة كبيرة جداً');
    db.prepare('INSERT OR REPLACE INTO wallet_receipts (entry_id, mime, data) VALUES (?, ?, ?)').run(Number(entryId), mime, data);
    db.prepare('UPDATE wallet_entries SET has_receipt = 1 WHERE id = ?').run(Number(entryId));
}
const receipt = (db, entryId) => db.prepare('SELECT mime, data FROM wallet_receipts WHERE entry_id = ?').get(Number(entryId)) || null;

/* ------------------------------ Requests ------------------------------ */

function request(db, userId, input) {
    ensureTables(db);
    const u = account(db, userId);
    const amount = cleanAmount(input.amount);
    const reason = clip(input.reason, 300);
    if (!reason) throw err(400, 'اكتب سبب الطلب (مثلاً: بترول ومواد لأعمال الأسبوع)');
    if (db.prepare("SELECT COUNT(*) AS n FROM wallet_requests WHERE user_id = ? AND status = 'pending'").get(u.id).n >= 3) {
        throw err(400, 'لديك طلبات بانتظار رد الإدارة');
    }
    const info = db.prepare('INSERT INTO wallet_requests (user_id, amount, reason) VALUES (?, ?, ?)').run(u.id, amount, reason);
    return { request: db.prepare('SELECT * FROM wallet_requests WHERE id = ?').get(info.lastInsertRowid), user: u };
}

/* The manager decides: approved → a «استلام» of the amount given (it may differ from the one asked) */
function decide(db, requestId, { approve, amount, note }, actor, settings) {
    ensureTables(db);
    const r = db.prepare('SELECT * FROM wallet_requests WHERE id = ?').get(Number(requestId));
    if (!r) throw err(404, 'الطلب غير موجود');
    if (r.status !== 'pending') throw err(400, 'تم الرد على هذا الطلب من قبل');
    const text = clip(note, 300) || null;
    if (!approve) {
        db.prepare("UPDATE wallet_requests SET status = 'declined', decided_by = ?, decided_at = datetime('now'), note = ? WHERE id = ?").run(actor.name, text, r.id);
        return { request: db.prepare('SELECT * FROM wallet_requests WHERE id = ?').get(r.id), added: null };
    }
    const given = amount === undefined || amount === null || amount === '' ? r.amount : cleanAmount(amount);
    const added = add(db, r.user_id, { kind: 'receive', amount: given, details: `طلب: ${r.reason}${text ? ` — ${text}` : ''}`, request_id: r.id }, actor, settings);
    db.prepare("UPDATE wallet_requests SET status = 'approved', decided_by = ?, decided_at = datetime('now'), note = ?, entry_id = ? WHERE id = ?")
        .run(actor.name, text, added.entry.id, r.id);
    return { request: db.prepare('SELECT * FROM wallet_requests WHERE id = ?').get(r.id), added };
}

function setMin(db, userId, value) {
    ensureTables(db);
    account(db, userId);
    const v = value === null || value === undefined || value === '' ? null : Number(value);
    if (v !== null && !(v >= 0 && v <= MAX_AMOUNT)) throw err(400, 'الحد غير صالح');
    db.prepare('UPDATE staff_users SET wallet_min = ? WHERE id = ?').run(v, Number(userId));
}

module.exports = {
    KINDS, DEFAULT_CATEGORIES, ensureTables, balanceOf, book, overview, lowAccounts, add, cancel, entry,
    saveReceipt, receipt, request, decide, setMin, categories, money, confirm
};
