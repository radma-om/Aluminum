/* An issued invoice is edited (new sizes, lines changed) by an employee or a manager, even when part of it
   is paid: the number and the payments stay, what it was is kept, open work orders follow */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/server');
const staff = require('../src/staff');
const workorders = require('../src/workorders');
const bonuses = require('../src/bonuses');
const push = require('../src/push');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const sent = [];
push.setSenderForTests(async (sub, payload) => { sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }); });

test('edit the sizes and lines of an invoice paid in part', async (t) => {
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = OWNER) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const sultan = staff.create(db, { username: 'sultan', display_name: 'سلطان', password: 'pass-12345', permissions: ['invoices'] });
    const tech = staff.create(db, { username: 'ahmed', display_name: 'أحمد الفني', password: 'pass-12345', role: 'technician' });
    const login = async (u) => (await call('POST', '/api/auth/login', { username: u, password: 'pass-12345' }, null)).body.token;
    const tok = await login('sultan');
    await call('POST', '/api/admin/me/push', { subscription: { endpoint: 'https://fcm.googleapis.com/send/tech', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } } }, await login('ahmed'));

    const conf = (await call('GET', '/api/public/configurator')).body;
    const type = conf.shutter_types.find((x) => x.variants.length === 1);
    const region = conf.locations[0].wilayat[0].id;
    const params = (w, h) => ({ shutter_type_id: type.id, variant_id: null, color_id: type.variants[0].colors[0].id, width_cm: w, height_cm: h, count: 1,
        option_ids: conf.accessory_groups.map((g) => g.options[0].id) });
    const gate = (w, h) => ({ calc: 'rolling_shutter', params: params(w, h) });
    const q = (await call('POST', '/api/admin/quotes', { customer_phone: '91234567', customer_name: 'خالد', region_id: region, items: [gate(300, 250)] })).body;
    const inv = (await call('POST', `/api/admin/quotes/${q.id}/invoice`, { deposit_required: { type: 'percent', value: 50 } })).body;
    await call('POST', `/api/admin/invoices/${inv.id}/payments`, { amount: 100, method: 'cash' });
    const order = workorders.create(db, { kind: 'installation', description: '', scheduled_date: '2099-01-01', technician_id: tech.id }, 'المكتب', { source: { invoice: { ...inv, items: inv.items, details: inv.details } } });
    sent.length = 0;

    // The employee (invoices only) may open the builder's catalog and preview
    assert.equal((await call('GET', '/api/admin/quotes/catalog', null, tok)).status, 200);
    assert.equal((await call('POST', '/api/admin/quotes/preview', { region_id: region, items: [gate(400, 300)] }, tok)).status, 200);
    // A reason is required
    assert.equal((await call('PUT', `/api/admin/invoices/${inv.id}/items`, { region_id: region, items: [gate(400, 300)] }, tok)).status, 400);

    // New size + a free line added, by the employee
    const r = await call('PUT', `/api/admin/invoices/${inv.id}/items`, { region_id: region, reason: 'تغيير المقاس بعد المعاينة',
        items: [gate(400, 300), { name: 'ريموت إضافي', unit: 'piece', unit_price: 10, quantity: 2 }] }, tok);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const e = r.body;
    assert.equal(e.number, inv.number, 'the same number');
    assert.ok(e.total > inv.total);
    assert.equal(e.previous_total, inv.total);
    assert.equal(e.paid, 100, 'the payment stays');
    assert.equal(e.balance, Math.round((e.total - 100) * 100) / 100);
    assert.equal(e.state, 'partial');
    assert.match(e.details.calc_groups[0].label, /400×300/);
    assert.equal(e.details.created_by, q.details.created_by, 'the sale stays its owner\'s');
    assert.equal(e.details.edited_by, 'سلطان');
    assert.equal(e.deposit.amount, Math.round(e.total * 50) / 100, 'a % deposit follows the new total');
    assert.equal(e.items.at(-1).name, 'ريموت إضافي');
    assert.deepEqual([e.revisions.length, e.revisions[0].total, e.revisions[0].new_total, e.revisions[0].reason, e.revisions[0].edited_by],
        [1, inv.total, e.total, 'تغيير المقاس بعد المعاينة', 'سلطان']);
    // The PDF still renders; the customer log tells; the quote is untouched
    assert.equal((await fetch(base + e.pdf_url)).status, 200);
    assert.match(db.prepare("SELECT text FROM lead_messages WHERE role = 'system' ORDER BY id DESC").get().text, /عُدّلت الفاتورة/);
    assert.equal(db.prepare('SELECT total FROM quotes WHERE id = ?').get(q.id).total, q.total);
    // The open work order: the new job, and the technician is told
    const o = workorders.get(db, order.id);
    assert.match(o.description, /ريموت إضافي/);
    assert.match(o.events[0].text, /عُدّلت الفاتورة/);
    assert.deepEqual(e.updated_work_orders, [order.number]);
    await new Promise((res) => setTimeout(res, 30));
    assert.ok(sent.some((m) => m.title === '✏️ تعديل في أمر عمل — راجع التفاصيل'));

    // Below what was paid: refused, nothing changes
    const low = await call('PUT', `/api/admin/invoices/${inv.id}/items`, { reason: 'تجربة', items: [{ name: 'بند صغير', unit: 'piece', unit_price: 20, quantity: 1 }] });
    assert.equal(low.status, 400);
    assert.match(low.body.error, /المدفوع على الفاتورة/);
    assert.equal((await call('GET', `/api/admin/invoices/${inv.id}`)).body.total, e.total);
    // Down to just above what was paid: allowed, the balance follows
    const exact = await call('PUT', `/api/admin/invoices/${inv.id}/items`, { reason: 'اتفاق نهائي', items: [{ name: 'بوابة', unit: 'piece', unit_price: 100, quantity: 1 }] });
    assert.equal(exact.status, 200, JSON.stringify(exact.body));
    assert.equal(exact.body.balance, Math.round((exact.body.total - 100) * 100) / 100);
    assert.equal(exact.body.revisions.length, 2);
    // Commissions follow the edited invoice
    bonuses.setPlan(db, sultan.id, { target: 0, percent: 10 });
    // A cancelled invoice is not edited
    await call('DELETE', `/api/admin/invoices/${inv.id}/payments/${exact.body.payments[0].id}`);
    await call('POST', `/api/admin/invoices/${inv.id}/cancel`, { reason: 'إلغاء' });
    assert.equal((await call('PUT', `/api/admin/invoices/${inv.id}/items`, { reason: 'x', items: [{ name: 'بوابة', unit: 'piece', unit_price: 100, quantity: 1 }] })).status, 400);
});
