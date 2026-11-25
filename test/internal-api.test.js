/* The internal API for panorama-commerce (/api/internal/v1): off without its two secrets; Bearer + timestamp +
   request id + HMAC of the raw body; Idempotency-Key; customers upsert (never clears a field); an installation work
   order without any message to the customer, once per external_ref; its status by ref; business / external_ref in the
   work order webhooks; and the retries of the two new events (1, 5, 15 minutes, the same payload). */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/server');
const webhooks = require('../src/webhooks');
const notify = require('../src/order-notify');

const OWNER = 'test-token-long-enough-1234';
const KEY = 'internal-key-for-tests-0123456789abcdef';
const SECRET = 'internal-hmac-secret-for-tests-0123456789';
process.env.ADMIN_TOKEN = OWNER;
process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = '1'; // the test receiver is on 127.0.0.1
const customerMessages = [];
notify.setSenderForTests(async (m) => { customerMessages.push(m); return { ok: true }; });

async function start(t, { enabled = true } = {}) {
    if (enabled) { process.env.INTERNAL_API_KEY = KEY; process.env.INTERNAL_API_HMAC_SECRET = SECRET; } else { delete process.env.INTERNAL_API_KEY; delete process.env.INTERNAL_API_HMAC_SECRET; }
    t.after(() => { delete process.env.INTERNAL_API_KEY; delete process.env.INTERNAL_API_HMAC_SECRET; });
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    /* A signed request as Panorama sends it (override any header to break it) */
    const call = async (method, path, body, { headers = {}, ts = Math.floor(Date.now() / 1000), rid = crypto.randomUUID(), idem = crypto.randomUUID(), key = KEY, secret = SECRET } = {}) => {
        const raw = body === undefined ? '' : JSON.stringify(body);
        const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${rid}.${raw}`).digest('hex');
        const res = await fetch(base + '/api/internal/v1' + path, {
            method,
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'X-Timestamp': String(ts), 'X-Request-Id': rid, 'X-Signature': sig,
                ...(method === 'POST' && idem ? { 'Idempotency-Key': idem } : {}), ...headers },
            body: body === undefined ? undefined : raw
        });
        return { status: res.status, body: await res.json().catch(() => null), rid };
    };
    const admin = async (method, url, body) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OWNER }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    return { db, base, call, admin };
}

/* A webhook receiver on this machine */
async function receiver(t, { fail = () => false } = {}) {
    const got = [];
    const srv = http.createServer((req, res) => {
        let b = '';
        req.on('data', (c) => { b += c; });
        req.on('end', () => { const body = JSON.parse(b); got.push(body); res.statusCode = fail(body) ? 500 : 200; res.end('{}'); });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    t.after(() => srv.close());
    return { url: `http://127.0.0.1:${srv.address().port}/hook`, got };
}
const settle = () => new Promise((r) => setTimeout(r, 150));

const ORDER = {
    customer_phone: '96891234567', customer_name: 'سالم الحارثي', business: 'panorama', external_ref: 'panorama:install:1021',
    title: 'تركيب 8 كاميرات + NVR',
    items: [{ description: 'كاميرا IP 4MP خارجية', qty: 8 }, { description: 'NVR 8 قنوات + HDD 2TB', qty: 1 }],
    location: { map_url: 'https://maps.google.com/?q=22.93,57.53', wilaya: 'نزوى', address: 'فرق' },
    preferred_date: '2026-12-02', notes: 'التمديدات موجودة', approved_by: 'مسؤول المبيعات'
};

test('off without its two secrets: 503 everywhere, and nothing else changes', async (t) => {
    const { call, base } = await start(t, { enabled: false });
    const off = await call('POST', '/customers/upsert', { phone: '91234567' });
    assert.deepEqual([off.status, off.body], [503, { status: 'unavailable' }]);
    assert.equal((await call('GET', '/work-orders/by-ref/x?business=panorama')).status, 503);
    assert.equal((await fetch(base + '/healthz')).status, 200);
});

test('authentication: key, timestamp, request id, signature; independent of the admin panel', async (t) => {
    const { call, base, db } = await start(t);
    const ok = await call('POST', '/customers/upsert', { phone: '91234567', name: 'أحمد' });
    assert.equal(ok.status, 200);
    const forbidden = { status: 'forbidden' };
    assert.deepEqual((await call('POST', '/customers/upsert', { phone: '91234567' }, { key: 'wrong-key' })).body, forbidden);
    assert.equal((await call('POST', '/customers/upsert', { phone: '91234567' }, { secret: 'wrong-secret' })).status, 401, 'bad signature');
    assert.equal((await call('POST', '/customers/upsert', { phone: '91234567' }, { ts: Math.floor(Date.now() / 1000) - 301 })).status, 401, 'older than 300 s');
    assert.equal((await call('POST', '/customers/upsert', { phone: '91234567' }, { rid: 'not-a-uuid' })).status, 401);
    assert.equal((await call('POST', '/customers/upsert', { phone: '91234567' }, { rid: ok.rid })).status, 401, 'a request id seen before');
    // The owner's password does not open it, and its key does not open the admin panel
    assert.equal((await call('POST', '/customers/upsert', { phone: '91234567' }, { key: OWNER })).status, 401);
    assert.equal((await fetch(base + '/api/admin/settings', { headers: { Authorization: 'Bearer ' + KEY } })).status, 401);
    // A body changed after signing
    const ts = Math.floor(Date.now() / 1000);
    const rid = crypto.randomUUID();
    const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${ts}.${rid}.{"phone":"91234567"}`).digest('hex');
    const tampered = await fetch(base + '/api/internal/v1/customers/upsert', { method: 'POST', body: '{"phone":"99999999"}',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY, 'X-Timestamp': String(ts), 'X-Request-Id': rid, 'X-Signature': sig, 'Idempotency-Key': 'k1' } });
    assert.equal(tampered.status, 401);
    // Not JSON: forbidden unsigned, invalid when signed
    const bad = 'not json';
    const rid2 = crypto.randomUUID();
    const sig2 = 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${ts}.${rid2}.${bad}`).digest('hex');
    const notJson = await fetch(base + '/api/internal/v1/customers/upsert', { method: 'POST', body: bad,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY, 'X-Timestamp': String(ts), 'X-Request-Id': rid2, 'X-Signature': sig2, 'Idempotency-Key': 'k2' } });
    assert.deepEqual([notJson.status, await notJson.json()], [422, { status: 'invalid_arguments', field: 'body' }]);
    // A POST without Idempotency-Key
    assert.equal((await call('POST', '/customers/upsert', { phone: '91234567' }, { idem: null })).status, 422);
    // No secret in the activity log or in the answers
    const logged = JSON.stringify(db.prepare("SELECT * FROM audit_log WHERE actor = 'panorama'").all());
    assert.ok(logged.includes('المسار الداخلي'));
    for (const s of [KEY, SECRET, OWNER]) assert.ok(!logged.includes(s), 'no secret in the log');
    // The owner's password as its key: the path stays off
    process.env.INTERNAL_API_KEY = OWNER;
    assert.equal((await call('POST', '/customers/upsert', { phone: '91234567' }, { key: OWNER })).status, 503);
});

test('customers/upsert: matched with or without 968, never clears a field, keeps the external number', async (t) => {
    const { call, db } = await start(t);
    const a = await call('POST', '/customers/upsert', { phone: '9123 4567', name: 'أحمد', email: 'a@example.com', wilaya: 'نزوى', source: 'panorama', external_ref: 'panorama:customer:45' });
    assert.deepEqual([a.status, a.body.status, a.body.created], [200, 'ok', true]);
    const b = await call('POST', '/customers/upsert', { phone: '+968 9123 4567', name: '', email: null, address: 'فرق', wilaya: '   ' });
    assert.deepEqual([b.body.customer_id, b.body.created], [a.body.customer_id, false]);
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(a.body.customer_id);
    assert.deepEqual([c.phone, c.name, c.email, c.city, c.address], ['96891234567', 'أحمد', 'a@example.com', 'نزوى', 'فرق']);
    assert.deepEqual(db.prepare('SELECT customer_id, system, ref FROM customer_external_refs').all().map((r) => ({ ...r })), [{ customer_id: c.id, system: 'panorama', ref: 'panorama:customer:45' }]);
    assert.equal((await call('POST', '/customers/upsert', { phone: '12' })).status, 422);
    assert.equal((await call('POST', '/customers/upsert', { phone: '92345678', email: 'not-an-email' })).body.status, 'invalid_arguments');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM customers WHERE phone = '96892345678'").get().n, 0, 'nothing half-made');
    assert.equal((await call('POST', '/customers/upsert', { phone: '92345678', source: 'other' })).status, 422);
});

test('work-orders: a new installation, no message to the customer, once per external_ref; idempotent; by ref', async (t) => {
    const { call, db, admin } = await start(t);
    const hook = await receiver(t);
    db.prepare("INSERT INTO webhooks (name, url, events, active) VALUES ('panorama', ?, 'work_order.created,work_order.status_changed', 1)").run(hook.url);
    customerMessages.length = 0;

    const first = await call('POST', '/work-orders', ORDER, { idem: 'panorama:install:1021:create' });
    assert.equal(first.status, 201);
    assert.deepEqual([first.body.status, first.body.duplicate], ['ok', false]);
    assert.match(first.body.number, /^WO-\d{4}-\d{4}$/);
    const o = db.prepare('SELECT * FROM work_orders WHERE id = ?').get(first.body.work_order_id);
    assert.deepEqual([o.kind, o.status, o.business, o.external_ref, o.location, o.technician_id, o.scheduled_date], ['installation', 'new', 'panorama', 'panorama:install:1021', 'نزوى', null, null]);
    assert.equal(o.created_by, 'panorama: مسؤول المبيعات');
    assert.equal(o.description, 'تركيب 8 كاميرات + NVR\n• 8 × كاميرا IP 4MP خارجية\n• 1 × NVR 8 قنوات + HDD 2TB\nالموعد المفضل لدى العميل: 2026-12-02\nالتمديدات موجودة');
    assert.equal(db.prepare("SELECT name FROM customers WHERE phone = '96891234567'").get().name, 'سالم الحارثي');

    // The same Idempotency-Key: the same answer, one order
    const again = await call('POST', '/work-orders', ORDER, { idem: 'panorama:install:1021:create' });
    assert.deepEqual([again.status, again.body], [201, first.body]);
    // Another key, the same external_ref: the first order, marked duplicate
    const dup = await call('POST', '/work-orders', ORDER, { idem: 'another-key' });
    assert.deepEqual([dup.status, dup.body.work_order_id, dup.body.duplicate], [200, first.body.work_order_id, true]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM work_orders WHERE external_ref = 'panorama:install:1021'").get().n, 1);
    await settle();
    assert.equal(customerMessages.length, 0, 'no message to the customer');

    // Its status by ref: no technician details, no notes
    const by = await call('GET', '/work-orders/by-ref/panorama:install:1021?business=panorama');
    assert.deepEqual(by.body, { status: 'ok', work_order_id: o.id, number: o.number, order_status: 'new', scheduled_date: null, scheduled_time: null, completed_at: null });
    assert.equal((await call('GET', '/work-orders/by-ref/panorama:install:9999?business=panorama')).body.status, 'not_found');
    assert.equal((await call('GET', '/work-orders/by-ref/panorama:install:1021?business=radma')).status, 422);

    // Invalid input
    for (const bad of [{ ...ORDER, business: 'radma', external_ref: 'x1' }, { ...ORDER, external_ref: 'x2', items: [] }, { ...ORDER, external_ref: 'x3', title: '' },
        { ...ORDER, external_ref: 'x4', approved_by: '' }, { ...ORDER, external_ref: 'x5', preferred_date: '02-12-2026' }, { ...ORDER, external_ref: 'x6', customer_phone: '1' },
        { ...ORDER, external_ref: 'x7', customer_phone: '95556666', customer_name: '' }]) {
        assert.equal((await call('POST', '/work-orders', bad)).status, 422, JSON.stringify(bad).slice(0, 60));
    }

    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM customers WHERE phone = '96895556666'").get().n, 0, 'an unknown customer without a name: nothing saved');

    // The webhooks: business / external_ref added, every field of an office order still there
    await admin('POST', '/api/admin/work-orders', { customer_name: 'عميل ردما', customer_phone: '92223333', kind: 'installation', description: 'تركيب بوابة' });
    await admin('POST', `/api/admin/work-orders/${o.id}/status`, { status: 'cancelled' }).catch(() => null);
    await admin('POST', `/api/admin/work-orders/${o.id}/cancel`, { reason: 'تجربة' });
    await settle();
    const created = hook.got.filter((e) => e.event === 'work_order.created');
    assert.equal(created.length, 2);
    const [fromPanorama, fromOffice] = created;
    assert.deepEqual([fromPanorama.data.business, fromPanorama.data.external_ref], ['panorama', 'panorama:install:1021']);
    assert.deepEqual([fromOffice.data.business, fromOffice.data.external_ref], ['radma', null]);
    assert.deepEqual(Object.keys(fromPanorama.data).sort(), Object.keys(fromOffice.data).sort(), 'the same fields');
    const changed = hook.got.find((e) => e.event === 'work_order.status_changed');
    assert.deepEqual([changed.data.business, changed.data.external_ref], ['panorama', 'panorama:install:1021']);
    const before = ['id', 'number', 'kind', 'quote_id', 'invoice_id', 'customer_name', 'customer_phone', 'location', 'address', 'map_url', 'scheduled_date',
        'scheduled_time', 'technician_id', 'description', 'status', 'completion_note', 'completed_at', 'created_by', 'created_at', 'updated_at', 'technician_name', 'kind_label', 'status_label'];
    for (const k of before) assert.ok(k in changed.data, `${k} still in the event`);
    assert.ok('business' in require('../src/workorders').get(db, o.id));
});

test('the 60-a-minute limit', async (t) => {
    const { call } = await start(t);
    let last;
    for (let i = 0; i < 61; i++) last = await call('GET', '/work-orders/by-ref/none?business=panorama');
    assert.deepEqual([last.status, last.body], [429, { status: 'rate_limited' }]);
});

test('lead.message / handoff.requested: retried after 1, 5, 15 minutes with the same payload; other events once', async (t) => {
    const db = openDatabase(':memory:');
    let failing = true;
    const hook = await receiver(t, { fail: () => failing });
    db.prepare("INSERT INTO webhooks (name, url, events, active) VALUES ('panorama', ?, '*', 1)").run(hook.url);
    assert.ok(webhooks.EVENTS.includes('lead.message') && webhooks.EVENTS.includes('handoff.requested'));

    await webhooks.emit(db, 'quote.created', { ref: 'Q1' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM webhook_retries').get().n, 0, 'an existing event is tried once');

    await webhooks.emit(db, 'lead.message', { text: 'مرحبا' });
    const row = db.prepare('SELECT * FROM webhook_retries').get();
    assert.deepEqual([row.event, row.attempt], ['lead.message', 0]);
    const id = JSON.parse(row.payload).id;
    const at = (min) => Date.now() + min * 60_000 + 1000;
    assert.deepEqual(await webhooks.processRetries(db, at(0.5)), { sent: 0, failed: 0, gave_up: 0 }, 'not before a minute');
    assert.deepEqual(await webhooks.processRetries(db, at(1)), { sent: 0, failed: 1, gave_up: 0 });
    assert.deepEqual(await webhooks.processRetries(db, at(1 + 4)), { sent: 0, failed: 0, gave_up: 0 }, 'the next after 5 minutes');
    assert.deepEqual(await webhooks.processRetries(db, at(1 + 5)), { sent: 0, failed: 1, gave_up: 0 });
    assert.deepEqual(await webhooks.processRetries(db, at(1 + 5 + 15)), { sent: 0, failed: 0, gave_up: 1 });
    assert.equal(db.prepare('SELECT next_at FROM webhook_retries').get().next_at, null, 'given up');
    const sent = hook.got.filter((e) => e.event === 'lead.message');
    assert.equal(sent.length, 4, 'the first try and three retries');
    assert.ok(sent.every((e) => e.id === id), 'the same payload, the same id');

    // The state is in the table: a retry carries on whoever runs it (after a restart), and stops once delivered
    await webhooks.emit(db, 'handoff.requested', { summary: 'يطلب موظفاً' });
    failing = false;
    assert.deepEqual(await webhooks.processRetries(db, at(1)), { sent: 1, failed: 0, gave_up: 0 });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM webhook_retries WHERE event = 'handoff.requested'").get().n, 0);
});
