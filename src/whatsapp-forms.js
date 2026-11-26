/* =============================================================
   «طلب عرض سعر – بوابات ردما»: a WhatsApp form (MazBot form 12) the
   customer fills in; MazBot sends whatsapp_form.submitted to our webhook.
   - The raw event is kept whole (JSON), once per event id: MazBot tries a
     delivery up to 5 times, and the same id again changes nothing.
   - The answers are read whatever their shape (MazBot's documentation does
     not show it): every key / label in the event is matched to name, mobile,
     wilayah, gate type, width and height (cm), notes and the site visit — in Arabic or
     English; what is not understood is kept for the office to see.
   - Processing: the customer joins «متابعة العملاء» (by the mobile), waiting
     for a person, with the answers in their log; a «yes» to the site visit is
     an inspection request in «طلبات المواعيد» (approved by the office as usual).
   - Not a quote: the form has no height, so it cannot be priced. The office
     presses «تسعير الآن» (the quote builder, filled from the form).
   - Kept as received: a later fix to the reading can process it again.
   ============================================================= */
const crypto = require('node:crypto');
const leads = require('./leads');
const customers = require('./customers');

const TYPE = 'whatsapp_form.submitted';
const STATUSES = { new: 'جديد – من نموذج واتساب', contacted: 'تم التواصل', priced: 'تم التسعير', closed: 'مغلق', error: 'تعذرت المعالجة' };
const GATES = { rolling_shutter: 'رول شتر', overhead: 'أوفرهيد' };
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const err = (status, message) => Object.assign(new Error(message), { status });

const ready = new WeakSet();
function ensureTable(db) {
    if (ready.has(db)) return;
    ready.add(db);
    db.exec(`CREATE TABLE IF NOT EXISTS whatsapp_form_submissions (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id            TEXT NOT NULL UNIQUE,
        account             TEXT,
        form_id             TEXT,
        raw_json            TEXT NOT NULL,
        name                TEXT,
        phone               TEXT,
        region_text         TEXT,
        region_id           INTEGER,
        gate_type           TEXT,
        width_cm            REAL,
        height_cm           REAL,
        notes               TEXT,
        inspection          INTEGER,
        unmatched_json      TEXT,
        status              TEXT NOT NULL DEFAULT 'new',
        lead_id             INTEGER,
        service_request_id  INTEGER,
        error               TEXT,
        received_at         TEXT NOT NULL DEFAULT (datetime('now')),
        processed_at        TEXT,
        updated_at          TEXT
    ); CREATE INDEX IF NOT EXISTS whatsapp_form_phone ON whatsapp_form_submissions (phone);`);
    // Kept before the form asked for the height (3.62.2)
    const cols = db.prepare('PRAGMA table_info(whatsapp_form_submissions)').all().map((c) => c.name);
    if (!cols.includes('height_cm')) db.exec('ALTER TABLE whatsapp_form_submissions ADD COLUMN height_cm REAL');
}

/* The event is a form answer: its type, or MazBot's X-Mazbot-Event-Type header */
const isFormEvent = (event, headerType) => (event && event.type === TYPE) || String(headerType || '').trim() === TYPE;

/* ---------------- Reading the answers, whatever their shape ---------------- */

/* A size in cm: «400», «٤٠٠ سم», «4 م» / «4.2» (metres: up to 10) */
const cm = (value) => {
    const n = Number(String(value ?? '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/٫/g, '.').replace(/[^\d.]/g, ''));
    if (!(n > 0)) return null;
    return Math.round((n <= 10 ? n * 100 : n) * 10) / 10;
};
const toAscii = (s) => String(s ?? '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/٫/g, '.');
/* A value as text: a choice {id, title} → its title; a list → joined */
function text(v) {
    if (v == null) return '';
    if (Array.isArray(v)) return v.map(text).filter(Boolean).join('، ');
    if (typeof v === 'object') return text(v.title ?? v.label ?? v.text ?? v.value ?? v.name ?? v.id ?? '');
    return String(v).trim();
}
const LABEL_KEYS = ['label', 'question', 'title', 'field', 'field_name', 'name', 'key', 'id', 'question_text'];
const VALUE_KEYS = ['value', 'answer', 'response', 'text', 'selected', 'values', 'answer_text', 'selection'];
const META = /^(id|type|created_at|submitted_at|updated_at|client_id|contact_id|form_id|form_name|flow_id|flow_token|screen|version|timestamp|message_id|delivery_id|event|status|response_id)$/i;

/* One answer as an object: {label, value} / {question, answer} / {id, label, value: {id, title}} → [label, value];
   a choice {id, title} alone is a value, not an answer */
function asPair(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const vk = VALUE_KEYS.find((k) => item[k] !== undefined);
    if (!vk) return null;
    const lk = LABEL_KEYS.find((k) => k !== vk && typeof item[k] === 'string' && item[k].trim());
    return lk ? [item[lk], item[vk]] : null;
}

/* Every (label, value) pair in the event's data: plain keys, answers as objects (in a list or under each
   field's id — MazBot sends {"<field id>": {"label": "رقم الجوال", "value": "…"}}) */
function pairs(node, out = []) {
    if (node == null) return out;
    if (Array.isArray(node)) {
        for (const item of node) {
            const p = asPair(item);
            if (p) out.push(p);
            else pairs(item, out);
        }
        return out;
    }
    if (typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
            const p = asPair(v);
            if (p) out.push(p);
            else if (v && typeof v === 'object' && !(Object.keys(v).length <= 3 && ('title' in v || 'id' in v))) pairs(v, out);
            else out.push([k, v]);
        }
    }
    return out;
}

/* Which field a label is (the order matters: «عرض الفتحة» is the width, «ارتفاع الفتحة» the height, «نوع البوابة» the gate) */
const FIELDS = [
    ['height', /height|tall|ارتفاع|طول/i],
    ['inspection', /inspect|visit|survey|site|معاين|زيار/i],
    ['width', /width|wide|عرض/i],
    ['gate', /gate|door|product|shutter|نوع|بواب/i],
    ['notes', /note|comment|remark|message|ملاحظ|تفاصيل/i],
    ['phone', /phone|mobile|whats|tel|جوال|هاتف|رقم/i],
    ['region', /wilay|region|area|city|location|governorate|ولاي|منطق|مدين|محافظ/i],
    ['name', /name|اسم/i]
];
const gateOf = (v) => (/رول|شتر|roll|shutter/i.test(v) ? 'rolling_shutter' : /أوفر|اوفر|over|section|سكشن/i.test(v) ? 'overhead' : null);
/* «نعم» / «لا», also as a choice's id («0_نعم», «yes_option») */
const yesNo = (raw) => {
    const v = String(raw).trim().replace(/^\d+_/, '').replace(/_option$/i, '').replace(/_/g, ' ').trim();
    return /^(نعم|ايوه|أيوه|yes|y|true|1)$/i.test(v) ? 1 : /^(لا|no|n|false|0)$/i.test(v) ? 0 : null;
};

/**
 * The answers of one event: { name, phone, region_text, gate_type, width_cm, height_cm, notes, inspection, unmatched[] }.
 * The mobile falls back to the WhatsApp contact that sent it.
 */
function extract(event) {
    const data = (event && event.data) || {};
    const out = { name: null, phone: null, region_text: null, gate_type: null, width_cm: null, height_cm: null, notes: null, inspection: null, unmatched: [] };
    const contact = data.contact || data.customer || {};
    // The answers only: the WhatsApp contact that sent it is the fallback for the name and mobile, not an answer
    const answers = Object.fromEntries(Object.entries(data).filter(([k]) => !['contact', 'customer'].includes(k)));
    for (const [rawLabel, rawValue] of pairs(answers)) {
        const label = String(rawLabel || '');
        if (META.test(label)) continue;
        const value = text(rawValue);
        if (!value) continue;
        const field = (FIELDS.find(([, re]) => re.test(label)) || [])[0];
        if (field === 'inspection' && out.inspection == null && yesNo(value) != null) { out.inspection = yesNo(value); continue; }
        if ((field === 'width' && out.width_cm == null) || (field === 'height' && out.height_cm == null)) {
            const n = cm(value);
            if (n) { out[field === 'width' ? 'width_cm' : 'height_cm'] = n; continue; }
        }
        if (field === 'gate' && !out.gate_type && gateOf(value)) { out.gate_type = gateOf(value); continue; }
        if (field === 'notes' && !out.notes) { out.notes = clip(value, 1000); continue; }
        if (field === 'phone' && !out.phone && toAscii(value).replace(/\D/g, '').length >= 8) { out.phone = toAscii(value); continue; }
        if (field === 'region' && !out.region_text) { out.region_text = clip(value, 120); continue; }
        if (field === 'name' && !out.name && !/^\d+$/.test(value)) { out.name = clip(value, 120); continue; }
        // By the value alone, when the label said nothing
        if (!out.gate_type && gateOf(value) && value.length <= 30) { out.gate_type = gateOf(value); continue; }
        out.unmatched.push({ label: clip(label, 80), value: clip(value, 300) });
    }
    if (!out.phone) {
        const fallback = text(contact.phone || contact.wa_id || data.phone || data.from || data.wa_id || '');
        if (toAscii(fallback).replace(/\D/g, '').length >= 8) out.phone = toAscii(fallback);
    }
    if (!out.name) out.name = clip(text(contact.name || data.name || ''), 120) || null;
    out.phone = out.phone ? customers.normalizePhone(out.phone) : null;
    return out;
}

/* A wilayah written in English (the form is free text): its Arabic name, as the regions are kept */
const WILAYAT_EN = {
    buraimi: 'البريمي', mahdah: 'محضة', mahda: 'محضة', sunaynah: 'السنينة', sunainah: 'السنينة', nizwa: 'نزوى', nizwah: 'نزوى', bahla: 'بهلاء', bahlaa: 'بهلاء',
    manah: 'منح', hamra: 'الحمراء', alhamra: 'الحمراء', adam: 'أدم', izki: 'إزكي', samail: 'سمائل', sumail: 'سمائل', bidbid: 'بدبد',
    jabalakhdar: 'الجبل الأخضر', ibri: 'عبري', yanqul: 'ينقل', dhank: 'ضنك', haima: 'هيماء', haimaa: 'هيماء', mahout: 'محوت', mahoot: 'محوت',
    duqm: 'الدقم', jazer: 'الجازر', jazir: 'الجازر', rustaq: 'الرستاق', rustaque: 'الرستاق', awabi: 'العوابي', nakhal: 'نخل', wadimaawil: 'وادي المعاول',
    barka: 'بركاء', barkaa: 'بركاء', musannah: 'المصنعة', suwaiq: 'السويق', suwayq: 'السويق', sur: 'صور', soor: 'صور', kamil: 'الكامل والوافي',
    jalanbanibuhasan: 'جعلان بني بو حسن', jalanbanibuali: 'جعلان بني بو علي', masirah: 'مصيرة', masira: 'مصيرة', sohar: 'صحار', suhar: 'صحار',
    shinas: 'شناص', liwa: 'لوى', saham: 'صحم', khaburah: 'الخابورة', khabura: 'الخابورة', ibra: 'إبراء', mudhaibi: 'المضيبي', mudaybi: 'المضيبي',
    bidiyah: 'بدية', bidiya: 'بدية', qabil: 'القابل', wadibanikhalid: 'وادي بني خالد', dima: 'دماء والطائيين', sinaw: 'سناو', salalah: 'صلالة', salala: 'صلالة',
    taqah: 'طاقة', taqa: 'طاقة', mirbat: 'مرباط', rakhyut: 'رخيوت', thumrait: 'ثمريت', dhalkut: 'ضلكوت', mazyunah: 'المزيونة', muqshin: 'مقشن',
    shalim: 'شليم وجزر الحلانيات', sadah: 'سدح', muscat: 'مسقط', muttrah: 'مطرح', matrah: 'مطرح', bausher: 'بوشر', bowsher: 'بوشر', seeb: 'السيب', alseeb: 'السيب',
    amerat: 'العامرات', amarat: 'العامرات', quriyat: 'قريات', qurayyat: 'قريات', khasab: 'خصب', dibba: 'دبا', daba: 'دبا', bukha: 'بخا', madha: 'مدحاء'
};
function arabicWilayah(text) {
    const words = String(text || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
    const joined = words.join('').replace(/^al/, '');
    if (WILAYAT_EN[joined]) return WILAYAT_EN[joined];
    for (const w of words) { const k = w.replace(/^al-?/, ''); if (WILAYAT_EN[k]) return WILAYAT_EN[k]; }
    return null;
}

/* ---------------- Receiving and processing ---------------- */

/**
 * Keep the event (raw, whole) once per id. Returns { id, duplicate }. eventId: the event's id, else MazBot's
 * delivery id, else a hash of the body.
 */
function receive(db, event, { account = 'templates', deliveryId = null, raw = '' } = {}) {
    ensureTable(db);
    const eventId = clip((event && event.id) || deliveryId || crypto.createHash('sha256').update(String(raw || JSON.stringify(event))).digest('hex'), 120);
    const existing = db.prepare('SELECT id FROM whatsapp_form_submissions WHERE event_id = ?').get(eventId);
    if (existing) return { id: existing.id, duplicate: true };
    const d = (event && event.data) || {};
    const formId = clip(d.form_id ?? d.formId ?? (d.form && (d.form.id ?? d.form.form_id)) ?? '', 40) || null;
    const info = db.prepare('INSERT INTO whatsapp_form_submissions (event_id, account, form_id, raw_json) VALUES (?, ?, ?, ?)')
        .run(eventId, account, formId, JSON.stringify(event ?? null));
    return { id: Number(info.lastInsertRowid), duplicate: false };
}

/* What the follow-up log and the inspection request say */
function summary(f, regionName) {
    return [
        '📝 نموذج واتساب «طلب عرض سعر – بوابات ردما»',
        f.name ? `الاسم: ${f.name}` : null,
        f.phone ? `الجوال: +${f.phone}` : null,
        regionName || f.region_text ? `الولاية/المنطقة: ${regionName || f.region_text}` : null,
        f.gate_type ? `نوع البوابة: ${GATES[f.gate_type]}` : null,
        f.width_cm ? `عرض الفتحة: ${f.width_cm} سم` : null,
        f.height_cm ? `ارتفاع الفتحة: ${f.height_cm} سم` : null,
        f.notes ? `ملاحظات: ${f.notes}` : null,
        f.inspection == null ? null : `زيارة معاينة: ${f.inspection ? 'نعم' : 'لا'}`
    ].filter(Boolean).join('\n');
}

/**
 * Read the answers and act on them: the customer in «متابعة العملاء» (waiting for a person), and an inspection
 * request when asked. Again on the same submission (after a fix to the reading): the fields are read again; the
 * customer is not told twice and no second inspection request is made.
 */
async function processSubmission(db, id, { notifyStaff = true } = {}) {
    ensureTable(db);
    const row = db.prepare('SELECT * FROM whatsapp_form_submissions WHERE id = ?').get(Number(id));
    if (!row) throw err(404, 'الطلب غير موجود');
    let event = null;
    try { event = JSON.parse(row.raw_json); } catch { /* kept as received */ }
    const f = extract(event);
    let regionId = null;
    let regionName = null;
    if (f.region_text) {
        const doors = require('./doors');
        let matches = doors.findRegions(db, f.region_text);
        if (matches.length !== 1 && arabicWilayah(f.region_text)) matches = doors.findRegions(db, arabicWilayah(f.region_text));
        if (matches.length === 1) { regionId = matches[0].id; regionName = `${matches[0].name}، ${matches[0].governorate}`; }
    }
    const set = { name: f.name, phone: f.phone, region_text: f.region_text, region_id: regionId, gate_type: f.gate_type, width_cm: f.width_cm, height_cm: f.height_cm,
        notes: f.notes, inspection: f.inspection, unmatched_json: JSON.stringify(f.unmatched) };
    if (!f.phone || f.phone.length < 8) {
        db.prepare(`UPDATE whatsapp_form_submissions SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')}, status = 'error', error = ?, processed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
            .run(...Object.values(set), 'لم يُعثر على رقم الجوال في النموذج', row.id);
        return get(db, row.id);
    }
    const first = !row.lead_id;
    const lead = leads.touch(db, { key: leads.phoneKey(f.phone), channel: 'whatsapp', name: f.name, phone: f.phone });
    if (first) {
        leads.addMessage(db, lead, 'customer', summary(f, regionName));
        leads.humanRequested(db, lead.contact_key, `نموذج واتساب: ${f.gate_type ? GATES[f.gate_type] : 'طلب عرض سعر'}${f.width_cm ? ` بعرض ${f.width_cm}${f.height_cm ? `×${f.height_cm}` : ''} سم` : ''}${regionName || f.region_text ? ` — ${regionName || f.region_text}` : ''}`);
    }
    let serviceRequestId = row.service_request_id;
    if (f.inspection === 1 && !serviceRequestId) {
        const requests = require('./servicerequests');
        try {
            const r = requests.create(db, {
                kind: 'inspection', customer_name: f.name || 'عميل نموذج واتساب', customer_phone: f.phone, location: regionName || f.region_text,
                description: `معاينة وقياس — ${summary(f, regionName).split('\n').slice(1).join(' / ')}`
            }, { source: 'whatsapp_form' });
            serviceRequestId = r.id;
            if (notifyStaff) requests.notifyStaff(db, r).catch((e) => console.error('[whatsapp-forms] notify', e.message));
        } catch (e) {
            leads.addMessage(db, lead, 'system', `⚠️ لم يُنشأ طلب المعاينة من النموذج: ${e.message}`);
        }
    }
    const status = row.status === 'error' || row.status === 'new' ? 'new' : row.status;
    db.prepare(`UPDATE whatsapp_form_submissions SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')}, status = ?, error = NULL, lead_id = ?, service_request_id = ?,
                processed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
        .run(...Object.values(set), status, lead.id, serviceRequestId || null, row.id);
    return get(db, row.id);
}

/* ---------------- The office's view ---------------- */

/* The latest quote for the same mobile made after the form (the office priced it) */
const quoteAfter = (db, s) => (s.phone ? db.prepare(`SELECT id, ref, total, created_at FROM quotes WHERE substr(replace(customer_phone, '+', ''), -8) = ? AND created_at >= ?
                                                     ORDER BY id DESC LIMIT 1`).get(s.phone.slice(-8), s.received_at) || null : null);

function view(db, s, { raw = false } = {}) {
    const region = s.region_id ? db.prepare('SELECT name, governorate FROM regions WHERE id = ?').get(s.region_id) : null;
    const sr = s.service_request_id ? db.prepare('SELECT ref, status FROM service_requests WHERE id = ?').get(s.service_request_id) : null;
    let unmatched = [];
    try { unmatched = JSON.parse(s.unmatched_json || '[]'); } catch { unmatched = []; }
    return {
        id: s.id, event_id: s.event_id, account: s.account, form_id: s.form_id, received_at: s.received_at, processed_at: s.processed_at,
        status: s.status, status_label: STATUSES[s.status] || s.status, error: s.error,
        name: s.name, phone: s.phone, region_text: s.region_text, region_id: s.region_id, region: region ? [region.name, region.governorate].filter(Boolean).join('، ') : null,
        gate_type: s.gate_type, gate_label: s.gate_type ? GATES[s.gate_type] : null, width_cm: s.width_cm, height_cm: s.height_cm, notes: s.notes, inspection: s.inspection,
        unmatched, lead_id: s.lead_id, service_request: sr, quote: quoteAfter(db, s),
        ...(raw ? { raw: (() => { try { return JSON.parse(s.raw_json); } catch { return s.raw_json; } })() } : {})
    };
}

function get(db, id, opts) {
    ensureTable(db);
    const s = db.prepare('SELECT * FROM whatsapp_form_submissions WHERE id = ?').get(Number(id));
    if (!s) throw err(404, 'الطلب غير موجود');
    return view(db, s, opts);
}

function list(db, { status = '' } = {}) {
    ensureTable(db);
    const rows = status
        ? db.prepare('SELECT * FROM whatsapp_form_submissions WHERE status = ? ORDER BY id DESC LIMIT 200').all(status)
        : db.prepare('SELECT * FROM whatsapp_form_submissions ORDER BY id DESC LIMIT 200').all();
    const counts = Object.fromEntries(db.prepare('SELECT status, COUNT(*) AS n FROM whatsapp_form_submissions GROUP BY status').all().map((r) => [r.status, r.n]));
    return { submissions: rows.map((s) => view(db, s)), statuses: STATUSES, counts };
}

function setStatus(db, id, status) {
    ensureTable(db);
    if (!STATUSES[status] || status === 'error') throw err(400, 'الحالة غير صالحة');
    const r = db.prepare("UPDATE whatsapp_form_submissions SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, Number(id));
    if (!r.changes) throw err(404, 'الطلب غير موجود');
    return get(db, id);
}

module.exports = { arabicWilayah, TYPE, STATUSES, GATES, ensureTable, isFormEvent, extract, receive, processSubmission, get, list, setStatus };
