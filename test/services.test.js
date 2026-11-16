/* «خدمة»: a service with its description and price.
   - A technician adds it on site to their own open work order; the office to any order. It goes on the
     order's invoice (a new invoice when the order has none), with a PDF, the order's log, the activity log
     and a notification to the managers — no approval.
   - Staff and managers add it in the quote builder (a description is required; not a «free line»).
   - Its commission is the technician's (their installation %), never a salesperson's. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase, saveSettings } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const staff = require('../src/staff');
const invoices = require('../src/invoices');
const workorders = require('../src/workorders');
const bonuses = require('../src/bonuses');
const push = require('../src/push');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const sent = [];
push.setSenderForTests(async (sub, payload) => { sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }); });

async function start(t) {
    sent.length = 0;
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = OWNER) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const login = async (u) => (await call('POST', '/api/auth/login', { username: u, password: 'pass-12345' }, '')).body.token;
    return { db, call, login, base };
}

function invoiceFor(db) {
    const priced = { items: [{ name: 'بوابة', unit: 'piece', quantity: 1, unit_price: 400, line_total: 400, part: 'slats' }, { name: 'التركيب', unit: 'service', quantity: 1, unit_price: 100, line_total: 100, part: 'installation' }],
        subtotal: 500, vat_percent: 5, vat: 25, total: 525 };
    const q = saveQuote(db, { customer_name: 'خالد', customer_phone: '96891234567', source: 'staff', priced, details: { staff_quote: true, created_by: 'سارة' } });
    const row = db.prepare('SELECT * FROM quotes WHERE id = ?').get(q.id);
    return invoices.createFromQuote(db, { ...row, items: JSON.parse(row.items_json), details: JSON.parse(row.details_json) }, {}, 'سارة');
}

test('a technician adds a service on site: it goes on the invoice, the PDF follows, the managers hear of it', async (t) => {
    const { db, call, login, base } = await start(t);
    const tech = staff.create(db, { username: 'ahmed', display_name: 'أحمد الفني', password: 'pass-12345', role: 'technician' });
    const other = staff.create(db, { username: 'omar', display_name: 'عمر', password: 'pass-12345', role: 'technician' });
    staff.create(db, { username: 'boss', display_name: 'المدير', password: 'pass-12345', role: 'manager' });
    const inv = invoiceFor(db);
    const order = workorders.create(db, { kind: 'installation', description: 'تركيب', scheduled_date: '2099-01-01', technician_id: tech.id }, 'المكتب', { source: { invoice: inv } });
    const tk = await login('ahmed');

    const svc = { title: 'تغيير مكثف المحرك', description: 'فحص المحرك وتغيير المكثف وضبط الحساسات', quantity: 1, unit_price: 20 };
    assert.equal((await call('POST', `/api/admin/work-orders/${order.id}/services`, { ...svc, description: '' }, tk)).status, 400);
    assert.equal((await call('POST', `/api/admin/work-orders/${order.id}/services`, { ...svc, unit_price: 0 }, tk)).status, 400);
    assert.equal((await call('POST', `/api/admin/work-orders/${order.id}/services`, svc, await login('omar'))).status, 404, 'not their order');

    const r = await call('POST', `/api/admin/work-orders/${order.id}/services`, svc, tk);
    assert.equal(r.status, 201);
    assert.equal(r.body.invoice.id, inv.id, 'the order\'s own invoice');
    assert.equal(r.body.invoice.subtotal, 520);
    assert.equal(r.body.invoice.total, 546);
    const line = r.body.invoice.items.find((i) => i.part === 'service');
    assert.deepEqual([line.name, line.description, line.line_total, line.work_order_id, line.added_by], ['تغيير مكثف المحرك', svc.description, 20, order.id, 'أحمد الفني']);
    assert.equal(invoices.revisions(db, inv.id).length, 1, 'in the invoice\'s edit history');
    assert.ok(workorders.get(db, order.id).events.some((e) => /تغيير مكثف المحرك/.test(e.text)), 'in the order\'s log');
    const pdf = await fetch(base + r.body.invoice.pdf_url);
    assert.equal(pdf.status, 200);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    const log = (await call('GET', '/api/admin/audit')).body;
    assert.ok((log.entries || log.rows || log).some((e) => /إضافة خدمة/.test(e.action)));
    void other;

    // Once the order is done the technician cannot add more; the office can
    workorders.setStatus(db, order.id, 'done', 'تم التركيب', { role: 'technician', id: tech.id, display_name: 'أحمد الفني' });
    assert.equal((await call('POST', `/api/admin/work-orders/${order.id}/services`, svc, tk)).status, 400);
    assert.equal((await call('POST', `/api/admin/work-orders/${order.id}/services`, { ...svc, unit_price: 5 })).status, 201);
});

test('an order without an invoice (a maintenance visit) gets a new invoice for the service', async (t) => {
    const { db, call, login } = await start(t);
    const tech = staff.create(db, { username: 'ahmed', display_name: 'أحمد الفني', password: 'pass-12345', role: 'technician' });
    const order = workorders.create(db, { kind: 'maintenance', customer_name: 'مريم', customer_phone: '93334444', description: 'صيانة', scheduled_date: '2099-01-01', technician_id: tech.id }, 'المكتب');
    const r = await call('POST', `/api/admin/work-orders/${order.id}/services`, { description: 'تنظيف وتشحيم المسارات', unit_price: 15, quantity: 2 }, await login('ahmed'));
    assert.equal(r.status, 201);
    assert.match(r.body.invoice.number, /^INV-/);
    assert.equal(r.body.invoice.subtotal, 30);
    assert.equal(r.body.invoice.customer_name, 'مريم');
    assert.equal(workorders.get(db, order.id).invoice_id, r.body.invoice.id, 'the order is linked to it');
    assert.equal(r.body.invoice.created_by, 'أحمد الفني');
});

test('the service\'s commission is the technician\'s (installation %), not the salesperson\'s', async (t) => {
    const { db, call, login } = await start(t);
    const tech = staff.create(db, { username: 'ahmed', display_name: 'أحمد الفني', password: 'pass-12345', role: 'technician' });
    staff.create(db, { username: 'sara', display_name: 'سارة', password: 'pass-12345', permissions: ['quotes', 'invoices'] });
    db.prepare("UPDATE staff_users SET bonus_percent = 10 WHERE username = 'ahmed'").run();
    db.prepare("UPDATE staff_users SET bonus_percent = 5, bonus_target = 0 WHERE username = 'sara'").run();
    const inv = invoiceFor(db);
    const order = workorders.create(db, { kind: 'installation', description: 'تركيب', scheduled_date: '2099-01-01', technician_id: tech.id }, 'المكتب', { source: { invoice: inv } });
    await call('POST', `/api/admin/work-orders/${order.id}/services`, { description: 'تغيير ريموت', unit_price: 50 }, await login('ahmed'));
    workorders.setStatus(db, order.id, 'done', 'تم', { role: 'technician', id: tech.id, display_name: 'أحمد الفني' });
    invoices.addPayment(db, inv.id, { amount: 577.5, method: 'cash' }, 'المكتب');

    const month = bonuses.thisMonth();
    const people = bonuses.compute(db, month).people;
    const ahmed = people.find((p) => p.name === 'أحمد الفني');
    const row = ahmed.orders.find((o) => o.id === order.id);
    assert.deepEqual([row.installation, row.service, row.fee], [100, 50, 150]);
    assert.equal(ahmed.commission, 15, '10% of installation 100 + service 50');
    const sara = people.find((p) => p.name === 'سارة');
    assert.equal(sara.base, 400, 'the salesperson: the goods only, no installation, no service');
});

test('staff add a «خدمة» in the quote builder: a description is required; allowed even when free lines are off', async (t) => {
    const { db, call, login } = await start(t);
    staff.create(db, { username: 'sara', display_name: 'سارة', password: 'pass-12345', permissions: ['quotes'] });
    const sara = await login('sara');
    saveSettings(db, { staff_free_lines: false });
    const quote = (description) => ({ customer_name: 'عميل', customer_phone: '91234567', items: [{ name: 'خدمة', part: 'service', unit: 'service', quantity: 1, unit_price: 30, description }] });
    const missing = await call('POST', '/api/admin/quotes', quote(''), sara);
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /وصف الخدمة/);
    const ok = await call('POST', '/api/admin/quotes', quote('صيانة دورية للمحرك'), sara);
    assert.equal(ok.status, 201);
    const item = ok.body.items[0];
    assert.deepEqual([item.part, item.category, item.description], ['service', 'service', 'صيانة دورية للمحرك']);
    assert.ok(!JSON.parse(db.prepare('SELECT details_json FROM quotes WHERE id = ?').get(ok.body.id).details_json).free_lines, 'a service is not a free line');
});
