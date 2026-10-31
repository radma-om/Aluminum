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
    const db = openDatabase(':memory:');
    db.prepare("INSERT INTO inbound_events (source, method, body, status) VALUES ('mazbot', 'POST', '{}', 'bad_signature')").run();
    const r = await check.run(db);
    assert.strictEqual(byKey(r, 'signature').level, 'bad');
    assert.match(byKey(r, 'signature').fix, /MAZBOT_SIGNING_SECRET/);
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
