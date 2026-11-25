/* =============================================================
   The internal API for another system (panorama-commerce): /api/internal/v1
   Panorama's installations are done by Radma's technicians, and the
   customers' record is Radma's, so Panorama creates / updates a
   customer and opens an installation work order here.
   - Off entirely until INTERNAL_API_KEY and INTERNAL_API_HMAC_SECRET
     are set: every request → 503 {"status":"unavailable"}.
   - Independent of the admin panel: ADMIN_TOKEN and staff sessions do
     not open it, and its key does not open /api/admin.
   - Every request (all must pass, else 401 {"status":"forbidden"}):
       Authorization: Bearer <INTERNAL_API_KEY>
       X-Timestamp:  Unix seconds, within 300 s of now
       X-Request-Id: a UUID, never seen in the last 24 hours
       X-Signature:  sha256=<hex HMAC-SHA256 with INTERNAL_API_HMAC_SECRET
                     of "<X-Timestamp>.<X-Request-Id>.<the raw body>">
   - POST needs Idempotency-Key: the same key on the same path within
     24 hours returns the saved answer, without doing it again.
   - 60 requests a minute; each one in the activity log as «panorama».
   - Never returns prices, invoices or costs.
   ============================================================= */
const crypto = require('node:crypto');
const express = require('express');
const customers = require('./customers');
const workorders = require('./workorders');
const audit = require('./audit');

const SKEW_SECONDS = 300;
const KEEP_HOURS = 24;
const RATE_PER_MINUTE = 60;
const BUSINESSES = ['panorama'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/* A value pasted in the hosting panel: no spaces or quotes around it */
const cleanEnv = (v) => String(v || '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
const config = () => ({ key: cleanEnv(process.env.INTERNAL_API_KEY), secret: cleanEnv(process.env.INTERNAL_API_HMAC_SECRET) });
/* On only with both secrets — and never with the owner's password as its key (it must not open the admin panel too) */
function isEnabled() {
    const { key, secret } = config();
    return Boolean(key && secret && key !== cleanEnv(process.env.ADMIN_TOKEN));
}

const safeEqual = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const invalid = (message) => Object.assign(new Error(message), { code: 'invalid_arguments' });
const notFound = (message) => Object.assign(new Error(message), { code: 'not_found' });
const STATUS = { invalid_arguments: 422, not_found: 404 };

/* The caller is Panorama: Bearer key, a fresh timestamp, a new request id, and the body signed */
function authenticate(req) {
    const { key, secret } = config();
    const given = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!given || !safeEqual(given, key)) return 'bad_key';
    const ts = String(req.get('x-timestamp') || '');
    if (!/^\d{9,11}$/.test(ts) || Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > SKEW_SECONDS) return 'bad_timestamp';
    const rid = String(req.get('x-request-id') || '');
    if (!UUID.test(rid)) return 'bad_request_id';
    const sig = String(req.get('x-signature') || '');
    const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.alloc(0);
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`${ts}.${rid}.`), raw])).digest('hex');
    if (!/^sha256=[0-9a-f]{64}$/i.test(sig) || !safeEqual(sig.toLowerCase(), expected)) return 'bad_signature';
    return null;
}

/* ---------------- Customers ---------------- */

const SYSTEM = 'panorama';

/**
 * Create the customer, or fill / update the fields sent that are not empty (an empty or missing field never
 * clears what is there). Matched by the phone (with or without 968, or their second phone).
 * Returns { customer, created }.
 */
function upsertCustomer(db, b) {
    const phone = customers.normalizePhone(b.phone);
    if (phone.length < 8 || phone.length > 15) throw invalid('phone');
    const sent = {};
    const take = (field, value, max) => { const v = clip(value, max); if (v) sent[field] = v; };
    take('name', b.name, 120);
    take('email', b.email, 120);
    take('city', b.wilaya, 120);
    take('address', b.address, 200);
    take('map_url', b.map_url, 500);
    const existing = db.prepare('SELECT * FROM customers WHERE phone = ? OR phone2 = ?').get(phone, phone);
    let row;
    try {
        row = existing || customers.ensure(db, { phone });
        if (Object.keys(sent).length) row = customers.update(db, row.id, sent);
    } catch (e) {
        // The record's own checks (an e-mail or a map link that is not valid)
        if (!existing && row) db.prepare('DELETE FROM customers WHERE id = ?').run(row.id);
        throw invalid(e.message);
    }
    return { customer: row, created: !existing };
}

function saveExternalRef(db, customerId, ref) {
    const r = clip(ref, 120);
    if (!r) return;
    db.prepare(`INSERT INTO customer_external_refs (customer_id, system, ref) VALUES (?, ?, ?)
                ON CONFLICT(system, ref) DO UPDATE SET customer_id = excluded.customer_id`).run(customerId, SYSTEM, r);
}

function customersUpsert(db, b) {
    if (b.source !== undefined && b.source !== null && b.source !== SYSTEM) throw invalid('source');
    const { customer, created } = upsertCustomer(db, b);
    saveExternalRef(db, customer.id, b.external_ref);
    return { code: 200, body: { status: 'ok', customer_id: customer.id, created } };
}

/* ---------------- Work orders ---------------- */

function cleanItems(items) {
    if (!Array.isArray(items) || !items.length || items.length > 50) throw invalid('items');
    return items.map((i) => {
        const description = clip(i && i.description, 300);
        const qty = Number(i && i.qty);
        if (!description || !(qty > 0 && qty <= 100000)) throw invalid('items');
        return { description, qty };
    });
}

/* What the order shows the office and the technician: the title, a line per item, the customer's preferred day, the notes */
function describe({ title, items, preferred_date: preferred, notes }) {
    const lines = [title, ...items.map((i) => `• ${i.qty} × ${i.description}`)];
    if (preferred) lines.push(`الموعد المفضل لدى العميل: ${preferred}`);
    if (notes) lines.push(notes);
    return lines.join('\n');
}

const orderView = (o) => ({ work_order_id: o.id, number: o.number });

/**
 * A Panorama installation: the customer first (as in upsert), then a «new» installation work order — the office
 * sets the day and the technician, and only then does the customer hear of it. The same external_ref again
 * returns the order made the first time ({ duplicate: true }).
 */
function workOrdersCreate(db, b, { emit, afterCreate }) {
    if (!BUSINESSES.includes(b.business)) throw invalid('business');
    const ref = clip(b.external_ref, 120);
    if (!ref) throw invalid('external_ref');
    const title = clip(b.title, 200);
    if (!title) throw invalid('title');
    const items = cleanItems(b.items);
    const approvedBy = clip(b.approved_by, 60);
    if (!approvedBy) throw invalid('approved_by');
    const preferred = b.preferred_date ? String(b.preferred_date) : '';
    if (preferred && !(DATE.test(preferred) && !Number.isNaN(Date.parse(preferred + 'T00:00:00Z')))) throw invalid('preferred_date');
    const location = b.location && typeof b.location === 'object' ? b.location : {};
    const notes = clip(b.notes, 1000);

    const dup = db.prepare('SELECT * FROM work_orders WHERE business = ? AND external_ref = ?').get(b.business, ref);
    if (dup) return { code: 200, body: { status: 'ok', ...orderView(dup), duplicate: true } };

    // A customer we do not know needs a name — checked before anything is saved
    const known = db.prepare('SELECT name FROM customers WHERE phone = ? OR phone2 = ?').get(customers.normalizePhone(b.customer_phone), customers.normalizePhone(b.customer_phone));
    if (!clip(b.customer_name, 120) && !(known && known.name)) throw invalid('customer_name');
    const { customer } = upsertCustomer(db, {
        phone: b.customer_phone, name: b.customer_name, wilaya: location.wilaya, address: location.address, map_url: location.map_url
    });
    const name = clip(b.customer_name, 120) || customer.name;
    if (!name) throw invalid('customer_name');
    let order;
    try {
        order = workorders.create(db, {
            kind: 'installation', customer_name: name, customer_phone: customer.phone,
            location: clip(location.wilaya, 120) || null, address: clip(location.address, 200) || null, map_url: clip(location.map_url, 500) || null,
            description: describe({ title, items, preferred_date: preferred, notes })
        }, `panorama: ${approvedBy}`, { notify: false, external: { business: b.business, ref } });
    } catch (e) {
        throw invalid(e.message);
    }
    emit('work_order.created', order);
    afterCreate(order);
    return { code: 201, body: { status: 'ok', ...orderView(order), duplicate: false } };
}

/* Where an order stands — no technician's details, no office notes */
function workOrderByRef(db, ref, business) {
    if (!BUSINESSES.includes(business)) throw invalid('business');
    const o = db.prepare('SELECT * FROM work_orders WHERE business = ? AND external_ref = ?').get(business, clip(ref, 120));
    if (!o) throw notFound('work order');
    return {
        code: 200,
        body: {
            status: 'ok', work_order_id: o.id, number: o.number, order_status: o.status,
            scheduled_date: o.scheduled_date || null, scheduled_time: o.scheduled_time || null, completed_at: o.completed_at || null
        }
    };
}

/* ---------------- The router ---------------- */

/* 60 requests a minute from one address */
function limiter() {
    const hits = new Map();
    const timer = setInterval(() => { const now = Date.now(); for (const [k, t] of hits) if (now - t[t.length - 1] > 60_000) hits.delete(k); }, 60_000);
    timer.unref();
    return (req, res, next) => {
        const now = Date.now();
        const list = (hits.get(req.ip) || []).filter((t) => now - t < 60_000);
        if (list.length >= RATE_PER_MINUTE) return res.status(429).json({ status: 'rate_limited' });
        list.push(now);
        hits.set(req.ip, list);
        next();
    };
}

/**
 * The /api/internal/v1 router. deps: { emit(event, data), afterCreate(order) } — the webhook and the
 * place of the order (the same as the admin path does).
 */
function router(db, deps) {
    const r = express.Router();
    const log = (req, action, details) => audit.record(db, {
        actor: 'panorama', ip: req.ip, action: `المسار الداخلي: ${action}`, method: req.method, path: '/api/internal/v1' + req.path, details
    });

    r.use((req, res, next) => {
        if (!isEnabled()) return res.status(503).json({ status: 'unavailable' });
        next();
    });
    r.use(limiter());
    r.use((req, res, next) => {
        const why = authenticate(req);
        if (why) {
            log(req, 'رُفض طلب', { reason: why });
            return res.status(401).json({ status: 'forbidden' });
        }
        // Each request once: a request id seen in the last 24 hours is a replay
        const rid = req.get('x-request-id');
        const seen = db.prepare(`SELECT 1 FROM internal_requests WHERE request_id = ? AND created_at > datetime('now', ?)`).get(rid, `-${KEEP_HOURS} hours`);
        if (seen) {
            log(req, 'رُفض طلب', { reason: 'replayed_request_id' });
            return res.status(401).json({ status: 'forbidden' });
        }
        db.prepare('INSERT OR REPLACE INTO internal_requests (request_id, idempotency_key, endpoint) VALUES (?, ?, ?)')
            .run(rid, clip(req.get('idempotency-key'), 200) || null, `${req.method} ${req.path}`);
        req.internalRequestId = rid;
        next();
    });

    /* A POST: Idempotency-Key required; the same key on the same path within 24 hours → the saved answer */
    const handle = (action, fn) => (req, res) => {
        const endpoint = `${req.method} ${req.route.path}`;
        const idem = clip(req.get('idempotency-key'), 200);
        const answer = (code, body, extra = {}) => {
            db.prepare('UPDATE internal_requests SET endpoint = ?, status_code = ?, response_json = ? WHERE request_id = ?')
                .run(endpoint, code, code < 500 && req.method === 'POST' ? JSON.stringify(body) : null, req.internalRequestId);
            log(req, action, { status_code: code, request_id: req.internalRequestId, ...(idem ? { idempotency_key: idem } : {}), ...extra });
            res.status(code).json(body);
        };
        if (req.method === 'POST') {
            if (!idem) return answer(422, { status: 'invalid_arguments', field: 'Idempotency-Key' });
            const saved = db.prepare(`SELECT status_code, response_json FROM internal_requests
                                      WHERE idempotency_key = ? AND endpoint = ? AND response_json IS NOT NULL AND request_id != ?
                                      AND created_at > datetime('now', ?) ORDER BY created_at DESC LIMIT 1`)
                .get(idem, endpoint, req.internalRequestId, `-${KEEP_HOURS} hours`);
            if (saved) return answer(saved.status_code, JSON.parse(saved.response_json), { replayed: true });
        }
        try {
            const out = fn(req);
            const extra = out.body.work_order_id ? { work_order_id: out.body.work_order_id } : out.body.customer_id ? { customer_id: out.body.customer_id } : {};
            answer(out.code, out.body, extra);
        } catch (e) {
            if (e.code && STATUS[e.code]) return answer(STATUS[e.code], { status: e.code, ...(e.code === 'invalid_arguments' ? { field: String(e.message).slice(0, 120) } : {}) });
            console.error('[internal-api]', e.message);
            answer(500, { status: 'error' });
        }
    };

    r.post('/customers/upsert', handle('إضافة أو تحديث عميل', (req) => customersUpsert(db, req.body || {})));
    r.post('/work-orders', handle('أمر عمل تركيب', (req) => workOrdersCreate(db, req.body || {}, deps)));
    r.get('/work-orders/by-ref/:ref', handle('حالة أمر عمل', (req) => workOrderByRef(db, req.params.ref, String(req.query.business || ''))));
    r.use((req, res) => res.status(404).json({ status: 'not_found' }));
    return r;
}

/* A body that is not JSON (express.json fails before the router): forbidden when unsigned, else invalid */
function bodyErrors() {
    return (err, req, res, next) => {
        if (!err || !(err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) return next(err);
        if (!isEnabled()) return res.status(503).json({ status: 'unavailable' });
        if (authenticate(req)) return res.status(401).json({ status: 'forbidden' });
        return res.status(422).json({ status: 'invalid_arguments', field: 'body' });
    };
}

/* Old requests and answers: kept 2 days (the replay and idempotency windows are 24 hours) */
const prune = (db) => Number(db.prepare("DELETE FROM internal_requests WHERE created_at < datetime('now', '-2 days')").run().changes);

module.exports = { router, bodyErrors, isEnabled, prune, describe, upsertCustomer, SKEW_SECONDS };
