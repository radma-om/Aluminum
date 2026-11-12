/* The deposit asked of the customer on an invoice: a % or an amount, shown on the invoice;
   any payment counts towards it, whatever its size */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase, saveSettings } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const invoices = require('../src/invoices');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;

function quoteOf(db, total = 1000) {
    const q = saveQuote(db, { customer_name: 'خالد', customer_phone: '96891234567', source: 'web',
        priced: { items: [{ name: 'بوابة', unit: 'piece', quantity: 1, unit_price: total, line_total: total }], subtotal: total, vat_percent: 0, vat: 0, total } });
    const row = db.prepare('SELECT * FROM quotes WHERE id = ?').get(q.id);
    return { ...row, items: JSON.parse(row.items_json), details: row.details_json ? JSON.parse(row.details_json) : null };
}

test('the deposit asked: a % or an amount of the total; payments of any size count towards it', () => {
    const db = openDatabase(':memory:');
    const inv = invoices.createFromQuote(db, quoteOf(db, 1000), { deposit_required: { type: 'percent', value: 40 } }, 'سلطان');
    assert.deepEqual(inv.deposit, { type: 'percent', value: 40, amount: 400, label: 'المقدم المطلوب (40%)', remaining: 400, paid: false });
    // The customer pays less than asked: recorded as it is
    let r = invoices.addPayment(db, inv.id, { amount: 150, method: 'cash' }, 'سلطان');
    assert.equal(r.deposit.remaining, 250);
    assert.equal(r.deposit.paid, false);
    assert.equal(r.state, 'partial');
    // …then more than what is left of the deposit
    r = invoices.addPayment(db, inv.id, { amount: 500, method: 'bank' }, 'سلطان');
    assert.equal(r.deposit.remaining, 0);
    assert.equal(r.deposit.paid, true);
    assert.equal(r.balance, 350);

    // An amount; changed later; removed
    const inv2 = invoices.createFromQuote(db, quoteOf(db, 800), { deposit_required: { type: 'amount', value: 300 } });
    assert.equal(inv2.deposit.amount, 300);
    assert.equal(inv2.deposit.label, 'المقدم المطلوب');
    assert.equal(invoices.update(db, inv2.id, { deposit_required: { type: 'percent', value: 50 } }).deposit.amount, 400);
    assert.equal(invoices.update(db, inv2.id, { deposit_required: null }).deposit, null);
    // Checked
    for (const bad of [{ type: 'percent', value: 150 }, { type: 'amount', value: 5000 }, { type: 'amount', value: -5 }]) {
        assert.throws(() => invoices.createFromQuote(db, quoteOf(db, 500), { deposit_required: bad }), (e) => e.status === 400, JSON.stringify(bad));
    }
    // No deposit asked: as before
    assert.equal(invoices.createFromQuote(db, quoteOf(db, 200), {}).deposit, null);
    // The % follows the final amount with VAT
    saveSettings(db, { vat_percent: 5 });
    const q = quoteOf(db, 1000);
    const inv3 = invoices.createFromQuote(db, { ...q, vat_percent: 5, vat: 50, total: 1050 }, { final_subtotal: 900, deposit_required: { type: 'percent', value: 50 } });
    assert.equal(inv3.total, 945);
    assert.equal(inv3.deposit.amount, 472.5);
});

test('through the panel: issued with the deposit, shown on the PDF, changed, and the list flags it', async (t) => {
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OWNER }, body: body ? JSON.stringify(body) : undefined });
        const type = res.headers.get('content-type') || '';
        return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
    };
    const q = quoteOf(db, 600);
    const inv = await call('POST', `/api/admin/quotes/${q.id}/invoice`, { deposit_required: { type: 'percent', value: 50 }, deposit: { amount: 100, method: 'cash' } });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    assert.equal(inv.body.deposit.amount, 300);
    assert.equal(inv.body.deposit.remaining, 200, 'the payment at issue counts');
    const pdf = await call('GET', `/api/admin/invoices/${inv.body.id}/pdf`);
    assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
    const customerPdf = await fetch(base + inv.body.pdf_url);
    assert.equal(customerPdf.status, 200);
    const list = await call('GET', '/api/admin/invoices');
    assert.equal(list.body.invoices[0].deposit.remaining, 200);
    assert.deepEqual(list.body.deposit_types, { percent: 'نسبة', amount: 'مبلغ' });
    const changed = await call('PATCH', `/api/admin/invoices/${inv.body.id}`, { deposit_required: { type: 'amount', value: 100 } });
    assert.equal(changed.body.deposit.paid, true);
});
