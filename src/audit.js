/* =============================================================
   Activity log: who changed what in the admin panel, and when.
   - Every successful change (POST / PUT / PATCH / DELETE) through the
     admin API is recorded with the account, its address and the time.
   - For edits of one record (a product, a wilayah, the settings…) the
     fields that changed are kept as "before → after"; for deletions the
     deleted record; for anything else the request (shortened).
   - Sign-ins, failed sign-ins and backup downloads are recorded too.
   - Passwords, secrets, tokens and codes are never stored (shown as ***).
   - Kept 365 days. Only managers can read it.
   ============================================================= */

const RETENTION_DAYS = 365;
const SENSITIVE = /pass|secret|token|api_?key|^code$|totp|hash|access_key/i;

/* Records whose "before" is read so the log can show exactly what changed */
const RECORDS = [
    [/^\/products\/(\d+)$/, 'products'],
    [/^\/purchases\/(\d+)$/, 'purchases'],
    [/^\/regions\/(\d+)$/, 'regions'],
    [/^\/governorates\/(\d+)$/, 'governorates'],
    [/^\/shutter-types\/(\d+)$/, 'shutter_types'],
    [/^\/accessory-groups\/(\d+)$/, 'accessory_groups'],
    [/^\/knowledge\/(\d+)$/, 'knowledge_items'],
    [/^\/users\/(\d+)$/, 'staff_users'],
    [/^\/webhooks\/(\d+)$/, 'webhooks'],
    [/^\/quotes\/(\d+)$/, 'quotes'],
    [/^\/leads\/(\d+)$/, 'leads']
];

const LABELS = [
    ['POST', /^\/products$/, 'إضافة منتج'], ['PUT', /^\/products\/\d+$/, 'تعديل منتج'], ['DELETE', /^\/products\/\d+$/, 'حذف منتج'],
    ['POST', /^\/purchases$/, 'تسجيل سعر شراء'], ['DELETE', /^\/purchases\/\d+$/, 'حذف سعر شراء'],
    ['PUT', /^\/settings$/, 'تعديل الإعدادات'],
    ['POST', /^\/regions$/, 'إضافة ولاية'], ['PUT', /^\/regions\/\d+$/, 'تعديل ولاية'],
    ['PUT', /^\/governorates\/\d+$/, 'تعديل محافظة'],
    ['POST', /^\/shutter-types$/, 'إضافة نوع بوابة شتر'], ['PUT', /^\/shutter-types\/\d+$/, 'تعديل نوع بوابة شتر'], ['DELETE', /^\/shutter-types\/\d+$/, 'حذف نوع بوابة شتر'],
    ['POST', /^\/accessory-groups$/, 'إضافة مجموعة إكسسوارات'], ['PUT', /^\/accessory-groups\/\d+$/, 'تعديل مجموعة إكسسوارات'], ['DELETE', /^\/accessory-groups\/\d+$/, 'حذف مجموعة إكسسوارات'],
    ['PUT', /^\/overhead$/, 'تعديل بوابات الأوفرهيد'],
    ['PUT', /^\/motors$/, 'تعديل مكائن البوابات'], ['PUT', /^\/motors\/sections$/, 'تعديل أقسام المكائن'], ['POST', /^\/motors\/copy-installation$/, 'نسخ رسوم تركيب المكائن'],
    ['POST', /^\/knowledge$/, 'إضافة إلى قاعدة المعرفة'], ['POST', /^\/knowledge\/upload$/, 'رفع ملف إلى قاعدة المعرفة'],
    ['PUT', /^\/knowledge\/\d+$/, 'تعديل قاعدة المعرفة'], ['DELETE', /^\/knowledge\/\d+$/, 'حذف من قاعدة المعرفة'],
    ['PUT', /^\/mazbot\/agent$/, 'إعدادات المساعد على واتساب'], ['POST', /^\/mazbot\/test$/, 'إرسال رسالة تجربة عبر MazBot'],
    ['DELETE', /^\/mazbot\/pauses$/, 'إعادة تشغيل المساعد لكل العملاء'], ['POST', /^\/agent\/reset$/, 'مسح محادثة تجربة المساعد'],
    ['PATCH', /^\/quotes\/\d+$/, 'تغيير حالة عرض سعر'],
    ['PATCH', /^\/leads\/\d+$/, 'تعديل بيانات عميل'], ['POST', /^\/leads\/\d+\/notes$/, 'إضافة تقرير متابعة'],
    ['POST', /^\/leads\/\d+\/reply$/, 'رد على عميل'], ['DELETE', /^\/leads\/\d+\/pause$/, 'إعادة تشغيل المساعد لعميل'],
    ['POST', /^\/users$/, 'إضافة حساب موظف'], ['PUT', /^\/users\/\d+$/, 'تعديل حساب موظف'], ['DELETE', /^\/users\/\d+$/, 'حذف حساب موظف'],
    ['POST', /^\/webhooks$/, 'إضافة Webhook'], ['PUT', /^\/webhooks\/\d+$/, 'تعديل Webhook'], ['DELETE', /^\/webhooks\/\d+$/, 'حذف Webhook'], ['POST', /^\/webhooks\/\d+\/test$/, 'تجربة Webhook'],
    ['POST', /^\/restore$/, 'استعادة نسخة احتياطية من ملف'], ['POST', /^\/backups\/[^/]+\/restore$/, 'استعادة نسخة احتياطية محفوظة'],
    ['POST', /^\/offsite-backup$/, 'إرسال نسخة احتياطية بالبريد'],
    ['POST', /^\/alerts\/test$/, 'إرسال تنبيه أعطال تجريبي'],
    ['GET', /^\/backup\.xlsx$/, 'تنزيل نسخة احتياطية'], ['GET', /^\/backups\/[^/]+\.xlsx$/, 'تنزيل نسخة احتياطية محفوظة'],
    ['POST', /^\/me\/password$/, 'تغيير كلمة المرور'],
    ['POST', /^\/me\/2fa\/enable$/, 'تفعيل التحقق بخطوتين'], ['POST', /^\/me\/2fa\/disable$/, 'إيقاف التحقق بخطوتين']
];

/* Not changes: tests and previews that write nothing that matters */
const SKIP = [/^\/agent\/chat$/, /^\/mazbot\/diagnose\/simulate$/, /^\/me\/2fa\/setup$/];

const labelFor = (method, path) => (LABELS.find(([m, re]) => m === method && re.test(path)) || [])[2] || null;

const actorOf = (user) => (user.owner ? 'المدير العام (كلمة مرور الإدارة)' : `${user.display_name} (${user.username})`);

/* A copy safe to keep: no secrets, no file contents, long text shortened */
function sanitize(value, depth = 0) {
    if (value == null) return value;
    if (Buffer.isBuffer(value)) return `[ملف ${value.length} بايت]`;
    if (typeof value === 'string') return value.length > 300 ? value.slice(0, 300) + '…' : value;
    if (typeof value !== 'object') return value;
    if (depth > 4) return '…';
    if (Array.isArray(value)) {
        const items = value.slice(0, 30).map((v) => sanitize(v, depth + 1));
        if (value.length > 30) items.push(`… و${value.length - 30} عنصر آخر`);
        return items;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? (v ? '***' : v) : sanitize(v, depth + 1);
    return out;
}

/* Only the fields that changed: { field: [before, after] } */
function diff(before, after) {
    const out = {};
    const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
    for (const k of keys) {
        const a = JSON.stringify((before || {})[k]);
        const b = JSON.stringify((after || {})[k]);
        if (a !== b) out[k] = SENSITIVE.test(k) ? ['***', '***'] : [sanitize((before || {})[k]), sanitize((after || {})[k])];
    }
    return out;
}

function record(db, { user_id = null, actor, ip = null, action, method = null, path = null, details = null }) {
    try {
        let json = details == null ? null : JSON.stringify(details);
        if (json && json.length > 20_000) json = JSON.stringify({ note: 'التفاصيل طويلة جداً — اختُصرت', start: json.slice(0, 4000) });
        db.prepare('INSERT INTO audit_log (user_id, actor, ip, action, method, path, details_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(user_id, String(actor || '—').slice(0, 120), ip ? String(ip).replace(/^::ffff:/, '') : null, String(action).slice(0, 200),
                method, path ? String(path).slice(0, 200) : null, json);
    } catch (err) {
        console.error('[audit]', err.message); // the log must never break the action itself
    }
}

/* Express middleware for the admin router (after sign-in): records every successful change */
function middleware(db, { getSettings }) {
    const readRow = (table, id) => {
        const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(id));
        return row ? { ...row } : null;
    };
    return (req, res, next) => {
        const path = req.path.replace(/\/+$/, '') || '/';
        const label = labelFor(req.method, path);
        if ((req.method === 'GET' && !label) || SKIP.some((re) => re.test(path))) return next();

        // "Before" for edits and deletions of one record, and for the settings
        let snapshot = null;
        const rec = RECORDS.find(([re]) => re.test(path));
        if (rec && ['PUT', 'PATCH', 'DELETE'].includes(req.method)) {
            const id = rec[0].exec(path)[1];
            snapshot = { table: rec[1], id, before: readRow(rec[1], id) };
        } else if (req.method === 'PUT' && path === '/settings') {
            snapshot = { settings: true, before: getSettings(db) };
        }

        let created = null;
        const json = res.json.bind(res);
        res.json = (body) => {
            if (req.method === 'POST' && body && typeof body === 'object' && body.id) created = { id: body.id };
            return json(body);
        };

        res.on('finish', () => {
            if (res.statusCode >= 400) return; // refused or failed: nothing changed
            let details;
            if (snapshot && snapshot.settings) details = { changes: diff(snapshot.before, getSettings(db)) };
            else if (snapshot && req.method === 'DELETE') details = { deleted: sanitize(snapshot.before) };
            else if (snapshot) details = { record: Number(snapshot.id), changes: diff(snapshot.before, readRow(snapshot.table, snapshot.id)) };
            else if (req.method === 'GET' || path.startsWith('/me/')) details = null; // own password / two-step: nothing worth keeping
            else details = { request: sanitize(req.body), ...(created ? { created } : {}) };
            if (details && details.changes && !Object.keys(details.changes).length && path === '/settings') return; // saved unchanged
            record(db, {
                user_id: req.user.id || null, actor: actorOf(req.user), ip: req.ip,
                action: label || `${req.method} ${path}`, method: req.method, path, details
            });
        });
        next();
    };
}

function list(db, { q = '', user = '', from = '', to = '', before_id = 0, limit = 50 } = {}) {
    const where = [];
    const args = [];
    if (q) { where.push('(action LIKE ? OR actor LIKE ? OR details_json LIKE ? OR path LIKE ?)'); const like = `%${String(q).slice(0, 100)}%`; args.push(like, like, like, like); }
    if (user) { where.push('actor LIKE ?'); args.push(`%${String(user).slice(0, 80)}%`); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { where.push('at >= ?'); args.push(from); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) { where.push("at < date(?, '+1 day')"); args.push(to); }
    if (Number(before_id) > 0) { where.push('id < ?'); args.push(Number(before_id)); }
    const n = Math.min(200, Math.max(1, Number(limit) || 50));
    const rows = db.prepare(`SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...args, n + 1);
    return {
        entries: rows.slice(0, n).map((r) => ({ ...r, details: r.details_json ? JSON.parse(r.details_json) : null, details_json: undefined })),
        more: rows.length > n
    };
}

const prune = (db) => Number(db.prepare(`DELETE FROM audit_log WHERE at < datetime('now', '-${RETENTION_DAYS} days')`).run().changes);

module.exports = { record, middleware, list, prune, sanitize, diff, labelFor, actorOf, RETENTION_DAYS };
