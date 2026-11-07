/* =============================================================
   A copy of the daily backup outside the server, by email.
   The backups in data/backups sit on the same server as the database:
   if the hosting account is lost, both are lost. With these variables
   set, one Excel backup a day is emailed to BACKUP_EMAIL_TO:
     SMTP_HOST, SMTP_PORT (465 = SSL, 587 = STARTTLS), SMTP_USER, SMTP_PASS,
     BACKUP_EMAIL_TO (one or more addresses, comma separated), SMTP_FROM (optional)
   e.g. a Hostinger mailbox: smtp.hostinger.com, port 465.
   - The connection is always encrypted (TLS); the certificate is checked.
   - The file has customer data and staff password hashes (never passwords,
     two-step secrets or environment secrets): send it to a private mailbox.
   - Every attempt is logged (offsite_backups) and shown in the admin panel;
     a failed send is retried every hour, and the system status warns.
   ============================================================= */
const backup = require('./backup');
const mailer = require('./mailer');
const alerts = require('./alerts');

const MAX_BYTES = 20 * 1024 * 1024; // most mail servers refuse larger attachments
const DAY_MS = 24 * 3600_000;

function config() {
    const to = String(process.env.BACKUP_EMAIL_TO || '').split(',').map((x) => x.trim()).filter(Boolean);
    return { ...mailer.config(), to };
}

const isConfigured = (c = config()) => mailer.isConfigured(c) && c.to.length > 0;
const setTransportForTests = mailer.setTransportForTests;

const logAttempt = (db, row) => db.prepare('INSERT INTO offsite_backups (file, bytes, ok, error, reason) VALUES (?, ?, ?, ?, ?)')
    .run(row.file || null, row.bytes || null, row.ok ? 1 : 0, row.error || null, row.reason || null);

/* Builds a fresh backup and emails it. Never throws: returns { ok, error? } and logs the attempt. */
async function sendBackup(db, { reason = 'daily' } = {}) {
    const c = config();
    if (!isConfigured(c)) {
        return { ok: false, error: 'الإرسال بالبريد غير مضبوط — أضف SMTP_HOST وSMTP_USER وSMTP_PASS وBACKUP_EMAIL_TO في متغيرات البيئة' };
    }
    const date = new Date().toISOString().slice(0, 10);
    const file = `radma-backup-${date}.xlsx`;
    let bytes = null;
    try {
        const content = await backup.exportWorkbook(db);
        bytes = content.length;
        if (bytes > MAX_BYTES) throw new Error(`حجم النسخة ${(bytes / 1048576).toFixed(1)} MB أكبر من حد البريد (20 MB)`);
        const settings = require('./db').getSettings(db);
        const counts = backup.TABLES.map(([table, label]) => {
            const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
            return `- ${label}: ${n}`;
        }).join('\n');
        await mailer.send({
            to: c.to.join(', '),
            subject: `نسخة احتياطية — ${settings.company_name || 'نظام التسعير'} — ${date}`,
            text: [
                'نسخة احتياطية تلقائية من نظام التسعير (ملف Excel مرفق).',
                '',
                'للاستعادة: لوحة الإدارة ← بوابات الشتر ← النسخ الاحتياطي ← «استعادة من ملف…».',
                'الملف حساس: فيه بيانات العملاء وتجزئات كلمات مرور الموظفين — لا تعِد إرساله لأحد.',
                '',
                'محتوى النسخة:',
                counts
            ].join('\n'),
            attachments: [{ filename: file, content, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }]
        });
        logAttempt(db, { file, bytes, ok: true, reason });
        alerts.ok(db, 'backup_offsite');
        return { ok: true, file, bytes, to: c.to };
    } catch (err) {
        // The mail server's answer, without the password (nodemailer never includes it)
        const error = String(err && err.message || err).slice(0, 300);
        logAttempt(db, { file, bytes, ok: false, error, reason });
        alerts.fail(db, 'backup_offsite', error);
        console.error('[offsite-backup]', error);
        return { ok: false, error };
    }
}

function status(db) {
    const c = config();
    const last = db.prepare('SELECT * FROM offsite_backups ORDER BY id DESC LIMIT 1').get() || null;
    const lastOk = db.prepare('SELECT * FROM offsite_backups WHERE ok = 1 ORDER BY id DESC LIMIT 1').get() || null;
    return {
        configured: isConfigured(c),
        host: c.host || null, port: c.port, to: c.to,
        last: last && { at: last.at, ok: Boolean(last.ok), error: last.error, file: last.file, bytes: last.bytes, reason: last.reason },
        last_ok_at: lastOk ? lastOk.at : null,
        history: db.prepare('SELECT at, ok, error, bytes, reason FROM offsite_backups ORDER BY id DESC LIMIT 10').all()
            .map((r) => ({ ...r, ok: Boolean(r.ok) }))
    };
}

/* For the system status: null when all is well */
function warning(db) {
    if (!isConfigured()) {
        return { level: 'warning', text: 'النسخ الاحتياطية محفوظة على نفس الخادم فقط — إذا فُقد حساب الاستضافة تضيع معها. اضبط إرسال نسخة يومية بالبريد (SMTP_HOST وSMTP_USER وSMTP_PASS وBACKUP_EMAIL_TO).' };
    }
    const s = status(db);
    const age = s.last_ok_at ? Date.now() - Date.parse(s.last_ok_at.replace(' ', 'T') + 'Z') : Infinity;
    if (s.last && !s.last.ok && age > 2 * DAY_MS) {
        return { level: 'danger', text: `تعذر إرسال النسخة الاحتياطية بالبريد منذ أكثر من يومين: ${s.last.error}` };
    }
    return null;
}

/* Hourly check: one successful copy a day; after a failure, try again the next hour */
function scheduleDaily(db) {
    const run = () => {
        if (!isConfigured()) return;
        const lastOk = db.prepare("SELECT 1 FROM offsite_backups WHERE ok = 1 AND at > datetime('now', '-23 hours')").get();
        const recentTry = db.prepare("SELECT 1 FROM offsite_backups WHERE at > datetime('now', '-55 minutes')").get();
        if (!lastOk && !recentTry) sendBackup(db, { reason: 'daily' }).catch(() => {});
    };
    setTimeout(run, 60_000).unref(); // shortly after start, once the server is up
    setInterval(run, 3600_000).unref();
}

module.exports = { config, isConfigured, sendBackup, status, warning, scheduleDaily, setTransportForTests, MAX_BYTES };
