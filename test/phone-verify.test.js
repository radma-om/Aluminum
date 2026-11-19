/* Confirming the customer's mobile before a calculator request: the company sends a 4-digit code on WhatsApp
   (an approved MazBot template through the templates account), the customer types it in the page, the request
   goes through with the token — 30 days for that number. Off by default, and never on without the template. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase, saveSettings } = require('../src/db');
const { createApp } = require('../src/server');
const phoneVerify = require('../src/phone-verify');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const ENV = { MAZBOT_VERIFY_TEMPLATE_ID: '4001', MAZBOT_TEMPLATES_API_KEY: 'k', MAZBOT_TEMPLATES_STAFF_EMAIL: 'e@x', MAZBOT_TEMPLATES_STAFF_PASSWORD: 'p' };

async function start(t, { fail = false } = {}) {
    Object.assign(process.env, ENV);
    const sent = [];
    phoneVerify.setSenderForTests(async (mobile, values) => { sent.push({ mobile, values }); return fail ? { ok: false, error: 'x' } : { ok: true }; });
    t.after(() => { for (const k of Object.keys(ENV)) delete process.env[k]; phoneVerify.setSenderForTests(null); });
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
    return { db, call, door, sent };
}

test('off by default: a calculator request goes through without confirmation', async (t) => {
    const { call, door } = await start(t);
    assert.equal((await call('GET', '/api/public/verify/config')).body.required, false);
    assert.equal((await call('POST', '/api/public/door-quotes', { ...door, customer_name: 'أحمد', customer_phone: '99123456' })).status, 201);
    assert.equal((await call('POST', '/api/public/verify/start', { phone: '99123456' })).status, 400);
});

test('on: the code goes by template to the number → typed in the page → the request goes through for 30 days', async (t) => {
    const { db, call, door, sent } = await start(t);
    saveSettings(db, { calculator_verify_phone: true });
    assert.equal((await call('GET', '/api/public/verify/config')).body.required, true);

    let r = await call('POST', '/api/public/door-quotes', { ...door, customer_name: 'أحمد', customer_phone: '99123456' });
    assert.equal(r.status, 403);
    assert.equal(r.body.need_verification, true);

    const s = (await call('POST', '/api/public/verify/start', { phone: '99123456' })).body;
    assert.equal(s.code, undefined, 'the page never gets the code');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].mobile, '96899123456');
    const code = sent[0].values[0];
    assert.match(code, /^\d{4}$/);

    // A wrong code: refused, tries counted
    const wrong = code === '1234' ? '4321' : '1234';
    r = await call('POST', '/api/public/verify/confirm', { token: s.token, code: wrong });
    assert.equal(r.status, 400);
    assert.equal(r.body.verify, 'wrong');
    assert.equal((await call('POST', '/api/public/door-quotes', { ...door, customer_name: 'أحمد', customer_phone: '99123456', verify_token: s.token })).status, 403);

    // The right one (Arabic digits work too)
    r = await call('POST', '/api/public/verify/confirm', { token: s.token, code: code.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[d]) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, 'verified');
    assert.ok(r.body.until > new Date(Date.now() + 29 * 86400_000).toISOString().slice(0, 10));

    r = await call('POST', '/api/public/door-quotes', { ...door, customer_name: 'أحمد', customer_phone: '99123456', verify_token: s.token });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    // The same token for another number: refused
    assert.equal((await call('POST', '/api/public/door-quotes', { ...door, customer_name: 'أحمد', customer_phone: '99887766', verify_token: s.token })).status, 403);
    // 30 days later: asked again
    db.prepare("UPDATE phone_verifications SET verified_until = datetime('now', '-1 minute')").run();
    assert.equal((await call('POST', '/api/public/door-quotes', { ...door, customer_name: 'أحمد', customer_phone: '99123456', verify_token: s.token })).status, 403);
});

test('5 wrong tries end the code; an expired code; a non-Omani number; 5 codes an hour; never on without the template', async (t) => {
    const { db, call, sent } = await start(t);
    saveSettings(db, { calculator_verify_phone: true });
    let s = (await call('POST', '/api/public/verify/start', { phone: '99123456' })).body;
    const wrong = sent[0].values[0] === '1111' ? '2222' : '1111';
    let last;
    for (let i = 0; i < 5; i++) last = await call('POST', '/api/public/verify/confirm', { token: s.token, code: wrong });
    assert.equal(last.body.verify, 'expired');
    assert.equal((await call('POST', '/api/public/verify/confirm', { token: s.token, code: sent[0].values[0] })).body.verify, 'expired', 'not even the right one after');

    s = (await call('POST', '/api/public/verify/start', { phone: '99123456' })).body;
    db.prepare("UPDATE phone_verifications SET expires_at = datetime('now', '-1 minute')").run();
    assert.equal((await call('POST', '/api/public/verify/confirm', { token: s.token, code: sent[1].values[0] })).body.verify, 'expired');

    assert.equal((await call('POST', '/api/public/verify/start', { phone: '12345' })).status, 400);
    for (let i = 0; i < 3; i++) await call('POST', '/api/public/verify/start', { phone: '99123456' });
    assert.equal((await call('POST', '/api/public/verify/start', { phone: '99123456' })).status, 429, '5 codes an hour');

    delete process.env.MAZBOT_VERIFY_TEMPLATE_ID;
    assert.equal((await call('GET', '/api/public/verify/config')).body.required, false, 'no template: never asked (it would stop every request)');
});

test('the template could not be sent: the page is told, and that code never confirms', async (t) => {
    const { db, call, sent } = await start(t, { fail: true });
    saveSettings(db, { calculator_verify_phone: true });
    const r = await call('POST', '/api/public/verify/start', { phone: '99123456' });
    assert.equal(r.status, 502);
    assert.match(r.body.error, /تعذر إرسال رمز التحقق/);
    const row = db.prepare('SELECT token, status FROM phone_verifications').get();
    assert.equal(row.status, 'failed');
    assert.equal((await call('POST', '/api/public/verify/confirm', { token: row.token, code: sent[0].values[0] })).body.verify, 'unknown');
});
