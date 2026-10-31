/* =============================================================
   Customer follow-up (WhatsApp, website chat, calculators).
   - One lead per customer: 'tel:<phone>' for WhatsApp and the calculators
     (the same number joins both), 'web:<session>' for a website chat.
   - A readable log of the conversation (customer / assistant / staff /
     system), kept apart from the AI's own history (which is reset).
   - Status, the employee following the customer, the next follow-up
     date, and notes: follow-up reports, recommendations and handovers
     to another employee.
   ============================================================= */

const STATUSES = {
    new: 'جديد',
    needs_staff: 'يطلب موظفاً',
    following: 'قيد المتابعة',
    waiting: 'بانتظار العميل',
    won: 'تم البيع',
    lost: 'لم يتم'
};
const OPEN_STATUSES = ['new', 'needs_staff', 'following', 'waiting'];
const NOTE_KINDS = { report: 'تقرير متابعة', recommendation: 'توصية', handover: 'تسليم لموظف آخر', note: 'ملاحظة' };
const CHANNELS = { whatsapp: 'واتساب', website: 'الموقع', calculator: 'الحاسبة' };
const MAX_MESSAGES = 400; // per lead; older ones are dropped

const err = (status, message) => Object.assign(new Error(message), { status });
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

const phoneKey = (phone) => {
    const digits = String(phone || '').replace(/\D/g, '');
    return digits ? 'tel:' + digits : null;
};

/* Find or create the lead of a contact key; fills a missing name or phone */
function touch(db, { key, channel, name = null, phone = null }) {
    if (!key) return null;
    let lead = db.prepare('SELECT * FROM leads WHERE contact_key = ?').get(key);
    if (!lead) {
        const info = db.prepare(`INSERT INTO leads (contact_key, channel, name, phone, status, created_at, last_activity_at)
                                 VALUES (?, ?, ?, ?, 'new', ?, ?)`)
            .run(key, CHANNELS[channel] ? channel : 'calculator', clip(name, 120) || null, clip(phone, 20) || null, now(), now());
        return db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(info.lastInsertRowid));
    }
    const fill = {};
    if (name && !lead.name) fill.name = clip(name, 120);
    if (phone && !lead.phone) fill.phone = clip(phone, 20);
    if (Object.keys(fill).length) {
        db.prepare(`UPDATE leads SET ${Object.keys(fill).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(fill), lead.id);
        lead = { ...lead, ...fill };
    }
    return lead;
}

/* A closed lead that writes again is open again */
function addMessage(db, lead, role, text, { author = null } = {}) {
    if (!lead || !String(text || '').trim()) return;
    const at = now();
    db.prepare('INSERT INTO lead_messages (lead_id, role, author, text, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(lead.id, role, author, clip(text, 4000), at);
    const reopen = role === 'customer' && ['won', 'lost'].includes(lead.status) ? ", status = 'following'" : '';
    db.prepare(`UPDATE leads SET last_activity_at = ?, last_message = ?, last_role = ?,
                    message_count = message_count + 1${reopen} WHERE id = ?`)
        .run(at, clip(text, 200), role, lead.id);
    const extra = db.prepare('SELECT COUNT(*) AS n FROM lead_messages WHERE lead_id = ?').get(lead.id).n - MAX_MESSAGES;
    if (extra > 0) {
        db.prepare('DELETE FROM lead_messages WHERE id IN (SELECT id FROM lead_messages WHERE lead_id = ? ORDER BY id LIMIT ?)').run(lead.id, extra);
    }
}

/* ---- Called by the channels ---- */

function customerMessage(db, { key, channel, name, phone, text }) {
    const lead = touch(db, { key, channel, name, phone });
    addMessage(db, lead, 'customer', text);
    return lead;
}

function assistantMessage(db, key, text) {
    const lead = db.prepare('SELECT * FROM leads WHERE contact_key = ?').get(key);
    addMessage(db, lead, 'assistant', text);
}

/* "Talk to a person": the lead waits for an employee */
function humanRequested(db, key, summary) {
    const lead = db.prepare('SELECT * FROM leads WHERE contact_key = ?').get(key);
    if (!lead) return;
    if (!['following', 'waiting'].includes(lead.status)) db.prepare("UPDATE leads SET status = 'needs_staff' WHERE id = ?").run(lead.id);
    addMessage(db, lead, 'system', '🙋 طلب التواصل مع موظف: ' + summary);
}

/* Every saved quote joins its customer's lead (calculator, WhatsApp, website) */
function quoteCreated(db, quote, { key = null, channel = 'calculator' } = {}) {
    const lead = touch(db, { key: key || phoneKey(quote.customer_phone), channel, name: quote.customer_name, phone: quote.customer_phone });
    if (!lead) return;
    if (quote.customer_phone && !lead.phone) db.prepare('UPDATE leads SET phone = ? WHERE id = ?').run(quote.customer_phone, lead.id);
    addMessage(db, lead, 'system', `📄 عرض سعر ${quote.ref} — ${Number(quote.total).toFixed(2)} ر.ع`);
}

/* ---- Admin ---- */

function list(db, { status = '', assigned = '', channel = '', q = '', open = false } = {}) {
    const where = [];
    const args = [];
    if (status) { where.push('status = ?'); args.push(status); }
    if (open) {
        where.push(`status IN (${OPEN_STATUSES.map(() => '?').join(',')})`);
        args.push(...OPEN_STATUSES);
    }
    if (assigned === '-') where.push("IFNULL(assigned_to, '') = ''");
    else if (assigned) { where.push('assigned_to = ?'); args.push(assigned); }
    if (channel) { where.push('channel = ?'); args.push(channel); }
    if (q) {
        where.push('(IFNULL(name, \'\') LIKE ? OR IFNULL(phone, \'\') LIKE ? OR IFNULL(last_message, \'\') LIKE ?)');
        args.push(`%${q}%`, `%${q.replace(/\D/g, '') || q}%`, `%${q}%`);
    }
    return db.prepare(`SELECT l.*,
            (SELECT COUNT(*) FROM quotes WHERE l.phone IS NOT NULL AND customer_phone = l.phone) AS quote_count,
            (SELECT text FROM lead_notes WHERE lead_id = l.id ORDER BY id DESC LIMIT 1) AS last_note
        FROM leads l ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY CASE status WHEN 'needs_staff' THEN 0 WHEN 'new' THEN 1 ELSE 2 END, last_activity_at DESC LIMIT 300`).all(...args);
}

function detail(db, id) {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(id));
    if (!lead) throw err(404, 'العميل غير موجود');
    return {
        lead,
        messages: db.prepare('SELECT * FROM lead_messages WHERE lead_id = ? ORDER BY id').all(lead.id),
        notes: db.prepare('SELECT * FROM lead_notes WHERE lead_id = ? ORDER BY id DESC').all(lead.id),
        quotes: lead.phone
            ? db.prepare('SELECT id, ref, total, status, created_at, details_json FROM quotes WHERE customer_phone = ? ORDER BY id DESC LIMIT 50')
                .all(lead.phone).map(({ details_json, ...q }) => ({ ...q, calculator: (JSON.parse(details_json || '{}') || {}).calculator || null }))
            : []
    };
}

/* Status, employee, next follow-up date, name. A change of employee is recorded as a handover. */
function update(db, id, patch, author) {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(id));
    if (!lead) throw err(404, 'العميل غير موجود');
    const set = {};
    if (patch.status !== undefined) {
        if (!STATUSES[patch.status]) throw err(400, 'الحالة غير صالحة');
        set.status = patch.status;
    }
    if (patch.assigned_to !== undefined) set.assigned_to = clip(patch.assigned_to, 80) || null;
    if (patch.next_follow_up !== undefined) {
        const d = clip(patch.next_follow_up, 10);
        if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw err(400, 'تاريخ المتابعة غير صالح');
        set.next_follow_up = d || null;
    }
    if (patch.name !== undefined) set.name = clip(patch.name, 120) || null;
    if (!Object.keys(set).length) return detail(db, lead.id);
    db.prepare(`UPDATE leads SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(set), lead.id);
    if ('assigned_to' in set && set.assigned_to !== lead.assigned_to) {
        const text = set.assigned_to
            ? `${lead.assigned_to ? `تم تحويل المتابعة من ${lead.assigned_to} إلى ${set.assigned_to}` : `تم إسناد المتابعة إلى ${set.assigned_to}`}`
            : `أُلغي إسناد المتابعة (كان: ${lead.assigned_to})`;
        addNote(db, lead.id, { kind: 'handover', text: text + (patch.handover_text ? `\n${patch.handover_text}` : '') }, author, { system: true });
    }
    if ('status' in set && set.status !== lead.status) {
        addMessage(db, lead, 'system', `الحالة: ${STATUSES[lead.status] || lead.status} ← ${STATUSES[set.status]}${author ? ` (${author})` : ''}`);
    }
    return detail(db, lead.id);
}

function addNote(db, leadId, { kind, text }, author, { system = false } = {}) {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ?').get(Number(leadId));
    if (!lead) throw err(404, 'العميل غير موجود');
    const k = NOTE_KINDS[kind] ? kind : 'note';
    const body = clip(text, 4000);
    if (!body) throw err(400, 'اكتب نص التقرير أو الملاحظة');
    db.prepare('INSERT INTO lead_notes (lead_id, kind, author, text, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(lead.id, k, clip(author, 80) || (system ? 'النظام' : null), body, now());
    db.prepare('UPDATE leads SET last_activity_at = ? WHERE id = ?').run(now(), lead.id);
}

function staffMessage(db, leadId, text, author) {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(leadId));
    if (!lead) throw err(404, 'العميل غير موجود');
    addMessage(db, lead, 'staff', text, { author: clip(author, 80) || null });
    if (['new', 'needs_staff'].includes(lead.status)) db.prepare("UPDATE leads SET status = 'following' WHERE id = ?").run(lead.id);
    return lead;
}

/* First run: start the list from the saved quotes, so it is not empty after an update */
function backfill(db) {
    if (db.prepare('SELECT COUNT(*) AS n FROM leads').get().n) return;
    const rows = db.prepare("SELECT * FROM quotes WHERE created_at >= datetime('now', '-120 days') ORDER BY id").all();
    for (const q of rows) {
        const channel = q.source === 'mazbot' ? 'whatsapp' : q.source === 'website' ? 'website' : 'calculator';
        const lead = touch(db, { key: phoneKey(q.customer_phone), channel, name: q.customer_name, phone: q.customer_phone });
        if (!lead) continue;
        db.prepare('INSERT INTO lead_messages (lead_id, role, text, created_at) VALUES (?, ?, ?, ?)')
            .run(lead.id, 'system', `📄 عرض سعر ${q.ref} — ${Number(q.total).toFixed(2)} ر.ع`, q.created_at);
        const status = q.status === 'accepted' || q.status === 'done' ? 'won' : q.status === 'rejected' ? 'lost'
            : q.status === 'contacted' ? 'following' : 'new';
        db.prepare(`UPDATE leads SET last_activity_at = ?, last_message = ?, last_role = 'system', message_count = message_count + 1,
                        created_at = MIN(created_at, ?), status = ? WHERE id = ?`)
            .run(q.created_at, `📄 عرض سعر ${q.ref}`, q.created_at, status, lead.id);
    }
}

module.exports = {
    STATUSES, OPEN_STATUSES, NOTE_KINDS, CHANNELS, phoneKey,
    touch, customerMessage, assistantMessage, humanRequested, quoteCreated,
    list, detail, update, addNote, staffMessage, backfill
};
