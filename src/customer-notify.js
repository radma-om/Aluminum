/* =============================================================
   WhatsApp to the customer from the company's number (MazBot):
   the invoice once issued, the confirmation of a payment, a reminder of
   what is left — each with the amounts and the link to the invoice PDF.
   - Sent by an employee with a button (never by itself).
   - An approved template when its id is set (it reaches the customer at
     any time); otherwise a plain text, which WhatsApp delivers only
     within 24 hours of the customer's last message.
       MAZBOT_INVOICE_TEMPLATE_ID  {{1}} name {{2}} number {{3}} total {{4}} paid {{5}} left {{6}} link
       MAZBOT_PAYMENT_TEMPLATE_ID  {{1}} name {{2}} amount {{3}} number {{4}} paid {{5}} left {{6}} link
       MAZBOT_BALANCE_TEMPLATE_ID  {{1}} name {{2}} number {{3}} left {{4}} link
   - Every attempt is kept (invoice_messages) and written in the
     customer's follow-up log, with who sent it.
   ============================================================= */
const mazbot = require('./mazbot');

const KINDS = {
    invoice: { label: 'الفاتورة', env: 'MAZBOT_INVOICE_TEMPLATE_ID' },
    payment: { label: 'تأكيد دفعة', env: 'MAZBOT_PAYMENT_TEMPLATE_ID' },
    balance: { label: 'تذكير بالمتبقي', env: 'MAZBOT_BALANCE_TEMPLATE_ID' }
};
const money = (n) => Number(n || 0).toFixed(2);
const err = (status, message) => Object.assign(new Error(message), { status });

let sender = null; // tests
const setSenderForTests = (fn) => { sender = fn; };

function ensureTable(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS invoice_messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_id INTEGER NOT NULL,
        payment_id INTEGER,
        kind       TEXT NOT NULL,
        phone      TEXT,
        via        TEXT,
        ok         INTEGER NOT NULL DEFAULT 0,
        error      TEXT,
        sent_by    TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    ); CREATE INDEX IF NOT EXISTS invoice_messages_invoice ON invoice_messages (invoice_id, id);`);
}

const templateId = (kind) => String(process.env[KINDS[kind].env] || '').trim();

/* What is ready: the MazBot sign-in and each template (for the buttons' labels) */
function status() {
    const login = mazbot.hasLogin();
    return { login, invoice: Boolean(templateId('invoice')), payment: Boolean(templateId('payment')), balance: Boolean(templateId('balance')) };
}

/* Oman numbers: 8 digits → 968…; anything else as typed (digits only) */
function mobileOf(phone) {
    const d = String(phone || '').replace(/\D/g, '').replace(/^00/, '');
    return d.length === 8 ? '968' + d : d;
}

/* The template's values, in its order, and the same words as a plain message */
function content(kind, inv, payment, link) {
    const name = inv.customer_name || 'عميلنا العزيز';
    if (kind === 'invoice') {
        return {
            values: [name, inv.number, money(inv.total), money(inv.paid), money(inv.balance), link],
            text: `مرحباً ${name}،\nصدرت فاتورتكم رقم ${inv.number}.\nالإجمالي: ${money(inv.total)} ر.ع\nالمدفوع: ${money(inv.paid)} ر.ع\nالمتبقي: ${money(inv.balance)} ر.ع\nلعرض الفاتورة: ${link}\nشكراً لتعاملكم معنا.`
        };
    }
    if (kind === 'payment') {
        return {
            values: [name, money(payment.amount), inv.number, money(inv.paid), money(inv.balance), link],
            text: `مرحباً ${name}،\nاستلمنا دفعتكم بمبلغ ${money(payment.amount)} ر.ع للفاتورة رقم ${inv.number}.\nمجموع المدفوع: ${money(inv.paid)} ر.ع\nالمتبقي: ${money(inv.balance)} ر.ع\nلعرض الفاتورة: ${link}\nشكراً لكم.`
        };
    }
    return {
        values: [name, inv.number, money(inv.balance), link],
        text: `مرحباً ${name}،\nنذكّركم بأن المتبقي على الفاتورة رقم ${inv.number} هو ${money(inv.balance)} ر.ع.\nلعرض الفاتورة: ${link}\nيسعدنا تواصلكم لأي استفسار.`
    };
}

/**
 * Send one message about an invoice. kind: invoice | payment (paymentId) | balance.
 * link: the full address of the invoice's PDF for the customer.
 * Returns { ok, via, error, message } — the attempt is logged either way.
 */
async function send(db, inv, { kind, paymentId = null, link, by = null }) {
    ensureTable(db);
    if (!KINDS[kind]) throw err(400, 'نوع الرسالة غير صالح');
    if (inv.status === 'cancelled') throw err(400, 'الفاتورة ملغاة');
    if (!/^https:\/\//.test(String(link || '')) && !/^http:\/\/(localhost|127\.)/.test(String(link || ''))) {
        throw err(400, 'رابط النظام العام غير مضبوط — حدده في الإعدادات (رابط النظام) حتى يصل العميل رابط الفاتورة');
    }
    let payment = null;
    if (kind === 'payment') {
        payment = (inv.payments || []).find((p) => p.id === Number(paymentId)) || (paymentId ? null : (inv.payments || []).at(-1));
        if (!payment) throw err(404, 'الدفعة غير موجودة');
    }
    if (kind === 'balance' && !(inv.balance > 0.004)) throw err(400, 'لا يوجد متبقٍ على هذه الفاتورة');
    const mobile = mobileOf(inv.customer_phone);
    if (mobile.length < 11) throw err(400, 'رقم جوال العميل غير صالح في الفاتورة');
    if (!sender && !mazbot.hasLogin()) throw err(400, 'MazBot غير مضبوط على الخادم (MAZBOT_API_KEY وبيانات الدخول) — أرسلها من جوالك بزر «واتساب من جوالي»');

    const { values, text } = content(kind, inv, payment, link);
    const id = templateId(kind);
    const via = id ? 'template' : 'text';
    let r;
    try {
        r = sender ? await sender({ via, mobile, templateId: id, values, text })
            : id ? await mazbot.sendTemplateTo(mobile, values, id) : await mazbot.sendTextToPhone(mobile, text);
    } catch (e) { r = { ok: false, error: e.message }; }
    const ok = Boolean(r && r.ok);
    let error = ok ? null : String((r && r.error) || 'failed').slice(0, 300);
    // Without a template, a plain message reaches the customer only within 24 hours of their last message
    if (!ok && via === 'text') error = `لم تصل (لا يوجد قالب معتمد، والرسالة النصية تصل فقط خلال 24 ساعة من آخر رسالة من العميل) — ${error}`;
    db.prepare('INSERT INTO invoice_messages (invoice_id, payment_id, kind, phone, via, ok, error, sent_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(inv.id, payment ? payment.id : null, kind, mobile, via, ok ? 1 : 0, error, by);
    if (ok) {
        const lead = db.prepare('SELECT * FROM leads WHERE phone = ?').get(mobile);
        if (lead) {
            require('./leads').addMessage(db, lead, 'system',
                `📤 أُرسلت ${KINDS[kind].label} ${inv.number} للعميل على واتساب${payment ? ` (${money(payment.amount)} ر.ع)` : ''} — المتبقي ${money(inv.balance)} ر.ع`, { author: by });
        }
    }
    return { ok, via, error, message: text };
}

/* What was sent about an invoice, newest first */
function history(db, invoiceId) {
    ensureTable(db);
    return db.prepare('SELECT * FROM invoice_messages WHERE invoice_id = ? ORDER BY id DESC LIMIT 30').all(Number(invoiceId))
        .map((m) => ({ ...m, ok: Boolean(m.ok), kind_label: (KINDS[m.kind] || {}).label || m.kind }));
}

module.exports = { KINDS, ensureTable, status, send, history, content, mobileOf, setSenderForTests };
