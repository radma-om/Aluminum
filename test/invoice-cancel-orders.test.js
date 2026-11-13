/* An invoice cancelled: its open work orders are cancelled with it and the technician is told; done ones stay */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const staff = require('../src/staff');
const invoices = require('../src/invoices');
const workorders = require('../src/workorders');
const push = require('../src/push');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const sent = [];
push.setSenderForTests(async (sub, payload) => { sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }); });

function invoiceFor(db) {
    const priced = { items: [{ name: 'بوابة', unit: 'piece', quantity: 1, unit_price: 500, line_total: 500 }], subtotal: 500, vat_percent: 0, vat: 0, total: 500 };
    const q = saveQuote(db, { customer_name: 'خالد', customer_phone: '96891234567', source: 'web', priced });
    const row = db.prepare('SELECT * FROM quotes WHERE id = ?').get(q.id);
    return invoices.createFromQuote(db, { ...row, items: JSON.parse(row.items_json), details: null }, {});
}

test('cancelling an invoice cancels its open work orders; the technician is told; done orders stay', async (t) => {
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
    const tech = staff.create(db, { username: 'ahmed', display_name: 'أحمد الفني', password: 'pass-12345', role: 'technician' });
    const tt = (await call('POST', '/api/auth/login', { username: 'ahmed', password: 'pass-12345' }, null)).body.token;
    await call('POST', '/api/admin/me/push', { subscription: { endpoint: 'https://fcm.googleapis.com/send/tech', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } } }, tt);

    const inv = invoiceFor(db);
    const mk = (kind) => workorders.create(db, { kind, description: 'عمل', scheduled_date: '2099-01-01', technician_id: tech.id }, 'المكتب', { source: { invoice: inv } });
    const open = mk('installation');
    const done = mk('inspection');
    workorders.setStatus(db, done.id, 'done', 'تمت المعاينة', { role: 'technician', id: tech.id, display_name: 'أحمد الفني' });
    const other = workorders.create(db, { kind: 'maintenance', customer_name: 'سالم', customer_phone: '96899999999', description: 'صيانة', technician_id: tech.id }, 'المكتب');
    sent.length = 0;

    const r = await call('POST', `/api/admin/invoices/${inv.id}/cancel`, { reason: 'العميل ألغى الطلب' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.cancelled_work_orders, [open.number]);
    assert.equal(workorders.get(db, open.id).status, 'cancelled');
    assert.match(workorders.get(db, open.id).events[0].text, /أُلغي تلقائياً: أُلغيت الفاتورة INV-.* — العميل ألغى الطلب/);
    assert.equal(workorders.get(db, done.id).status, 'done', 'work already done stays');
    assert.notEqual(workorders.get(db, other.id).status, 'cancelled', 'another customer\'s order is untouched');
    await new Promise((res) => setTimeout(res, 30));
    assert.ok(sent.some((m) => m.title === '❌ أُلغي أمر عمل — لا تذهب' && m.body.includes(open.number)));
    // The technician's list no longer shows it among the open ones
    const mine = (await call('GET', '/api/admin/work-orders?open=1', null, tt)).body.orders.map((o) => o.number);
    assert.ok(!mine.includes(open.number));
});

test('orders left open on an invoice cancelled earlier are cancelled when the system starts', () => {
    const db = openDatabase(':memory:');
    const inv = invoiceFor(db);
    const o = workorders.create(db, { kind: 'installation', description: 'تركيب', scheduled_date: '2099-01-01' }, 'المكتب', { source: { invoice: inv } });
    invoices.cancel(db, inv.id, 'خطأ في الفاتورة', 'المدير'); // the old way: the order stayed open
    assert.notEqual(workorders.get(db, o.id).status, 'cancelled');
    createApp(db);
    assert.equal(workorders.get(db, o.id).status, 'cancelled');
    assert.equal(workorders.cancelOrphans(db).length, 0, 'nothing left the next time');
});
