/* Managers: today's pulse on the dashboard, and each employee's work between two dates */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const staff = require('../src/staff');
const leads = require('../src/leads');
const invoices = require('../src/invoices');
const team = require('../src/team');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const today = leads.localToday();
const addDays = (n) => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

function seed() {
    const db = openDatabase(':memory:');
    staff.create(db, { username: 'sultan', display_name: 'سلطان', password: 'pass-12345', permissions: ['quotes', 'leads', 'invoices'] });
    staff.create(db, { username: 'maryam', display_name: 'مريم', password: 'pass-12345', permissions: ['quotes', 'leads'] });
    const priced = (total) => ({ items: [{ name: 'بوابة', unit: 'piece', quantity: 1, unit_price: total, line_total: total }], subtotal: total, vat_percent: 0, vat: 0, total });
    const quote = (by, phone, total, status) => {
        const q = saveQuote(db, { customer_name: 'عميل ' + phone, customer_phone: phone, source: 'staff', priced: priced(total),
            details: { staff_quote: true, created_by: by, discount_percent: 5 }, lead_key: leads.phoneKey(phone) });
        if (status) db.prepare('UPDATE quotes SET status = ? WHERE id = ?').run(status, q.id);
        return q;
    };
    const q1 = quote('سلطان', '96891111111', 500, 'accepted');
    quote('سلطان', '96892222222', 300);
    quote('مريم', '96893333333', 200);
    return { db, q1 };
}

test('the report: each employee\'s quotes, invoices, money received, follow-up and reply time; totals and the period before', () => {
    const { db, q1 } = seed();
    const parsed = { ...db.prepare('SELECT * FROM quotes WHERE id = ?').get(q1.id) };
    parsed.items = JSON.parse(parsed.items_json); parsed.details = JSON.parse(parsed.details_json);
    // The manager issues the invoice of Sultan's quote and Sultan records a payment: the sale is Sultan's
    const inv = invoices.createFromQuote(db, parsed, {}, 'المدير العام');
    invoices.addPayment(db, inv.id, { amount: 200, method: 'cash', paid_on: today }, 'سلطان');
    // Follow-up: a customer is handed to Maryam, who answers two hours later
    const lead = db.prepare("SELECT * FROM leads WHERE phone = '96893333333'").get();
    leads.update(db, lead.id, { assigned_to: 'مريم' }, 'المدير العام');
    // Fixed times inside today's Muscat day (08:00 and 10:00 Muscat), so the test does not depend on the hour it runs
    db.prepare('UPDATE lead_assignments SET created_at = ? WHERE lead_id = ?').run(today + ' 04:00:00', lead.id);
    leads.addNote(db, lead.id, { kind: 'report', text: 'تم الاتصال بالعميل' }, 'مريم');
    db.prepare('UPDATE lead_notes SET created_at = ? WHERE lead_id = ? AND author = ?').run(today + ' 06:00:00', lead.id, 'مريم');

    const r = team.report(db, { from: addDays(-6), to: today });
    assert.equal(r.days, 7);
    assert.equal(r.previous_to, addDays(-7));
    const sultan = r.staff.find((s) => s.name === 'سلطان');
    const maryam = r.staff.find((s) => s.name === 'مريم');
    assert.equal(r.staff[0].name, 'سلطان', 'ordered by invoiced value');
    assert.equal(sultan.quote_count, 2);
    assert.equal(sultan.quote_value, 800);
    assert.equal(sultan.accepted_count, 1);
    assert.equal(sultan.win_rate, 50);
    assert.equal(sultan.average_discount, 5);
    assert.equal(sultan.invoice_count, 1);
    assert.equal(sultan.invoice_value, 500);
    assert.equal(sultan.collected, 200);
    assert.equal(sultan.active_days, 1);
    assert.equal(maryam.quote_value, 200);
    assert.equal(maryam.reports, 1);
    assert.equal(maryam.customers_handled, 1);
    assert.equal(maryam.assignments_received, 1);
    assert.equal(maryam.assignments_answered, 1);
    assert.ok(maryam.response_hours >= 1.9 && maryam.response_hours <= 2.1, String(maryam.response_hours));
    assert.equal(maryam.open_customers, 1);
    assert.equal(r.totals.quote_value, 1000);
    assert.equal(r.totals.invoice_value, 500);
    assert.equal(r.totals.collected, 200);
    assert.equal(r.previous_totals.quote_value, 0);

    // A response after the selected period must not close an assignment in it.
    const lateLead = leads.touch(db, { key: leads.phoneKey('96894444444'), channel: 'calculator', name: 'عميل لاحق', phone: '96894444444' });
    leads.update(db, lateLead.id, { assigned_to: 'مريم' }, 'المدير العام');
    const tomorrow = addDays(1);
    db.prepare('UPDATE lead_assignments SET created_at = ? WHERE lead_id = ?').run(today + ' 10:00:00', lateLead.id);
    leads.addNote(db, lateLead.id, { kind: 'report', text: 'رد خارج الفترة' }, 'مريم');
    db.prepare('UPDATE lead_notes SET created_at = ? WHERE lead_id = ? AND author = ?').run(tomorrow + ' 10:00:00', lateLead.id, 'مريم');
    const bounded = team.report(db, { from: today, to: today });
    const boundedMaryam = bounded.staff.find((s) => s.name === 'مريم');
    assert.equal(boundedMaryam.assignments_received, 2);
    assert.equal(boundedMaryam.assignments_answered, 1);
    assert.equal(boundedMaryam.assignments_waiting, 1);
    assert.ok(boundedMaryam.response_hours >= 1.9 && boundedMaryam.response_hours <= 2.1, String(boundedMaryam.response_hours));

    // A period before today's work: nothing in it, and it is the "previous" of the next one
    const old = team.report(db, { from: addDays(-20), to: addDays(-10) });
    assert.equal(old.totals.quote_count, 0);
    assert.throws(() => team.report(db, { from: today, to: addDays(-1) }), (e) => e.status === 400);
    assert.throws(() => team.report(db, { from: addDays(-500), to: today }), (e) => e.status === 400);

    // One employee in detail
    const d = team.report(db, { from: addDays(-6), to: today, employee: 'سلطان' }).employee;
    assert.equal(d.per_day.length, 7);
    assert.equal(d.per_day.at(-1).quotes, 2);
    assert.equal(d.per_day.at(-1).quote_value, 800);
    assert.equal(d.per_day.at(-1).invoice_value, 500);
    assert.deepEqual(d.timeline.map((e) => e.type).sort(), ['invoice', 'payment', 'quote', 'quote']);
    assert.equal(d.quotes_by_status.find((s) => s.key === 'accepted').value, 1);
    assert.throws(() => team.report(db, { employee: 'لا أحد' }), (e) => e.status === 404);
});

test('the pulse: today, the three rates, the sales path and the latest events', () => {
    const { db, q1 } = seed();
    const parsed = { ...db.prepare('SELECT * FROM quotes WHERE id = ?').get(q1.id) };
    parsed.items = JSON.parse(parsed.items_json); parsed.details = JSON.parse(parsed.details_json);
    const inv = invoices.createFromQuote(db, parsed, {}, 'سلطان');
    invoices.addPayment(db, inv.id, { amount: 125, method: 'cash', paid_on: today }, 'سلطان');
    const p = team.pulse(db, { days: 30 });
    assert.equal(p.today, today);
    assert.equal(p.quotes.count, 3);
    assert.equal(p.quotes.value, 1000);
    assert.equal(p.invoices.value, 500);
    assert.equal(p.collected.value, 125);
    assert.equal(p.outstanding.value, 375);
    assert.equal(p.outstanding.count, 1);
    assert.deepEqual(p.rates.win, { percent: 33.3, part: 1, whole: 3 });
    assert.equal(p.rates.collection.percent, 25);
    assert.equal(p.rates.on_time.percent, null, 'no finished job yet: no rate, not zero');
    assert.deepEqual(p.funnel.map((f) => f.value), [3, 1, 1, 0]);
    assert.ok(p.activity.length >= 5 && p.activity.some((e) => e.type === 'payment'));
});

test('only managers: the team report is refused to employees, and their dashboard has no company pulse', async (t) => {
    const { db } = seed();
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = OWNER) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const tok = (await call('POST', '/api/auth/login', { username: 'sultan', password: 'pass-12345' }, null)).body.token;
    assert.equal((await call('GET', '/api/admin/team', null, tok)).status, 403);
    staff.update(db, db.prepare("SELECT id FROM staff_users WHERE username = 'sultan'").get().id, { permissions: ['quotes', 'leads', 'dashboard'] });
    const mine = await call('GET', '/api/admin/dashboard', null, tok);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.pulse, null);
    const boss = await call('GET', '/api/admin/dashboard');
    assert.equal(boss.body.pulse.quotes.count, 3);
    const rep = await call('GET', `/api/admin/team?from=${addDays(-6)}&to=${today}&employee=${encodeURIComponent('مريم')}`);
    assert.equal(rep.status, 200);
    assert.equal(rep.body.employee.name, 'مريم');
});
