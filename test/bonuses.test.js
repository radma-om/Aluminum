/* Monthly commissions: sales staff over their target (without installation and delivery);
   technicians a % of the installation they completed */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const staff = require('../src/staff');
const invoices = require('../src/invoices');
const workorders = require('../src/workorders');
const bonuses = require('../src/bonuses');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const month = bonuses.thisMonth();
const today = new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);

/* A quote of goods + installation + delivery, priced by `owner`, invoiced today */
function sale(db, owner, goods, install = 0, delivery = 0) {
    const items = [{ name: 'شرائح', unit: 'm2', quantity: 1, unit_price: goods, line_total: goods, part: 'slats' }];
    if (install) items.push({ name: 'التركيب', type: 'السيب', unit: 'service', quantity: 1, unit_price: install, line_total: install, part: 'installation' });
    if (delivery) items.push({ name: 'التوصيل', type: 'السيب', unit: 'service', quantity: 1, unit_price: delivery, line_total: delivery, part: 'delivery' });
    const total = goods + install + delivery;
    const q = saveQuote(db, { customer_name: 'عميل', customer_phone: '9689' + Math.floor(1e7 + Math.random() * 8e7), source: 'staff',
        priced: { items, subtotal: total, vat_percent: 5, vat: total * 0.05, total: total * 1.05 }, details: { staff_quote: true, created_by: owner } });
    const row = db.prepare('SELECT * FROM quotes WHERE id = ?').get(q.id);
    const quote = { ...row, items: JSON.parse(row.items_json), details: JSON.parse(row.details_json) };
    return invoices.createFromQuote(db, quote, { issue_date: today }, 'المكتب');
}

test('a salesperson: the % of what goes over the target, without installation and delivery', () => {
    const db = openDatabase(':memory:');
    const ahmed = staff.create(db, { username: 'ahmedo', display_name: 'أحمد عثمان عمر', password: 'pass-12345', permissions: ['quotes'] });
    bonuses.setPlan(db, ahmed.id, { target: 7000, percent: 2.5 });
    sale(db, 'أحمد عثمان عمر', 5000, 300, 50);
    sale(db, 'أحمد عثمان عمر', 3000, 200);
    let s = bonuses.statement(db, month);
    let me = s.people.find((p) => p.user_id === ahmed.id);
    assert.equal(me.base, 8000, 'installation and delivery left out');
    assert.equal(me.over, 1000);
    assert.equal(me.commission, 25, '1000 × 2.5%');
    assert.equal(me.reached, true);
    assert.equal(me.invoices[0].excluded, 350);

    // A discount on the invoice: the goods' share of the final amount
    const inv = sale(db, 'أحمد عثمان عمر', 900, 100);
    invoices.cancel(db, inv.id, 'خطأ', 'المدير');
    assert.equal(bonuses.statement(db, month).people.find((p) => p.user_id === ahmed.id).base, 8000, 'a cancelled invoice does not count');

    // Under the target: no commission
    const sara = staff.create(db, { username: 'sara', display_name: 'سارة', password: 'pass-12345', permissions: ['quotes'] });
    bonuses.setPlan(db, sara.id, { target: 7000, percent: 2.5 });
    sale(db, 'سارة', 6000);
    me = bonuses.statement(db, month).people.find((p) => p.user_id === sara.id);
    assert.deepEqual([me.base, me.over, me.commission, me.reached, me.progress], [6000, 0, 0, false, 85.7]);

    // Checked
    assert.throws(() => bonuses.setPlan(db, sara.id, { target: 7000, percent: 150 }), (e) => e.status === 400);
    assert.throws(() => bonuses.setPlan(db, sara.id, { target: -1, percent: 2 }), (e) => e.status === 400);
});

test('a technician: the % of the installation fee of the installations completed; each invoice once', () => {
    const db = openDatabase(':memory:');
    const tech = staff.create(db, { username: 'tech1', display_name: 'سعيد الفني', password: 'pass-12345', role: 'technician' });
    bonuses.setPlan(db, tech.id, { target: 5000, percent: 10 });
    const inv = sale(db, 'المكتب', 1000, 200, 50);
    const t = { role: 'technician', id: tech.id, display_name: 'سعيد الفني' };
    const done = (source) => {
        const o = workorders.create(db, { kind: 'installation', customer_name: 'عميل', customer_phone: inv.customer_phone, description: 'تركيب', scheduled_date: today, technician_id: tech.id }, 'المكتب', { source });
        workorders.setStatus(db, o.id, 'done', 'تم', t);
        return o;
    };
    done({ invoice: inv });
    done({ invoice: inv });             // a second visit on the same invoice
    done(null);                         // no invoice: no installation fee
    const me = bonuses.statement(db, month).people.find((p) => p.user_id === tech.id);
    assert.equal(me.target, null, 'no target for a technician');
    assert.equal(me.count, 3);
    assert.equal(me.base, 200);
    assert.equal(me.commission, 20, '10% of 200');
    assert.deepEqual(me.orders.map((o) => o.note), ['', 'تركيب هذه الفاتورة احتُسب في أمر سابق', 'بلا فاتورة أو عرض — لا مبلغ تركيب']);
});

test('the manager: the month, setting targets, approving (kept as it was); an employee sees only their own', async (t) => {
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = OWNER) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const ahmed = staff.create(db, { username: 'ahmedo', display_name: 'أحمد عثمان عمر', password: 'pass-12345', permissions: ['quotes', 'invoices'] });
    const tok = (await call('POST', '/api/auth/login', { username: 'ahmedo', password: 'pass-12345' }, null)).body.token;
    assert.equal((await call('PUT', `/api/admin/bonuses/plan/${ahmed.id}`, { target: 7000, percent: 2.5 })).status, 200);
    assert.equal((await call('PUT', `/api/admin/bonuses/plan/${ahmed.id}`, { target: 1, percent: 90 }, tok)).status, 403, 'not their own target');
    assert.equal((await call('GET', '/api/admin/bonuses', null, tok)).status, 403, 'not the others');
    sale(db, 'أحمد عثمان عمر', 8000, 500);
    const mine = (await call('GET', '/api/admin/me/bonus', null, tok)).body.bonus;
    assert.deepEqual([mine.target, mine.base, mine.commission], [7000, 8000, 25]);
    assert.ok(!('invoices' in mine));

    const s = (await call('GET', `/api/admin/bonuses?month=${month}`)).body;
    assert.equal(s.totals.commission, 25);
    const ok = await call('POST', `/api/admin/bonuses/${month}/approve`);
    assert.equal(ok.body.approved.by, 'المدير العام');
    // Later changes do not move an approved month
    bonuses.setPlan(db, ahmed.id, { target: 1000, percent: 5 });
    assert.equal((await call('GET', `/api/admin/bonuses?month=${month}`)).body.people[0].commission, 25);
    assert.equal((await call('POST', `/api/admin/bonuses/${month}/approve`)).status, 400, 'once');
    // Withdrawn: computed again with the new figures
    const back = await call('DELETE', `/api/admin/bonuses/${month}/approve`);
    assert.equal(back.body.approved, null);
    assert.equal(back.body.people[0].commission, 350, '(8000 − 1000) × 5%');
    assert.equal((await call('GET', '/api/admin/bonuses?month=2026-13')).status, 400);
});
