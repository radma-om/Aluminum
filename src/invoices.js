/* =============================================================
   Invoices and payments.
   - An invoice is made from a quote: the customer, items and amounts are
     copied, so later changes to the quote or the prices never change an
     issued invoice. A regular invoice (the company is not VAT registered:
     no tax number); the VAT line follows the quote as it was priced.
   - The final amount before VAT can be set when issuing (a discount, or the
     final price of a quote given as a range); the difference shows as an
     adjustment line.
   - Numbers: INV-<year>-0001, sequential per year, never reused — a
     cancelled invoice keeps its number and stays in the list.
   - Payments (deposit, instalments) are recorded against the invoice; the
     paid amount, the balance and the state (unpaid / partial / paid) follow.
   - The deposit asked (المقدم المطلوب): a % of the total or an amount, set
     when issuing (and changeable later). The customer sees it on the
     invoice; any payment counts towards it first, whatever its size.
   ============================================================= */
const crypto = require('node:crypto');
const leads = require('./leads');

const METHODS = { cash: 'نقداً', bank: 'تحويل بنكي', card: 'بطاقة', cheque: 'شيك', other: 'أخرى' };
const PAY_STATES = { unpaid: 'غير مدفوعة', partial: 'مدفوعة جزئياً', paid: 'مدفوعة', cancelled: 'ملغاة' };
const EPS = 0.0005;
const DEPOSIT_TYPES = { percent: 'نسبة', amount: 'مبلغ' };

const err = (status, message) => Object.assign(new Error(message), { status });
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));

function tx(db, fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
        const r = fn();
        db.exec('COMMIT');
        return r;
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
}

/* Invoice row → what the panel and the PDF use: amounts, payments, balance and state */
function withPayments(db, row) {
    if (!row) return null;
    const payments = db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY paid_on, id').all(row.id);
    const paid = round2(payments.reduce((s, p) => s + p.amount, 0));
    const balance = row.status === 'cancelled' ? 0 : round2(row.total - paid);
    const state = row.status === 'cancelled' ? 'cancelled' : paid <= EPS ? 'unpaid' : balance <= EPS ? 'paid' : 'partial';
    const { items_json, details_json, deposit_type, deposit_value, deposit_amount, ...rest } = row;
    // The deposit asked: how much of it is paid, and what is left of it
    const deposit = deposit_amount > EPS ? {
        type: deposit_type, value: deposit_value, amount: round2(deposit_amount),
        label: deposit_type === 'percent' ? `المقدم المطلوب (${Number(deposit_value)}%)` : 'المقدم المطلوب',
        remaining: round2(Math.max(0, deposit_amount - paid)),
        paid: paid >= deposit_amount - EPS
    } : null;
    return {
        ...rest,
        items: JSON.parse(items_json || '[]'),
        details: details_json ? JSON.parse(details_json) : null,
        adjustment: round2(row.subtotal - row.quote_subtotal),
        payments, paid, balance, state, state_label: PAY_STATES[state],
        deposit
    };
}

const get = (db, id) => withPayments(db, db.prepare('SELECT * FROM invoices WHERE id = ?').get(Number(id)));
const byNumber = (db, number) => withPayments(db, db.prepare('SELECT * FROM invoices WHERE number = ?').get(String(number)));
const activeForQuote = (db, quoteId) => db.prepare("SELECT * FROM invoices WHERE quote_id = ? AND status = 'issued'").get(Number(quoteId)) || null;

function nextNumber(db, year) {
    const prefix = `INV-${year}-`;
    const last = db.prepare("SELECT MAX(CAST(substr(number, ?) AS INTEGER)) AS n FROM invoices WHERE number LIKE ?").get(prefix.length + 1, prefix + '%').n || 0;
    return prefix + String(last + 1).padStart(4, '0');
}

/* { type: 'percent' | 'amount', value } on the invoice total → what is stored (null = no deposit asked) */
function cleanDeposit(input, total) {
    if (!input || input.value === '' || input.value === null || input.value === undefined || !Number(input.value)) return null;
    const type = input.type === 'amount' ? 'amount' : 'percent';
    const value = round2(input.value);
    if (!Number.isFinite(value) || value <= 0) throw err(400, 'قيمة المقدم غير صالحة');
    if (type === 'percent' && value > 100) throw err(400, 'نسبة المقدم لا تتجاوز 100%');
    const amount = round2(type === 'percent' ? total * value / 100 : value);
    if (amount > total + EPS) throw err(400, 'المقدم المطلوب أكبر من إجمالي الفاتورة');
    return { type, value, amount };
}

function cleanPayment(input) {
    const amount = round2(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw err(400, 'اكتب مبلغ الدفعة (أكبر من صفر)');
    const method = METHODS[input.method] ? input.method : null;
    if (!method) throw err(400, 'اختر طريقة الدفع');
    const paidOn = String(input.paid_on || leads.localToday()).slice(0, 10);
    if (!isDate(paidOn)) throw err(400, 'تاريخ الدفعة غير صالح');
    return {
        amount, method, paid_on: paidOn,
        reference: String(input.reference || '').trim().slice(0, 80) || null,
        note: String(input.note || '').trim().slice(0, 300) || null
    };
}

/**
 * Issue an invoice from a quote.
 * input: { issue_date?, due_date?, final_subtotal?, customer_address?, notes?, deposit?: { amount, method, ... } }
 */
function createFromQuote(db, quote, input = {}, author = null) {
    if (activeForQuote(db, quote.id)) throw err(400, 'لهذا العرض فاتورة سارية — ألغها أولاً إذا أردت إصدار فاتورة جديدة');
    const details = quote.details || {};
    const range = details.range && details.range.total_to != null && details.range.total_to !== quote.total;
    const hasFinal = input.final_subtotal !== undefined && input.final_subtotal !== null && input.final_subtotal !== '';
    if (range && !hasFinal) {
        throw err(400, 'سعر هذا العرض نطاق (من – إلى): اكتب المبلغ النهائي قبل الضريبة بعد الاتفاق مع العميل');
    }
    const subtotal = hasFinal ? round2(input.final_subtotal) : round2(quote.subtotal);
    if (!Number.isFinite(subtotal) || subtotal <= 0) throw err(400, 'المبلغ النهائي قبل الضريبة غير صالح');
    const vatPercent = Number(quote.vat_percent) || 0;
    const vat = hasFinal ? round2(subtotal * vatPercent / 100) : round2(quote.vat);
    const total = hasFinal ? round2(subtotal + vat) : round2(quote.total);

    const issueDate = String(input.issue_date || leads.localToday()).slice(0, 10);
    if (!isDate(issueDate)) throw err(400, 'تاريخ الفاتورة غير صالح');
    const dueDate = input.due_date ? String(input.due_date).slice(0, 10) : null;
    if (dueDate && (!isDate(dueDate) || dueDate < issueDate)) throw err(400, 'تاريخ الاستحقاق غير صالح (يجب ألا يسبق تاريخ الفاتورة)');
    const deposit = input.deposit && Number(input.deposit.amount) > 0 ? cleanPayment(input.deposit) : null;
    if (deposit && deposit.amount > total + EPS) throw err(400, 'العربون أكبر من إجمالي الفاتورة');
    const asked = cleanDeposit(input.deposit_required, total);

    const id = tx(db, () => {
        // Re-check while the write lock is held. The initial check above is
        // only a fast failure path; it cannot protect against two concurrent
        // requests issuing the same quote.
        if (activeForQuote(db, quote.id)) throw err(400, 'لهذا العرض فاتورة سارية — ألغها أولاً إذا أردت إصدار فاتورة جديدة');
        const number = nextNumber(db, issueDate.slice(0, 4));
        const info = db.prepare(`INSERT INTO invoices (number, quote_id, access_key, customer_name, customer_phone, customer_city, customer_address,
                                    items_json, details_json, quote_subtotal, subtotal, vat_percent, vat, total, issue_date, due_date, notes, created_by,
                                    deposit_type, deposit_value, deposit_amount)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(number, quote.id, crypto.randomBytes(16).toString('hex'), quote.customer_name, quote.customer_phone, quote.customer_city || null,
                String(input.customer_address || '').trim().slice(0, 200) || null,
                JSON.stringify(quote.items), quote.details ? JSON.stringify(quote.details) : null,
                round2(quote.subtotal), subtotal, vatPercent, vat, total, issueDate, dueDate,
                String(input.notes || '').trim().slice(0, 1000) || null, author,
                asked ? asked.type : null, asked ? asked.value : null, asked ? asked.amount : null);
        const invoiceId = Number(info.lastInsertRowid);
        if (deposit) {
            db.prepare('INSERT INTO payments (invoice_id, amount, method, paid_on, reference, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .run(invoiceId, deposit.amount, deposit.method, deposit.paid_on, deposit.reference, deposit.note || 'عربون', author);
        }
        // The quote is accepted; the customer is won
        if (['new', 'contacted'].includes(quote.status)) db.prepare("UPDATE quotes SET status = 'accepted' WHERE id = ?").run(quote.id);
        const lead = db.prepare('SELECT * FROM leads WHERE phone = ?').get(quote.customer_phone);
        if (lead) {
            leads.addMessage(db, lead, 'system', `🧾 فاتورة ${number} — ${total.toFixed(2)} ر.ع${author ? ` (${author})` : ''}`);
            if (leads.OPEN_STATUSES.includes(lead.status)) db.prepare("UPDATE leads SET status = 'won' WHERE id = ?").run(lead.id);
        }
        return invoiceId;
    });
    return get(db, id);
}

function addPayment(db, invoiceId, input, author = null) {
    const p = cleanPayment(input);
    tx(db, () => {
        // Read the balance after acquiring the write lock. Otherwise two
        // simultaneous payments can both pass the stale balance check.
        const inv = get(db, invoiceId);
        if (!inv) throw err(404, 'الفاتورة غير موجودة');
        if (inv.status === 'cancelled') throw err(400, 'الفاتورة ملغاة — لا تُسجَّل عليها دفعات');
        if (p.amount > inv.balance + EPS) throw err(400, `المبلغ أكبر من المتبقي على الفاتورة (${inv.balance.toFixed(2)} ر.ع)`);
        db.prepare('INSERT INTO payments (invoice_id, amount, method, paid_on, reference, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(inv.id, p.amount, p.method, p.paid_on, p.reference, p.note, author);
    });
    return get(db, invoiceId);
}

function deletePayment(db, invoiceId, paymentId) {
    const info = db.prepare('DELETE FROM payments WHERE id = ? AND invoice_id = ?').run(Number(paymentId), Number(invoiceId));
    if (!info.changes) throw err(404, 'الدفعة غير موجودة');
    return get(db, invoiceId);
}

/* Cancelling keeps the number (the sequence has no gaps); refused while payments remain */
function cancel(db, invoiceId, reason, author = null) {
    const why = String(reason || '').trim().slice(0, 300);
    if (!why) throw err(400, 'اكتب سبب الإلغاء');
    tx(db, () => {
        // Check payments and change status atomically so a payment cannot be
        // inserted after the check but before cancellation.
        const inv = get(db, invoiceId);
        if (!inv) throw err(404, 'الفاتورة غير موجودة');
        if (inv.status === 'cancelled') throw err(400, 'الفاتورة ملغاة من قبل');
        if (inv.payments.length) throw err(400, 'على الفاتورة دفعات مسجّلة — احذفها أولاً (أو سجّل استرداد المبلغ) ثم ألغِ الفاتورة');
        db.prepare("UPDATE invoices SET status = 'cancelled', cancel_reason = ?, cancelled_at = datetime('now') WHERE id = ?")
            .run(why + (author ? ` (${author})` : ''), inv.id);
    });
    return get(db, invoiceId);
}

function update(db, invoiceId, patch) {
    const inv = get(db, invoiceId);
    if (!inv) throw err(404, 'الفاتورة غير موجودة');
    const set = {};
    if (patch.due_date !== undefined) {
        const d = patch.due_date ? String(patch.due_date).slice(0, 10) : null;
        if (d && (!isDate(d) || d < inv.issue_date)) throw err(400, 'تاريخ الاستحقاق غير صالح');
        set.due_date = d;
    }
    if (patch.notes !== undefined) set.notes = String(patch.notes || '').trim().slice(0, 1000) || null;
    if (patch.customer_address !== undefined) set.customer_address = String(patch.customer_address || '').trim().slice(0, 200) || null;
    if (patch.deposit_required !== undefined) {
        if (inv.status === 'cancelled') throw err(400, 'الفاتورة ملغاة');
        const d = cleanDeposit(patch.deposit_required, inv.total);
        Object.assign(set, { deposit_type: d ? d.type : null, deposit_value: d ? d.value : null, deposit_amount: d ? d.amount : null });
    }
    if (Object.keys(set).length) {
        db.prepare(`UPDATE invoices SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(set), inv.id);
    }
    return get(db, inv.id);
}

function list(db, { q = '', state = '', from = '', to = '' } = {}) {
    const where = [];
    const args = [];
    if (q) {
        where.push('(number LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ?)');
        const like = `%${String(q).slice(0, 60)}%`;
        args.push(like, like, `%${String(q).replace(/\D/g, '') || q}%`);
    }
    if (isDate(from)) { where.push('issue_date >= ?'); args.push(from); }
    if (isDate(to)) { where.push('issue_date <= ?'); args.push(to); }
    const rows = db.prepare(`SELECT * FROM invoices ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 500`).all(...args)
        .map((r) => withPayments(db, r));
    return state ? rows.filter((r) => r.state === state) : rows;
}

/* This month's figures for the panel (issued, collected, still owed overall).
   When mineOf is set, match the same customer scope as staff.seesPhones: an
   invoice is visible unless one of the customer's leads is assigned to another
   employee. */
function summary(db, { today = leads.localToday(), mineOf = null } = {}) {
    const month = today.slice(0, 7);
    const scope = mineOf
        ? ` AND NOT EXISTS (SELECT 1 FROM leads scope_lead
                           WHERE scope_lead.phone = i.customer_phone
                             AND scope_lead.assigned_to IS NOT NULL
                             AND TRIM(scope_lead.assigned_to) <> ''
                             AND scope_lead.assigned_to <> ?)`
        : '';
    const args = (values) => mineOf ? [...values, mineOf] : values;
    const issued = db.prepare(`SELECT COUNT(*) AS n, IFNULL(SUM(i.total), 0) AS v FROM invoices i
                               WHERE i.status = 'issued' AND substr(i.issue_date, 1, 7) = ?${scope}`).get(...args([month]));
    const collected = db.prepare(`SELECT IFNULL(SUM(p.amount), 0) AS v FROM payments p JOIN invoices i ON i.id = p.invoice_id
                                  WHERE i.status = 'issued' AND substr(p.paid_on, 1, 7) = ?${scope}`).get(...args([month])).v;
    const owed = db.prepare(`SELECT IFNULL(SUM(i.total - IFNULL((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id), 0)), 0) AS v
                             FROM invoices i WHERE i.status = 'issued'${scope}`).get(...args([])).v;
    const overdue = db.prepare(`SELECT COUNT(*) AS n FROM invoices i WHERE i.status = 'issued' AND i.due_date IS NOT NULL AND i.due_date < ?
                                AND i.total - IFNULL((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id), 0) > ?${scope}`).get(...args([today, EPS])).n;
    return { month, issued_count: issued.n, issued_value: round2(issued.v), collected: round2(collected), outstanding: round2(owed), overdue };
}

module.exports = { createFromQuote, addPayment, deletePayment, cancel, update, list, get, byNumber, activeForQuote, summary, METHODS, PAY_STATES, DEPOSIT_TYPES };
