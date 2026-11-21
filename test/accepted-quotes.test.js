/* A customer accepts a quote from its page: the managers, the quote's owner and every employee who issues
   invoices (and may see this customer) are told; «وافق العميل» in «طلبات العروض» lists it — waiting for the
   invoice, then with the invoice and who issued it. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const staff = require('../src/staff');
const invoices = require('../src/invoices');
const push = require('../src/push');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const pushed = [];
push.setSenderForTests(async (sub, payload) => { pushed.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }); });
const device = (name) => ({ endpoint: `https://fcm.googleapis.com/send/${name}`, keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } });

test('accepted: managers and invoice staff are told; the list shows who accepted and who issued the invoice', async (t) => {
    pushed.length = 0;
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;

    const sara = staff.create(db, { username: 'sara', display_name: 'سارة', password: 'pass-12345', role: 'staff', permissions: ['quotes', 'invoices'] });
    const ali = staff.create(db, { username: 'ali', display_name: 'علي', password: 'pass-12345', role: 'staff', permissions: ['quotes', 'leads'] });          // no invoices
    const mona = staff.create(db, { username: 'mona', display_name: 'منى', password: 'pass-12345', role: 'staff', permissions: ['invoices'], leads_scope: 'mine' }); // only her customers
    const tech = staff.create(db, { username: 'ahmed', display_name: 'أحمد', password: 'pass-12345', role: 'technician' });
    await push.subscribe(db, { owner: true }, device('boss'));
    for (const [u, n] of [[sara, 'sara'], [ali, 'ali'], [mona, 'mona'], [tech, 'tech']]) await push.subscribe(db, { id: u.id }, device(n));

    // A calculator quote (no owner), accepted by the customer from its page
    const priced = { items: [{ name: 'بوابة', quantity: 1, unit_price: 400, line_total: 400 }], subtotal: 400, vat_percent: 5, vat: 20, total: 420 };
    const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(saveQuote(db, { customer_name: 'خالد سالم', customer_phone: '91234567', source: 'calculator', priced }).id);
    const res = await fetch(`${base}/q/${q.access_key}/accept`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'confirm=1' });
    assert.equal(res.status, 303);
    await new Promise((r) => setTimeout(r, 80));
    const told = new Set(pushed.filter((p) => /وافق خالد/.test(p.title)).map((p) => p.endpoint.split('/').pop()));
    // «mine» covers the customers not assigned to anyone, so Mona is told too
    assert.deepEqual([...told].sort(), ['boss', 'mona', 'sara'], 'the manager and those who issue invoices; not quotes-only, not a technician');

    // «وافق العميل»: waiting for the invoice
    const login = async (u) => (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'pass-12345' }) })).json()).token;
    const list = async (token) => fetch(`${base}/api/admin/quotes/accepted`, { headers: { Authorization: 'Bearer ' + token } });
    const saraToken = await login('sara');
    let rows = await (await list(saraToken)).json();
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].ref, rows[0].status, rows[0].invoice], [q.ref, 'accepted', null]);
    assert.ok(rows[0].accepted_at);

    // Sara issues the invoice: the row shows it and her name
    const row = db.prepare('SELECT * FROM quotes WHERE id = ?').get(q.id);
    const inv = invoices.createFromQuote(db, { ...row, items: JSON.parse(row.items_json), details: JSON.parse(row.details_json || '{}') }, {}, 'سارة');
    rows = await (await list(saraToken)).json();
    assert.deepEqual([rows[0].invoice.number, rows[0].invoice.by], [inv.number, 'سارة']);

    // Who may see the list: quotes or invoices; a technician may not; «mine» sees only their customers
    assert.equal((await list(await login('ali'))).status, 200);
    assert.equal((await (await list(await login('mona'))).json()).length, 1, 'an unassigned customer: in «mine» too');
    // Once the customer is assigned to another employee, «mine» no longer sees it
    db.prepare("UPDATE leads SET assigned_to = 'علي' WHERE phone = '96891234567'").run();
    assert.deepEqual(await (await list(await login('mona'))).json(), []);
    assert.equal((await list(await login('ahmed'))).status, 403);
});
