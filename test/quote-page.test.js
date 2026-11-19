/* «عرض السعر»: the customer's page of a quote (its random key, no sign-in): the lines, the totals, the terms,
   and «أوافق على العرض» — once, not when expired / declined / invoiced. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase, saveSettings } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const staff = require('../src/staff');
const invoices = require('../src/invoices');
const leads = require('../src/leads');
const push = require('../src/push');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const pushed = [];
push.setSenderForTests(async (sub, payload) => { pushed.push(JSON.parse(payload)); });

async function start(t) {
    pushed.length = 0;
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (url) => { const r = await fetch(base + url); return { status: r.status, headers: r.headers, text: await r.text() }; };
    const accept = (key, confirm = true) => fetch(`${base}/q/${key}/accept`, { method: 'POST', redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: confirm ? 'confirm=1' : '' });
    const api = async (url) => (await fetch(base + url, { headers: { Authorization: 'Bearer ' + OWNER } })).json();
    return { db, get, accept, api, base };
}
const quoteFor = (db, extra = {}) => {
    const priced = { items: [{ name: 'بوابة رولينج شتر', type: 'مضغوط', unit: 'm2', quantity: 7.5, unit_price: 40, line_total: 300 }, { name: 'التركيب', unit: 'service', quantity: 1, unit_price: 46.6, line_total: 46.6 }],
        subtotal: 346.6, vat_percent: 5, vat: 17.33, total: 363.93 };
    const q = saveQuote(db, { customer_name: 'محمد الحضرمي', customer_phone: '99887897', source: 'staff', priced, notes: 'لون أبيض', details: { staff_quote: true, created_by: 'سارة' }, ...extra });
    return db.prepare('SELECT * FROM quotes WHERE id = ?').get(q.id);
};

test('the page shows the quote; «أوافق على العرض» accepts it once; staff are told; the log records it', async (t) => {
    const { db, get, accept, api, base } = await start(t);
    saveSettings(db, { quote_terms: '1. الأسعار شاملة الضريبة\n2. مدة التنفيذ 7 أيام عمل' });
    staff.create(db, { username: 'sara', display_name: 'سارة', password: 'pass-12345', permissions: ['quotes'] });
    leads.customerMessage(db, { key: 'tel:96899887897', channel: 'whatsapp', name: 'محمد', phone: '96899887897', text: 'السلام' });
    const q = quoteFor(db);
    // The manager's phone, for the notification
    await fetch(`${base}/api/admin/me/push`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OWNER },
        body: JSON.stringify({ subscription: { endpoint: 'https://fcm.googleapis.com/send/owner', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } } }) });

    let r = await get(`/q/${q.access_key}`);
    assert.equal(r.status, 200);
    assert.match(r.text, /مرحباً محمد/);
    assert.match(r.text, /بانتظار موافقتكم/);
    assert.match(r.text, /بوابة رولينج شتر/);
    assert.match(r.text, /363\.930 ر\.ع/);
    assert.match(r.text, /<li>الأسعار شاملة الضريبة<\/li>/, 'the terms, without their numbers');
    assert.match(r.text, /ملاحظات: لون أبيض/);
    assert.match(r.text, /name="confirm" value="1" required/);
    assert.doesNotMatch(r.text, /<script/i);
    assert.match(r.headers.get('content-security-policy'), /form-action 'self'/);
    assert.ok(!r.text.includes('سارة'), 'not who prepared it');

    // Without ticking «اطلعت»: not accepted
    let res = await accept(q.access_key, false);
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), /\?m=confirm$/);
    assert.equal(db.prepare('SELECT status FROM quotes WHERE id = ?').get(q.id).status, 'new');

    res = await accept(q.access_key);
    assert.match(res.headers.get('location'), /\?m=accepted$/);
    const row = db.prepare('SELECT status, accepted_at, accepted_via FROM quotes WHERE id = ?').get(q.id);
    assert.deepEqual([row.status, row.accepted_via], ['accepted', 'customer_page']);
    assert.ok(row.accepted_at);
    await new Promise((r2) => setTimeout(r2, 50));
    assert.ok(pushed.some((p) => /وافق محمد الحضرمي على عرض السعر/.test(p.title)), 'staff are told');
    const lead = db.prepare("SELECT id FROM leads WHERE phone = '96899887897'").get();
    assert.match(db.prepare('SELECT text FROM lead_messages WHERE lead_id = ? ORDER BY id DESC').get(lead.id).text, /وافق العميل على عرض السعر/);

    r = await get(`/q/${q.access_key}?m=accepted`);
    assert.match(r.text, /سُجّلت موافقتكم/);
    assert.match(r.text, /وافقتم على هذا العرض/);
    assert.doesNotMatch(r.text, /name="confirm"/, 'no second acceptance');
    pushed.length = 0;
    await accept(q.access_key);
    assert.equal(pushed.length, 0, 'once only');

    // The staff see the link and how it was accepted
    const view = await api(`/api/admin/quotes/${q.id}`);
    assert.equal(view.customer_url, `/q/${q.access_key}`);
    assert.equal(view.accepted_via, 'customer_page');

    // Invoiced: the page points to the invoice's tracking page
    const inv = invoices.createFromQuote(db, { ...db.prepare('SELECT * FROM quotes WHERE id = ?').get(q.id), items: JSON.parse(q.items_json), details: JSON.parse(q.details_json) }, {}, 'المكتب');
    r = await get(`/q/${q.access_key}`);
    assert.match(r.text, new RegExp(`صدرت فاتورة هذا العرض: ${inv.number}`));
    assert.ok(r.text.includes(`/t/${inv.access_key}`));
});

test('expired or declined: no acceptance; a wrong key: not found', async (t) => {
    const { db, get, accept } = await start(t);
    const old = quoteFor(db);
    db.prepare("UPDATE quotes SET valid_until = '2026-01-01' WHERE id = ?").run(old.id);
    let r = await get(`/q/${old.access_key}`);
    assert.match(r.text, /انتهت صلاحية هذا العرض/);
    assert.doesNotMatch(r.text, /name="confirm"/);
    await accept(old.access_key);
    assert.equal(db.prepare('SELECT status FROM quotes WHERE id = ?').get(old.id).status, 'new');

    const no = quoteFor(db);
    db.prepare("UPDATE quotes SET status = 'rejected' WHERE id = ?").run(no.id);
    r = await get(`/q/${no.access_key}`);
    assert.match(r.text, /العرض غير متاح/);
    await accept(no.access_key);
    assert.equal(db.prepare('SELECT status FROM quotes WHERE id = ?').get(no.id).status, 'rejected');

    assert.equal((await get('/q/' + 'a'.repeat(32))).status, 404);
    assert.equal((await get('/q/nope')).status, 404);
    assert.equal((await accept('b'.repeat(32))).status, 404);
});
