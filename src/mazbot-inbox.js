/* =============================================================
   Customer messages from MazBot → AI sales agent → reply via MazBot.
   MazBot POSTs JSON events to /webhooks/mazbot/<secret>:
     { id, type: 'message.received' | 'interactive.selected', created_at,
       data: { contact: { id, phone, name }, message: { id, message_type, value } } }
   data.contact.id is the receiver_id used to answer.
   ============================================================= */
const { getSettings } = require('./db');
const agent = require('./agent');
const mazbot = require('./mazbot');
const leads = require('./leads');
const alerts = require('./alerts');
const mediaLib = require('./media');

const autoreply = require('./autoreply');

const PAUSE_HOURS = autoreply.PAUSE_HOURS; // after "talk to a person", the agent stays quiet for this customer
const isPaused = (db, phone) => autoreply.isStopped(db, phone);
const pause = (db, phone) => autoreply.pauseAuto(db, phone);
const unpause = (db, phone) => autoreply.resume(db, phone);

function setStatus(db, eventId, status) {
    db.prepare('UPDATE inbound_events SET status = ? WHERE id = ?').run(String(status).slice(0, 500), eventId);
}

/* The customer's text: a typed message, or the title of a button/list choice */
function messageText(event) {
    const m = (event.data && event.data.message) || {};
    if (event.type === 'interactive.selected') {
        const d = event.data || {};
        return String(m.value || (d.selection && (d.selection.title || d.selection.id)) || d.title || '').trim() || null;
    }
    return m.message_type === 'text' || m.meta_type === 'text' ? String(m.value || '').trim() || null : null;
}

/* One message at a time per customer, so replies stay in order */
const queues = new Map();
function enqueue(key, job) {
    const next = (queues.get(key) || Promise.resolve()).then(job).catch((err) => console.error('[mazbot-inbox]', err.message));
    queues.set(key, next);
    next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
    return next;
}

/**
 * Decide what to do with a stored webhook event; the reply runs in the background.
 * ctx = { saveQuote(q), notifySales(quote), baseUrl, client? (tests) }
 * Returns the queued job (tests await it) or null.
 */
function handleEvent(db, eventId, event, ctx) {
    if (!event || typeof event !== 'object') { setStatus(db, eventId, 'ignored: not JSON'); return null; }
    if (!['message.received', 'interactive.selected'].includes(event.type)) { setStatus(db, eventId, `ignored: ${event.type}`); return null; }

    const contact = (event.data && event.data.contact) || {};
    const phone = String(contact.phone || '').replace(/\D/g, '');
    if (!phone || contact.id == null) { setStatus(db, eventId, 'ignored: no contact'); return null; }

    // MazBot may retry a delivery: answer each message once
    const key = `${event.type}:${(event.data.message && event.data.message.id) || event.id}`;
    const dup = db.prepare("SELECT 1 FROM inbound_events WHERE event_key = ? AND id != ? AND status NOT LIKE 'bad_signature%'").get(key, eventId);
    db.prepare('UPDATE inbound_events SET event_key = ? WHERE id = ?').run(key, eventId);
    if (dup) { setStatus(db, eventId, 'duplicate'); return null; }

    // Every customer message is kept for the follow-up, even when the agent does not answer.
    // A voice note is logged once it is turned into text (in reply); without the agent, as a link.
    const text = messageText(event);
    const media = text ? null : mediaLib.mediaOf(event);
    const logCustomer = (body) => {
        try {
            leads.customerMessage(db, { key: leads.phoneKey(phone), channel: 'whatsapp', name: contact.name, phone, text: body });
        } catch (err) { console.error('[leads]', err.message); }
    };
    if (!media) logCustomer(text || '[رسالة غير نصية]');

    const settings = getSettings(db);
    const notAnswered = (status) => { if (media) logCustomer(mediaLabel(media)); setStatus(db, eventId, status); return null; };
    if (!settings.mazbot_agent_enabled) return notAnswered('agent_off');
    if (!agent.isConfigured()) return notAnswered('agent_not_configured (OPENAI_API_KEY / ANTHROPIC_API_KEY)');

    setStatus(db, eventId, 'queued');
    return enqueue(phone, () => reply(db, eventId, event, { ...ctx, phone, contact, media, logCustomer }));
}

/* How a photo / voice note shows in the customer follow-up (with the link, so staff can open it) */
function mediaLabel(m, extra = '') {
    const kinds = { image: '📷 صورة', audio: '🎤 رسالة صوتية', video: '🎬 فيديو', document: '📎 ملف' };
    return [`${kinds[m.kind] || '📎 مرفق'}${m.caption ? ': ' + m.caption : ''}${extra}`, m.url].filter(Boolean).join('\n');
}

async function reply(db, eventId, event, { phone, contact, saveQuote, notifySales, baseUrl, client, media = null, logCustomer = () => {}, mediaTools = mediaLib }) {
    let text = messageText(event);
    let images = [];
    // MazBot's answer to each send is kept with the request: "accepted by MazBot" is not "delivered on WhatsApp",
    // and its message id / status is what MazBot support needs to trace a reply that never arrived
    const sends = [];
    const send = async (msg) => {
        const r = await mazbot.sendText(contact.id, msg);
        sends.push({ receiver_id: contact.id, ok: r.ok, status: r.status, response: r.body === undefined ? null : r.body, error: r.ok ? null : r.error });
        db.prepare('UPDATE inbound_events SET reply_json = ? WHERE id = ?').run(JSON.stringify(sends).slice(0, 4000), eventId);
        if (!r.ok) {
            alerts.fail(db, 'mazbot_reply', r.error);
            throw new Error('send: ' + r.error);
        }
        alerts.ok(db, 'mazbot_reply');
    };
    try {
        // A voice note becomes text; a photo is shown to the AI with its caption
        if (!text && media && media.kind === 'audio' && media.url) {
            try {
                text = await mediaTools.transcribe(await mediaTools.download(media.url, 'audio'), media.url);
                alerts.ok(db, 'media');
            } catch (err) {
                alerts.fail(db, 'media', err);
                logCustomer(mediaLabel(media, ' (تعذر تحويلها إلى نص)'));
                await send('عذراً، لم أتمكن من سماع رسالتك الصوتية 🙏 هل يمكنك كتابة طلبك؟');
                return setStatus(db, eventId, 'replied: audio failed — ' + err.message);
            }
            if (!text) {
                logCustomer(mediaLabel(media, ' (غير واضحة)'));
                await send('لم تتضح الرسالة الصوتية 🙏 هل يمكنك إعادتها أو كتابة طلبك؟');
                return setStatus(db, eventId, 'replied: audio unclear');
            }
            logCustomer(mediaLabel(media, `: «${text}»`));
        } else if (!text && media && media.kind === 'image' && media.url) {
            try {
                images = [mediaTools.imagePart(await mediaTools.download(media.url, 'image'), media.url)];
                text = media.caption || '';
                alerts.ok(db, 'media');
            } catch (err) {
                alerts.fail(db, 'media', err);
                logCustomer(mediaLabel(media, ' (تعذر فتحها)'));
                await send('عذراً، لم أتمكن من فتح الصورة 🙏 هل يمكنك إرسالها مرة أخرى أو وصف طلبك؟');
                return setStatus(db, eventId, 'replied: image failed — ' + err.message);
            }
            logCustomer(mediaLabel(media));
        } else if (!text) {
            if (media) logCustomer(mediaLabel(media));
            await send('أستطيع قراءة النصوص والصور والرسائل الصوتية 🙏 اكتب لي طلبك أو أرسله برسالة صوتية.');
            return setStatus(db, eventId, 'replied: unsupported message');
        }
        const stopped = autoreply.stateOf(db, phone);
        if (stopped && stopped.kind === 'manual') {
            // Switched off by an employee: the customer's «جديد» does not switch it back on
            return setStatus(db, eventId, `paused: auto-reply off for this number${stopped.forever ? '' : ' until ' + stopped.until.slice(0, 10)}`);
        }
        if (/^\s*(جديد|ابدأ من جديد|reset|restart)\s*$/i.test(text)) unpause(db, phone);
        else if (stopped) return setStatus(db, eventId, 'paused: with sales team');

        const settings = getSettings(db);
        const result = await agent.chat({
            db, key: 'mz:' + phone, channel: 'mazbot', phone, text, images,
            createQuote: saveQuote,
            ...(client ? { client } : {}),
            notifyHuman: async (summary) => {
                pause(db, phone);
                leads.humanRequested(db, leads.phoneKey(phone), summary);
                const alert = `🙋 عميل يطلب التواصل مع فريق المبيعات\n${contact.name || ''} — +${phone}\n\n${summary}`;
                for (const to of mazbot.parseRecipients(settings.mazbot_recipients)) {
                    const r = await mazbot.sendTextToPhone(to, alert);
                    if (!r.ok) console.error('[mazbot-inbox] alert', to, r.error);
                }
            }
        });
        await send(result.reply);
        leads.assistantMessage(db, leads.phoneKey(phone), result.reply);
        // PDF links always point at this system (where the quotes live), not at the company website
        const base = String(baseUrl || settings.public_base_url || '').replace(/\/$/, '');
        for (const e of result.events) {
            if (e.type !== 'quote_created') continue;
            await send(`📄 عرض السعر رقم ${e.quote.ref}\n${base}${e.quote.pdf_url}`);
            notifySales(e.quote).catch((err) => console.error('[mazbot-inbox] notify', err.message));
        }
        setStatus(db, eventId, 'replied');
    } catch (err) {
        console.error('[mazbot-inbox]', err.message);
        setStatus(db, eventId, 'error: ' + err.message);
    }
}

module.exports = { handleEvent, messageText, pause, unpause, isPaused, PAUSE_HOURS };
