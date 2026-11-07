/* Work orders and technician accounts. No real email is sent: the transport is a recorder. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase, saveSettings } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const staff = require('../src/staff');
const mailer = require('../src/mailer');
const workorders = require('../src/workorders');
const followup = require('../src/followup');
const leads = require('../src/leads');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const SMTP = { SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465', SMTP_USER: 'noreply@example.com', SMTP_PASS: 'mail-pass', BACKUP_EMAIL_TO: 'owner@example.com' };
const sent = [];
mailer.setTransportForTests(() => ({ sendMail: async (mail) => { sent.push(mail); return { messageId: 'x' }; } }));

async function start(t) {
    for (const k of Object.keys(SMTP)) delete process.env[k];
    Object.assign(process.env, SMTP);
    t.after(() => { for (const k of Object.keys(SMTP)) delete process.env[k]; });
    sent.length = 0;
    const db = openDatabase(':memory:');
    saveSettings(db, { public_base_url: 'https://calc.example.com' });
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = OWNER) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const login = async (u, p) => (await call('POST', '/api/auth/login', { username: u, password: p }, null)).body.token;
    return { db, call, login };
}
const settle = () => new Promise((r) => setTimeout(r, 30));

function invoiceFor(db) {
    const q = saveQuote(db, {
        customer_name: 'خالد', customer_phone: '96891234567', customer_city: 'السيب', source: 'web',
        priced: { items: [{ name: 'بوابة رول شتر', type: '77 ملم', quantity: 2, unit: 'piece', unit_price: 500, line_total: 1000 }], subtotal: 1000, vat_percent: 5, vat: 50, total: 1050 },
        details: { width_cm: 300, height_cm: 250, count: 2 }
    });
    return q;
}

test('a work order from an invoice copies the job without prices, and the technician is emailed', async (t) => {
    const { db, call } = await start(t);
    const tech = staff.create(db, { username: 'tech1', display_name: 'سعيد الفني', email: 'tech@example.com', password: 'pass-12345', role: 'technician' });
    assert.deepEqual(tech.permissions, ['work_orders']);
    const q = invoiceFor(db);
    const inv = (await call('POST', `/api/admin/quotes/${q.id}/invoice`, { customer_address: 'السيب — الخوض 6، منزل 12' })).body;
    const r = await call('POST', '/api/admin/work-orders', { invoice_id: inv.id, kind: 'installation', scheduled_date: '2026-11-10', scheduled_time: '9 صباحاً', technician_id: tech.id, map_url: 'https://maps.app.goo.gl/abc' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const o = r.body;
    assert.match(o.number, /^WO-\d{4}-0001$/);
    assert.equal(o.status, 'scheduled');
    assert.equal(o.invoice_number, inv.number);
    assert.equal(o.address, 'السيب — الخوض 6، منزل 12');
    assert.match(o.description, /2 × بوابة رول شتر — 77 ملم/);
    assert.match(o.description, /العرض 300 سم × الارتفاع 250 سم/);
    assert.doesNotMatch(o.description, /500|1000|1050/, 'no prices for the technician');
    await settle();
    const mail = sent.find((m) => m.to === 'tech@example.com');
    assert.ok(mail);
    assert.match(mail.subject, /أمر عمل جديد: خالد — 2026-11-10/);
    assert.match(mail.text, /maps\.app\.goo\.gl/);
    assert.doesNotMatch(mail.text, /1050/);
    assert.equal((await call('POST', '/api/admin/work-orders', { customer_name: 'x', customer_phone: '96890000000', description: 'y', map_url: 'javascript:alert(1)' })).status, 400);
});

test('a technician sees only their orders, cannot edit or cancel, and closes the job with a note', async (t) => {
    const { db, call, login } = await start(t);
    const a = staff.create(db, { username: 'tech1', display_name: 'سعيد', password: 'pass-12345', role: 'technician' });
    const b = staff.create(db, { username: 'tech2', display_name: 'ناصر', password: 'pass-12345', role: 'technician' });
    const q = invoiceFor(db);
    const mine = (await call('POST', '/api/admin/work-orders', { quote_id: q.id, technician_id: a.id, scheduled_date: '2026-11-10' })).body;
    const other = (await call('POST', '/api/admin/work-orders', { customer_name: 'مريم', customer_phone: '96895555555', kind: 'maintenance', description: 'صيانة المحرك', technician_id: b.id, scheduled_date: '2026-11-11' })).body;
    const tok = await login('tech1', 'pass-12345');

    const list = (await call('GET', '/api/admin/work-orders', null, tok)).body;
    assert.deepEqual(list.orders.map((o) => o.number), [mine.number]);
    assert.deepEqual(list.technicians, [], 'technicians do not get the team list');
    assert.equal((await call('GET', `/api/admin/work-orders/${other.id}`, null, tok)).status, 404);
    for (const [m, u, body] of [['POST', '/api/admin/work-orders', { customer_name: 'x', customer_phone: '96890000000', description: 'y' }],
        ['PATCH', `/api/admin/work-orders/${mine.id}`, { scheduled_date: '2026-12-01' }], ['POST', `/api/admin/work-orders/${mine.id}/cancel`, { reason: 'x' }]]) {
        assert.equal((await call(m, u, body, tok)).status, 403, u);
    }
    // No other part of the panel
    for (const u of ['/api/admin/quotes', '/api/admin/invoices', '/api/admin/leads', '/api/admin/dashboard']) assert.equal((await call('GET', u, null, tok)).status, 403, u);

    assert.equal((await call('POST', `/api/admin/work-orders/${other.id}/status`, { status: 'in_progress' }, tok)).status, 404);
    assert.equal((await call('POST', `/api/admin/work-orders/${mine.id}/status`, { status: 'in_progress' }, tok)).body.status, 'in_progress');
    assert.equal((await call('POST', `/api/admin/work-orders/${mine.id}/status`, { status: 'done' }, tok)).status, 400, 'a note is required');
    assert.equal((await call('POST', `/api/admin/work-orders/${mine.id}/notes`, { text: 'تحتاج قاعدة إضافية' }, tok)).status, 201);
    const done = (await call('POST', `/api/admin/work-orders/${mine.id}/status`, { status: 'done', note: 'رُكّبت البوابتان وجُرّبتا' }, tok)).body;
    assert.equal(done.status, 'done');
    assert.equal(done.completion_note, 'رُكّبت البوابتان وجُرّبتا');
    assert.ok(done.events.some((e) => e.author === 'سعيد' && /تحتاج قاعدة/.test(e.text)));
    assert.equal(db.prepare('SELECT status FROM quotes WHERE id = ?').get(q.id).status, 'done', 'an installation done is the quote done');
    assert.equal((await call('POST', `/api/admin/work-orders/${mine.id}/status`, { status: 'in_progress' }, tok)).status, 400, 'closed');
    await settle();
    assert.ok(sent.some((m) => /اكتمل/.test(m.subject) && m.to.includes('owner@example.com')), 'the managers hear about it');
    assert.match(db.prepare("SELECT text FROM lead_messages ORDER BY id DESC").get().text, /اكتمل أمر تركيب/);
});

test('the customer was not there: the technician sends it back for a new appointment', async (t) => {
    const { db, call, login } = await start(t);
    const a = staff.create(db, { username: 'tech1', display_name: 'سعيد', email: 'tech@example.com', password: 'pass-12345', role: 'technician' });
    const o = (await call('POST', '/api/admin/work-orders', { customer_name: 'مريم', customer_phone: '96895555555', description: 'معاينة', kind: 'inspection', technician_id: a.id, scheduled_date: '2026-11-10' })).body;
    const tok = await login('tech1', 'pass-12345');
    assert.equal((await call('POST', `/api/admin/work-orders/${o.id}/status`, { status: 'new' }, tok)).status, 400, 'a reason is required');
    const back = (await call('POST', `/api/admin/work-orders/${o.id}/status`, { status: 'new', note: 'العميل غير موجود' }, tok)).body;
    assert.equal(back.status, 'new');
    // The office sets a new date: scheduled again, and the technician is told
    sent.length = 0;
    const again = (await call('PATCH', `/api/admin/work-orders/${o.id}`, { scheduled_date: '2026-11-12' })).body;
    assert.equal(again.status, 'scheduled');
    await settle();
    assert.match(sent[0].subject, /موعد جديد لأمر عمل/);
    // Removing the technician puts it back in the queue
    assert.equal((await call('PATCH', `/api/admin/work-orders/${o.id}`, { technician_id: null })).body.status, 'new');
    assert.equal((await call('POST', `/api/admin/work-orders/${o.id}/cancel`, {})).status, 400, 'a reason is required');
    assert.equal((await call('POST', `/api/admin/work-orders/${o.id}/cancel`, { reason: 'ألغى العميل' })).body.status, 'cancelled');
    assert.equal((await call('PATCH', `/api/admin/work-orders/${o.id}`, { scheduled_date: '2026-11-20' })).status, 400, 'closed');
});

test('technicians get a morning list of today\'s jobs; the weekly report counts the work', async (t) => {
    const { db, call } = await start(t);
    const a = staff.create(db, { username: 'tech1', display_name: 'سعيد', email: 'tech@example.com', password: 'pass-12345', role: 'technician' });
    const today = leads.localToday();
    const later = new Date(Date.parse(today + 'T00:00:00Z') + 5 * 86400000).toISOString().slice(0, 10);
    await call('POST', '/api/admin/work-orders', { customer_name: 'اليوم', customer_phone: '96891111111', description: 'تركيب', technician_id: a.id, scheduled_date: today });
    await call('POST', '/api/admin/work-orders', { customer_name: 'لاحقاً', customer_phone: '96892222222', description: 'تركيب', technician_id: a.id, scheduled_date: later });
    await call('POST', '/api/admin/work-orders', { customer_name: 'بلا موعد', customer_phone: '96893333333', description: 'صيانة' });
    const digests = workorders.technicianDigests(db);
    assert.equal(digests.length, 1);
    assert.deepEqual(digests[0].orders.map((o) => o.customer_name), ['اليوم']);
    sent.length = 0;
    assert.equal(await workorders.sendTechnicianDigests(db), 1);
    assert.match(sent[0].subject, /أعمالك اليوم: 1/);
    const w = followup.buildWeekly(db);
    assert.equal(w.work_orders.open, 3);
    assert.equal(w.work_orders.unscheduled, 1);
    assert.match(followup.weeklyText(db, w), /أوامر العمل: اكتمل 0/);
});

test('roles: a technician account cannot be given other sections; backups keep work orders', async (t) => {
    const { db, call } = await start(t);
    const r = await call('POST', '/api/admin/users', { username: 'tech9', display_name: 'فني', password: 'pass-12345', role: 'technician', permissions: ['invoices', 'quotes'] });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.permissions, ['work_orders']);
    assert.equal(r.body.must_setup_2fa, false);
    await call('POST', '/api/admin/work-orders', { customer_name: 'خالد', customer_phone: '96891111111', description: 'صيانة', technician_id: r.body.id });
    const backup = require('../src/backup');
    const file = await backup.exportWorkbook(db);
    db.prepare('DELETE FROM work_order_events').run();
    db.prepare('DELETE FROM work_orders').run();
    await backup.restoreWorkbook(db, file);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_orders').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_order_events').get().n, 1);
});
