/* تاريخ الإصدار = the day the quote became an invoice; تاريخ الفاتورة = the day its work was completed
   (stamped when the last open work order is done — by the technician or the office), or set by hand. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const staff = require('../src/staff');
const invoices = require('../src/invoices');
const workorders = require('../src/workorders');

process.env.ADMIN_TOKEN = 'test-token-long-enough-1234';
const today = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);

function invoiceFor(db) {
    const priced = { items: [{ name: 'بوابة', unit: 'piece', quantity: 1, unit_price: 500, line_total: 500 }], subtotal: 500, vat_percent: 0, vat: 0, total: 500 };
    const q = saveQuote(db, { customer_name: 'خالد', customer_phone: '96891234567', source: 'web', priced });
    const row = db.prepare('SELECT * FROM quotes WHERE id = ?').get(q.id);
    return invoices.createFromQuote(db, { ...row, items: JSON.parse(row.items_json), details: null }, { issue_date: '2026-11-01' });
}

test('the invoice date is stamped when the last open work order of the invoice is done', () => {
    const db = openDatabase(':memory:');
    const tech = staff.create(db, { username: 'ahmed', display_name: 'أحمد', password: 'pass-12345', role: 'technician' });
    const techUser = { role: 'technician', id: tech.id, display_name: 'أحمد' };
    const inv = invoiceFor(db);
    assert.equal(invoices.get(db, inv.id).issue_date, '2026-11-01');
    assert.equal(invoices.get(db, inv.id).invoice_date, null, 'not before the work is done');

    const mk = (kind) => workorders.create(db, { kind, description: 'عمل', scheduled_date: '2099-01-01', technician_id: tech.id }, 'المكتب', { source: { invoice: inv } });
    const a = mk('installation');
    const b = mk('maintenance');
    workorders.setStatus(db, a.id, 'done', 'رُكّبت البوابة', techUser);
    assert.equal(invoices.get(db, inv.id).invoice_date, null, 'another job of the invoice is still open');
    // The office closes the second one: now the work is complete
    workorders.setStatus(db, b.id, 'done', 'تمت الصيانة', { role: 'manager', display_name: 'المكتب' });
    assert.equal(invoices.get(db, inv.id).invoice_date, today());
});

test('a cancelled last job completes the work too; a date set by hand is kept; the office can change or clear it', async (t) => {
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const call = async (method, url, body) => {
        const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.ADMIN_TOKEN }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const tech = staff.create(db, { username: 'ahmed', display_name: 'أحمد', password: 'pass-12345', role: 'technician' });
    const inv = invoiceFor(db);
    const mk = () => workorders.create(db, { kind: 'installation', description: 'عمل', scheduled_date: '2099-01-01', technician_id: tech.id }, 'المكتب', { source: { invoice: inv } });
    const a = mk();
    const b = mk();
    workorders.setStatus(db, a.id, 'done', 'تم', { role: 'technician', id: tech.id, display_name: 'أحمد' });
    workorders.cancel(db, b.id, 'مكرر', 'المكتب');
    assert.equal(invoices.get(db, inv.id).invoice_date, today(), 'the only remaining job was done');

    // By hand: not before the issue date; another date; cleared
    assert.equal((await call('PATCH', `/api/admin/invoices/${inv.id}`, { invoice_date: '2026-10-01' })).status, 400);
    assert.equal((await call('PATCH', `/api/admin/invoices/${inv.id}`, { invoice_date: '2026-11-05' })).body.invoice_date, '2026-11-05');
    // A later job done does not overwrite it
    const c = mk();
    workorders.setStatus(db, c.id, 'done', 'تم', { role: 'technician', id: tech.id, display_name: 'أحمد' });
    assert.equal(invoices.get(db, inv.id).invoice_date, '2026-11-05');
    assert.equal((await call('PATCH', `/api/admin/invoices/${inv.id}`, { invoice_date: '' })).body.invoice_date, null);
    // The PDF carries both dates
    const one = (await call('GET', `/api/admin/invoices/${inv.id}`)).body;
    assert.equal(one.issue_date, '2026-11-01');
    const pdf = await fetch(`http://127.0.0.1:${server.address().port}${one.pdf_url}`);
    assert.equal(pdf.status, 200);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
});
