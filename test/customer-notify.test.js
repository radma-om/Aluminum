/* WhatsApp to the customer from the company's number: the invoice, a payment's confirmation, a reminder of
   what is left — an approved template when set (any time), else a plain message (24-hour window). */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const staff = require('../src/staff');
const invoices = require('../src/invoices');
const workorders = require('../src/workorders');
const leads = require('../src/leads');
const notify = require('../src/customer-notify');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const sent = [];
let fail = null;
notify.setSenderForTests(async (m) => { sent.push(m); return fail ? { ok: false, error: fail } : { ok: true }; });

async function start(t) {
    sent.length = 0;
    fail = null;
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = OWNER) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const login = async (u) => (await call('POST', '/api/auth/login', { username: u, password: 'pass-12345' }, '')).body.token;
    return { db, call, login };
}

function invoiceFor(db) {
    const priced = { items: [{ name: 'بوابة', unit: 'piece', quantity: 1, unit_price: 400, line_total: 400, part: 'slats' }], subtotal: 400, vat_percent: 5, vat: 20, total: 420 };
    const q = saveQuote(db, { customer_name: 'خالد', customer_phone: '91234567', source: 'staff', priced, details: { staff_quote: true, created_by: 'سارة' } });
    const row = db.prepare('SELECT * FROM quotes WHERE id = ?').get(q.id);
    return invoices.createFromQuote(db, { ...row, items: JSON.parse(row.items_json), details: JSON.parse(row.details_json) }, {}, 'سارة');
}

test('the invoice, a payment, a reminder: the template\'s values in order, the PDF link, the log and the customer\'s file', async (t) => {
    const { db, call } = await start(t);
    process.env.MAZBOT_INVOICE_TEMPLATE_ID = '101';
    process.env.MAZBOT_PAYMENT_TEMPLATE_ID = '102';
    process.env.MAZBOT_BALANCE_TEMPLATE_ID = '';
    t.after(() => { delete process.env.MAZBOT_INVOICE_TEMPLATE_ID; delete process.env.MAZBOT_PAYMENT_TEMPLATE_ID; delete process.env.MAZBOT_BALANCE_TEMPLATE_ID; });
    const inv = invoiceFor(db);
    const lead = leads.customerMessage(db, { key: 'tel:96891234567', channel: 'whatsapp', name: 'خالد', phone: '96891234567', text: 'مرحبا' });

    const got = (await call('GET', `/api/admin/invoices/${inv.id}`)).body;
    assert.deepEqual(got.wa, { login: false, separate_account: false, invoice: true, payment: true, balance: false });
    assert.deepEqual(got.messages, []);

    let r = await call('POST', `/api/admin/invoices/${inv.id}/whatsapp`, { kind: 'invoice' });
    assert.equal(r.body.ok, true);
    assert.equal(r.body.via, 'template');
    const m = sent.at(-1);
    assert.equal(m.mobile, '96891234567');
    assert.equal(m.templateId, '101');
    assert.deepEqual(m.values.slice(0, 5), ['خالد', inv.number, '420.00', '0.00', '420.00']);
    assert.match(m.values[5], new RegExp(`^http://127\\.0\\.0\\.1:\\d+/invoices/${inv.number}\\.pdf\\?k=`), 'the customer\'s PDF link');
    assert.equal(r.body.messages[0].sent_by, 'المدير العام');
    const log = db.prepare('SELECT text FROM lead_messages WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(lead.id).text;
    assert.match(log, /أُرسلت الفاتورة .* للعميل على واتساب/);

    // A payment: its amount, what is paid in all, what is left
    const paid = invoices.addPayment(db, inv.id, { amount: 200, method: 'cash' }, 'المكتب');
    r = await call('POST', `/api/admin/invoices/${inv.id}/whatsapp`, { kind: 'payment', payment_id: paid.payments[0].id });
    assert.equal(r.body.ok, true);
    assert.deepEqual(sent.at(-1).values.slice(0, 5), ['خالد', '200.00', inv.number, '200.00', '220.00']);
    assert.equal(r.body.messages[0].payment_id, paid.payments[0].id);
    assert.equal((await call('POST', `/api/admin/invoices/${inv.id}/whatsapp`, { kind: 'payment', payment_id: 999 })).status, 404);

    // The reminder has no template: a plain message (it reaches the customer only within 24 hours)
    r = await call('POST', `/api/admin/invoices/${inv.id}/whatsapp`, { kind: 'balance' });
    assert.equal(r.body.via, 'text');
    assert.match(sent.at(-1).text, /المتبقي على الفاتورة رقم .* هو 220\.00 ر\.ع/);
    fail = 'outside 24h';
    r = await call('POST', `/api/admin/invoices/${inv.id}/whatsapp`, { kind: 'balance' });
    assert.equal(r.body.ok, false);
    assert.match(r.body.error, /24 ساعة/);
    assert.equal(r.body.messages[0].ok, false, 'a failed attempt is logged too');

    // Nothing left / cancelled / unknown kind
    fail = null;
    invoices.addPayment(db, inv.id, { amount: 220, method: 'cash' }, 'المكتب');
    assert.equal((await call('POST', `/api/admin/invoices/${inv.id}/whatsapp`, { kind: 'balance' })).status, 400);
    assert.equal((await call('POST', `/api/admin/invoices/${inv.id}/whatsapp`, { kind: 'x' })).status, 400);
    const other = invoiceFor(db);
    invoices.cancel(db, other.id, 'خطأ', 'المدير');
    assert.equal((await call('POST', `/api/admin/invoices/${other.id}/whatsapp`, { kind: 'invoice' })).status, 400);
});

test('a technician sends their order\'s invoice only; staff without the invoices section cannot send', async (t) => {
    const { db, call, login } = await start(t);
    const tech = staff.create(db, { username: 'ahmed', display_name: 'أحمد الفني', password: 'pass-12345', role: 'technician' });
    staff.create(db, { username: 'mona', display_name: 'منى', password: 'pass-12345', permissions: ['quotes'] });
    const inv = invoiceFor(db);
    const other = invoiceFor(db);
    const order = workorders.create(db, { kind: 'installation', description: 'تركيب', scheduled_date: '2099-01-01', technician_id: tech.id }, 'المكتب', { source: { invoice: inv } });
    const tk = await login('ahmed');
    assert.equal((await call('POST', `/api/admin/work-orders/${order.id}/whatsapp`, { invoice_id: inv.id }, tk)).body.ok, true);
    assert.equal((await call('POST', `/api/admin/work-orders/${order.id}/whatsapp`, { invoice_id: other.id }, tk)).status, 404, 'not this order\'s invoice');
    assert.equal((await call('POST', `/api/admin/invoices/${inv.id}/whatsapp`, { kind: 'invoice' }, tk)).status, 403);
    assert.equal((await call('POST', `/api/admin/invoices/${inv.id}/whatsapp`, { kind: 'invoice' }, await login('mona'))).status, 403);
});

test('two MazBot accounts: the templates to customers through their own account, the plain message through the main one', async (t) => {
    const { db, call } = await start(t);
    Object.assign(process.env, { MAZBOT_TEMPLATES_API_KEY: 'k', MAZBOT_TEMPLATES_STAFF_EMAIL: 'c@x', MAZBOT_TEMPLATES_STAFF_PASSWORD: 'p', MAZBOT_INVOICE_TEMPLATE_ID: '201' });
    t.after(() => { for (const k of ['MAZBOT_TEMPLATES_API_KEY', 'MAZBOT_TEMPLATES_STAFF_EMAIL', 'MAZBOT_TEMPLATES_STAFF_PASSWORD', 'MAZBOT_INVOICE_TEMPLATE_ID']) delete process.env[k]; });
    const inv = invoiceFor(db);
    const got = (await call('GET', `/api/admin/invoices/${inv.id}`)).body;
    assert.equal(got.wa.separate_account, true);
    assert.equal(got.wa.login, true, 'the templates\' account can sign in');

    let r = await call('POST', `/api/admin/invoices/${inv.id}/whatsapp`, { kind: 'invoice' });
    assert.equal(r.body.ok, true);
    assert.equal(sent.at(-1).account, 'templates', 'the template goes through the templates account');
    assert.equal(r.body.messages[0].via, 'template:templates');
    // No balance template: a plain message, through the main account (the customers chat with its number)
    invoices.addPayment(db, inv.id, { amount: 100, method: 'cash' }, 'المكتب');
    r = await call('POST', `/api/admin/invoices/${inv.id}/whatsapp`, { kind: 'balance' });
    assert.equal(sent.at(-1).via, 'text');
    assert.equal(sent.at(-1).account, 'main');
    // The calculators keep the main account
    assert.equal(require('../src/mazbot').hasLogin(), false, 'the main account is untouched by the customer one');
});
