/* The office follows the technicians' reports; the technician sees the jobs that matter now with the time left */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const staff = require('../src/staff');
const leads = require('../src/leads');
const push = require('../src/push');
const workorders = require('../src/workorders');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const sent = [];
push.setSenderForTests(async (sub, payload) => { sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }); });
const settle = () => new Promise((r) => setTimeout(r, 30));
const device = (name) => ({ endpoint: `https://fcm.googleapis.com/send/${name}`, keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } });
const local = (iso) => new Date(Date.parse(iso) + 4 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');

test('the time of a job, from the free text the office writes (Muscat time)', () => {
    const at = (t) => { const d = workorders.dueAt('2026-11-14', t); return [local(d.at).slice(11), d.exact]; };
    assert.deepEqual(at('9 صباحاً'), ['09:00', true]);
    assert.deepEqual(at('4:30 م'), ['16:30', true]);
    assert.deepEqual(at('٣ مساءً'), ['15:00', true]);
    assert.deepEqual(at('2 ظهراً'), ['14:00', true]);
    assert.deepEqual(at('14:00'), ['14:00', true]);
    assert.deepEqual(at('عصراً'), ['16:00', false], 'a part of the day is approximate');
    assert.deepEqual(at(''), ['08:00', false], 'no time: the start of the working day');
    assert.equal(workorders.dueAt('غير صالح', '9'), null);
});

test('the board: under way first, then late, today, the next days; time left counted from now', () => {
    const now = Date.parse('2026-11-14T06:00:00Z'); // 10:00 in Muscat
    const o = (id, status, date, time) => ({ id, number: 'WO-' + id, status, scheduled_date: date, scheduled_time: time, customer_name: 'ع' + id });
    const b = workorders.board(null, [
        o(1, 'scheduled', '2026-11-20', '9 صباحاً'),
        o(2, 'scheduled', '2026-11-14', '2 ظهراً'),
        o(3, 'in_progress', '2026-11-14', '8 صباحاً'),
        o(4, 'scheduled', '2026-11-13', ''),
        o(5, 'scheduled', '2026-11-14', '9 صباحاً'),
        o(6, 'new', null, null),
        o(7, 'done', '2026-11-14', ''),
        o(8, 'scheduled', '2026-12-30', '')
    ], { now });
    assert.deepEqual(b.top.map((x) => x.id), [3, 4, 5, 2, 1], 'under way, late (yesterday, 9:00 passed), today, then next week; far and unscheduled left out');
    assert.equal(b.top.find((x) => x.id === 2).minutes_left, 240, '14:00 is 4 hours away');
    assert.equal(b.top.find((x) => x.id === 5).late, true, 'today at 9:00, now 10:00');
    assert.deepEqual(b.counts, { in_progress: 1, late: 2, today: 3, week: 4, unscheduled: 1 });
});

test('the technician reports: the office is told on the phone, sees the latest report on the order and in the feed; the salesperson in the customer log', async (t) => {
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
    const login = async (u) => (await call('POST', '/api/auth/login', { username: u, password: 'pass-12345' }, null)).body.token;
    const tech = staff.create(db, { username: 'ahmed', display_name: 'أحمد الفني', password: 'pass-12345', role: 'technician' });
    staff.create(db, { username: 'office', display_name: 'مكتب', password: 'pass-12345', permissions: ['work_orders'] });
    staff.create(db, { username: 'sales', display_name: 'مبيعات', password: 'pass-12345', permissions: ['quotes', 'leads'] });
    const tt = await login('ahmed');
    const to = await login('office');
    await call('POST', '/api/admin/me/push', { subscription: device('boss') });
    await call('POST', '/api/admin/me/push', { subscription: device('office') }, to);
    await call('POST', '/api/admin/me/push', { subscription: device('tech') }, tt);
    await call('POST', '/api/admin/me/push', { subscription: device('sales') }, await login('sales'));

    const priced = { items: [{ name: 'بوابة', unit: 'piece', quantity: 1, unit_price: 500, line_total: 500 }], subtotal: 500, vat_percent: 0, vat: 0, total: 500 };
    saveQuote(db, { customer_name: 'خالد', customer_phone: '96891234567', source: 'web', priced, lead_key: leads.phoneKey('96891234567') });
    const tomorrow = new Date(Date.now() + 4 * 3600_000 + 86400_000).toISOString().slice(0, 10);
    const order = (await call('POST', '/api/admin/work-orders', { kind: 'installation', customer_name: 'خالد', customer_phone: '96891234567',
        description: 'تركيب بوابة', scheduled_date: tomorrow, scheduled_time: '9 صباحاً', technician_id: tech.id })).body;
    await settle();
    sent.length = 0;

    // The technician's board: their job, tomorrow at 9, with the time left; no feed
    const tb = (await call('GET', '/api/admin/work-orders/board', null, tt)).body;
    assert.equal(tb.top.length, 1);
    assert.equal(tb.top[0].number, order.number);
    assert.equal(tb.top[0].due_exact, true);
    assert.ok(tb.top[0].minutes_left > 0);
    assert.deepEqual(tb.feed, []);

    // An office note is not a technician report
    await call('POST', `/api/admin/work-orders/${order.id}/notes`, { text: 'العميل يفضّل الاتصال قبل الوصول' }, to);
    await settle();
    assert.equal(sent.length, 0);

    // The technician starts, reports, sends it back
    await call('POST', `/api/admin/work-orders/${order.id}/status`, { status: 'in_progress' }, tt);
    await call('POST', `/api/admin/work-orders/${order.id}/notes`, { text: 'ركّبت المجاري، بانتظار وصول المحرك' }, tt);
    await settle();
    const told = sent.map((m) => [m.endpoint.split('/').pop(), m.title]).sort();
    assert.deepEqual(told, [['boss', '▶️ بدأ الفني العمل'], ['boss', '📝 تقرير من الفني'], ['office', '▶️ بدأ الفني العمل'], ['office', '📝 تقرير من الفني']],
        'the office and the managers, not the technician or sales');
    assert.match(sent.find((m) => m.title === '📝 تقرير من الفني').body, /ركّبت المجاري/);

    // The office: the latest report on the order, the feed, the order history marks the technician's lines
    const list = (await call('GET', '/api/admin/work-orders?open=1', null, to)).body.orders;
    assert.equal(list[0].tech_last_text, 'ركّبت المجاري، بانتظار وصول المحرك');
    assert.equal(list[0].tech_last_author, 'أحمد الفني');
    assert.equal(list[0].tech_reports, 2);
    const ob = (await call('GET', '/api/admin/work-orders/board', null, to)).body;
    assert.deepEqual(ob.feed.map((e) => e.text), ['ركّبت المجاري، بانتظار وصول المحرك', 'الحالة: مجدول ← قيد التنفيذ']);
    assert.equal(ob.counts.in_progress, 1);
    const full = (await call('GET', `/api/admin/work-orders/${order.id}`, null, to)).body;
    assert.deepEqual(full.events.map((e) => e.by_technician), [1, 1, 0, 0]);

    // The salesperson following the customer sees the reports in the customer's log
    const lead = db.prepare("SELECT * FROM leads WHERE phone = '96891234567'").get();
    const log = db.prepare("SELECT text FROM lead_messages WHERE lead_id = ? AND role = 'system' ORDER BY id").all(lead.id).map((r) => r.text);
    assert.ok(log.some((x) => /بدأ الفني العمل/.test(x)));
    assert.ok(log.some((x) => /تقرير من الفني.*ركّبت المجاري/.test(x)));

    // Done: one line in the customer log (as before), the office told
    sent.length = 0;
    await call('POST', `/api/admin/work-orders/${order.id}/status`, { status: 'done', note: 'رُكّبت وجُرّبت' }, tt);
    await settle();
    assert.ok(sent.some((m) => m.title === '✅ أنهى الفني العمل' && /رُكّبت وجُرّبت/.test(m.body)));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lead_messages WHERE lead_id = ? AND text LIKE '%اكتمل أمر%'").get(lead.id).n, 1);
    assert.equal((await call('GET', '/api/admin/work-orders/board', null, tt)).body.top.length, 0);
});
