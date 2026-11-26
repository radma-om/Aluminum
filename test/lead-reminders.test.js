/* «تذكير العملاء بلا عرض سعر»: who is on the list (wrote in 14 days, no quote, not closed, not stopped or muted,
   a valid mobile, once per number), the send (the template with the first name), the managers-only routes, and the
   answers on the templates account: «أريد عرض سعر» (needs a person, the calculator's link) and «لا شكراً» (never again). */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase, saveSettings } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const leads = require('../src/leads');
const staff = require('../src/staff');
const autoreply = require('../src/autoreply');
const orderNotify = require('../src/order-notify');
const lr = require('../src/lead-reminders');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const sent = [];
lr.setSenderForTests(async (m) => { sent.push(m); return m.mobile === '96890000009' ? { ok: false, error: 'template paused' } : { ok: true }; });

const say = (db, phone, name, text = 'كم سعر بوابة 3×3؟') => leads.customerMessage(db, { key: leads.phoneKey(phone), channel: 'whatsapp', name, phone, text });

test('the list, the send, and the answers on the templates account', async (t) => {
    process.env.MAZBOT_LEAD_REMINDER_TEMPLATE_ID = '3500';
    t.after(() => { delete process.env.MAZBOT_LEAD_REMINDER_TEMPLATE_ID; });
    const db = openDatabase(':memory:');
    saveSettings(db, { mazbot_recipients: '', public_base_url: 'https://calcshutter.radma.co', company_phone: '90660001' });
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, token = OWNER) => {
        const res = await fetch(base + url, { method, headers: { Authorization: 'Bearer ' + token } });
        return { status: res.status, body: await res.json().catch(() => null) };
    };

    say(db, '96891111111', 'سالم الحارثي');                       // ✓
    say(db, '96892222222', 'خالد');                               // ✓ (its row will fail to send)
    say(db, '96893333333', 'له عرض');                             // a quote for the number
    saveQuote(db, { customer_name: 'له عرض', customer_phone: '93333333', source: 'calculator',
        priced: { items: [{ name: 'بوابة', unit: 'piece', quantity: 1, unit_price: 100, line_total: 100 }], subtotal: 100, vat_percent: 5, vat: 5, total: 105 } });
    const won = say(db, '96894444444', 'تم البيع');
    leads.update(db, won.id, { status: 'won' }, 'المدير');
    const old = say(db, '96895555555', 'قديم');                   // wrote 20 days ago
    db.prepare("UPDATE lead_messages SET created_at = datetime('now', '-20 days') WHERE lead_id = ?").run(old.id);
    say(db, '96896666666', 'موقوف');
    autoreply.stop(db, '96896666666', { reason: 'مورد' });        // switched off by hand
    say(db, '96897777777', 'أوقف الإشعارات');
    orderNotify.mute(db, '96897777777');
    leads.customerMessage(db, { key: 'web:abcdefabcdefabcd', channel: 'website', text: 'مرحبا' }); // no phone
    db.prepare("UPDATE leads SET phone = '96890000009' WHERE id = ?").run(db.prepare("SELECT id FROM leads WHERE phone = '96892222222'").get().id);

    let l = lr.list(db);
    assert.deepEqual(l.candidates.map((c) => c.phone).sort(), ['96890000009', '96891111111']);

    // Managers only
    staff.create(db, { username: 'sara', display_name: 'سارة', password: 'pass-12345', role: 'staff', permissions: ['leads'] });
    const tok = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sara', password: 'pass-12345' }) })).json()).token;
    assert.equal((await call('GET', '/api/admin/lead-reminders', tok)).status, 403);
    assert.equal((await call('POST', '/api/admin/lead-reminders/send', tok)).status, 403);

    // Send to all: the template with the first name; a failure is kept on its row
    const out = await call('POST', '/api/admin/lead-reminders/send');
    assert.deepEqual([out.body.sent, out.body.failed], [1, 1]);
    assert.deepEqual(sent.find((m) => m.mobile === '96891111111'), { mobile: '96891111111', templateId: '3500', values: ['سالم'] });
    l = out.body.list;
    assert.deepEqual(l.sent.map((c) => c.phone), ['96891111111']);
    assert.equal(l.candidates.find((c) => c.phone === '96890000009').last_error, 'template paused');
    assert.equal((await call('POST', `/api/admin/lead-reminders/${l.sent[0].lead_id}/send`)).status, 409, 'once per customer');
    const salem = db.prepare("SELECT * FROM leads WHERE phone = '96891111111'").get();
    assert.match(db.prepare("SELECT text FROM lead_messages WHERE lead_id = ? AND role = 'system' ORDER BY id DESC").get(salem.id).text, /أُرسل تذكير/);

    // «أريد عرض سعر» on the templates account: needs a person, the calculator's link in the reply
    const replies = [];
    const client = { sendTextToPhone: async (phone, text) => { replies.push({ phone, text }); return { ok: true }; } };
    const press = (phone, value) => orderNotify.handleTemplatesEvent(db, { type: 'interactive.selected', data: { contact: { phone }, message: { value } } }, { client });
    const r = await press('96891111111', 'أريد عرض سعر');
    assert.equal(r.action, 'lead_reminder_quote');
    assert.match(replies[0].text, /https:\/\/calcshutter\.radma\.co\//);
    assert.match(replies[0].text, /90660001/);
    assert.equal(db.prepare('SELECT status FROM leads WHERE id = ?').get(salem.id).status, 'needs_staff');
    assert.equal(lr.list(db).sent[0].response, 'quote');
    assert.equal((await press('96891111111', 'أريد عرض سعر')).action, 'ignored', 'answered once');

    // «لا شكراً»: never reminded again, even after writing again
    await call('POST', `/api/admin/lead-reminders/${db.prepare("SELECT id FROM leads WHERE phone = '96890000009'").get().id}/send`); // still fails
    lr.setSenderForTests(async (m) => { sent.push(m); return { ok: true }; });
    say(db, '96898888888', 'منى');
    const mona = lr.list(db).candidates.find((c) => c.phone === '96898888888');
    assert.ok((await lr.sendLead(db, mona.lead_id, { by: 'المدير' })).ok);
    assert.equal((await press('96898888888', 'لا شكراً')).action, 'lead_reminder_no');
    say(db, '96898888888', 'منى', 'مرحبا مرة ثانية');
    assert.ok(!lr.list(db).candidates.some((c) => c.phone === '96898888888'), 'said no: never again');

    // Wrote again after the reminder without answering: back on the list
    say(db, '96899999999', 'هدى');
    const huda = lr.list(db).candidates.find((c) => c.phone === '96899999999');
    await lr.sendLead(db, huda.lead_id, { by: 'المدير' });
    assert.ok(!lr.list(db).candidates.some((c) => c.phone === '96899999999'));
    db.prepare("UPDATE lead_reminders SET sent_at = datetime('now', '-1 hour') WHERE phone = '96899999999'").run();
    say(db, '96899999999', 'هدى', 'عندي سؤال');
    assert.ok(lr.list(db).candidates.some((c) => c.phone === '96899999999'), 'wrote again: back on the list');

    // A button without a recent reminder is not an answer
    assert.equal((await press('96891234567', 'أريد عرض سعر')).action, 'ignored');
    // Without the template: refused with the reason
    delete process.env.MAZBOT_LEAD_REMINDER_TEMPLATE_ID;
    assert.match((await call('POST', '/api/admin/lead-reminders/send')).body.error, /MAZBOT_LEAD_REMINDER_TEMPLATE_ID/);
});
