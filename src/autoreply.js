/* =============================================================
   Who the AI assistant does not answer on WhatsApp (agent_pauses).
   - 'auto':   a short pause the system sets by itself — the customer asked
               for a person, or an employee replied (PAUSE_HOURS); a later
               automatic pause only ever extends it.
   - 'manual': an employee switched the auto-reply off for this number,
               for good or until a date (a big customer followed in person,
               a supplier, a colleague…). Automatic pauses never shorten or
               replace it, and «resume all» leaves it alone.
   Messages from a stopped number are still kept in the customer follow-up.
   ============================================================= */
const PAUSE_HOURS = 12;
const FOREVER = '9999-12-31 23:59:59';

const err = (status, message) => Object.assign(new Error(message), { status });
const digits = (phone) => String(phone || '').replace(/\D/g, '');
const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function stateOf(db, phone) {
    const p = digits(phone);
    if (!p) return null;
    const row = db.prepare("SELECT * FROM agent_pauses WHERE phone = ? AND until > datetime('now')").get(p);
    return row ? { ...row, forever: row.until === FOREVER } : null;
}
const isStopped = (db, phone) => Boolean(stateOf(db, phone));

/* The automatic short pause: added or extended, never over a manual stop */
function pauseAuto(db, phone, hours = PAUSE_HOURS) {
    const p = digits(phone);
    if (!p) return;
    db.prepare(`INSERT INTO agent_pauses (phone, until, kind, created_at) VALUES (?, datetime('now', '+${Number(hours)} hours'), 'auto', ?)
                ON CONFLICT(phone) DO UPDATE SET until = excluded.until, kind = 'auto', reason = NULL, created_by = NULL, created_at = excluded.created_at
                WHERE agent_pauses.kind != 'manual' OR agent_pauses.until <= datetime('now')`).run(p, nowSql());
}

/**
 * An employee stops the auto-reply for a number.
 * until: null → for good; 'YYYY-MM-DD' → through that day (Muscat time, inclusive).
 */
function stop(db, phone, { until = null, reason = '', by = null } = {}) {
    const p = digits(phone);
    if (p.length < 8) throw err(400, 'رقم الجوال غير صالح');
    let untilSql = FOREVER;
    if (until) {
        const d = String(until).slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d + 'T00:00:00Z'))) throw err(400, 'التاريخ غير صالح');
        untilSql = `${d} 19:59:59`; // 23:59:59 in Muscat
        if (untilSql <= nowSql()) throw err(400, 'اختر تاريخاً قادماً');
    }
    db.prepare(`INSERT INTO agent_pauses (phone, until, kind, reason, created_by, created_at) VALUES (?, ?, 'manual', ?, ?, ?)
                ON CONFLICT(phone) DO UPDATE SET until = excluded.until, kind = 'manual', reason = excluded.reason,
                    created_by = excluded.created_by, created_at = excluded.created_at`)
        .run(p, untilSql, String(reason || '').trim().slice(0, 200) || null, by ? String(by).slice(0, 80) : null, nowSql());
    return stateOf(db, p);
}

const resume = (db, phone) => db.prepare('DELETE FROM agent_pauses WHERE phone = ?').run(digits(phone));
/* «Resume all»: the automatic pauses only — numbers switched off by hand stay off */
const resumeAllAuto = (db) => db.prepare("DELETE FROM agent_pauses WHERE kind != 'manual'").run();

/* Active stops, with the customer's name when known */
function list(db) {
    return db.prepare(`SELECT p.*, (SELECT name FROM leads WHERE phone = p.phone LIMIT 1) AS name,
                              (SELECT id FROM leads WHERE phone = p.phone LIMIT 1) AS lead_id
                       FROM agent_pauses p WHERE p.until > datetime('now')
                       ORDER BY p.kind = 'manual' DESC, p.until DESC`).all()
        .map((r) => ({ ...r, forever: r.until === FOREVER }));
}

module.exports = { stateOf, isStopped, pauseAuto, stop, resume, resumeAllAuto, list, PAUSE_HOURS, FOREVER };
