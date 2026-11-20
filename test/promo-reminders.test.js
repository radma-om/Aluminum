/* «تذكير بانتهاء العرض»: the customers whose quote used the running promotion or gift (not invoiced, not
   rejected) get one WhatsApp reminder per number per promotion, when the manager presses the button. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase, saveSettings } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const invoices = require('../src/invoices');
const pr = require('../src/promo-reminders');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const sent = [];
pr.setSenderForTests(async (m) => { sent.push(m); return m.mobile === '96893333333' ? { ok: false, error: 'قالب 9: refused' } : { ok: true }; });

const future = (days) => new Date(Date.now() + 4 * 3600_000 + days * 86400_000).toISOString().slice(0, 10);

async function start(t) {
    sent.length = 0;
    process.env.MAZBOT_PROMO_REMINDER_TEMPLATE_ID = '601';
    t.after(() => { delete process.env.MAZBOT_PROMO_REMINDER_TEMPLATE_ID; });
    const db = openDatabase(':memory:');
    saveSettings(db, { public_base_url: 'https://calc.example.com', promo_enabled: true, promo_percent: 10, promo_label: 'عرض الشتاء', promo_until: future(3),
        gift_enabled: true, gift_name: 'جهاز GSM', gift_price: 25, gift_until: future(10) });
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OWNER }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const quote = (phone, details, status = 'new') => {
        const priced = { items: [{ name: 'بوابة', quantity: 1, unit_price: 400, line_total: 400 }], subtotal: 400, vat_percent: 5, vat: 20, total: 420 };
        const q = saveQuote(db, { customer_name: 'خالد سالم', customer_phone: phone, source: 'calculator', priced, details });
        db.prepare("UPDATE quotes SET status = ?, valid_until = date('now', '+1 day') WHERE id = ?").run(status, q.id);
        return db.prepare('SELECT * FROM quotes WHERE id = ?').get(q.id);
    };
    return { db, call, quote, base };
}
const promo = { promo_label: 'عرض الشتاء', promo_percent: 10, discount_total: 45 };

test('the list: this promotion\'s quotes only, one per number, not invoiced / rejected / accepted', async (t) => {
    const { db, call, quote } = await start(t);
    const a = quote('91111111', promo);
    quote('91111111', promo);                                          // same number, newer: the one listed
    quote('92222222', { gift_name: 'جهاز GSM', discount_total: 25 });  // the gift
    quote('94444444', { promo_label: 'عرض الصيف', discount_total: 30 }); // another promotion: no
    quote('95555555', {});                                             // no promotion: no
    quote('96666666', promo, 'rejected');                              // declined: no
    quote('97777777', promo, 'accepted');                              // accepted: the office invoices it
    const inv = quote('98888888', promo);
    invoices.createFromQuote(db, { ...inv, items: JSON.parse(inv.items_json), details: JSON.parse(inv.details_json) }, {}, 'سارة'); // invoiced: no

    const r = (await call('GET', '/api/admin/promo-reminders')).body;
    assert.equal(r.template, true);
    assert.deepEqual(r.candidates.map((c) => c.phone).sort(), ['96891111111', '96892222222']);
    const first = r.candidates.find((c) => c.phone === '96891111111');
    assert.notEqual(first.quote_id, a.id, 'the latest quote of the number');
    assert.deepEqual([first.offer, first.until, first.saving], ['عرض الشتاء', future(3), 45]);
    const gift = r.candidates.find((c) => c.phone === '96892222222');
    assert.deepEqual([gift.offer, gift.until], ['هدية جهاز GSM', future(10)]);
});

test('send: the template with the saving, the offer, the last day and the quote link; once per number; validity extended', async (t) => {
    const { db, call, quote } = await start(t);
    const q = quote('91111111', promo);
    quote('93333333', promo); // MazBot refuses this one

    let r = (await call('POST', '/api/admin/promo-reminders/send')).body;
    assert.deepEqual([r.sent, r.failed], [1, 1]);
    const m = sent.find((x) => x.mobile === '96891111111');
    assert.deepEqual(m.values, ['خالد', q.ref, '45.000', 'عرض الشتاء', future(3), `https://calc.example.com/q/${q.access_key}`]);
    assert.equal(m.templateId, '601');
    assert.equal(db.prepare('SELECT valid_until FROM quotes WHERE id = ?').get(q.id).valid_until, future(3), 'the quote holds until the offer ends');
    // The list after: one got it, the refused one stays with its reason
    assert.deepEqual(r.list.sent.map((c) => c.phone), ['96891111111']);
    assert.match(r.list.candidates[0].last_error, /refused/);

    // Pressing again: only the one that did not get it
    sent.length = 0;
    r = (await call('POST', '/api/admin/promo-reminders/send')).body;
    assert.deepEqual(sent.map((x) => x.mobile), ['96893333333']);

    // A new promotion (another last day) reminds again
    saveSettings(db, { promo_until: future(5) });
    assert.equal((await call('GET', '/api/admin/promo-reminders')).body.candidates.length, 2);
});

test('refused without a last day, without the template; staff accounts cannot use it', async (t) => {
    const { db, call, quote, base } = await start(t);
    quote('91111111', promo);
    saveSettings(db, { promo_until: '', gift_enabled: false });
    let r = await call('POST', '/api/admin/promo-reminders/send');
    assert.equal(r.status, 400);
    assert.match(r.body.error, /آخر يوم/);
    saveSettings(db, { promo_until: future(3) });
    delete process.env.MAZBOT_PROMO_REMINDER_TEMPLATE_ID;
    r = await call('POST', '/api/admin/promo-reminders/send');
    assert.equal(r.status, 400);
    assert.match(r.body.error, /MAZBOT_PROMO_REMINDER_TEMPLATE_ID/);
    assert.equal(sent.length, 0);

    // An employee (even with «طلبات العروض»): managers only
    require('../src/staff').create(db, { username: 'sara', display_name: 'سارة', password: 'pass-12345', role: 'staff', permissions: ['quotes', 'leads'] });
    const login = await call('POST', '/api/auth/login', { username: 'sara', password: 'pass-12345' });
    const asStaff = (method, url) => fetch(base + url, { method, headers: { Authorization: 'Bearer ' + login.body.token } }).then((x) => x.status);
    assert.equal(await asStaff('GET', '/api/admin/promo-reminders'), 403);
    assert.equal(await asStaff('POST', '/api/admin/promo-reminders/send'), 403);
});
