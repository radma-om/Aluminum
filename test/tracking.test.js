/* «تتبع طلبي»: the customer's page of an invoice, opened with the invoice's random key (no sign-in):
   the steps, the amounts, the appointment — nothing internal. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const staff = require('../src/staff');
const invoices = require('../src/invoices');
const workorders = require('../src/workorders');

process.env.ADMIN_TOKEN = 'test-token-long-enough-1234';

async function start(t) {
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (url) => { const r = await fetch(base + url); return { status: r.status, headers: r.headers, text: await r.text() }; };
    return { db, get };
}
function invoiceFor(db) {
    const priced = { items: [{ name: 'بوابة رولينج شتر', type: 'مضغوط', unit: 'm2', quantity: 7.5, unit_price: 40, line_total: 300, part: 'slats' }, { name: 'التركيب', unit: 'service', quantity: 1, unit_price: 100, line_total: 100, part: 'installation' }],
        subtotal: 400, vat_percent: 5, vat: 20, total: 420 };
    const q = saveQuote(db, { customer_name: 'خالد سالم', customer_phone: '91234567', source: 'staff', priced, notes: 'ملاحظة داخلية سرية', details: { staff_quote: true, created_by: 'سارة' } });
    const row = db.prepare('SELECT * FROM quotes WHERE id = ?').get(q.id);
    return invoices.createFromQuote(db, { ...row, items: JSON.parse(row.items_json), details: JSON.parse(row.details_json) }, { notes: 'خصم خاص للمدير' }, 'سارة');
}

test('the steps follow the invoice and its work order; amounts; nothing internal; private headers', async (t) => {
    const { db, get } = await start(t);
    const inv = invoiceFor(db);
    const url = `/t/${inv.access_key}`;

    let r = await get(url);
    assert.equal(r.status, 200);
    assert.match(r.text, /مرحباً خالد/);
    assert.match(r.text, /<li class="now"><b>بانتظار الدفع/);
    assert.match(r.text, /420\.000 ر\.ع/);
    assert.match(r.text, new RegExp(`/invoices/${inv.number}\\.pdf\\?k=${inv.access_key}`), 'the PDF link');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    assert.doesNotMatch(r.text, /<script/i, 'a static page');
    for (const secret of ['ملاحظة داخلية', 'خصم خاص للمدير', 'سارة', '91234567']) assert.ok(!r.text.includes(secret), `does not show «${secret}»`);

    // Part paid, an appointment with a technician
    invoices.addPayment(db, inv.id, { amount: 200, method: 'cash', paid_on: '2026-11-19' }, 'المكتب');
    const tech = staff.create(db, { username: 'ahmed', display_name: 'أحمد', password: 'pass-12345', role: 'technician' });
    const order = workorders.create(db, { kind: 'installation', description: 'تركيب', scheduled_date: '2026-11-22', scheduled_time: '10:00', technician_id: tech.id }, 'المكتب', { source: { invoice: inv } });
    r = await get(url);
    assert.match(r.text, /<li class="due"><b>دُفع جزء من المبلغ/, 'the balance left is marked, the appointment is the step reached');
    assert.match(r.text, /المتبقي 220\.000/);
    assert.match(r.text, /<li class="now"><b>موعد التركيب<\/b><small>الأحد 2026-11-22 — 10:00 — الفني أحمد/);

    // Under way, then done
    const t1 = { role: 'technician', id: tech.id, display_name: 'أحمد' };
    workorders.setStatus(db, order.id, 'in_progress', '', t1);
    r = await get(url);
    assert.match(r.text, /<li class="now"><b>جاري التنفيذ/);
    workorders.setStatus(db, order.id, 'done', 'تم', t1);
    r = await get(url);
    assert.match(r.text, /اكتمل العمل ✅/);
    assert.match(r.text, /<li class="done"><b>اكتمل العمل/);

    // The staff's invoice carries the link; the WhatsApp message points to it
    assert.equal(require('../src/tracking').path(inv), url);
});

test('a wrong, malformed or cancelled key: not found / «cancelled»', async (t) => {
    const { db, get } = await start(t);
    const inv = invoiceFor(db);
    assert.equal((await get('/t/' + 'a'.repeat(32))).status, 404);
    assert.equal((await get('/t/xyz')).status, 404);
    assert.equal((await get(`/t/${inv.access_key}x`)).status, 404);
    invoices.cancel(db, inv.id, 'خطأ', 'المدير');
    const r = await get(`/t/${inv.access_key}`);
    assert.equal(r.status, 200);
    assert.match(r.text, /هذه الفاتورة ملغاة/);
});
