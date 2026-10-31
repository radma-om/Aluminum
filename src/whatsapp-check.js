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
    if (s === 'replied') return { level: 'ok', note: 'كتب المساعد الرد وقبله MazBot ✓ (التسليم إلى واتساب يتم عند MazBot)' };
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

/* MazBot's answer to our send-message calls (receiver, HTTP status, its message id / status if it gave one) */
function summarizeReply(json) {
    const sends = parse(json);
    if (!Array.isArray(sends) || !sends.length) return null;
    return sends.map((x) => {
        const r = x.response && typeof x.response === 'object' ? x.response : {};
        const d = r.data && typeof r.data === 'object' ? r.data : {};
        const id = d.message_id || d.id || d.wamid || r.message_id || r.id || null;
        const st = d.status || r.status || r.message || null;
        return { receiver_id: x.receiver_id, ok: x.ok, http: x.status, message_id: id, mazbot_status: typeof st === 'string' ? st.slice(0, 120) : null,
            error: x.error ? String(x.error).slice(0, 300) : null, raw: JSON.stringify(x.response).slice(0, 300) };
    });
}

/* A short, readable line for any other MazBot event, and whether it reports a failure */
const FAILURE = /fail|error|reject|undeliver|invalid|blocked|expired/i;
function summarizeEvent(ev) {
    const d = ev.data || {};
    const pick = (o) => (o && typeof o === 'object' ? o : {});
    const m = pick(d.message);
    const status = d.status || m.status || d.state || null;
    const error = d.error || m.error || d.reason || m.reason || (d.errors && JSON.stringify(d.errors)) || null;
    const text = JSON.stringify(d).slice(0, 300);
    return { type: ev.type, status: status ? String(status).slice(0, 80) : null, error: error ? String(typeof error === 'object' ? JSON.stringify(error) : error).slice(0, 300) : null,
        failure: FAILURE.test(`${ev.type} ${status || ''} ${error || ''}`), text };
}
const ago = (sqlTime) => (Date.now() - Date.parse(String(sqlTime).replace(' ', 'T') + 'Z')) / 60000; // minutes

async function run(db, { live = true } = {}) {
    const settings = getSettings(db);
    const secret = process.env.MAZBOT_WEBHOOK_SECRET || '';
    // Only requests that really came from outside count as evidence; the panel's own test is marked 'diagnostic'
    const events = db.prepare('SELECT id, source, status, signature, body, reply_json, received_at FROM inbound_events ORDER BY id DESC LIMIT 40').all();
    const external = events.filter((e) => e.source === 'mazbot');
    const messages = events.map((e) => {
        const ev = parse(e.body) || {};
        const d = ev.data || {};
        return {
            id: e.id, at: e.received_at, type: ev.type || null, test: e.source !== 'mazbot',
            phone: d.contact && d.contact.phone ? String(d.contact.phone) : null,
            name: d.contact ? d.contact.name || null : null,
            text: d.message ? String(d.message.value || '').slice(0, 200) : null,
            status: e.status, signature: e.signature || null, ...explainStatus(e.status),
            mazbot_reply: summarizeReply(e.reply_json),
            raw_summary: ev.type && !['message.received', 'interactive.selected'].includes(ev.type) ? summarizeEvent(ev) : null
        };
    });
    // Everything else MazBot sent (delivery status, failures…): ignored for replies, but it is the only news after "accepted"
    const otherEvents = messages.filter((m) => !m.test && m.raw_summary).slice(0, 10);
    const customerMsgs = messages.filter((m) => ['message.received', 'interactive.selected'].includes(m.type));
    const last = external[0];
    const checks = [];
    const add = (key, level, title, detail, fix = null) => checks.push({ key, level, title, detail, fix });
    const since = (t) => {
        const mins = ago(t);
        return mins < 1 ? 'الآن' : mins < 60 ? `قبل ${Math.round(mins)} دقيقة` : mins < 1440 ? `قبل ${Math.round(mins / 60)} ساعة` : `قبل ${Math.round(mins / 1440)} يوم`;
    };

    // 1) MazBot → this system (an external request; the panel's test does not prove it)
    if (secret.length < 16) {
        add('webhook', 'bad', 'رابط الـ Webhook غير مفعّل', 'متغير البيئة MAZBOT_WEBHOOK_SECRET غير موجود (أو أقل من 16 حرفاً)، فلا يستقبل النظام رسائل MazBot.',
            'أضف MAZBOT_WEBHOOK_SECRET في متغيرات البيئة في هوستنجر ثم أعد النشر، وضع الرابط الظاهر هنا في «Whatsapp External Webhook Url» في MazBot.');
    } else if (!last) {
        add('webhook', 'bad', 'لم تصل أي رسالة من MazBot', 'الرابط مفعّل، لكن لا يوجد أي طلب وصل من MazBot (التجارب من هذه اللوحة لا تُحسب).',
            'في MazBot افتح صفحة الـ Webhook وتأكد أن «Whatsapp External Webhook Url» هو الرابط الظاهر هنا بالضبط ومفعّل، ثم أرسل رسالة من واتساب.');
    } else {
        const mins = ago(last.received_at);
        add('webhook', mins > 60 * 24 * 3 ? 'warn' : 'ok', 'MazBot يرسل الرسائل إلى النظام', `آخر طلب من MazBot وصل ${since(last.received_at)}.`,
            mins > 60 * 24 * 3 ? 'إذا أرسلت رسالة الآن ولم تظهر هنا خلال دقيقة، فالرابط في MazBot تغيّر أو توقف — أعد لصقه.' : null);
    }

    // 2) Signature: judged from the latest external request, never from the secret alone
    const signingSet = Boolean(process.env.MAZBOT_SIGNING_SECRET);
    const latestSigned = external.find((e) => e.signature === 'verified' || e.signature === 'bad' || e.status === 'bad_signature');
    const latestIsBad = latestSigned && (latestSigned.signature === 'bad' || latestSigned.status === 'bad_signature');
    const olderBad = external.filter((e) => e !== latestSigned && (e.signature === 'bad' || e.status === 'bad_signature'));
    if (!signingSet) {
        add('signature', 'warn', 'التحقق من التوقيع غير مفعّل',
            'MAZBOT_SIGNING_SECRET غير موجود، فالنظام يقبل أي طلب يصل إلى رابط الـ Webhook دون التأكد أنه من MazBot. الرد يعمل، والحماية الوحيدة سرية الرابط.',
            'لتفعيل التحقق: انسخ «Webhook signing secret» من صفحة الـ Webhook في MazBot وضعه في MAZBOT_SIGNING_SECRET في هوستنجر، ثم أعد النشر وأرسل رسالة تجربة من واتساب وافحص هنا.');
    } else if (!latestSigned) {
        add('signature', 'warn', 'لا يوجد دليل بعد على صحة التوقيع',
            'MAZBOT_SIGNING_SECRET مضبوط، لكن لم يصل منذ ضبطه أي طلب من MazBot اجتاز التحقق أو فشل فيه (وجود السر وحده لا يثبت أنه يطابق MazBot).',
            'أرسل رسالة من واتساب إلى رقم الشركة ثم اضغط «افحص الآن».');
    } else if (latestIsBad) {
        add('signature', 'bad', 'آخر طلب من MazBot رُفض: التوقيع لا يطابق', `آخر طلب موقّع وصل ${since(latestSigned.received_at)} ورُفض، فلا يرد المساعد على الرسائل.`,
            'انسخ «Webhook signing secret» من صفحة الـ Webhook في MazBot من جديد (بدون مسافات زائدة) وضعه في MAZBOT_SIGNING_SECRET في هوستنجر، ثم أعد النشر. إذا ولّد MazBot سراً جديداً فاستخدم الجديد.');
    } else {
        add('signature', 'ok', 'التوقيع سليم', `آخر طلب من MazBot (${since(latestSigned.received_at)}) اجتاز التحقق من التوقيع.` +
            (olderBad.length ? ` (رُفضت ${olderBad.length} طلبات أقدم — قبل إصلاح السر غالباً؛ لا تحتاج إجراء)` : ''));
    }

    // 3) The switch
    add('switch', settings.mazbot_agent_enabled ? 'ok' : 'bad',
        settings.mazbot_agent_enabled ? 'المساعد مفعّل للرد على واتساب' : 'المساعد لا يرد على واتساب (الخيار متوقف)',
        settings.mazbot_agent_enabled ? 'خيار «المساعد الذكي يرد على رسائل العملاء في واتساب» مفعّل.' : 'خيار «المساعد الذكي يرد على رسائل العملاء في واتساب (عبر MazBot)» غير مفعّل.',
        settings.mazbot_agent_enabled ? null : 'فعّل الخيار من بطاقة «واتساب المبيعات عبر MazBot» أدناه ثم اضغط «حفظ» (أو زر «تفعيل» هنا).');

    // 4) The AI — an error older than the latest successful reply is history, not the current state
    const aiErr = agent.getLastError();
    const lastReplied = customerMsgs.find((m) => m.status === 'replied');
    // Request times are stored to the second: a reply in the same second as the error counts as after it
    const aiErrIsOld = aiErr && lastReplied && Date.parse(String(lastReplied.at).replace(' ', 'T') + 'Z') + 999 >= Date.parse(aiErr.at);
    const aiHint = (m) => (/quota|billing|credit|insufficient/i.test(m) ? 'رصيد حساب OpenAI انتهى — اشحن الرصيد من platform.openai.com.'
        : /model/i.test(m) ? 'اسم النموذج في OPENAI_MODEL غير صحيح — جرّب gpt-4.1-mini.'
            : /key|auth|401/i.test(m) ? 'المفتاح OPENAI_API_KEY غير صحيح أو أُلغي — أنشئ مفتاحاً جديداً.' : null);
    if (!agent.isConfigured()) {
        add('ai', 'bad', 'مفتاح الذكاء الاصطناعي غير موجود', 'OPENAI_API_KEY (أو ANTHROPIC_API_KEY) غير موجود في متغيرات البيئة — ربما ضاع عند إعادة ربط الاستضافة.',
            'أضف OPENAI_API_KEY و OPENAI_MODEL في متغيرات البيئة في هوستنجر ثم أعد النشر.');
    } else if (aiErr && !aiErrIsOld && Date.now() - Date.parse(aiErr.at) < 6 * 3600_000) {
        add('ai', 'bad', 'الذكاء الاصطناعي أعاد خطأ مؤخراً', `${aiErr.provider} / ${aiErr.model}: ${aiErr.message}`, aiHint(aiErr.message));
    } else {
        add('ai', 'ok', 'الذكاء الاصطناعي جاهز', `${agent.provider() === 'openai' ? 'OpenAI' : 'Claude'} — ${agent.modelName()}` +
            (aiErr && aiErrIsOld ? ` (خطأ سابق في ${aiErr.at.slice(0, 16).replace('T', ' ')} UTC، وتم الرد بنجاح بعده)` : ''));
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

    // 5b) After MazBot accepted a reply: did MazBot report a delivery failure?
    const lastReplied2 = customerMsgs.find((m) => !m.test && m.status === 'replied');
    if (lastReplied2) {
        const after = otherEvents.filter((e) => e.id > lastReplied2.id);
        const failed = after.find((e) => e.raw_summary.failure);
        const reply = (lastReplied2.mazbot_reply || [])[0];
        const ids = reply ? `أُرسل إلى جهة MazBot رقم ${reply.receiver_id}${reply.message_id ? `، رقم الرسالة عند MazBot: ${reply.message_id}` : ''}${reply.mazbot_status ? `، ردّ MazBot: «${reply.mazbot_status}»` : ''}.` : '';
        if (failed) {
            add('delivery', 'bad', 'MazBot أبلغ عن فشل تسليم رسالة', `${failed.raw_summary.type}${failed.raw_summary.status ? ` (${failed.raw_summary.status})` : ''}: ${failed.raw_summary.error || failed.raw_summary.text}`,
                'افتح المحادثة في MazBot (Live chat) لرقم العميل وانظر سبب الفشل بجانب الرسالة. أرسل لدعم MazBot رقم الرسالة الظاهر هنا.');
        } else {
            add('delivery', 'warn', 'آخر رد قبله MazBot — تأكد من وصوله على واتساب',
                `${ids} النظام لا يعرف إن وصلت الرسالة إلى واتساب العميل: MazBot لا يرسل حالة التسليم إلى النظام.`,
                'إذا لم تصل: افتح في MazBot المحادثة مع رقم العميل. إن ظهر الرد هناك بعلامة خطأ فسبب الفشل مكتوب بجانبه؛ وإن لم يظهر أصلاً فأرسل لدعم MazBot رقم الجهة ورقم الرسالة الظاهرين هنا.');
        }
    }

    // 6) The last customer messages and what happened to each
    const lastCustomer = customerMsgs.find((m) => !m.test) || customerMsgs[0];
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
        other_events: otherEvents,
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
