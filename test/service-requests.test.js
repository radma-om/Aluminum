/* Appointment requests: the customer asks (AI or office), the responsible employee approves with an
   appointment (→ a work order) or declines; the customer is told on WhatsApp; the AI answers
   «متى موعدي؟» from the customer's own number only. No real message or email is sent. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase, saveSettings } = require('../src/db');
const { createApp } = require('../src/server');
const staff = require('../src/staff');
const agent = require('../src/agent');
const leads = require('../src/leads');
const requests = require('../src/servicerequests');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const today = leads.localToday();
const inDays = (n) => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

async function start(t) {
    const db = openDatabase(':memory:');
    saveSettings(db, { company_name: 'رادما' });
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = OWNER) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const login = async (u, p = 'pass-12345') => (await call('POST', '/api/auth/login', { username: u, password: p }, null)).body.token;
    return { db, call, login };
}

/* A WhatsApp sender that records instead of sending */
const recorder = (ok = true) => {
    const sent = [];
    return {
        sent,
        mazbot: { hasLogin: () => true, sendTextToPhone: async (to, text) => { sent.push({ to, text }); return ok ? { ok: true } : { ok: false, error: 'outside 24h' }; } },
        whatsapp: { isConfigured: () => false }
    };
};

test('a request: checked, numbered, linked to the customer, and limited per number', () => {
    const db = openDatabase(':memory:');
    const base = { kind: 'maintenance', customer_name: 'سالم', customer_phone: '91234567', description: 'محرك الرول شتر لا يعمل', location: 'نزوى' };
    const r = requests.create(db, { ...base, preferred_date: inDays(2), preferred_period: 'morning' }, { source: 'mazbot' });
    assert.match(r.ref, /^SR-\d{4}-0001$/);
    assert.equal(r.customer_phone, '96891234567');
    assert.equal(r.status, 'pending');
    assert.equal(r.period_label, 'صباحاً');
    assert.ok(require('../src/customers').byPhone(db, '96891234567'));
    for (const bad of [{ customer_phone: '123' }, { description: '' }, { preferred_date: inDays(-1) }, { preferred_date: inDays(200) }, { preferred_date: '2026-13-40' }]) {
        assert.throws(() => requests.create(db, { ...base, ...bad }), (e) => e.status === 400, JSON.stringify(bad));
    }
    requests.create(db, base);
    requests.create(db, base);
    assert.throws(() => requests.create(db, base), (e) => e.status === 429, 'at most 3 waiting per number');
});

test('approve: a work order with the appointment, the customer gets the confirmation; decline: with the reason', async () => {
    const db = openDatabase(':memory:');
    saveSettings(db, { company_name: 'رادما' });
    const r = requests.create(db, { kind: 'installation', customer_name: 'سالم', customer_phone: '96891234567', description: 'تركيب بوابة أوفرهيد Q-1', location: 'نزوى', preferred_date: inDays(2) });
    const tech = staff.create(db, { username: 'tech', display_name: 'فني', password: 'pass-12345', role: 'technician' });
    const rec = recorder();
    await assert.rejects(requests.approve(db, r.id, {}, 'مدير', rec), (e) => e.status === 400, 'a date is needed');
    const out = await requests.approve(db, r.id, { scheduled_date: inDays(3), scheduled_time: '9 صباحاً', technician_id: tech.id, note: 'تجهيز كهرباء' }, 'مدير', rec);
    assert.equal(out.request.status, 'approved');
    assert.equal(out.order.status, 'scheduled');
    assert.equal(out.order.scheduled_date, inDays(3));
    assert.match(out.order.description, /من طلب العميل SR-/);
    assert.equal(out.notice.ok, true);
    assert.equal(rec.sent.length, 1);
    assert.equal(rec.sent[0].to, '96891234567');
    // Another day than asked: the message says so
    assert.match(rec.sent[0].text, /التاريخ الذي طلبته غير متاح/);
    assert.match(rec.sent[0].text, new RegExp(inDays(3)));
    assert.match(rec.sent[0].text, /تجهيز كهرباء/);
    assert.equal(requests.get(db, r.id).customer_notice, 'sent');
    await assert.rejects(requests.approve(db, r.id, { scheduled_date: inDays(3) }, 'مدير', rec), (e) => e.status === 400, 'decided once');

    // WhatsApp refuses (24 hours passed): the appointment stays, the failure is kept and returned
    const r2 = requests.create(db, { kind: 'maintenance', customer_name: 'خالد', customer_phone: '96899887766', description: 'صيانة', preferred_date: inDays(1) });
    const out2 = await requests.approve(db, r2.id, { scheduled_date: inDays(1) }, 'مدير', recorder(false));
    assert.equal(out2.request.status, 'approved');
    assert.equal(out2.notice.ok, false);
    assert.match(requests.get(db, r2.id).customer_notice, /^failed: outside 24h/);

    const r3 = requests.create(db, { kind: 'inspection', customer_name: 'خالد', customer_phone: '96899887766', description: 'قياس' });
    const rec3 = recorder();
    await assert.rejects(requests.reject(db, r3.id, { reason: '' }, 'مدير', rec3), (e) => e.status === 400);
    const out3 = await requests.reject(db, r3.id, { reason: 'خارج منطقة الخدمة' }, 'مدير', rec3);
    assert.equal(out3.request.status, 'rejected');
    assert.match(rec3.sent[0].text, /خارج منطقة الخدمة/);
});

test('the AI: records a request, and tells only the WhatsApp customer their own appointments', async () => {
    const db = openDatabase(':memory:');
    const ctx = (phone, channel = 'mazbot') => ({ db, phone, channel, events: [], createQuote: () => null, notifyHuman: async () => {} });
    const c1 = ctx('96891234567');
    const made = await agent.executeTool('request_appointment', {
        kind: 'maintenance', description: 'المحرك لا يعمل', location: 'السيب', address: null, preferred_date: inDays(1), preferred_period: 'evening', customer_name: 'سالم', customer_phone: null
    }, c1);
    assert.match(made.ref, /^SR-/);
    assert.equal(c1.events[0].type, 'service_request');
    assert.equal(requests.get(db, c1.events[0].request.id).source, 'mazbot');

    // Another customer's appointment must never show
    const other = requests.create(db, { kind: 'installation', customer_name: 'غيره', customer_phone: '96895555555', description: 'تركيب' });
    await requests.approve(db, other.id, { scheduled_date: inDays(4) }, 'مدير', recorder());

    const mine = await agent.executeTool('my_appointments', {}, ctx('96891234567'));
    assert.equal(mine.requests.length, 1);
    assert.equal(mine.requests[0].ref, made.ref);
    assert.equal(mine.appointments.length, 0);
    assert.ok(!JSON.stringify(mine).includes('95555555'));
    assert.ok(mine.today.includes(today));

    const theirs = await agent.executeTool('my_appointments', {}, ctx('96895555555'));
    assert.equal(theirs.appointments.length, 1);
    assert.equal(theirs.appointments[0].status, 'مؤكد');
    assert.ok(theirs.appointments[0].date.includes(inDays(4)));

    // Website: no verified number — nothing is read, even with a number typed in
    const web = await agent.executeTool('my_appointments', { customer_phone: '95555555' }, ctx(null, 'website'));
    assert.equal(web.appointments, undefined);
    assert.match(web.message, /واتساب/);
    // …but a request can be made with the number the visitor gives
    const webReq = await agent.executeTool('request_appointment', {
        kind: 'inspection', description: 'قياس فتحة', location: 'مسقط', address: null, preferred_date: null, preferred_period: null, customer_name: 'زائر', customer_phone: '92223333'
    }, ctx(null, 'website'));
    assert.match(webReq.ref, /^SR-/);
    assert.ok(agent.TOOLS.some((t) => t.name === 'request_appointment') && agent.OPENAI_TOOLS.some((t) => t.function.name === 'my_appointments'));
    assert.match(agent.systemPrompt({ company_name: 'x' }), new RegExp(today));
});

test('the panel: list, approve, decline, record by phone; technicians and other sections are refused', async (t) => {
    const { db, call, login } = await start(t);
    const r = requests.create(db, { kind: 'maintenance', customer_name: 'سالم', customer_phone: '96891234567', description: 'صيانة محرك', preferred_date: inDays(2) }, { source: 'mazbot' });
    const list = await call('GET', '/api/admin/service-requests?status=pending');
    assert.equal(list.status, 200);
    assert.equal(list.body.requests.length, 1);
    assert.equal((await call('GET', '/api/admin/work-orders?open=1')).body.pending_requests, 1);

    // No WhatsApp connected in tests: approved anyway, and the employee is told the message did not go
    const ok = await call('POST', `/api/admin/service-requests/${r.id}/approve`, { scheduled_date: inDays(2), scheduled_time: '10 صباحاً' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.match(ok.body.order.number, /^WO-/);
    assert.equal(ok.body.notice.ok, false);
    assert.equal((await call('GET', '/api/admin/work-orders?open=1')).body.pending_requests, 0);

    // Moving the appointment with «إبلاغ العميل» tries to tell them; without it, nothing is sent
    const moved = await call('PATCH', `/api/admin/work-orders/${ok.body.order.id}`, { scheduled_date: inDays(5), notify_customer: true });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.scheduled_date, inDays(5));
    assert.equal(moved.body.notice.ok, false);
    const quiet = await call('PATCH', `/api/admin/work-orders/${ok.body.order.id}`, { scheduled_time: '11 صباحاً' });
    assert.equal(quiet.body.notice, null);
    const cancelled = await call('POST', `/api/admin/work-orders/${ok.body.order.id}/cancel`, { reason: 'طلب العميل', notify_customer: true });
    assert.equal(cancelled.body.status, 'cancelled');
    assert.ok(cancelled.body.notice);

    const byPhone = await call('POST', '/api/admin/service-requests', { kind: 'inspection', customer_name: 'خالد', customer_phone: '99887766', description: 'قياس' });
    assert.equal(byPhone.status, 201);
    assert.equal(byPhone.body.source, 'staff');
    const no = await call('POST', `/api/admin/service-requests/${byPhone.body.id}/reject`, { reason: 'لا يوجد فنيون', notify: false });
    assert.equal(no.body.request.status, 'rejected');
    assert.equal(no.body.notice, null);

    staff.create(db, { username: 'tech', display_name: 'فني', password: 'pass-12345', role: 'technician' });
    staff.create(db, { username: 'sales', display_name: 'مبيعات', password: 'pass-12345', permissions: ['quotes'] });
    staff.create(db, { username: 'office', display_name: 'مكتب', password: 'pass-12345', permissions: ['work_orders'] });
    assert.equal((await call('GET', '/api/admin/service-requests', null, await login('tech'))).status, 403);
    assert.equal((await call('GET', '/api/admin/service-requests', null, await login('sales'))).status, 403);
    assert.equal((await call('GET', '/api/admin/service-requests', null, await login('office'))).status, 200);

    const foreign = leads.touch(db, { key: leads.phoneKey('96895555555'), channel: 'calculator', name: 'مريم', phone: '96895555555' });
    db.prepare("UPDATE leads SET assigned_to = 'مريم' WHERE id = ?").run(foreign.id);
    staff.create(db, { username: 'office-scope', display_name: 'سالم', password: 'pass-12345', permissions: ['work_orders'], leads_scope: 'mine' });
    const scoped = await login('office-scope');
    assert.equal((await call('POST', '/api/admin/service-requests', { kind: 'maintenance', customer_name: 'مريم', customer_phone: '96895555555', description: 'صيانة' }, scoped)).status, 404);
});
