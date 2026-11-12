/* The admin app: installable (manifest, service worker) and phone notifications (Web Push).
   Nothing is sent for real: the push sender is a recorder. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const staff = require('../src/staff');
const leads = require('../src/leads');
const push = require('../src/push');
const workorders = require('../src/workorders');
const requests = require('../src/servicerequests');
const backup = require('../src/backup');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const sent = [];
push.setSenderForTests(async (sub, payload) => {
    if (sub.endpoint.includes('gone')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
    if (sub.endpoint.includes('refused')) throw Object.assign(new Error('Forbidden'), { statusCode: 403, body: '{"reason":"BadJwtToken"}' });
    if (sub.endpoint.includes('offline')) throw Object.assign(new Error('getaddrinfo ENOTFOUND web.push.apple.com'), { code: 'ENOTFOUND' });
    sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
});
const settle = () => new Promise((r) => setTimeout(r, 30));
const device = (name) => ({ endpoint: `https://push.example.com/send/${name}`, keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } });

async function start(t) {
    sent.length = 0;
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = OWNER) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const type = res.headers.get('content-type') || '';
        return { status: res.status, type, body: type.includes('json') ? await res.json() : await res.text() };
    };
    const login = async (u) => (await call('POST', '/api/auth/login', { username: u, password: 'pass-12345' }, null)).body.token;
    return { db, call, login, base };
}

test('installable: manifest, icons, service worker and offline page; the admin page links them', async (t) => {
    const { call } = await start(t);
    const m = await call('GET', '/manifest.webmanifest', null, null);
    assert.equal(m.status, 200);
    const manifest = typeof m.body === 'string' ? JSON.parse(m.body) : m.body;
    assert.equal(manifest.start_url, '/admin');
    assert.equal(manifest.scope, '/admin', 'the customer calculators stay outside the app');
    assert.equal(manifest.display, 'standalone');
    assert.ok(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
    for (const i of manifest.icons) assert.equal((await call('GET', i.src, null, null)).status, 200);
    const sw = await call('GET', '/sw.js', null, null);
    assert.equal(sw.status, 200);
    assert.match(sw.type, /javascript/);
    assert.ok(!/\/api/.test(sw.body.match(/fetch\(req\)[^\n]*/)[0]), 'no data is cached');
    assert.equal((await call('GET', '/offline.html', null, null)).status, 200);
    const page = await call('GET', '/admin', null, null);
    assert.match(page.body, /rel="manifest" href="\/manifest.webmanifest"/);
    assert.match(page.body, /apple-touch-icon/);
    assert.match(page.body, /admin-pwa\.js\?v=/);
});

test('devices: each account its own; checked; a device that signs in with another account moves to it', async (t) => {
    const { db, call, login } = await start(t);
    staff.create(db, { username: 'sultan', display_name: 'سلطان', password: 'pass-12345', permissions: ['quotes'] });
    const tok = await login('sultan');
    const k = await call('GET', '/api/admin/me/push', null, tok);
    assert.equal(k.status, 200);
    assert.match(k.body.public_key, /^[A-Za-z0-9_-]{80,}$/);
    assert.equal((await call('GET', '/api/admin/me/push')).body.public_key, k.body.public_key, 'one key pair for the system');
    assert.equal((await call('POST', '/api/admin/me/push', { subscription: { endpoint: 'http://insecure.example.com/x', keys: device('a').keys } }, tok)).status, 400);
    assert.equal((await call('POST', '/api/admin/me/push', { subscription: { endpoint: device('a').endpoint, keys: { p256dh: '<script>', auth: 'x' } } }, tok)).status, 400);
    const ok = await call('POST', '/api/admin/me/push', { subscription: device('phone'), device: 'iPhone — Safari (التطبيق)' }, tok);
    assert.equal(ok.status, 201);
    assert.equal(ok.body.devices.length, 1);
    assert.equal((await call('GET', '/api/admin/me/push')).body.devices.length, 0, 'not the general manager\'s');
    // The same phone, now signed in as the general manager
    await call('POST', '/api/admin/me/push', { subscription: device('phone') });
    assert.equal((await call('GET', '/api/admin/me/push', null, tok)).body.devices.length, 0);
    assert.equal((await call('GET', '/api/admin/me/push')).body.devices.length, 1);
    // Test and stop
    assert.equal((await call('POST', '/api/admin/me/push/test', null, tok)).status, 400, 'no device for Sultan now');
    const tst = await call('POST', '/api/admin/me/push/test');
    assert.equal(tst.body.sent, 1);
    assert.equal(sent[0].title, '🔔 تجربة الإشعارات');
    await call('DELETE', '/api/admin/me/push', { endpoint: device('phone').endpoint });
    assert.equal((await call('GET', '/api/admin/me/push')).body.devices.length, 0);
    // The signing keys never go into a backup file
    assert.ok(!backup.TABLES.some(([name]) => /secret|push/i.test(name)));
});

test('who is told: customer quotes, a customer handed over, a work order, an appointment request; gone devices are removed', async (t) => {
    const { db, call, login } = await start(t);
    const sultan = staff.create(db, { username: 'sultan', display_name: 'سلطان', password: 'pass-12345', permissions: ['quotes', 'leads'] });
    const office = staff.create(db, { username: 'office', display_name: 'مكتب', password: 'pass-12345', permissions: ['work_orders'] });
    const tech = staff.create(db, { username: 'tech', display_name: 'أحمد الفني', password: 'pass-12345', role: 'technician' });
    const s = await login('sultan');
    await call('POST', '/api/admin/me/push', { subscription: device('sultan') }, s);
    await call('POST', '/api/admin/me/push', { subscription: device('office') }, await login('office'));
    await call('POST', '/api/admin/me/push', { subscription: device('tech') }, await login('tech'));
    await call('POST', '/api/admin/me/push', { subscription: device('boss') });
    await call('POST', '/api/admin/me/push', { subscription: device('gone-boss') });
    const to = (title) => sent.filter((m) => m.title === title).map((m) => m.endpoint.split('/').pop()).sort();

    // 1) A customer's quote (the calculator) → whoever handles quotes; an employee's own quote → nobody
    const priced = { items: [{ name: 'بوابة', unit: 'piece', quantity: 1, unit_price: 500, line_total: 500 }], subtotal: 500, vat_percent: 0, vat: 0, total: 500 };
    saveQuote(db, { customer_name: 'خالد', customer_phone: '96891234567', source: 'web', priced, lead_key: leads.phoneKey('96891234567') });
    await settle();
    assert.deepEqual(to('📄 عرض سعر جديد من عميل'), ['boss', 'sultan']);
    assert.match(sent.find((m) => m.title === '📄 عرض سعر جديد من عميل').body, /خالد — 500\.00 ر\.ع/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint LIKE '%gone%'").get().n, 0, 'a device the service no longer knows is removed');
    sent.length = 0;
    saveQuote(db, { customer_name: 'خالد', customer_phone: '96891234567', source: 'staff', priced, details: { staff_quote: true, created_by: 'سلطان' } });
    await settle();
    assert.equal(sent.length, 0);

    // 2) The customer handed to Sultan → Sultan, with a link to the customer
    const lead = db.prepare("SELECT * FROM leads WHERE phone = '96891234567'").get();
    await call('PATCH', `/api/admin/leads/${lead.id}`, { assigned_to: 'سلطان' });
    await settle();
    const handed = sent.find((m) => m.title === '👤 أُسند إليك عميل');
    assert.equal(handed.endpoint.split('/').pop(), 'sultan');
    assert.equal(handed.url, `/admin#lead=${lead.id}`);
    // …and when that customer asks for a person, Sultan hears it
    sent.length = 0;
    leads.humanRequested(db, lead.contact_key, 'يريد معاينة اليوم');
    await settle();
    assert.deepEqual(to('🙋 عميل يطلب التواصل مع موظف'), ['sultan']);

    // 3) A work order assigned to the technician → the technician only
    sent.length = 0;
    workorders.create(db, { kind: 'installation', customer_name: 'خالد', customer_phone: '96891234567', description: 'تركيب', scheduled_date: '2099-01-01', technician_id: tech.id }, 'المدير العام');
    await settle();
    assert.deepEqual(to('🔧 أمر عمل جديد'), ['tech']);

    // 4) An appointment request → managers and the work-orders staff (not the technician, not sales)
    sent.length = 0;
    const r = requests.create(db, { kind: 'maintenance', customer_name: 'خالد', customer_phone: '96891234567', description: 'صيانة' }, { source: 'mazbot' });
    await requests.notifyStaff(db, r, { mazbot: { parseRecipients: () => [] }, whatsapp: { isConfigured: () => false } });
    await settle();
    assert.deepEqual(to('📅 طلب موعد ينتظر موافقتك'), ['boss', 'office']);
    assert.ok(sultan && office);
});

test('when nothing arrives: the push service\'s answer is kept per device and shown by the test button', async (t) => {
    const { call } = await start(t);
    await call('POST', '/api/admin/me/push', { subscription: device('refused'), device: 'iPhone — Safari (التطبيق)' });
    const r = await call('POST', '/api/admin/me/push/test');
    assert.equal(r.status, 502);
    assert.match(r.body.error, /403 — رفضت خدمة الإشعارات مفتاح الخادم/);
    assert.match(r.body.error, /BadJwtToken/);
    const d = (await call('GET', '/api/admin/me/push')).body.devices[0];
    assert.match(d.last_error, /^403/);
    assert.equal(d.service, 'push.example.com');
    assert.equal(d.tail, device('refused').endpoint.slice(-12));
    assert.ok(!('endpoint' in d), 'the full address is never sent back');
    // The host cannot reach the push service
    await call('POST', '/api/admin/me/push', { subscription: device('offline') });
    const r2 = await call('POST', '/api/admin/me/push/test');
    assert.match(r2.body.error, /لم يصل الخادم إلى خدمة الإشعارات \(ENOTFOUND\)/);
    // A good device next to a bad one: sent, and the failure listed
    await call('POST', '/api/admin/me/push', { subscription: device('good') });
    const r3 = await call('POST', '/api/admin/me/push/test');
    assert.equal(r3.status, 200);
    assert.equal(r3.body.sent, 1);
    assert.equal(r3.body.failed.length, 2);
});
