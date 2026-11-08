/* The customers section: one record per customer and their profile */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const customers = require('../src/customers');
const leads = require('../src/leads');
const staff = require('../src/staff');
const backup = require('../src/backup');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;

async function start(t, db = openDatabase(':memory:')) {
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = OWNER) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    return { db, call };
}
const priced = (s) => ({ items: [{ name: 'بوابة', quantity: 1, unit: 'piece', unit_price: s, line_total: s }], subtotal: s, vat_percent: 5, vat: s * 0.05, total: s * 1.05 });
const quote = (db, phone, name, s = 1000, city = 'السيب') => saveQuote(db, { customer_name: name, customer_phone: phone, customer_city: city, source: 'web', priced: priced(s) });

test('existing data becomes customers on first start: one per phone, named after the latest quote', () => {
    const db = openDatabase(':memory:');
    // Data from before the customers section
    db.exec('DELETE FROM customers');
    db.prepare("INSERT INTO quotes (ref, customer_name, customer_phone, customer_city, items_json, subtotal, vat_percent, vat, total, created_at) VALUES ('Q-OLD', 'خالد', '96891111111', 'بركاء', '[]', 1, 5, 0, 1, '2026-01-01 10:00:00')").run();
    db.prepare("INSERT INTO quotes (ref, customer_name, customer_phone, customer_city, items_json, subtotal, vat_percent, vat, total, created_at) VALUES ('Q-NEW', 'خالد الحارثي', '96891111111', 'بركاء', '[]', 1, 5, 0, 1, '2026-02-01 10:00:00')").run();
    db.prepare("INSERT INTO leads (contact_key, channel, name, phone) VALUES ('tel:96892222222', 'whatsapp', 'مريم (واتساب)', '96892222222')").run();
    db.prepare("INSERT INTO leads (contact_key, channel, name) VALUES ('web:abc', 'website', 'زائر')").run(); // no phone: not a customer
    assert.equal(customers.backfill(db), 2);
    const all = db.prepare('SELECT phone, name, city FROM customers ORDER BY phone').all();
    assert.deepEqual(all.map((c) => ({ ...c })), [
        { phone: '96891111111', name: 'خالد الحارثي', city: 'بركاء' },
        { phone: '96892222222', name: 'مريم (واتساب)', city: null }
    ]);
    assert.equal(customers.backfill(db), 0, 'runs once');
});

test('new customers are added automatically from WhatsApp, the calculators and manual work orders', async (t) => {
    const { db, call } = await start(t);
    leads.customerMessage(db, { key: 'tel:96893333333', channel: 'whatsapp', name: 'سعيد', phone: '96893333333', text: 'مرحبا' });
    quote(db, '91234567', 'ناصر');   // an 8-digit number
    await call('POST', '/api/admin/work-orders', { customer_name: 'هلال', customer_phone: '96895555555', location: 'صحار', description: 'صيانة' });
    const phones = db.prepare('SELECT phone, name, city FROM customers ORDER BY phone').all().map((c) => [c.phone, c.name, c.city]);
    assert.deepEqual(phones, [['96891234567', 'ناصر', 'السيب'], ['96893333333', 'سعيد', null], ['96895555555', 'هلال', 'صحار']]);
    // A later quote with another name does not overwrite the record
    quote(db, '96891234567', 'اسم آخر');
    assert.equal(customers.byPhone(db, '96891234567').name, 'ناصر');
});

test('the profile gathers follow-up, quotes, invoices (paid / owed) and work orders — also through the second phone', async (t) => {
    const { db, call } = await start(t);
    const q1 = quote(db, '96891111111', 'خالد', 1000);
    const q2 = quote(db, '96897777777', 'خالد (رقم العمل)', 200);   // the same customer on another number
    const c = customers.byPhone(db, '96891111111');
    // The second number already has its own record: it cannot be added to another one
    const dup = await call('PATCH', `/api/admin/customers/${c.id}`, { phone2: '97777777' });
    assert.equal(dup.status, 400);
    assert.match(dup.body.error, /مسجّل لعميل آخر/);
    db.prepare('DELETE FROM customers WHERE phone = ?').run('96897777777'); // the duplicate record goes; its history joins via phone2
    assert.equal((await call('PATCH', `/api/admin/customers/${c.id}`, { phone2: '97777777', email: 'khalid@example.com', address: 'الخوض 6' })).status, 200);
    const inv = (await call('POST', `/api/admin/quotes/${q1.id}/invoice`, { deposit: { amount: 300, method: 'cash' } })).body;
    await call('POST', '/api/admin/work-orders', { invoice_id: inv.id });

    const p = (await call('GET', `/api/admin/customers/${c.id}`)).body;
    assert.equal(p.customer.phone2, '96897777777');
    assert.deepEqual(p.quotes.map((q) => q.ref).sort(), [q1.ref, q2.ref].sort());
    assert.equal(p.quotes.find((q) => q.id === q1.id).invoice.number, inv.number);
    assert.equal(p.invoices[0].balance, 750);
    assert.equal(p.customer.invoiced, 1050);
    assert.equal(p.customer.paid, 300);
    assert.equal(p.customer.balance, 750);
    assert.equal(p.work_orders.length, 1);
    assert.equal(p.customer.open_jobs, 1);
    assert.ok(p.leads.length >= 1);

    // List: search, and «owes money»
    assert.equal((await call('GET', '/api/admin/customers?q=khalid@')).body.customers.length, 1);
    assert.equal((await call('GET', '/api/admin/customers?q=7777')).body.customers[0].id, c.id, 'found by the second phone');
    quote(db, '96898888888', 'لا يدين');
    const owes = (await call('GET', '/api/admin/customers?owes=1')).body.customers;
    assert.deepEqual(owes.map((x) => x.id), [c.id]);
    // The name typed in the record follows into the follow-up
    await call('PATCH', `/api/admin/customers/${c.id}`, { name: 'خالد الحارثي' });
    assert.equal(db.prepare("SELECT name FROM leads WHERE phone = '96891111111'").get().name, 'خالد الحارثي');
    // The lead page links to the record
    const lead = db.prepare("SELECT id FROM leads WHERE phone = '96891111111'").get().id;
    assert.equal((await call('GET', `/api/admin/leads/${lead}`)).body.customer_id, c.id);
});

test('the customer list uses one aggregate query instead of queries per customer', () => {
    const db = openDatabase(':memory:');
    for (let i = 0; i < 40; i++) {
        const phone = '9689' + String(i).padStart(7, '0');
        quote(db, phone, 'عميل ' + i, 100 + i);
    }

    let prepareCount = 0;
    const countedDb = new Proxy(db, {
        get(target, property) {
            if (property === 'prepare') return (...args) => {
                prepareCount++;
                return target.prepare(...args);
            };
            const value = target[property];
            return typeof value === 'function' ? value.bind(target) : value;
        }
    });
    const rows = customers.list(countedDb, { limit: 100 });
    assert.equal(rows.length, 40);
    assert.ok(rows.every((c) => c.quote_count === 1 && c.invoiced === 0 && c.balance === 0));
    assert.equal(prepareCount, 1, 'the query count stays constant as the customer count grows');
});

test('adding by hand: phone and name required, no duplicates; deleting only an empty record (managers)', async (t) => {
    const { db, call } = await start(t);
    assert.equal((await call('POST', '/api/admin/customers', { name: 'x', phone: '12' })).status, 400);
    assert.equal((await call('POST', '/api/admin/customers', { phone: '96891111111' })).status, 400);
    const r = await call('POST', '/api/admin/customers', { name: 'مؤسسة النور', phone: '9123 4567', city: 'مسقط', map_url: 'https://maps.app.goo.gl/x' });
    assert.equal(r.status, 201);
    assert.equal(r.body.phone, '96891234567');
    assert.equal((await call('POST', '/api/admin/customers', { name: 'مكرر', phone: '96891234567' })).status, 400);
    assert.equal((await call('PATCH', `/api/admin/customers/${r.body.id}`, { map_url: 'javascript:alert(1)' })).status, 400);
    assert.equal((await call('PATCH', `/api/admin/customers/${r.body.id}`, { email: 'bad' })).status, 400);
    const withQuote = customers.byPhone(db, quote(db, '96892222222', 'له عرض').customer_phone);
    assert.equal((await call('DELETE', `/api/admin/customers/${withQuote.id}`)).status, 400);
    staff.create(db, { username: 'sales', display_name: 'سالم', password: 'pass-12345', permissions: ['customers'] });
    const tok = (await call('POST', '/api/auth/login', { username: 'sales', password: 'pass-12345' }, null)).body.token;
    assert.equal((await call('DELETE', `/api/admin/customers/${r.body.id}`, null, tok)).status, 403);
    assert.equal((await call('DELETE', `/api/admin/customers/${r.body.id}`)).status, 204);
    const actions = (await call('GET', '/api/admin/audit')).body.entries.map((e) => e.action);
    for (const a of ['إضافة عميل', 'حذف عميل']) assert.ok(actions.includes(a), a);
});

test('permissions and scope: the customers section, and «عملاؤه فقط» applies; backups keep the records', async (t) => {
    const { db, call } = await start(t);
    quote(db, '96891111111', 'عميل سالم');
    quote(db, '96892222222', 'عميل مريم');
    db.prepare("UPDATE leads SET assigned_to = 'سالم' WHERE phone = '96891111111'").run();
    db.prepare("UPDATE leads SET assigned_to = 'مريم' WHERE phone = '96892222222'").run();
    staff.create(db, { username: 'salem', display_name: 'سالم', password: 'pass-12345', permissions: ['customers'], leads_scope: 'mine' });
    staff.create(db, { username: 'other', display_name: 'خالد', password: 'pass-12345', permissions: ['quotes'] });
    const login = async (u) => (await call('POST', '/api/auth/login', { username: u, password: 'pass-12345' }, null)).body.token;
    const salem = await login('salem');
    const list = (await call('GET', '/api/admin/customers', null, salem)).body.customers;
    assert.deepEqual(list.map((c) => c.name), ['عميل سالم']);
    const maryam = customers.byPhone(db, '96892222222');
    assert.equal((await call('GET', `/api/admin/customers/${maryam.id}`, null, salem)).status, 404);
    assert.equal((await call('GET', '/api/admin/customers', null, await login('other'))).status, 403);

    const file = await backup.exportWorkbook(db);
    db.prepare('DELETE FROM customers').run();
    await backup.restoreWorkbook(db, file);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 2);
});

test('a limited employee cannot open a customer when the second phone belongs to another employee', async (t) => {
    const { db, call } = await start(t);
    quote(db, '96891111111', 'عميل برقمين');
    quote(db, '96892222222', 'عميل برقمين — العمل');
    db.prepare("UPDATE leads SET assigned_to = 'سالم' WHERE phone = '96891111111'").run();
    db.prepare("UPDATE leads SET assigned_to = 'مريم' WHERE phone = '96892222222'").run();

    const main = customers.byPhone(db, '96891111111');
    const merged = (await call('POST', `/api/admin/customers/${main.id}/merge`, { phone: '96892222222' })).body;
    assert.equal(merged.phone2, '96892222222');
    assert.equal((await call('GET', `/api/admin/customers/${main.id}`)).status, 200, 'the manager still sees the full customer');

    staff.create(db, {
        username: 'salem2', display_name: 'سالم', password: 'pass-12345',
        permissions: ['customers', 'quotes'], leads_scope: 'mine'
    });
    const token = (await call('POST', '/api/auth/login', { username: 'salem2', password: 'pass-12345' }, null)).body.token;

    assert.deepEqual((await call('GET', '/api/admin/customers', null, token)).body.customers, []);
    assert.equal((await call('GET', `/api/admin/customers/${main.id}`, null, token)).status, 404);
    assert.equal((await call('PATCH', `/api/admin/customers/${main.id}`, { notes: 'غير مسموح' }, token)).status, 404);
    assert.equal((await call('POST', '/api/admin/quotes', { customer_id: main.id, items: [] }, token)).status, 404);
});

test('the same customer on two numbers: merging joins the history under one record', async (t) => {
    const { db, call } = await start(t);
    quote(db, '96891111111', 'خالد', 1000);
    quote(db, '96897777777', 'خالد (العمل)', 200, 'مسقط');
    const a = customers.byPhone(db, '96891111111');
    assert.equal((await call('POST', `/api/admin/customers/${a.id}/merge`, { phone: '96899999999' })).status, 400);
    const merged = (await call('POST', `/api/admin/customers/${a.id}/merge`, { phone: '97777777' })).body;
    assert.equal(merged.phone2, '96897777777');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 1);
    const p = (await call('GET', `/api/admin/customers/${a.id}`)).body;
    assert.equal(p.quotes.length, 2);
    assert.equal(p.customer.quote_count, 2);
    // A third number cannot be merged in (one second number per customer)
    quote(db, '96895555555', 'خالد 3');
    assert.equal((await call('POST', `/api/admin/customers/${a.id}/merge`, { phone: '96895555555' })).status, 400);
    // New activity on the second number stays with the merged customer
    quote(db, '96897777777', 'خالد', 50);
    assert.equal(customers.byPhone(db, '96897777777').id, a.id);
    assert.ok((await call('GET', '/api/admin/audit')).body.entries.some((e) => e.action.startsWith('دمج عميلين')));
});
