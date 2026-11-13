/* Quote validity, invoices and payments */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const ExcelJS = require('exceljs');
const { openDatabase, saveSettings } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const staff = require('../src/staff');
const leads = require('../src/leads');
const backup = require('../src/backup');
const followup = require('../src/followup');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;

async function start(t) {
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = OWNER) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const type = res.headers.get('content-type') || '';
        return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), type };
    };
    const login = async (username, password) => (await call('POST', '/api/auth/login', { username, password }, null)).body.token;
    return { db, base, call, login };
}

const priced = (subtotal, extra = {}) => ({
    items: [{ name: 'بوابة شتر', quantity: 1, unit: 'piece', unit_price: subtotal, line_total: subtotal }],
    subtotal, vat_percent: 5, vat: Math.round(subtotal * 5) / 100, total: Math.round(subtotal * 105) / 100, ...extra
});
const quote = (db, subtotal = 1000, { phone = '96891234567', details = null } = {}) =>
    saveQuote(db, { customer_name: 'خالد', customer_phone: phone, source: 'web', priced: priced(subtotal), details });

test('a new quote is valid for the set number of days; past that it shows as expired', async (t) => {
    const { db, call } = await start(t);
    saveSettings(db, { quote_validity_days: 10 });
    const q = quote(db);
    const expected = new Date(Date.parse(leads.localToday() + 'T00:00:00Z') + 10 * 86400000).toISOString().slice(0, 10);
    assert.equal(q.valid_until, expected);
    let row = (await call('GET', '/api/admin/quotes')).body[0];
    assert.equal(row.expired, false);
    db.prepare("UPDATE quotes SET valid_until = date('now', '-1 day')").run();
    row = (await call('GET', '/api/admin/quotes')).body[0];
    assert.equal(row.expired, true);
    // Extended
    assert.equal((await call('PATCH', `/api/admin/quotes/${q.id}`, { valid_until: 'not-a-date' })).status, 400);
    assert.equal((await call('PATCH', `/api/admin/quotes/${q.id}`, { valid_until: '2099-01-31' })).body.valid_until, '2099-01-31');
    assert.equal((await call('GET', '/api/admin/quotes')).body[0].expired, false);
    assert.equal((await call('PUT', '/api/admin/settings', { quote_validity_days: 0 })).status, 400);
    // The PDF still renders with its validity line
    const pdf = await call('GET', `/api/admin/quotes/${q.id}/pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
});

test('an invoice copies the quote, numbers in sequence, accepts the quote and wins the customer', async (t) => {
    const { db, base, call } = await start(t);
    const q1 = quote(db, 1000);
    const q2 = quote(db, 400, { phone: '96899999999' });
    const lead = db.prepare('SELECT * FROM leads WHERE phone = ?').get('96891234567');
    assert.ok(lead);

    const r = await call('POST', `/api/admin/quotes/${q1.id}/invoice`, { issue_date: '2026-11-07', due_date: '2026-11-30', deposit: { amount: 300, method: 'bank', reference: 'TRX-1' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const inv = r.body;
    assert.equal(inv.number, 'INV-2026-0001');
    assert.equal(inv.total, 1050);
    assert.equal(inv.paid, 300);
    assert.equal(inv.balance, 750);
    assert.equal(inv.state, 'partial');
    assert.equal(inv.access_key, undefined, 'the key only travels inside the link');
    assert.match(inv.pdf_url, /^\/invoices\/INV-2026-0001\.pdf\?k=[0-9a-f]{32}$/);
    assert.equal(db.prepare('SELECT status FROM quotes WHERE id = ?').get(q1.id).status, 'accepted');
    assert.equal(db.prepare('SELECT status FROM leads WHERE id = ?').get(lead.id).status, 'won');
    assert.match(db.prepare("SELECT text FROM lead_messages WHERE lead_id = ? ORDER BY id DESC").get(lead.id).text, /INV-2026-0001/);

    // One valid invoice per quote
    assert.equal((await call('POST', `/api/admin/quotes/${q1.id}/invoice`, {})).status, 400);
    const second = (await call('POST', `/api/admin/quotes/${q2.id}/invoice`, { issue_date: '2026-11-08' })).body;
    assert.equal(second.number, 'INV-2026-0002');
    assert.equal(second.state, 'unpaid');

    // Changing the quote afterwards never changes the invoice
    db.prepare('UPDATE quotes SET total = 1 WHERE id = ?').run(q1.id);
    assert.equal((await call('GET', `/api/admin/invoices/${inv.id}`)).body.total, 1050);

    // The customer's link opens the PDF; a wrong key does not
    const ok = await fetch(base + inv.pdf_url);
    assert.equal(ok.status, 200);
    assert.equal(Buffer.from(await ok.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
    assert.equal((await fetch(base + inv.pdf_url.replace(/k=.*/, 'k=' + '0'.repeat(32)))).status, 404);
    assert.equal((await call('GET', `/api/admin/invoices/${inv.id}/pdf`)).status, 200);
});

test('a discount or the final price of a range quote sets the amounts; VAT follows', async (t) => {
    const { db, call } = await start(t);
    const q = quote(db, 1000);
    const inv = (await call('POST', `/api/admin/quotes/${q.id}/invoice`, { final_subtotal: 900 })).body;
    assert.equal(inv.subtotal, 900);
    assert.equal(inv.vat, 45);
    assert.equal(inv.total, 945);
    assert.equal(inv.adjustment, -100);
    assert.equal((await call('GET', `/api/admin/invoices/${inv.id}/pdf`)).status, 200);

    const range = saveQuote(db, { customer_name: 'مريم', customer_phone: '96895555555', source: 'web',
        priced: priced(800), details: { range: { subtotal_to: 1200, vat_to: 60, total_to: 1260 } } });
    const refused = await call('POST', `/api/admin/quotes/${range.id}/invoice`, {});
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /نطاق/);
    const fixed = (await call('POST', `/api/admin/quotes/${range.id}/invoice`, { final_subtotal: 1000 })).body;
    assert.equal(fixed.total, 1050);
    for (const bad of [{ final_subtotal: -5 }, { final_subtotal: 'abc' }]) {
        const q2 = quote(db, 100, { phone: '9689' + Math.floor(Math.random() * 1e7) });
        assert.equal((await call('POST', `/api/admin/quotes/${q2.id}/invoice`, bad)).status, 400);
    }
});

test('payments: never more than the balance; paid in full; deleting and cancelling are for managers', async (t) => {
    const { db, call, login } = await start(t);
    staff.create(db, { username: 'acc', display_name: 'المحاسب', password: 'pass-12345', permissions: ['invoices', 'quotes'] });
    const acc = await login('acc', 'pass-12345');
    const q = quote(db, 100);
    const inv = (await call('POST', `/api/admin/quotes/${q.id}/invoice`, {}, acc)).body; // total 105
    assert.equal(inv.created_by, 'المحاسب');
    assert.equal((await call('POST', `/api/admin/invoices/${inv.id}/payments`, { amount: 200, method: 'cash' }, acc)).status, 400);
    assert.equal((await call('POST', `/api/admin/invoices/${inv.id}/payments`, { amount: 50, method: 'nope' }, acc)).status, 400);
    assert.equal((await call('POST', `/api/admin/invoices/${inv.id}/payments`, { amount: 0, method: 'cash' }, acc)).status, 400);
    let r = await call('POST', `/api/admin/invoices/${inv.id}/payments`, { amount: 50, method: 'cash', paid_on: '2026-11-07' }, acc);
    assert.equal(r.status, 201);
    assert.equal(r.body.state, 'partial');
    r = await call('POST', `/api/admin/invoices/${inv.id}/payments`, { amount: 55, method: 'card' }, acc);
    assert.equal(r.body.state, 'paid');
    assert.equal(r.body.balance, 0);
    assert.equal((await call('POST', `/api/admin/invoices/${inv.id}/payments`, { amount: 1, method: 'cash' }, acc)).status, 400, 'nothing left to pay');

    const pid = r.body.payments[1].id;
    assert.equal((await call('DELETE', `/api/admin/invoices/${inv.id}/payments/${pid}`, null, acc)).status, 403);
    assert.equal((await call('POST', `/api/admin/invoices/${inv.id}/cancel`, { reason: 'x' }, acc)).status, 403);
    // Cancelling waits until the payments are removed
    assert.equal((await call('POST', `/api/admin/invoices/${inv.id}/cancel`, { reason: 'خطأ' })).status, 400);
    for (const p of r.body.payments) await call('DELETE', `/api/admin/invoices/${inv.id}/payments/${p.id}`);
    assert.equal((await call('POST', `/api/admin/invoices/${inv.id}/cancel`, {})).status, 400, 'a reason is required');
    const cancelled = (await call('POST', `/api/admin/invoices/${inv.id}/cancel`, { reason: 'العميل غيّر المقاس' })).body;
    assert.equal(cancelled.state, 'cancelled');
    assert.equal((await call('POST', `/api/admin/invoices/${inv.id}/payments`, { amount: 1, method: 'cash' })).status, 400);
    // The number stays taken: the replacement gets the next one
    const again = (await call('POST', `/api/admin/quotes/${q.id}/invoice`, {})).body;
    assert.equal(again.number.slice(-4), '0002');
    const actions = (await call('GET', '/api/admin/audit')).body.entries.map((e) => e.action);
    for (const a of ['إصدار فاتورة', 'تسجيل دفعة', 'حذف دفعة', 'إلغاء فاتورة']) assert.ok(actions.includes(a), a);
});

test('staff without the invoices section cannot see invoices; the customer scope applies', async (t) => {
    const { db, call, login } = await start(t);
    staff.create(db, { username: 'sales', display_name: 'سالم', password: 'pass-12345', permissions: ['quotes', 'leads'] });
    staff.create(db, { username: 'mine', display_name: 'مريم', password: 'pass-12345', permissions: ['invoices', 'quotes', 'leads'], leads_scope: 'mine' });
    const q = quote(db, 100);
    // Legacy follow-up rows may store the local 8-digit form while quotes and
    // invoices use the normalized 968… form. The employee scope must still
    // recognize the ownership and keep the invoice hidden from other staff.
    db.prepare("UPDATE leads SET phone = '91234567', assigned_to = 'سالم' WHERE phone = '96891234567'").run();
    const inv = (await call('POST', `/api/admin/quotes/${q.id}/invoice`, {})).body;
    const sales = await login('sales', 'pass-12345');
    assert.equal((await call('GET', '/api/admin/invoices', null, sales)).status, 403);
    assert.equal((await call('POST', `/api/admin/quotes/${q.id}/invoice`, {}, sales)).status, 403);
    const mine = await login('mine', 'pass-12345');
    const mineInvoices = (await call('GET', '/api/admin/invoices', null, mine)).body;
    assert.equal(mineInvoices.invoices.length, 0, 'another employee\'s customer');
    assert.deepEqual(mineInvoices.summary, {
        month: leads.localToday().slice(0, 7), issued_count: 0, issued_value: 0,
        collected: 0, outstanding: 0, overdue: 0
    }, 'the summary follows the employee customer scope');
    assert.equal((await call('GET', `/api/admin/invoices/${inv.id}`, null, mine)).status, 404);
});

test('summary, weekly report, backups and restore include invoices and payments', async (t) => {
    const { db, call } = await start(t);
    const today = leads.localToday();
    const q = quote(db, 1000);
    const inv = (await call('POST', `/api/admin/quotes/${q.id}/invoice`, { due_date: today, deposit: { amount: 200, method: 'cash' } })).body;
    const s = (await call('GET', '/api/admin/invoices')).body.summary;
    assert.equal(s.issued_count, 1);
    assert.equal(s.issued_value, 1050);
    assert.equal(s.collected, 200);
    assert.equal(s.outstanding, 850);
    const w = followup.buildWeekly(db);
    assert.equal(w.invoices.count, 1);
    assert.equal(w.invoices.collected, 200);
    assert.match(followup.weeklyText(db, w), /الفواتير: 1 بقيمة 1050\.00/);

    const file = await backup.exportWorkbook(db);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file);
    assert.ok(wb.getWorksheet('الفواتير') && wb.getWorksheet('الدفعات'));
    db.prepare('DELETE FROM payments').run();
    db.prepare('DELETE FROM invoices').run();
    await backup.restoreWorkbook(db, file);
    const back = (await call('GET', `/api/admin/invoices/${inv.id}`)).body;
    assert.equal(back.number, inv.number);
    assert.equal(back.paid, 200);
});
