const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { openDatabase, saveSettings } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const inbox = require('../src/mazbot-inbox');
const mazbot = require('../src/mazbot');
const check = require('../src/whatsapp-check');

process.env.ADMIN_TOKEN = 'test-token';

/* Fake MazBot API; loginOk = false makes the login fail */
async function fakeMazbot({ loginOk = true } = {}) {
    const sent = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks);
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/login') {
            if (!loginOk) { res.statusCode = 401; return res.end('{"message":"Unauthenticated"}'); }
            return res.end(JSON.stringify({ data: { token: 'jwt' } }));
        }
        if (req.url === '/api/contact/resolve-by-phone') return res.end(JSON.stringify({ data: { receiver_id: 555 } }));
        const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: raw }).formData();
        sent.push({ path: req.url, ...Object.fromEntries(form.entries()) });
        res.end(JSON.stringify({ success: true }));
    });
    await new Promise((r) => server.listen(0, r));
    Object.assign(process.env, {
        MAZBOT_BASE_URL: `http://127.0.0.1:${server.address().port}/api`,
        MAZBOT_API_KEY: 'k', MAZBOT_STAFF_EMAIL: 's@example.com', MAZBOT_STAFF_PASSWORD: 'p', ANTHROPIC_API_KEY: 'test'
    });
    mazbot._reset();
    return { server, sent };
}

const say = (t) => ({ content: [{ type: 'text', text: t }], stop_reason: 'end_turn' });
const fakeClient = (script) => ({ beta: { messages: { create: async () => script.shift()() } } });
let n = 0;
const incoming = (value, phone = '96899887897') => ({
    id: 'e' + (++n), type: 'message.received',
    data: { contact: { id: 1376829, phone, name: 'محمد' }, message: { id: 18800000 + n, message_type: 'text', value } }
});
const store = (db, e) => Number(db.prepare("INSERT INTO inbound_events (source, method, body) VALUES ('mazbot', 'POST', ?)").run(JSON.stringify(e)).lastInsertRowid);
const byKey = (r, key) => r.checks.find((c) => c.key === key);

test('no webhook secret, or MazBot never called: the first broken link is named', async (t) => {
    const fake = await fakeMazbot();
    t.after(() => fake.server.close());
    const db = openDatabase(':memory:');
    delete process.env.MAZBOT_WEBHOOK_SECRET;
    let r = await check.run(db);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(byKey(r, 'webhook').level, 'bad');
    assert.match(r.summary, /رابط الـ Webhook غير مفعّل/);

    process.env.MAZBOT_WEBHOOK_SECRET = 'abcdefghijklmnop1234';
    t.after(() => { delete process.env.MAZBOT_WEBHOOK_SECRET; });
    r = await check.run(db);
    assert.match(byKey(r, 'webhook').title, /لم تصل أي رسالة من MazBot/);
    assert.strictEqual(r.webhook_path, '/webhooks/mazbot/abcdefghijklmnop1234');
});

test('agent switched off, paused number, missing AI key and MazBot login are each explained; fixes work', async (t) => {
    const fake = await fakeMazbot();
    t.after(() => fake.server.close());
    process.env.MAZBOT_WEBHOOK_SECRET = 'abcdefghijklmnop1234';
    t.after(() => { delete process.env.MAZBOT_WEBHOOK_SECRET; });
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json() };
    };

    // Agent off: the message reached the system, the switch is the cause
    const e1 = incoming('كم سعر الرول شتر؟');
    inbox.handleEvent(db, store(db, e1), e1, { saveQuote: (q) => saveQuote(db, q), notifySales: async () => null });
    let { body: r } = await call('GET', '/api/admin/mazbot/diagnose');
    assert.strictEqual(byKey(r, 'webhook').level, 'ok');
    assert.strictEqual(byKey(r, 'switch').level, 'bad');
    assert.match(r.summary, /المساعد لا يرد على واتساب/);
    assert.strictEqual(r.messages[0].text, 'كم سعر الرول شتر؟'); // the customer's words stay
    assert.match(r.messages[0].note, /غير مفعّل/);
    assert.strictEqual(byKey(r, 'send').level, 'ok'); // a real login against MazBot

    assert.deepStrictEqual((await call('PUT', '/api/admin/mazbot/agent', { enabled: true })).body, { enabled: true });
    r = (await call('GET', '/api/admin/mazbot/diagnose')).body;
    assert.strictEqual(byKey(r, 'switch').level, 'ok');

    // Paused number: shown with a resume
    inbox.pause(db, '96899887897');
    const e2 = incoming('مرحبا؟');
    await inbox.handleEvent(db, store(db, e2), e2, { saveQuote: (q) => saveQuote(db, q), notifySales: async () => null, client: fakeClient([]) });
    r = (await call('GET', '/api/admin/mazbot/diagnose')).body;
    assert.match(byKey(r, 'last').detail, /متوقف لهذا الرقم/);
    assert.deepStrictEqual(r.pauses.map((p) => p.phone), ['96899887897']);
    assert.strictEqual((await call('DELETE', '/api/admin/mazbot/pauses?phone=96899887897')).body.resumed, 1);
    assert.strictEqual((await call('GET', '/api/admin/mazbot/diagnose')).body.pauses.length, 0);

    // Missing AI key
    const saved = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    r = (await call('GET', '/api/admin/mazbot/diagnose')).body;
    assert.strictEqual(byKey(r, 'ai').level, 'bad');
    assert.match(byKey(r, 'ai').fix, /OPENAI_API_KEY/);
    if (saved.a) process.env.ANTHROPIC_API_KEY = saved.a;
    if (saved.o) process.env.OPENAI_API_KEY = saved.o;

    // Staff without «الربط» cannot run it
    await call('POST', '/api/admin/users', { username: 'salem', display_name: 'سالم', password: 'salem-pass-1', permissions: ['leads'] });
    const { token } = await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'salem', password: 'salem-pass-1' }) })).json();
    assert.strictEqual((await fetch(base + '/api/admin/mazbot/diagnose', { headers: { Authorization: 'Bearer ' + token } })).status, 403);
});

test('a wrong MazBot password and bad signatures are reported', async (t) => {
    const fake = await fakeMazbot({ loginOk: false });
    t.after(() => fake.server.close());
    process.env.MAZBOT_WEBHOOK_SECRET = 'abcdefghijklmnop1234';
    t.after(() => { delete process.env.MAZBOT_WEBHOOK_SECRET; });
    process.env.MAZBOT_SIGNING_SECRET = 'sign-secret';
    t.after(() => { delete process.env.MAZBOT_SIGNING_SECRET; });
    const db = openDatabase(':memory:');
    db.prepare("INSERT INTO inbound_events (source, method, body, status, signature) VALUES ('mazbot', 'POST', '{}', 'bad_signature', 'bad')").run();
    const r = await check.run(db);
    assert.strictEqual(byKey(r, 'signature').level, 'bad');
    assert.match(byKey(r, 'signature').fix, /MAZBOT_SIGNING_SECRET/);
    assert.doesNotMatch(byKey(r, 'signature').fix, /احذف/); // never "remove the secret to test"
    assert.strictEqual(byKey(r, 'send').level, 'bad');
    assert.match(byKey(r, 'send').detail, /login_failed_http_401/);
});

test('the full test on a number: the AI answers and the reply goes out through MazBot', async (t) => {
    const fake = await fakeMazbot();
    t.after(() => fake.server.close());
    const db = openDatabase(':memory:');
    saveSettings(db, { mazbot_agent_enabled: true });
    inbox.pause(db, '96899887897'); // an earlier pause never blocks the test
    const ctx = { saveQuote: (q) => saveQuote(db, q), notifySales: async () => null, client: fakeClient([() => say('أهلاً! ما مقاس البوابة؟')]) };
    const r = await check.simulate(db, { phone: '99887897', text: 'كم السعر؟' }, ctx);
    assert.strictEqual(r.status, 'replied');
    assert.strictEqual(r.level, 'ok');
    assert.deepStrictEqual(fake.sent.map((s) => [s.receiver_id, s.message]), [['555', 'أهلاً! ما مقاس البوابة؟']]);
    await assert.rejects(check.simulate(db, { phone: '123' }, ctx), /رقم واتساب/);
});

/* ---------------- The MazBot webhook signature, end to end ---------------- */

async function webhookApp(t, signingSecret) {
    process.env.MAZBOT_WEBHOOK_SECRET = 'abcdefghijklmnop1234';
    if (signingSecret) process.env.MAZBOT_SIGNING_SECRET = signingSecret; else delete process.env.MAZBOT_SIGNING_SECRET;
    t.after(() => { delete process.env.MAZBOT_WEBHOOK_SECRET; delete process.env.MAZBOT_SIGNING_SECRET; });
    const db = openDatabase(':memory:'); // agent switch off: nothing is sent to anyone
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const url = `http://127.0.0.1:${server.address().port}/webhooks/mazbot/abcdefghijklmnop1234`;
    const send = (body, sig) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-Mazbot-Signature': sig } : {}) }, body });
    const lastSig = () => db.prepare('SELECT signature, status FROM inbound_events ORDER BY id DESC LIMIT 1').get();
    return { db, send, lastSig };
}
const crypto = require('node:crypto');
const hmac = (body, secret = 'sign-secret') => crypto.createHmac('sha256', secret).update(body).digest('hex');
const event = (text) => JSON.stringify({ id: 'ev' + (++n), type: 'message.received', data: { contact: { id: 7, phone: '96891112222', name: 'تجربة' }, message: { id: 'm' + n, message_type: 'text', value: text } } });

test('MazBot signature: correct accepted; wrong, missing and a changed body refused; each result recorded', async (t) => {
    const { send, lastSig } = await webhookApp(t, 'sign-secret');
    const body = event('مرحبا');
    assert.strictEqual((await send(body, hmac(body))).status, 200);
    assert.deepStrictEqual({ ...lastSig() }, { signature: 'verified', status: 'agent_off' });
    assert.strictEqual((await send(body, 'sha256=' + hmac(body))).status, 200);

    const cases = [['wrong secret', body, hmac(body, 'other')], ['missing header', body, null], ['garbage', body, 'sha256=xyz'],
        ['body changed after signing', body.replace('مرحبا', 'مرحبا!'), hmac(body)]];
    for (const [name, b, sig] of cases) {
        assert.strictEqual((await send(b, sig)).status, 401, name);
        assert.deepStrictEqual({ ...lastSig() }, { signature: 'bad', status: 'bad_signature' }, name);
    }
});

test('MazBot without a signing secret: still accepted (integration unchanged) and recorded as unchecked', async (t) => {
    const { send, lastSig, db } = await webhookApp(t, null);
    assert.strictEqual((await send(event('مرحبا'), null)).status, 200);
    assert.strictEqual(lastSig().signature, 'unchecked');
    const r = await check.run(db, { live: false });
    assert.strictEqual(byKey(r, 'signature').level, 'warn');
    assert.match(byKey(r, 'signature').title, /غير مفعّل/);
    assert.match(byKey(r, 'signature').detail, /دون التأكد أنه من MazBot/);
});

test('diagnostics never call the signature "sound" without a verified external request', async (t) => {
    const fake = await fakeMazbot();
    t.after(() => fake.server.close());
    process.env.MAZBOT_WEBHOOK_SECRET = 'abcdefghijklmnop1234';
    process.env.MAZBOT_SIGNING_SECRET = 'sign-secret';
    t.after(() => { delete process.env.MAZBOT_WEBHOOK_SECRET; delete process.env.MAZBOT_SIGNING_SECRET; });
    const db = openDatabase(':memory:');

    // The secret alone is not evidence
    let r = await check.run(db, { live: false });
    assert.strictEqual(byKey(r, 'signature').level, 'warn');
    assert.match(byKey(r, 'signature').title, /لا يوجد دليل/);

    // The panel's own test is not evidence either (and does not prove MazBot reaches us)
    saveSettings(db, { mazbot_agent_enabled: true });
    await check.simulate(db, { phone: '99887897', text: 'تجربة' }, { saveQuote: (q) => saveQuote(db, q), notifySales: async () => null, client: fakeClient([() => say('أهلاً')]) });
    r = await check.run(db, { live: false });
    assert.match(byKey(r, 'signature').title, /لا يوجد دليل/);
    assert.match(byKey(r, 'webhook').title, /لم تصل أي رسالة من MazBot/);
    assert.ok(r.messages.every((m) => m.test));

    // An old rejection followed by a verified request: sound now, the old one is history
    const ins = db.prepare("INSERT INTO inbound_events (source, method, body, status, signature, received_at) VALUES ('mazbot', 'POST', ?, ?, ?, datetime('now', ?))");
    ins.run(event('قديمة'), 'bad_signature', 'bad', '-2 hours');
    ins.run(event('جديدة'), 'replied', 'verified', '-1 minutes');
    r = await check.run(db, { live: false });
    assert.strictEqual(byKey(r, 'signature').level, 'ok');
    assert.match(byKey(r, 'signature').detail, /اجتاز التحقق[^]*رُفضت 1 طلبات أقدم/);
    assert.strictEqual(byKey(r, 'webhook').level, 'ok');

    // The latest request rejected: that is the current state
    ins.run(event('أحدث'), 'bad_signature', 'bad', '+0 minutes');
    r = await check.run(db, { live: false });
    assert.strictEqual(byKey(r, 'signature').level, 'bad');
    assert.match(r.summary, /التوقيع لا يطابق/);
});

test('an AI error older than the latest successful reply is reported as history, not as the cause', async (t) => {
    const fake = await fakeMazbot();
    t.after(() => fake.server.close());
    const agent = require('../src/agent');
    const db = openDatabase(':memory:');
    // Produce a real AI error, then a successful reply after it
    await assert.rejects(agent.chat({ db, key: 'x', channel: 'mazbot', phone: '1', text: 'hi', createQuote: () => null, notifyHuman: async () => {},
        client: { beta: { messages: { create: async () => { throw new Error('insufficient_quota'); } } } } }));
    let r = await check.run(db, { live: false });
    assert.strictEqual(byKey(r, 'ai').level, 'bad');
    assert.match(byKey(r, 'ai').fix, /رصيد/);
    db.prepare("INSERT INTO inbound_events (source, method, body, status, received_at) VALUES ('mazbot', 'POST', ?, 'replied', datetime('now', '+1 minutes'))").run(event('شكراً'));
    r = await check.run(db, { live: false });
    assert.strictEqual(byKey(r, 'ai').level, 'ok');
    assert.match(byKey(r, 'ai').detail, /خطأ سابق/);
});
