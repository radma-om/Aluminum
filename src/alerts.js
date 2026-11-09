/* =============================================================
   Failure alerts: an email to the manager when a part of the system
   keeps failing, and another when it works again.
   - Each part (the AI assistant, MazBot replies, sales alerts, webhooks,
     backups…) counts its failures in a time window; one blip is not an
     alert, a repeated failure is (THRESHOLDS below).
   - One email per fault, then quiet for 6 hours while it keeps failing
     (a reminder after that); "back to normal" once it succeeds again.
   - The state is kept in the database (survives restarts) and shown in
     the admin panel, so a fault is visible even if the email cannot leave.
   - Recipients: ALERT_EMAIL_TO, otherwise BACKUP_EMAIL_TO.
   ============================================================= */
const mailer = require('./mailer');
const { getSettings } = require('./db');

const REMIND_HOURS = 6;

/* key → [label, failures needed, within minutes, what to check] (key prefix before ':' for per-item keys) */
const PARTS = {
    ai: ['المساعد الذكي (الرد على العملاء)', 2, 30,
        'المساعد لا يرد على عملاء واتساب والموقع. تحقق من رصيد ومفتاح الذكاء الاصطناعي (OPENAI_API_KEY أو ANTHROPIC_API_KEY) في حساب المزوّد.'],
    mazbot_reply: ['إرسال ردود المساعد عبر MazBot', 2, 30,
        'الردود تُكتب لكن MazBot يرفض إرسالها. تحقق من MAZBOT_API_KEY وحساب الموظف في MazBot، ومن «تشخيص عدم الرد» في تبويب الربط.'],
    mazbot_sales: ['تنبيهات الطلبات لأرقام المبيعات (MazBot)', 2, 120,
        'طلبات العملاء الجديدة لا تصل إلى واتساب المبيعات. تحقق من MAZBOT_TEMPLATE_ID وأرقام المبيعات في تبويب الربط، ومن حالة القالب في MazBot.'],
    media: ['قراءة الصور والرسائل الصوتية من واتساب', 3, 60,
        'تعذر تنزيل صور أو رسائل صوتية من MazBot أو تحويل الصوت إلى نص. تحقق من OPENAI_API_KEY ورصيد حساب OpenAI، ومن أن روابط الملفات من MazBot ما زالت تعمل.'],
    whatsapp: ['واتساب المباشر (WhatsApp Cloud API)', 2, 60,
        'رسائل واتساب المباشرة تفشل. تحقق من WHATSAPP_TOKEN (قد تنتهي صلاحيته) ومن حساب Meta Business وطرق الدفع.'],
    phone_verification: ['التحقق من رقم العميل (Infocomm Verify)', 1, 60,
        'طُلب تفعيل الميزة لكن ربط Infocomm غير مكتمل. اترك PHONE_VERIFICATION_MODE=off حتى وصول التوثيق وبيانات الحساب.'],
    webhook: ['Webhook', 3, 60,
        'النظام الذي يستقبل الأحداث (n8n / Make / Zapier…) لا يقبلها. افتح سجل الإرسال في تبويب الربط لترى السبب.'],
    backup_local: ['النسخة الاحتياطية اليومية على الخادم', 1, 60,
        'تعذر حفظ النسخة اليومية. غالباً مساحة الاستضافة ممتلئة أو مجلد البيانات غير قابل للكتابة.'],
    backup_offsite: ['النسخة الاحتياطية بالبريد', 3, 360,
        'تعذر إرسال النسخة اليومية بالبريد. تحقق من متغيرات SMTP وكلمة مرور البريد.'],
    mail: ['البريد الصادر', 2, 60,
        'رسائل البريد (روابط استعادة كلمة المرور) لا تُرسل. تحقق من متغيرات SMTP. ملاحظة: تنبيهات الأعطال نفسها تُرسل بالبريد، فتابعها في اللوحة حتى يُصلح.']
};

const partOf = (key) => PARTS[String(key).split(':')[0]];

function recipients() {
    const list = String(process.env.ALERT_EMAIL_TO || process.env.BACKUP_EMAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
    return list;
}
const canEmail = () => mailer.isConfigured() && recipients().length > 0;

const nowSql = (db) => db.prepare("SELECT datetime('now') AS t").get().t;
const minutesSince = (db, at) => (at ? db.prepare("SELECT (julianday('now') - julianday(?)) * 1440 AS m").get(at).m : Infinity);

function panelLink(db) {
    const base = String(getSettings(db).public_base_url || '').trim().replace(/\/+$/, '');
    return /^https?:\/\//.test(base) ? `${base}/admin` : null;
}

/* Never throws, never blocks the caller */
function email(db, subject, lines) {
    if (!canEmail()) return Promise.resolve(false);
    const company = getSettings(db).company_name || 'نظام التسعير';
    const link = panelLink(db);
    return mailer.send({
        to: recipients().join(', '),
        subject: `${subject} — ${company}`,
        text: [...lines, '', link ? `لوحة الإدارة: ${link}` : '', 'هذه رسالة تلقائية من نظام التسعير.'].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n')
    }).then(() => true).catch((err) => { console.error('[alerts] email', err.message); return false; });
}

/* A part failed. label: for per-item keys (e.g. the webhook's name). */
function fail(db, key, error, { label = null } = {}) {
    try {
        const part = partOf(key);
        if (!part) return;
        const [baseLabel, threshold, windowMin, hint] = part;
        const name = label ? `${baseLabel} «${label}»` : baseLabel;
        const message = String(error && error.message || error || 'خطأ غير معروف').slice(0, 500);
        const row = db.prepare('SELECT * FROM system_alerts WHERE key = ?').get(key);
        const now = nowSql(db);
        // Failures counted inside the window; a failure after a long quiet period starts a new count
        const fresh = !row || row.state === 'ok' || minutesSince(db, row.window_start) > windowMin;
        const count = fresh ? 1 : row.fail_count + 1;
        db.prepare(`INSERT INTO system_alerts (key, label, state, fail_count, window_start, first_failed_at, last_failed_at, last_error)
                    VALUES (?, ?, 'failing', ?, ?, ?, ?, ?)
                    ON CONFLICT(key) DO UPDATE SET label = excluded.label, state = 'failing', fail_count = excluded.fail_count,
                        window_start = excluded.window_start, last_failed_at = excluded.last_failed_at, last_error = excluded.last_error,
                        first_failed_at = CASE WHEN system_alerts.state = 'ok' THEN excluded.first_failed_at ELSE system_alerts.first_failed_at END`)
            .run(key, name, count, fresh ? now : row.window_start, now, now, message);
        const current = db.prepare('SELECT * FROM system_alerts WHERE key = ?').get(key);
        const due = count >= threshold && (!current.notified_at || minutesSince(db, current.notified_at) >= REMIND_HOURS * 60);
        if (!due) return;
        db.prepare("UPDATE system_alerts SET notified_at = datetime('now') WHERE key = ?").run(key);
        const reminder = Boolean(row && row.notified_at && row.state === 'failing');
        email(db, `${reminder ? '⚠️ ما زال' : '⚠️'} عطل: ${name}`, [
            `${reminder ? 'ما زال هذا الجزء يفشل' : 'هذا الجزء من النظام يفشل'}: ${name}`,
            '',
            `منذ: ${current.first_failed_at} UTC`,
            `عدد مرات الفشل الأخيرة: ${count}`,
            `آخر خطأ: ${message}`,
            '',
            `ماذا تفعل: ${hint}`,
            '',
            `ستصلك رسالة «عاد للعمل» عند أول نجاح، وتذكير كل ${REMIND_HOURS} ساعات ما دام العطل قائماً.`
        ]);
    } catch (err) {
        console.error('[alerts]', err.message); // an alert must never break the work it reports on
    }
}

/* A part worked: close an open fault (and tell the manager if they were told it failed) */
function ok(db, key) {
    try {
        const row = db.prepare("SELECT * FROM system_alerts WHERE key = ? AND state = 'failing'").get(key);
        if (!row) return;
        db.prepare("UPDATE system_alerts SET state = 'ok', fail_count = 0, resolved_at = datetime('now'), notified_at = NULL WHERE key = ?").run(key);
        if (row.notified_at) {
            email(db, `✅ عاد للعمل: ${row.label}`, [
                `عاد هذا الجزء للعمل: ${row.label}`,
                '',
                `كان يفشل منذ: ${row.first_failed_at} UTC`,
                `آخر خطأ كان: ${row.last_error}`
            ]);
        }
    } catch (err) {
        console.error('[alerts]', err.message);
    }
}

/* For the panel: open faults first, then recently resolved */
function list(db) {
    return db.prepare(`SELECT key, label, state, fail_count, first_failed_at, last_failed_at, last_error, notified_at, resolved_at
                       FROM system_alerts ORDER BY state = 'failing' DESC, COALESCE(last_failed_at, resolved_at) DESC LIMIT 50`).all()
        .map((r) => {
            const part = partOf(r.key);
            return { ...r, threshold: part ? part[1] : 1, hint: part ? part[3] : '', alerting: r.state === 'failing' && r.fail_count >= (part ? part[1] : 1) };
        });
}

const status = (db) => ({ email_ready: canEmail(), mail_configured: mailer.isConfigured(), recipients: recipients(), alerts: list(db) });

function sendTest(db) {
    if (!canEmail()) {
        throw Object.assign(new Error(mailer.isConfigured()
            ? 'لا يوجد بريد لاستقبال التنبيهات — أضف ALERT_EMAIL_TO (أو BACKUP_EMAIL_TO) في متغيرات البيئة'
            : 'البريد غير مضبوط — أضف متغيرات SMTP أولاً'), { status: 400 });
    }
    const company = getSettings(db).company_name || 'نظام التسعير';
    return mailer.send({
        to: recipients().join(', '),
        subject: `🔔 تجربة تنبيهات الأعطال — ${company}`,
        text: 'هذه رسالة تجربة: تنبيهات الأعطال تصل إلى هذا البريد ✓\n\nعند تكرار فشل أي جزء من النظام (المساعد الذكي، MazBot، النسخ الاحتياطي، Webhooks…) تصلك رسالة بما حدث وماذا تفعل، ثم رسالة «عاد للعمل» عند إصلاحه.'
    }).then(() => ({ ok: true, to: recipients() }));
}

/* Resolved entries older than 90 days are removed */
const prune = (db) => Number(db.prepare("DELETE FROM system_alerts WHERE state = 'ok' AND resolved_at < datetime('now', '-90 days')").run().changes);

module.exports = { fail, ok, list, status, sendTest, prune, PARTS, REMIND_HOURS };
