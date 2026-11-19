/* The customer hears how their work order goes (approved templates, with the «تتبع طلبي» link):
   the appointment, on the way, started, done — muted 48 hours by «إيقاف الإشعارات»; «تتبع» answers
   with the customer's links. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { openDatabase, saveSettings } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const staff = require('../src/staff');
const invoices = require('../src/invoices');
const workorders = require('../src/workorders');
const notify = require('../src/order-notify');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const sent = [];
notify.setSenderForTests(async (m) => { sent.push(m); return { ok: true }; });
const TPL = { MAZBOT_WO_SCHEDULED_TEMPLATE_ID: '401', MAZBOT_WO_ONTHEWAY_TEMPLATE_ID: '402', MAZBOT_WO_STARTED_TEMPLATE_ID: '403', MAZBOT_WO_DONE_TEMPLATE_ID: '404',
    MAZBOT_TEMPLATES_WEBHOOK_SECRET: 'tpl-hook-secret-0123456789', MAZBOT_TEMPLATES_SIGNING_SECRET: 'tpl-signing-secret' };

async function start(t) {
    sent.length = 0;
    Object.assign(process.env, TPL);
    t.after(() => { for (const k of Object.keys(TPL)) delete process.env[k]; });
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
    return { db, call, login, base };
}
function invoiceFor(db) {
    const priced = { items: [{ name: 'بوابة', unit: 'piece', quantity: 1, unit_price: 400, line_total: 400, part: 'slats' }], subtotal: 400, vat_percent: 5, vat: 20, total: 420 };
    const q = saveQuote(db, { customer_name: 'خالد سالم', customer_phone: '91234567', source: 'staff', priced, details: { staff_quote: true, created_by: 'سارة' } });
    const row = db.prepare('SELECT * FROM quotes WHERE id = ?').get(q.id);
    return invoices.createFromQuote(db, { ...row, items: JSON.parse(row.items_json), details: JSON.parse(row.details_json) }, {}, 'سارة');
}
const wait = () => new Promise((r) => setTimeout(r, 60));
const logOf = (db, id) => db.prepare('SELECT text FROM work_order_events WHERE order_id = ? ORDER BY id').all(id).map((e) => e.text);

test('appointment → on the way → started → done: each a template with the tracking link; logged', async (t) => {
    const { db, call, login } = await start(t);
    const tech = staff.create(db, { username: 'ahmed', display_name: 'أحمد', password: 'pass-12345', role: 'technician' });
    const inv = invoiceFor(db);
    const order = workorders.create(db, { kind: 'installation', description: 'تركيب', technician_id: tech.id }, 'المكتب', { source: { invoice: inv } });
    db.prepare("UPDATE work_orders SET created_at = datetime('now', '-1 day') WHERE id = ?").run(order.id);

    // The office sets the appointment and ticks «إبلاغ العميل»
    let r = await call('PATCH', `/api/admin/work-orders/${order.id}`, { scheduled_date: '2026-11-22', scheduled_time: '10:00', notify_customer: true });
    assert.equal(r.body.notice.ok, true);
    let m = sent.at(-1);
    assert.equal(m.event, 'scheduled');
    assert.equal(m.templateId, '401');
    assert.equal(m.mobile, '96891234567');
    assert.deepEqual(m.values.slice(0, 4), ['خالد', 'تركيب البوابة', 'الأحد 2026-11-22 — 10:00', 'أحمد']);
    assert.match(m.values[4], new RegExp(`/t/${inv.access_key}$`), 'the invoice\'s tracking page');
    // Not ticked: nothing
    await call('PATCH', `/api/admin/work-orders/${order.id}`, { scheduled_time: '11:00' });
    assert.equal(sent.length, 1);

    const tk = await login('ahmed');
    r = await call('POST', `/api/admin/work-orders/${order.id}/on-the-way`, {}, tk);
    assert.equal(r.status, 200);
    assert.equal(r.body.notice.ok, true);
    assert.deepEqual(sent.at(-1).values.slice(0, 3), ['خالد', 'أحمد', 'تركيب البوابة']);

    await call('POST', `/api/admin/work-orders/${order.id}/status`, { status: 'in_progress' }, tk);
    await wait();
    assert.equal(sent.at(-1).event, 'started');

    invoices.addPayment(db, inv.id, { amount: 300, method: 'cash' }, 'المكتب');
    await call('POST', `/api/admin/work-orders/${order.id}/status`, { status: 'done', note: 'رُكّبت البوابة' }, tk);
    await wait();
    m = sent.at(-1);
    assert.equal(m.event, 'done');
    assert.deepEqual(m.values.slice(0, 3), ['خالد', 'تركيب البوابة', '120.000'], 'with what is left to pay');

    const log = logOf(db, order.id);
    assert.ok(log.includes('🚚 الفني في الطريق إلى العميل'));
    for (const label of ['موعد التركيب', 'الفني في الطريق', 'بدء العمل', 'اكتمال العمل']) {
        assert.ok(log.includes(`📤 أُرسل للعميل على واتساب: ${label}`), label);
    }
});

test('an order without invoice has its own tracking page; switched off / no template: not sent', async (t) => {
    const { db, call, base } = await start(t);
    const order = workorders.create(db, { kind: 'maintenance', customer_name: 'مريم', customer_phone: '93334444', description: 'صيانة', scheduled_date: '2026-11-23' }, 'المكتب', {});
    const r = await notify.notify(db, workorders.get(db, order.id), 'scheduled', { origin: base });
    assert.equal(r.sent, true);
    const link = sent.at(-1).values[4];
    assert.match(link, /\/t\/[0-9a-f]{32}$/);
    const page = await fetch(link);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /مرحباً مريم/);
    assert.match(html, /الاثنين 2026-11-23/);

    saveSettings(db, { wo_customer_notices: false });
    assert.equal((await notify.notify(db, workorders.get(db, order.id), 'started', { origin: base })).skipped, 'off');
    saveSettings(db, { wo_customer_notices: true });
    delete process.env.MAZBOT_WO_STARTED_TEMPLATE_ID;
    assert.equal((await notify.notify(db, workorders.get(db, order.id), 'started', { origin: base })).skipped, 'no_template');
});

test('«إيقاف الإشعارات 48 ساعة» from the templates account mutes the number; «تتبع» answers with the links', async (t) => {
    const { db, base } = await start(t);
    const inv = invoiceFor(db);
    const hook = `${base}/webhooks/mazbot-templates/${TPL.MAZBOT_TEMPLATES_WEBHOOK_SECRET}`;
    const post = (event, sign = true) => {
        const raw = JSON.stringify(event);
        const sig = 'sha256=' + crypto.createHmac('sha256', TPL.MAZBOT_TEMPLATES_SIGNING_SECRET).update(raw).digest('hex');
        return fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(sign ? { 'X-Mazbot-Signature': sig } : {}) }, body: raw });
    };
    const press = { type: 'message.received', data: { contact: { id: 9, phone: '96891234567' }, message: { id: 'm1', message_type: 'button', value: 'إيقاف الإشعارات 48 ساعة' } } };
    assert.equal((await post(press, false)).status, 401, 'signed only');
    assert.equal((await fetch(`${base}/webhooks/mazbot-templates/wrong-secret-0123456789`, { method: 'POST' })).status, 404);
    assert.equal((await post(press)).status, 200);
    await wait();
    assert.ok(notify.isMuted(db, '91234567'), 'muted for 48 hours');
    // The panel lists it under the templates account (not the main one), with what happened
    const list = async (q) => (await (await fetch(`${base}/api/admin/mazbot/inbound${q}`, { headers: { Authorization: 'Bearer ' + OWNER } })).json());
    const tpl = await list('?source=mazbot_templates');
    assert.equal(tpl.events.length, 2, 'the unsigned one and the signed one');
    assert.match(tpl.events[0].status, /^muted/);
    assert.equal(tpl.events[1].status, 'bad_signature');
    assert.equal(tpl.templates_webhook_path, `/webhooks/mazbot-templates/${TPL.MAZBOT_TEMPLATES_WEBHOOK_SECRET}`);
    assert.equal(tpl.templates_signed, true);
    assert.equal((await list('')).events.length, 0, 'the main account\'s list stays its own');
    const order = workorders.create(db, { kind: 'installation', description: 'تركيب', scheduled_date: '2026-11-22' }, 'المكتب', { source: { invoice: inv } });
    const r = await notify.notify(db, workorders.get(db, order.id), 'scheduled', { origin: base });
    assert.equal(r.skipped, 'muted');
    assert.ok(logOf(db, order.id).some((l) => l.startsWith('🔕')));

    // «تتبع»: the customer's invoices and open orders as links (replied through the templates account)
    const replies = [];
    const client = { sendTextToPhone: async (to, text) => { replies.push({ to, text }); return { ok: true }; } };
    const out = await notify.handleTemplatesEvent(db, { type: 'interactive.selected', data: { contact: { phone: '96891234567' }, selection: { id: 'track', title: 'تتبع طلبي' } } }, { origin: base, client });
    assert.equal(out.action, 'track');
    assert.equal(replies[0].to, '96891234567');
    assert.ok(replies[0].text.includes(`${base}/t/${inv.access_key}`));
    const none = await notify.handleTemplatesEvent(db, { type: 'message.received', data: { contact: { phone: '96899999999' }, message: { value: 'تتبع' } } }, { origin: base, client });
    assert.match(none.reply, /لم نجد طلبات/);
});
