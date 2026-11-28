/* Work order events to other systems (Panorama): the «تعديل / جدولة» window (PATCH) sends work_order.status_changed
   when the status changes (e.g. scheduled once it has a technician and a day), work_order.updated when only the day,
   time or technician changes, and nothing for the address or description alone; business / external_ref are in both.
   Also: a service visit made on site (created, then done), and orders of invoices cancelled earlier (at start). */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const webhooks = require('../src/webhooks');
const staff = require('../src/staff');
const workorders = require('../src/workorders');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;

async function start(t, db = openDatabase(':memory:')) {
    const emitted = [];
    const real = webhooks.emit;
    webhooks.emit = (d, event, data) => { emitted.push({ event, data }); return Promise.resolve([]); };
    t.after(() => { webhooks.emit = real; });
    const { createApp } = require('../src/server');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = OWNER) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    return { db, call, emitted };
}

test('the «تعديل / جدولة» window: status_changed, updated, or nothing — business and external_ref included', async (t) => {
    const { db, call, emitted } = await start(t);
    const tech = staff.create(db, { username: 'fahad', display_name: 'فهد', password: 'pass-12345', role: 'technician' });
    const tech2 = staff.create(db, { username: 'saeed', display_name: 'سعيد', password: 'pass-12345', role: 'technician' });
    // An order from Panorama, not scheduled yet
    const order = workorders.create(db, { kind: 'installation', customer_name: 'خالد', customer_phone: '96891234567', description: 'تركيب 4 كاميرات' }, 'بانوراما',
        { notify: false, external: { business: 'panorama', ref: 'panorama:install:3' } });
    assert.equal(order.status, 'new');

    // A technician and a day → scheduled: one work_order.status_changed (not updated too)
    let r = await call('PATCH', `/api/admin/work-orders/${order.id}`, { technician_id: tech.id, scheduled_date: '2026-12-30', scheduled_time: '10:00' });
    assert.equal(r.status, 200);
    assert.deepEqual(emitted.map((e) => e.event), ['work_order.status_changed']);
    const d = emitted[0].data;
    assert.deepEqual([d.id, d.number, d.status, d.scheduled_date, d.scheduled_time, d.completed_at, d.business, d.external_ref],
        [order.id, order.number, 'scheduled', '2026-12-30', '10:00', null, 'panorama', 'panorama:install:3']);

    // A new day for a scheduled order: one work_order.updated, the same shape
    emitted.length = 0;
    await call('PATCH', `/api/admin/work-orders/${order.id}`, { scheduled_date: '2026-12-31', scheduled_time: '11:30' });
    assert.deepEqual(emitted.map((e) => e.event), ['work_order.updated']);
    assert.deepEqual([emitted[0].data.status, emitted[0].data.scheduled_date, emitted[0].data.scheduled_time, emitted[0].data.business, emitted[0].data.external_ref],
        ['scheduled', '2026-12-31', '11:30', 'panorama', 'panorama:install:3']);
    assert.deepEqual(Object.keys(emitted[0].data).sort(), Object.keys(d).sort(), 'the same fields as status_changed');

    // Another technician, same status: updated
    emitted.length = 0;
    await call('PATCH', `/api/admin/work-orders/${order.id}`, { technician_id: tech2.id });
    assert.deepEqual(emitted.map((e) => e.event), ['work_order.updated']);

    // The description or address alone: nothing
    emitted.length = 0;
    await call('PATCH', `/api/admin/work-orders/${order.id}`, { description: 'تركيب 4 كاميرات وجهاز تسجيل', address: 'نزوى، حي الشرق' });
    assert.equal(emitted.length, 0);

    // The same values again: nothing
    await call('PATCH', `/api/admin/work-orders/${order.id}`, { scheduled_date: '2026-12-31', scheduled_time: '11:30' });
    assert.equal(emitted.length, 0);

    // No technician any more → back to new: status_changed only
    await call('PATCH', `/api/admin/work-orders/${order.id}`, { technician_id: null });
    assert.deepEqual(emitted.map((e) => [e.event, e.data.status]), [['work_order.status_changed', 'new']]);
});

test('work_order.updated is registered and retried (1, 5, 15 min); status_changed stays one try', () => {
    assert.ok(webhooks.EVENTS.includes('work_order.updated'));
    assert.ok(webhooks.RETRY_EVENTS.includes('work_order.updated'));
    assert.ok(!webhooks.RETRY_EVENTS.includes('work_order.status_changed'));
    assert.ok(!webhooks.RETRY_EVENTS.includes('work_order.created'));
});

test('a service visit done on site: work_order.created, then status_changed (done)', async (t) => {
    const { call, emitted } = await start(t);
    const r = await call('POST', '/api/admin/work-orders/service-visit', { customer: { phone: '93334444', name: 'مريم', city: 'نزوى' },
        services: [{ title: 'صيانة', description: 'تغيير ريموت', quantity: 1, unit_price: 5 }], done: true, note: 'تم' });
    assert.equal(r.status, 201);
    const wo = emitted.filter((e) => e.event.startsWith('work_order.'));
    assert.deepEqual(wo.map((e) => [e.event, e.data.status]), [['work_order.created', 'new'], ['work_order.status_changed', 'done']]);
});

test('orders of an invoice cancelled earlier, cancelled at start: work_order.status_changed for each', async (t) => {
    const db = openDatabase(':memory:');
    const order = workorders.create(db, { kind: 'installation', customer_name: 'سالم', customer_phone: '96891111111', description: 'تركيب' }, 'المدير', { notify: false });
    db.exec(`INSERT INTO invoices (number, access_key, customer_name, customer_phone, items_json, quote_subtotal, subtotal, vat_percent, vat, total, issue_date, status)
             VALUES ('INV-OLD', 'k-old', 'سالم', '96891111111', '[]', 0, 0, 5, 0, 0, '2026-11-01', 'cancelled')`);
    db.prepare('UPDATE work_orders SET invoice_id = (SELECT id FROM invoices WHERE number = ?) WHERE id = ?').run('INV-OLD', order.id);
    const { emitted } = await start(t, db);
    assert.deepEqual(emitted.filter((e) => e.event.startsWith('work_order.')).map((e) => [e.event, e.data.id, e.data.status]),
        [['work_order.status_changed', order.id, 'cancelled']]);
});
