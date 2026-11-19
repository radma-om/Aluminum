/* Confirming the customer's mobile on WhatsApp before a calculator request: the page gets a code, the customer
   sends it from their number to the templates number, the webhook confirms it, the request goes through with the
   token — 30 days for that number. Off by default. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { openDatabase, saveSettings } = require('../src/db');
const { createApp } = require('../src/server');
const notify = require('../src/order-notify');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const ENV = { MAZBOT_TEMPLATES_WEBHOOK_SECRET: 'tpl-hook-secret-0123456789', MAZBOT_TEMPLATES_SIGNING_SECRET: 'tpl-signing-secret' };

async function start(t) {
    Object.assign(process.env, ENV);
    t.after(() => { for (const k of Object.keys(ENV)) delete process.env[k]; });
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const conf = (await call('GET', '/api/public/configurator')).body;
    const type = conf.shutter_types.find((x) => x.variants.length === 1) || conf.shutter_types[0];
    const door = { width_cm: 300, height_cm: 250, count: 1, shutter_type_id: type.id, color_id: type.variants[0].colors[0].id,
        option_ids: conf.accessory_groups.map((g) => g.options[0].id), region_id: conf.locations[0].wilayat[0].id };
    // A WhatsApp message to the templates number (signed like MazBot)
    const whatsapp = async (phone, text, id = crypto.randomUUID()) => {
        const raw = JSON.stringify({ type: 'message.received', data: { contact: { id: 1, phone }, message: { id, message_type: 'text', value: text } } });
        const sig = 'sha256=' + crypto.createHmac('sha256', ENV.MAZBOT_TEMPLATES_SIGNING_SECRET).update(raw).digest('hex');
        await fetch(`${base}/webhooks/mazbot-templates/${ENV.MAZBOT_TEMPLATES_WEBHOOK_SECRET}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mazbot-Signature': sig }, body: raw });
        await new Promise((r) => setTimeout(r, 60));
    };
    return { db, call, door, whatsapp };
}

test('off by default: a calculator request goes through without confirmation', async (t) => {
    const { call, door } = await start(t);
    assert.equal((await call('GET', '/api/public/verify/config')).body.required, false);
    assert.equal((await call('POST', '/api/public/door-quotes', { ...door, customer_name: 'أحمد', customer_phone: '99123456' })).status, 201);
    assert.equal((await call('POST', '/api/public/verify/start', { phone: '99123456' })).status, 400);
});

test('on: code → WhatsApp from the same number → confirmed → the request goes through for 30 days', async (t) => {
    const { db, call, door, whatsapp } = await start(t);
    saveSettings(db, { calculator_verify_phone: true });
    const cfg = (await call('GET', '/api/public/verify/config')).body;
    assert.deepEqual([cfg.required, cfg.number], [true, '96890660005']);

    // Without a confirmation: refused, and the page knows why
    let r = await call('POST', '/api/public/door-quotes', { ...door, customer_name: 'أحمد', customer_phone: '99123456' });
    assert.equal(r.status, 403);
    assert.equal(r.body.need_verification, true);

    const s = (await call('POST', '/api/public/verify/start', { phone: '99123456' })).body;
    assert.match(s.code, /^\d{4}$/);
    assert.equal(s.wa_url, `https://wa.me/96890660005?text=${encodeURIComponent(`رمز تأكيد الرقم: ${s.code}`)}`);
    assert.equal((await call('GET', `/api/public/verify/status?token=${s.token}`)).body.status, 'pending');

    // Sent from another number: not confirmed
    await whatsapp('96891111111', `رمز تأكيد الرقم: ${s.code}`);
    assert.equal((await call('GET', `/api/public/verify/status?token=${s.token}`)).body.status, 'pending');
    assert.equal(db.prepare("SELECT status FROM inbound_events WHERE source = 'mazbot_templates' ORDER BY id DESC").get().status.split(':')[0].replace(/_failed$/, ''), 'verify_failed');

    // From the number typed: confirmed (Arabic digits work too)
    const arabic = s.code.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]);
    await whatsapp('96899123456', `رمز تأكيد الرقم: ${arabic}`);
    const st = (await call('GET', `/api/public/verify/status?token=${s.token}`)).body;
    assert.equal(st.status, 'verified');
    assert.ok(st.until > new Date(Date.now() + 29 * 86400_000).toISOString().slice(0, 10));

    r = await call('POST', '/api/public/door-quotes', { ...door, customer_name: 'أحمد', customer_phone: '99123456', verify_token: s.token });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    // The same token for another number: refused
    r = await call('POST', '/api/public/door-quotes', { ...door, customer_name: 'أحمد', customer_phone: '99887766', verify_token: s.token });
    assert.equal(r.status, 403);
    // 30 days later: asked again
    db.prepare("UPDATE phone_verifications SET verified_until = datetime('now', '-1 minute')").run();
    assert.equal((await call('POST', '/api/public/door-quotes', { ...door, customer_name: 'أحمد', customer_phone: '99123456', verify_token: s.token })).status, 403);
});

test('a wrong or expired code, a non-Omani number, too many codes; never on without the webhook', async (t) => {
    const { db, call } = await start(t);
    saveSettings(db, { calculator_verify_phone: true });
    const replies = [];
    const client = { sendTextToPhone: async (to, text) => { replies.push(text); return { ok: true }; } };
    const s = (await call('POST', '/api/public/verify/start', { phone: '99123456' })).body;
    db.prepare("UPDATE phone_verifications SET expires_at = datetime('now', '-1 minute')").run();
    const out = await notify.handleTemplatesEvent(db, { type: 'message.received', data: { contact: { phone: '96899123456' }, message: { value: `رمز تأكيد الرقم: ${s.code}` } } }, { client });
    assert.equal(out.action, 'verify_failed');
    assert.match(replies.at(-1), /انتهت صلاحيته/);
    assert.equal((await call('GET', `/api/public/verify/status?token=${s.token}`)).body.status, 'expired');
    // An ordinary message with no code is not taken for one
    assert.equal((await notify.handleTemplatesEvent(db, { type: 'message.received', data: { contact: { phone: '96899123456' }, message: { value: 'مرحبا أريد سعر بوابة 2025' } } }, { client })).action, 'ignored');

    assert.equal((await call('POST', '/api/public/verify/start', { phone: '12345' })).status, 400);
    for (let i = 0; i < 4; i++) await call('POST', '/api/public/verify/start', { phone: '99123456' });
    assert.equal((await call('POST', '/api/public/verify/start', { phone: '99123456' })).status, 429, '5 codes an hour');

    delete process.env.MAZBOT_TEMPLATES_WEBHOOK_SECRET;
    assert.equal((await call('GET', '/api/public/verify/config')).body.required, false, 'no webhook: never asked (it would stop every request)');
});
