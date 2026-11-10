const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { openDatabase, saveSettings } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const invoices = require('../src/invoices');
const dashboard = require('../src/dashboard');
const inbox = require('../src/mazbot-inbox');
const mazbot = require('../src/mazbot');
const leads = require('../src/leads');

process.env.ADMIN_TOKEN = 'test-token';

/* Fake MazBot API: records sent messages */
async function fakeMazbot() {
    const sent = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks);
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/login') return res.end(JSON.stringify({ data: { token: 'jwt' } }));
        if (req.url === '/api/contact/resolve-by-phone') return res.end(JSON.stringify({ data: { receiver_id: 777 } }));
        const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: raw }).formData();
        sent.push({ path: req.url, ...Object.fromEntries(form.entries()) });
        res.end(JSON.stringify({ success: true }));
    });
    await new Promise((r) => server.listen(0, r));
    Object.assign(process.env, {
        MAZBOT_BASE_URL: `http://127.0.0.1:${server.address().port}/api`,
        MAZBOT_API_KEY: 'k', MAZBOT_STAFF_EMAIL: 's@example.com', MAZBOT_STAFF_PASSWORD: 'p', ANTHROPIC_API_KEY: 'test'
    });
    delete process.env.MAZBOT_TEMPLATE_ID;
    delete process.env.MAZBOT_OVERHEAD_TEMPLATE_ID;
    mazbot._reset();
    return { server, sent };
}

const fakeClient = (script) => ({ beta: { messages: { create: async (params) => script.shift()(params) } } });
const toolUse = (id, name, input) => ({ content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' });
const say = (t) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' });

let n = 0;
const incoming = (value) => ({
    id: 'evt-' + (++n), type: 'message.received',
    data: { contact: { id: 1376829, phone: '96899887897', name: 'محمد' }, message: { id: 15700000 + n, message_type: 'text', value } }
});
const store = (db, e) => Number(db.prepare("INSERT INTO inbound_events (source, method, body) VALUES ('mazbot', 'POST', ?)").run(JSON.stringify(e)).lastInsertRowid);

async function startApp(db) {
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, staff = 'سالم') => {
        const res = await fetch(base + url, {
            method,
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token', 'X-Staff-Name': encodeURIComponent(staff) },
            body: body ? JSON.stringify(body) : undefined
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    return { server, call };
}

test('a WhatsApp conversation is kept for the follow-up: messages, quote, "talk to a person", paused and agent off', async (t) => {
    const fake = await fakeMazbot();
    t.after(() => fake.server.close());
    const db = openDatabase(':memory:');
    saveSettings(db, { mazbot_agent_enabled: true });
    const ctx = (client) => ({ saveQuote: (q) => saveQuote(db, q), notifySales: async () => null, baseUrl: 'https://x', client });

    const e1 = incoming('السلام عليكم، كم سعر الرول شتر؟');
    await inbox.handleEvent(db, store(db, e1), e1, ctx(fakeClient([() => say('أهلاً بك! ما مقاس الفتحة؟')])));
    const e2 = incoming('أريد التحدث مع موظف');
    await inbox.handleEvent(db, store(db, e2), e2, ctx(fakeClient([
        () => toolUse('t1', 'request_human', { summary: 'يريد زيارة للموقع' }),
        () => say('سيتواصل معك فريق المبيعات')
    ])));
    const e3 = incoming('متى؟'); // paused: no answer, still recorded
    await inbox.handleEvent(db, store(db, e3), e3, ctx(fakeClient([])));
    saveSettings(db, { mazbot_agent_enabled: false });
    const e4 = incoming('هل أنتم موجودون؟'); // agent off: still recorded
    inbox.handleEvent(db, store(db, e4), e4, ctx());

    const [lead] = leads.list(db);
    assert.strictEqual(lead.contact_key, 'tel:96899887897');
    assert.strictEqual(lead.name, 'محمد');
    assert.strictEqual(lead.channel, 'whatsapp');
    assert.strictEqual(lead.status, 'needs_staff');
    const { messages } = leads.detail(db, lead.id);
    assert.deepStrictEqual(messages.map((m) => m.role), ['customer', 'assistant', 'customer', 'system', 'assistant', 'customer', 'customer']);
    assert.match(messages[3].text, /يريد زيارة للموقع/);

    // A calculator request from the same number joins the same customer
    saveQuote(db, { customer_name: 'محمد', customer_phone: '99887897', source: 'web', priced: { items: [], subtotal: 100, vat_percent: 5, vat: 5, total: 105 } });
    assert.strictEqual(leads.list(db).length, 1);
    assert.match(leads.detail(db, lead.id).messages.at(-1).text, /عرض سعر Q.* — 105\.00 ر\.ع/);
    assert.strictEqual(leads.list(db)[0].quote_count, 1);
});

test('employees follow a customer: assign, report, recommendation, handover, status, WhatsApp reply', async (t) => {
    const fake = await fakeMazbot();
    t.after(() => fake.server.close());
    const db = openDatabase(':memory:');
    const lead = leads.customerMessage(db, { key: 'tel:96891112222', channel: 'whatsapp', name: 'خالد', phone: '96891112222', text: 'أريد مكينة بوابة' });
    const { server, call } = await startApp(db);
    t.after(() => server.close());

    assert.strictEqual((await call('PUT', '/api/admin/settings', { staff_members: ['سالم', 'مريم', ' سالم ', ''] })).body.staff_members.length, 2);
    const list = await call('GET', '/api/admin/leads?open=1');
    assert.deepStrictEqual(list.body.staff, ['سالم', 'مريم']);
    assert.strictEqual(list.body.leads[0].name, 'خالد');

    // Employee 1 takes the customer, writes a report and a recommendation
    await call('PATCH', `/api/admin/leads/${lead.id}`, { assigned_to: 'سالم', status: 'following', next_follow_up: '2026-11-05' });
    await call('POST', `/api/admin/leads/${lead.id}/notes`, { kind: 'report', text: 'اتصلت بالعميل، البوابة منزلقة ووزنها 500 كجم' });
    await call('POST', `/api/admin/leads/${lead.id}/notes`, { kind: 'recommendation', text: 'اقتراح مكينة 600 كجم مع ريموت إضافي' });
    // ...and hands over to employee 2
    const handed = await call('PATCH', `/api/admin/leads/${lead.id}`, { assigned_to: 'مريم', handover_text: 'العميل ينتظر زيارة يوم الخميس' });
    assert.strictEqual(handed.body.lead.assigned_to, 'مريم');
    assert.deepStrictEqual(handed.body.notes.map((x) => [x.kind, x.author]), [
        ['handover', 'سالم'], ['recommendation', 'سالم'], ['report', 'سالم'], ['handover', 'سالم']
    ]);
    assert.match(handed.body.notes[0].text, /من سالم إلى مريم[^]*يوم الخميس/);
    assert.ok(handed.body.messages.some((m) => m.role === 'system' && /جديد ← قيد المتابعة \(سالم\)/.test(m.text)));

    // Employee 2 answers on WhatsApp through MazBot; the AI agent steps back
    const reply = await call('POST', `/api/admin/leads/${lead.id}/reply`, { text: 'مرحباً خالد، نؤكد موعد الخميس' }, 'مريم');
    assert.strictEqual(reply.status, 201, JSON.stringify(reply.body));
    assert.deepStrictEqual(fake.sent.map((s) => [s.receiver_id, s.message]), [['777', 'مرحباً خالد، نؤكد موعد الخميس']]);
    assert.deepStrictEqual(reply.body.messages.at(-1), { ...reply.body.messages.at(-1), role: 'staff', author: 'مريم' });
    assert.ok(inbox.isPaused(db, '96891112222'));

    // Validation
    assert.strictEqual((await call('PATCH', `/api/admin/leads/${lead.id}`, { status: 'xx' })).status, 400);
    assert.strictEqual((await call('PATCH', `/api/admin/leads/${lead.id}`, { next_follow_up: 'غداً' })).status, 400);
    assert.strictEqual((await call('POST', `/api/admin/leads/${lead.id}/notes`, { kind: 'report', text: ' ' })).status, 400);
    assert.strictEqual((await call('GET', '/api/admin/leads/9999')).status, 404);
    const web = leads.customerMessage(db, { key: 'web:abc', channel: 'website', text: 'مرحبا' });
    assert.strictEqual((await call('POST', `/api/admin/leads/${web.id}/reply`, { text: 'أهلاً' })).status, 400); // no number

    // Filters: by employee, unassigned, search
    assert.strictEqual((await call('GET', '/api/admin/leads?assigned=' + encodeURIComponent('مريم'))).body.leads.length, 1);
    assert.strictEqual((await call('GET', '/api/admin/leads?assigned=-')).body.leads[0].contact_key, 'web:abc');
    assert.strictEqual((await call('GET', '/api/admin/leads?q=1112222')).body.leads[0].id, lead.id);
});

test('dashboard: requests, value, win rate, calculators, channels, places and follow-up', async (t) => {
    const db = openDatabase(':memory:');
    const priced = (total) => ({ items: [], subtotal: total, vat_percent: 5, vat: 0, total });
    const q1 = saveQuote(db, { customer_name: 'أ', customer_phone: '91111111', source: 'web', priced: priced(100), details: { calculator: 'overhead', region: 'نزوى' } });
    saveQuote(db, { customer_name: 'ب', customer_phone: '92222222', source: 'mazbot', priced: priced(300), details: { width_cm: 300, region: 'نزوى' } });
    saveQuote(db, { customer_name: 'ج', customer_phone: '93333333', source: 'website', priced: priced(200), details: { calculator: 'motors', region: 'بهلا' } });
    db.prepare("UPDATE quotes SET status = 'accepted' WHERE id = ?").run(q1.id);
    // A quote 40 days ago is in the previous period of a 30-day view
    const old = saveQuote(db, { customer_name: 'د', customer_phone: '94444444', source: 'web', priced: priced(50) });
    db.prepare("UPDATE quotes SET created_at = datetime('now', '-40 days') WHERE id = ?").run(old.id);
    db.prepare("UPDATE leads SET status = 'needs_staff', next_follow_up = date('now') WHERE phone = '96892222222'").run();

    const { server, call } = await startApp(db);
    t.after(() => server.close());
    const { body: d } = await call('GET', '/api/admin/dashboard?days=30');
    assert.strictEqual(d.per_day.length, 30);
    assert.strictEqual(d.per_day.at(-1).count, 3);
    assert.deepStrictEqual(d.kpis.quotes, { value: 3, previous: 1 });
    assert.deepStrictEqual(d.kpis.value, { value: 600, previous: 50 });
    assert.strictEqual(d.kpis.won_value.value, 100);
    assert.strictEqual(d.kpis.win_rate.value, 33.3);
    assert.strictEqual(d.kpis.average.value, 200);
    assert.deepStrictEqual(d.by_calculator.map((x) => x.label).sort(), ['أوفرهيد', 'رولينج شتر', 'مكائن البوابات'].sort());
    assert.deepStrictEqual(d.by_source.map((x) => x.label).sort(), ['الحاسبات', 'دردشة الموقع', 'واتساب'].sort());
    assert.deepStrictEqual(d.by_place[0], { key: 'نزوى', label: 'نزوى', value: 2 });
    assert.strictEqual(d.by_status.find((x) => x.key === 'accepted').value, 1);
    assert.strictEqual(d.kpis.open_leads.value, 4);
    assert.strictEqual(d.kpis.needs_staff.value, 1);
    assert.strictEqual(d.kpis.due_follow_ups.value, 1);
    assert.strictEqual(d.leads_by_staff[0].label, 'غير مُسند');
});

test('assignment history records both sides and warns after 48 hours until the employee acts', () => {
    const db = openDatabase(':memory:');
    const lead = leads.customerMessage(db, { key: 'tel:96890001111', channel: 'whatsapp', name: 'متابعة', phone: '96890001111', text: 'أحتاج عرضاً' });

    leads.update(db, lead.id, { assigned_to: 'سالم' }, 'المدير العام');
    db.prepare("UPDATE leads SET assigned_at = datetime('now', '-49 hours'), last_staff_at = datetime('now', '-49 hours'), last_staff_by = 'المدير العام' WHERE id = ?").run(lead.id);

    const overdue = leads.overdueAssignments(db);
    assert.strictEqual(overdue.length, 1);
    assert.strictEqual(overdue[0].assigned_to, 'سالم');
    assert.ok(overdue[0].assignment_overdue.hours >= 48);
    assert.deepStrictEqual(leads.detail(db, lead.id).assignments.map((a) => [a.from_employee, a.to_employee, a.assigned_by]), [[null, 'سالم', 'المدير العام']]);

    leads.addNote(db, lead.id, { kind: 'report', text: 'تم الاتصال بالعميل' }, 'سالم');
    assert.strictEqual(leads.overdueAssignments(db).length, 0);

    leads.update(db, lead.id, { assigned_to: 'مريم' }, 'سالم');
    assert.deepStrictEqual(leads.detail(db, lead.id).assignments.map((a) => [a.from_employee, a.to_employee, a.assigned_by]), [
        ['سالم', 'مريم', 'سالم'], [null, 'سالم', 'المدير العام']
    ]);
});

test('dashboard scopes an employee to their work and credits an invoice to the quote owner', () => {
    const db = openDatabase(':memory:');
    const priced = (total) => ({ items: [], subtotal: total, vat_percent: 0, vat: 0, total });
    const salemQuote = saveQuote(db, {
        customer_name: 'عميل سالم', customer_phone: '90002222', source: 'staff',
        priced: priced(120), details: { staff_quote: true, created_by: 'سالم', calculator: 'motors' }
    });
    saveQuote(db, {
        customer_name: 'عميل مريم', customer_phone: '90003333', source: 'staff',
        priced: priced(300), details: { staff_quote: true, created_by: 'مريم', calculator: 'overhead' }
    });
    // The manager issues Salem's quote, but the sale belongs to Salem.
    invoices.createFromQuote(db, salemQuote, {}, 'المدير العام');
    const lead = leads.customerMessage(db, { key: 'tel:96890004444', channel: 'whatsapp', name: 'عميل متابعة', phone: '96890004444', text: 'اتصلوا بي' });
    leads.update(db, lead.id, { assigned_to: 'سالم', status: 'following' }, 'المدير العام');
    leads.addNote(db, lead.id, { kind: 'report', text: 'تمت المتابعة' }, 'سالم');

    const manager = dashboard.build(db, { days: 30, user: { role: 'manager', display_name: 'المدير العام' } });
    const salem = manager.staff.find((s) => s.name === 'سالم');
    assert.deepStrictEqual({
        assigned: salem.assigned, received: salem.assignments_received,
        reports: salem.reports, quotes: salem.quote_count, invoices: salem.invoice_count, invoice_value: salem.invoice_value
    }, { assigned: 1, received: 1, reports: 1, quotes: 1, invoices: 1, invoice_value: 120 });
    assert.strictEqual(manager.staff.find((s) => s.name === 'المدير العام').invoice_count, 0);

    const employee = dashboard.build(db, { days: 30, user: { role: 'staff', display_name: 'سالم' } });
    assert.deepStrictEqual(employee.staff.map((s) => s.name), ['سالم']);
    assert.strictEqual(employee.kpis.quotes.value, 1);
    assert.strictEqual(employee.kpis.open_leads.value, 1);
    assert.strictEqual(employee.sales_by_staff[0].invoice_count, 1);
});

test('an existing database starts the follow-up list from its recent quotes', () => {
    const db = openDatabase(':memory:');
    const priced = { items: [], subtotal: 10, vat_percent: 5, vat: 0.5, total: 10.5 };
    saveQuote(db, { customer_name: 'أ', customer_phone: '91111111', source: 'web', priced });
    db.prepare("UPDATE quotes SET status = 'accepted'").run();
    db.exec('DELETE FROM lead_messages; DELETE FROM leads;');
    leads.backfill(db);
    const [lead] = leads.list(db);
    assert.strictEqual(lead.phone, '96891111111');
    assert.strictEqual(lead.status, 'won');
    assert.strictEqual(leads.detail(db, lead.id).messages.length, 1);
});
