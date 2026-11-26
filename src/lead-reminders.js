/* =============================================================
   «تذكير العملاء بلا عرض سعر» — customers in «متابعة العملاء» who wrote
   to us in the last 14 days and never got a quote hear from us once:
   an approved template asks whether they would like a quote.
   - Sent only when a manager presses «إرسال» (to all, or one row); the
     list shows first who will get it, and after, who got it and answered.
   - Who: a customer message in the last 14 days, a valid Omani mobile,
     no quote for the number, not «تم البيع» / «لم يتم», the auto-reply
     not switched off by hand for the number, notices not muted, and
     never reminded before (again only if they wrote after the reminder
     and did not answer «لا شكراً»). One per number.
   - Template (approved, the templates account):
       MAZBOT_LEAD_REMINDER_TEMPLATE_ID  {{1}} name
       quick-reply buttons: «أريد عرض سعر» «لا شكراً»
   - The press comes back on the templates account's webhook:
       «أريد عرض سعر» → a reply with the calculator's link and the sales
                         number; the customer becomes «يطلب موظفاً» in the
                         follow-up, and the sales numbers are told;
       «لا شكراً»     → never reminded again.
   ============================================================= */
const mazbot = require('./mazbot');
const { getSettings } = require('./db');

const WINDOW_DAYS = 14;
const ANSWER_DAYS = 7; // a button pressed within a week of the reminder counts as its answer
const templateId = () => String(process.env.MAZBOT_LEAD_REMINDER_TEMPLATE_ID || '').trim();
const mobileOf = (phone) => { const d = String(phone || '').replace(/\D/g, '').replace(/^00/, ''); return d.length === 8 ? '968' + d : d; };
const err = (status, message) => Object.assign(new Error(message), { status, expose: true });
const QUOTE_RE = /^\s*أريد عرض سعر\s*$/;
const NO_RE = /^\s*لا[،,]?\s*شكرا[ًا]?\s*$/;

let sender = null; // tests
const setSenderForTests = (fn) => { sender = fn; };

const ready = new WeakSet();
function ensureTable(db) {
    if (ready.has(db)) return;
    ready.add(db);
    db.exec(`CREATE TABLE IF NOT EXISTS lead_reminders (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id       INTEGER NOT NULL,
        phone         TEXT NOT NULL,
        ok            INTEGER NOT NULL,
        error         TEXT,
        sent_by       TEXT,
        sent_at       TEXT NOT NULL DEFAULT (datetime('now')),
        response      TEXT,
        responded_at  TEXT
    ); CREATE INDEX IF NOT EXISTS lead_reminders_phone ON lead_reminders (phone, sent_at);`);
}

/* Who would get the reminder now, and who got it (with their answer) */
function list(db) {
    ensureTable(db);
    const out = { template: Boolean(templateId()), login: mazbot.templatesAccount().client.hasLogin(), window_days: WINDOW_DAYS, candidates: [], sent: [] };
    // Each customer's latest message of the last 14 days (newest first)
    const rows = db.prepare(`SELECT l.id, l.name, l.phone, l.channel, l.status, l.assigned_to,
                                    (SELECT MAX(m.created_at) FROM lead_messages m WHERE m.lead_id = l.id AND m.role = 'customer') AS last_customer_at
                             FROM leads l
                             WHERE l.phone IS NOT NULL AND l.status NOT IN ('won', 'lost')
                             AND EXISTS (SELECT 1 FROM lead_messages m WHERE m.lead_id = l.id AND m.role = 'customer' AND m.created_at >= datetime('now', ?))
                             ORDER BY last_customer_at DESC`).all(`-${WINDOW_DAYS} days`);
    const hasQuote = db.prepare("SELECT 1 FROM quotes WHERE substr(replace(replace(customer_phone, '+', ''), ' ', ''), -8) = ? LIMIT 1");
    const lastOf = db.prepare('SELECT * FROM lead_reminders WHERE phone = ? ORDER BY id DESC LIMIT 1');
    const declined = db.prepare("SELECT 1 FROM lead_reminders WHERE phone = ? AND response = 'no' LIMIT 1");
    const autoreply = require('./autoreply');
    const notices = require('./order-notify');
    const seen = new Set();
    for (const l of rows) {
        const phone = mobileOf(l.phone);
        if (!/^968[79]\d{7}$/.test(phone) || seen.has(phone)) continue;
        seen.add(phone);
        if (hasQuote.get(phone.slice(-8))) continue;
        const item = { lead_id: l.id, name: l.name, phone, channel: l.channel, status: l.status, assigned_to: l.assigned_to, last_customer_at: l.last_customer_at };
        const last = lastOf.get(phone);
        if (last && last.ok) {
            // Reminded: shown as such, unless they wrote again since and did not say no
            const wroteSince = l.last_customer_at > last.sent_at && last.response !== 'quote';
            if (!wroteSince || declined.get(phone)) { out.sent.push({ ...item, sent_at: last.sent_at, response: last.response, responded_at: last.responded_at }); continue; }
        }
        if (declined.get(phone)) continue;
        const stop = autoreply.stateOf(db, phone);
        if (stop && stop.kind === 'manual') continue;           // switched off by hand for this number
        if (notices.isMuted(db, phone)) continue;              // «إيقاف الإشعارات»
        out.candidates.push({ ...item, last_error: last && !last.ok ? last.error : null });
    }
    return out;
}

/* What a send needs: the template and the templates account */
function ready_(l) {
    if (!l.template) throw err(400, 'قالب التذكير غير مضبوط (MAZBOT_LEAD_REMINDER_TEMPLATE_ID) — أضفه بعد اعتماده من Meta');
    if (!sender && !l.login) throw err(400, 'حساب القوالب في MazBot غير مضبوط');
}

/* One customer: the template goes out (MazBot's «success» decides), the attempt is kept, the follow-up says so */
async function sendOne(db, c, { by }) {
    const name = String(c.name || '').trim().split(/\s+/)[0] || 'عميلنا العزيز';
    const id = templateId();
    let r;
    try { r = sender ? await sender({ mobile: c.phone, templateId: id, values: [name] }) : await mazbot.templatesAccount().client.sendTemplate(c.phone, [name], id); } catch (e) { r = { ok: false, error: e.message }; }
    const ok = Boolean(r && r.ok);
    const error = ok ? null : String((r && r.error) || 'failed').slice(0, 300);
    db.prepare('INSERT INTO lead_reminders (lead_id, phone, ok, error, sent_by) VALUES (?, ?, ?, ?, ?)').run(c.lead_id, c.phone, ok ? 1 : 0, error, by);
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(c.lead_id);
    if (lead) require('./leads').addMessage(db, lead, 'system', ok ? '⏰ أُرسل تذكير «هل تحب نجهز لك عرض سعر؟»' : `⚠️ لم يصل تذكير عرض السعر: ${error}`, { author: by });
    if (!ok) console.error('[lead-reminders]', c.phone, error);
    return { lead_id: c.lead_id, phone: c.phone, ok, error };
}

/** Everyone on the list (the manager pressed «إرسال للكل»). Returns { sent, failed, results }. */
async function send(db, { by = null } = {}) {
    const l = list(db);
    ready_(l);
    const results = [];
    for (const c of l.candidates) results.push(await sendOne(db, c, { by }));
    return { sent: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length, results };
}

/** One customer of the list (the button on their row); refused with the reason when not on it. */
async function sendLead(db, leadId, { by = null } = {}) {
    const l = list(db);
    ready_(l);
    const c = l.candidates.find((x) => x.lead_id === Number(leadId));
    if (c) return sendOne(db, c, { by });
    const got = l.sent.find((x) => x.lead_id === Number(leadId));
    if (got) throw err(409, `وصل هذا العميل التذكير في ${String(got.sent_at).slice(0, 16)} — مرة واحدة فقط`);
    throw err(400, 'هذا العميل ليس في القائمة (له عرض سعر، أو لم يراسلنا خلال 14 يوماً، أو رفض التذكير، أو أوقف الإشعارات، أو بلا رقم صالح)');
}

/**
 * A button pressed on the templates account after a reminder (within a week, not answered yet). Returns
 * { action, reply } or null (not a reminder's answer: the other handlers decide).
 */
function handle(db, phone, text, { origin = '' } = {}) {
    ensureTable(db);
    const p = mobileOf(phone);
    const said = String(text || '').trim();
    const wantsQuote = QUOTE_RE.test(said);
    if (!wantsQuote && !NO_RE.test(said)) return null;
    const row = db.prepare(`SELECT * FROM lead_reminders WHERE phone = ? AND ok = 1 AND response IS NULL
                            AND sent_at >= datetime('now', ?) ORDER BY id DESC LIMIT 1`).get(p, `-${ANSWER_DAYS} days`);
    if (!row) return null;
    const leads = require('./leads');
    db.prepare("UPDATE lead_reminders SET response = ?, responded_at = datetime('now') WHERE id = ?").run(wantsQuote ? 'quote' : 'no', row.id);
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(row.lead_id);
    const s = getSettings(db);
    if (!wantsQuote) {
        if (lead) leads.addMessage(db, lead, 'system', '🔕 ردّ العميل على التذكير: «لا شكراً» — لن يُرسل له تذكير آخر');
        return { action: 'lead_reminder_no', reply: 'تم، لن نرسل لك تذكيرات أخرى. شكراً لك 🙏' };
    }
    // «أريد عرض سعر»: a person follows up, the sales numbers hear of it, and the customer gets the calculator now
    const summary = 'ضغط «أريد عرض سعر» من تذكير المتابعة';
    if (lead) leads.humanRequested(db, lead.contact_key, summary);
    const alert = `🙋 عميل يريد عرض سعر (تذكير المتابعة)\n${(lead && lead.name) || ''} — +${p}`;
    for (const to of mazbot.parseRecipients(s.mazbot_recipients)) {
        mazbot.sendTextToPhone(to, alert).then((r) => { if (!r.ok) console.error('[lead-reminders] alert', to, r.error); }).catch(() => {});
    }
    const base = String(s.public_base_url || origin || '').trim().replace(/\/+$/, '');
    const phoneLine = s.company_phone ? `أو راسلنا على واتساب ${s.company_phone}` : 'أو راسلنا على واتساب';
    return {
        action: 'lead_reminder_quote',
        reply: `شكراً لك! 🌟 سيتواصل معك فريق المبيعات قريباً.${base ? `\nويمكنك حساب سعر بوابتك فوراً من الحاسبة: ${base}/` : ''}\n${phoneLine} وسيجهز لك المساعد الذكي عرض السعر.`
    };
}

module.exports = { ensureTable, list, send, sendLead, handle, setSenderForTests, WINDOW_DAYS, ANSWER_DAYS };
