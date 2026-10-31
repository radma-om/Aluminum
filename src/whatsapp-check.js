/* =============================================================
   "Why doesn't the assistant answer on WhatsApp?" — checks every link
   of the chain, in order, and says in plain Arabic what to fix:
     customer → MazBot → webhook (this system) → AI → reply via MazBot
   ============================================================= */
const { getSettings } = require('./db');
const agent = require('./agent');
const mazbot = require('./mazbot');
const inbox = require('./mazbot-inbox');

/* What happened to one incoming request, for people */
function explainStatus(status) {
    const s = String(status || '');
    if (!s) return { level: 'warn', note: 'لم يُعالَج بعد' };
    if (s === 'replied') return { level: 'ok', note: 'تم الرد ✓' };
    if (s === 'replied: non-text') return { level: 'ok', note: 'رسالة غير نصية (صورة / صوت) — أُرسل للعميل أن المساعد يقرأ النصوص فقط' };
    if (s === 'queued') return { level: 'warn', note: 'قيد الرد…' };
    if (s === 'duplicate') return { level: 'info', note: 'نفس الرسالة وصلت مرة أخرى من MazBot — تم تجاهل التكرار' };
    if (s === 'agent_off') return { level: 'bad', note: 'لم يُرد: خيار «المساعد الذكي يرد على رسائل العملاء» غير مفعّل' };
    if (s.startsWith('agent_not_configured')) return { level: 'bad', note: 'لم يُرد: مفتاح الذكاء الاصطناعي (OPENAI_API_KEY) غير موجود في متغيرات البيئة' };
    if (s.startsWith('paused')) return { level: 'bad', note: 'لم يُرد: المساعد متوقف لهذا الرقم 12 ساعة (طلب العميل موظفاً، أو ردّ عليه موظف من اللوحة)' };
    if (s === 'bad_signature') return { level: 'bad', note: 'رُفض: التوقيع غير مطابق — MAZBOT_SIGNING_SECRET لا يطابق «Webhook signing secret» في MazBot' };
    if (s.startsWith('ignored: no contact')) return { level: 'info', note: 'حدث بدون رقم عميل — ليس رسالة' };
    if (s.startsWith('ignored')) return { level: 'info', note: `حدث ليس رسالة عميل (${s.replace('ignored: ', '')}) — لا يحتاج رداً` };
    if (s.startsWith('error: send')) return { level: 'bad', note: 'المساعد كتب الرد لكن الإرسال عبر MazBot فشل: ' + s.replace(/^error: send: ?/, '') };
    if (s.startsWith('error')) return { level: 'bad', note: 'خطأ أثناء الرد: ' + s.replace(/^error: ?/, '') };
    return { level: 'info', note: s };
}

const parse = (body) => { try { return JSON.parse(body); } catch { return null; } };
const ago = (sqlTime) => (Date.now() - Date.parse(String(sqlTime).replace(' ', 'T') + 'Z')) / 60000; // minutes

async function run(db, { live = true } = {}) {
    const settings = getSettings(db);
    const secret = process.env.MAZBOT_WEBHOOK_SECRET || '';
    const events = db.prepare('SELECT id, status, body, received_at FROM inbound_events ORDER BY id DESC LIMIT 30').all();
    const messages = events.map((e) => {
        const ev = parse(e.body) || {};
        const d = ev.data || {};
        return {
            id: e.id, at: e.received_at, type: ev.type || null,
            phone: d.contact && d.contact.phone ? String(d.contact.phone) : null,
            name: d.contact ? d.contact.name || null : null,
            text: d.message ? String(d.message.value || '').slice(0, 200) : null,
            status: e.status, ...explainStatus(e.status)
        };
    });
    const customerMsgs = messages.filter((m) => ['message.received', 'interactive.selected'].includes(m.type));
    const last = events[0];
    const checks = [];
    const add = (key, level, title, detail, fix = null) => checks.push({ key, level, title, detail, fix });

    // 1) MazBot → this system
    if (secret.length < 16) {
        add('webhook', 'bad', 'رابط الـ Webhook غير مفعّل', 'متغير البيئة MAZBOT_WEBHOOK_SECRET غير موجود (أو أقل من 16 حرفاً)، فلا يستقبل النظام رسائل MazBot.',
            'أضف MAZBOT_WEBHOOK_SECRET في متغيرات البيئة في هوستنجر ثم أعد النشر، وضع الرابط الظاهر هنا في «Whatsapp External Webhook Url» في MazBot.');
    } else if (!last) {
        add('webhook', 'bad', 'لم تصل أي رسالة من MazBot', 'الرابط مفعّل، لكن MazBot لم يرسل إلى النظام أي طلب حتى الآن.',
            'في MazBot افتح صفحة الـ Webhook وتأكد أن «Whatsapp External Webhook Url» هو الرابط الظاهر هنا بالضبط ومفعّل، ثم أرسل رسالة من واتساب.');
    } else {
        const mins = ago(last.received_at);
        add('webhook', mins > 60 * 24 * 3 ? 'warn' : 'ok', 'MazBot يرسل الرسائل إلى النظام',
            `آخر طلب وصل ${mins < 1 ? 'الآن' : mins < 60 ? `قبل ${Math.round(mins)} دقيقة` : mins < 1440 ? `قبل ${Math.round(mins / 60)} ساعة` : `قبل ${Math.round(mins / 1440)} يوم`}.`,
            mins > 60 * 24 * 3 ? 'إذا أرسلت رسالة الآن ولم تظهر هنا خلال دقيقة، فالرابط في MazBot تغيّر أو توقف — أعد لصقه.' : null);
    }

    // 2) Signature
    const recentBad = events.slice(0, 10).filter((e) => e.status === 'bad_signature').length;
    if (recentBad) {
        add('signature', 'bad', 'التوقيع مرفوض', `${recentBad} من آخر الطلبات رُفضت لأن التوقيع لا يطابق.`,
            'انسخ «Webhook signing secret» من MazBot وضعه في MAZBOT_SIGNING_SECRET في هوستنجر (أو احذف المتغير مؤقتاً للتجربة)، ثم أعد النشر.');
    } else if (!process.env.MAZBOT_SIGNING_SECRET) {
        add('signature', 'warn', 'التحقق من التوقيع غير مفعّل', 'الرسائل تُقبل بدون التحقق من أنها من MazBot (يعمل، لكنه أقل أماناً).',
            'اختياري: ضع «Webhook signing secret» من MazBot في MAZBOT_SIGNING_SECRET.');
    } else {
        add('signature', 'ok', 'التوقيع سليم', 'MAZBOT_SIGNING_SECRET مضبوط والطلبات الأخيرة مقبولة.');
    }

    // 3) The switch
    add('switch', settings.mazbot_agent_enabled ? 'ok' : 'bad',
        settings.mazbot_agent_enabled ? 'المساعد مفعّل للرد على واتساب' : 'المساعد لا يرد على واتساب (الخيار متوقف)',
        settings.mazbot_agent_enabled ? 'خيار «المساعد الذكي يرد على رسائل العملاء في واتساب» مفعّل.' : 'خيار «المساعد الذكي يرد على رسائل العملاء في واتساب (عبر MazBot)» غير مفعّل.',
        settings.mazbot_agent_enabled ? null : 'فعّل الخيار من بطاقة «واتساب المبيعات عبر MazBot» أدناه ثم اضغط «حفظ» (أو زر «تفعيل» هنا).');

    // 4) The AI
    const aiErr = agent.getLastError();
    if (!agent.isConfigured()) {
        add('ai', 'bad', 'مفتاح الذكاء الاصطناعي غير موجود', 'OPENAI_API_KEY (أو ANTHROPIC_API_KEY) غير موجود في متغيرات البيئة — ربما ضاع عند إعادة ربط الاستضافة.',
            'أضف OPENAI_API_KEY و OPENAI_MODEL في متغيرات البيئة في هوستنجر ثم أعد النشر.');
    } else if (aiErr && Date.now() - Date.parse(aiErr.at) < 6 * 3600_000) {
        add('ai', 'bad', 'الذكاء الاصطناعي أعاد خطأ مؤخراً', `${aiErr.provider} / ${aiErr.model}: ${aiErr.message}`,
            /quota|billing|credit|insufficient/i.test(aiErr.message) ? 'رصيد حساب OpenAI انتهى — اشحن الرصيد من platform.openai.com.'
                : /model/i.test(aiErr.message) ? 'اسم النموذج في OPENAI_MODEL غير صحيح — جرّب gpt-4.1-mini.'
                    : /key|auth|401/i.test(aiErr.message) ? 'المفتاح OPENAI_API_KEY غير صحيح أو أُلغي — أنشئ مفتاحاً جديداً.' : null);
    } else {
        add('ai', 'ok', 'الذكاء الاصطناعي جاهز', `${agent.provider() === 'openai' ? 'OpenAI' : 'Claude'} — ${agent.modelName()}`);
    }

    // 5) MazBot sending (a real login)
    if (!mazbot.hasLogin()) {
        add('send', 'bad', 'بيانات الإرسال عبر MazBot ناقصة', 'MAZBOT_API_KEY أو MAZBOT_STAFF_EMAIL أو MAZBOT_STAFF_PASSWORD غير موجود، فلا يستطيع النظام إرسال الرد.',
            'أضف المتغيرات الثلاثة في هوستنجر ثم أعد النشر.');
    } else if (live) {
        const login = await mazbot.checkLogin();
        add('send', login.ok ? 'ok' : 'bad', login.ok ? 'الدخول إلى MazBot ناجح' : 'تعذر الدخول إلى MazBot',
            login.ok ? (login.dry_run ? 'وضع تجريبي (MAZBOT_DRY_RUN=1): لا يُرسل شيء فعلياً.' : 'مفتاح API وحساب الموظف مقبولان، فالنظام يستطيع الإرسال.') : 'الخطأ: ' + login.error,
            login.ok ? (login.dry_run ? 'احذف MAZBOT_DRY_RUN من متغيرات البيئة ليُرسل الرد فعلياً.' : null)
                : 'تأكد من MAZBOT_API_KEY ومن بريد وكلمة مرور حساب الموظف (client-staff) في MazBot — ربما تغيّرت كلمة المرور.');
    }

    // 6) The last customer messages and what happened to each
    const lastCustomer = customerMsgs[0];
    if (lastCustomer && lastCustomer.level === 'bad') {
        const who = [lastCustomer.name, lastCustomer.phone ? '+' + lastCustomer.phone : null].filter(Boolean).join(' ');
        add('last', 'bad', 'آخر رسالة من عميل لم يُرد عليها', `${who}: «${lastCustomer.text || ''}» ← ${lastCustomer.note}`);
    } else if (lastCustomer && lastCustomer.status === 'queued' && ago(lastCustomer.at) > 3) {
        add('last', 'bad', 'آخر رسالة عالقة «قيد الرد»', 'بدأ الرد ولم ينتهِ — غالباً أُعيد تشغيل الخادم أثناء الرد.', 'أرسل الرسالة مرة أخرى من واتساب.');
    } else if (lastCustomer) {
        add('last', lastCustomer.level === 'ok' ? 'ok' : 'warn', 'آخر رسالة من عميل', lastCustomer.note);
    }

    const pauses = db.prepare("SELECT phone, until FROM agent_pauses WHERE until > datetime('now') ORDER BY until DESC").all();
    const firstBad = checks.find((c) => c.level === 'bad');
    return {
        ok: !firstBad,
        summary: firstBad ? `السبب الأرجح: ${firstBad.title}` : 'كل الروابط سليمة ✓ — إذا لم يُرد المساعد على رقم معيّن فانظر «أرقام متوقف عنها المساعد» وسجل الرسائل أدناه.',
        checks,
        pauses,
        messages: customerMsgs.slice(0, 15),
        webhook_path: secret.length >= 16 ? `/webhooks/mazbot/${secret}` : null
    };
}

/* Run the whole chain for a phone: AI answer + send through MazBot, as if the customer wrote */
async function simulate(db, { phone, text }, ctx) {
    const digits = String(phone || '').replace(/\D/g, '').replace(/^00/, '');
    const full = /^[79]\d{7}$/.test(digits) ? '968' + digits : digits;
    if (!/^968[79]\d{7}$/.test(full)) throw Object.assign(new Error('اكتب رقم واتساب عُماني (8 أرقام)'), { status: 400 });
    const msg = String(text || 'مرحبا، كم سعر بوابة رول شتر؟').trim().slice(0, 500);
    if (!mazbot.hasLogin()) throw Object.assign(new Error('بيانات MazBot ناقصة — انظر نتيجة الفحص'), { status: 400 });
    const receiverId = await mazbot.resolveContact(full);
    if (receiverId == null) throw Object.assign(new Error('MazBot لم يتعرف على هذا الرقم (resolve-by-phone فشل) — راسل رقم واتساب الشركة من هذا الرقم أولاً'), { status: 502 });
    inbox.unpause(db, full); // a test must not be blocked by an earlier pause
    const event = {
        id: 'diagnostic-' + Date.now(), type: 'message.received', diagnostic: true,
        data: { contact: { id: receiverId, phone: full, name: 'تجربة من لوحة الإدارة' }, message: { id: 'diag-' + Date.now(), message_type: 'text', value: msg } }
    };
    const eventId = Number(db.prepare("INSERT INTO inbound_events (source, method, body) VALUES ('diagnostic', 'POST', ?)").run(JSON.stringify(event)).lastInsertRowid);
    const job = inbox.handleEvent(db, eventId, event, ctx);
    if (job) await job;
    const status = db.prepare('SELECT status FROM inbound_events WHERE id = ?').get(eventId).status;
    return { status, ...explainStatus(status), phone: full };
}

module.exports = { run, simulate, explainStatus };
