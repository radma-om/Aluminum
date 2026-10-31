const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/server');
const trusted = require('../src/trusted-proxies');

const ENV_KEYS = ['ADMIN_TOKEN', 'TRUST_PROXY', 'TRUSTED_PROXIES', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN'];

/* createApp reads TRUSTED_PROXIES when it starts, so each test builds its own app */
async function start(t, env = {}) {
    for (const key of ENV_KEYS) {
        const before = process.env[key];
        t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
        delete process.env[key];
    }
    Object.assign(process.env, { ADMIN_TOKEN: 'test-admin', ...env });
    trusted.resetPeers();
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => new Promise((r) => server.close(r)));
    const base = `http://127.0.0.1:${server.address().port}`;
    return (url, options) => fetch(base + url, options);
}

/* ---------------- WhatsApp Cloud API (direct Meta route) ---------------- */

const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
const signature = (text, secret = 'test-app-secret') => 'sha256=' + crypto.createHmac('sha256', secret).update(text).digest('hex');
const post = (call, body, sig) => call('/webhooks/whatsapp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-Hub-Signature-256': sig } : {}) }, body
});

test('Cloud API: every POST is refused while WHATSAPP_APP_SECRET is missing, even "signed" ones', async (t) => {
    const call = await start(t);
    assert.equal((await post(call, payload, signature(payload))).status, 401);
    assert.equal((await post(call, payload)).status, 401);
});

test('Cloud API: missing, malformed, wrong and tampered signatures are refused; the raw-body HMAC is accepted', async (t) => {
    const call = await start(t, { WHATSAPP_APP_SECRET: 'test-app-secret' });
    for (const sig of [undefined, 'sha256=invalid', 'sha256=' + 'z'.repeat(64), 'md5=' + 'a'.repeat(64), signature(payload, 'wrong')]) {
        assert.equal((await post(call, payload, sig)).status, 401, String(sig));
    }
    assert.equal((await post(call, payload + ' ', signature(payload))).status, 401); // body changed after signing
    assert.equal((await post(call, payload, signature(payload))).status, 200);
});

test('Cloud API: the GET verification handshake still works on its own', async (t) => {
    const call = await start(t, { WHATSAPP_VERIFY_TOKEN: 'verify-test' });
    const res = await call('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-test&hub.challenge=42');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '42');
    assert.equal((await call('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42')).status, 403);
});

test('MazBot does not depend on any Cloud API setting', async (t) => {
    const call = await start(t, { MAZBOT_WEBHOOK_SECRET: 'abcdefghijklmnop1234' });
    t.after(() => { delete process.env.MAZBOT_WEBHOOK_SECRET; });
    const res = await call('/webhooks/mazbot/abcdefghijklmnop1234', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'e1', type: 'user.registered', data: {} })
    });
    assert.equal(res.status, 200);
});

/* ---------------- Trusted proxies and the login limit ---------------- */

const attempt = (call, forwarded) => call('/api/admin/products', {
    headers: { Authorization: 'Bearer wrong', ...(forwarded ? { 'X-Forwarded-For': forwarded } : {}) }
});

for (const [name, env, forwarded] of [
    ['default (no trusted proxy)', {}, (i) => `192.0.2.${i}`],
    ['the old trust-everyone setting', { TRUST_PROXY: '1' }, (i) => `192.0.2.${i}`],
    ['a rejected trust-everyone value', { TRUSTED_PROXIES: '0.0.0.0/0' }, (i) => `192.0.2.${i}`],
    ['the direct peer is not the trusted proxy', { TRUSTED_PROXIES: '192.0.2.100/32' }, (i) => `192.0.2.${i}`],
    ['trusted proxy, forged leftmost address', { TRUSTED_PROXIES: '127.0.0.1/32' }, (i) => `192.0.2.${i}, 198.51.100.10`]
]) {
    test(`changing X-Forwarded-For cannot reset the login limit: ${name}`, async (t) => {
        const call = await start(t, env);
        for (let i = 1; i <= 10; i++) assert.equal((await attempt(call, forwarded(i))).status, 401);
        assert.equal((await attempt(call, forwarded(11))).status, 429);
    });
}

test('a correctly trusted proxy keeps separate limits for separate customers', async (t) => {
    const call = await start(t, { TRUSTED_PROXIES: '127.0.0.1/32, ::1/128' });
    for (let i = 0; i < 10; i++) assert.equal((await attempt(call, '198.51.100.10')).status, 401);
    assert.equal((await attempt(call, '198.51.100.10')).status, 429);
    assert.equal((await attempt(call, '198.51.100.11')).status, 401); // another customer is not blocked
});

test('the staff login endpoint shares the same protection', async (t) => {
    const call = await start(t);
    const login = (xff) => call('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': xff }, body: JSON.stringify({ username: 'nobody', password: 'wrong-pass' })
    });
    for (let i = 1; i <= 10; i++) assert.equal((await login(`203.0.113.${i}`)).status, 401);
    assert.equal((await login('203.0.113.99')).status, 429);
});

test('system status: rejected TRUSTED_PROXIES, the untrusted proxy address seen, and the old TRUST_PROXY', async (t) => {
    const call = await start(t, { TRUSTED_PROXIES: '*', TRUST_PROXY: '1' });
    await call('/healthz', { headers: { 'X-Forwarded-For': '198.51.100.7' } });
    const s = await (await call('/api/admin/system-status', { headers: { Authorization: 'Bearer test-admin' } })).json();
    const text = s.warnings.map((w) => w.text).join('\n');
    assert.match(text, /TRUSTED_PROXIES مرفوضة/);
    assert.match(text, /وكيل غير موثوق \(العنوان الذي يراه الخادم: 127\.0\.0\.1\)/);
    assert.match(text, /TRUST_PROXY لم يعد يُستخدم/);
    assert.deepEqual(s.proxies.trusted, []);
});

test('TRUSTED_PROXIES accepts only explicit addresses and reasonable networks', () => {
    assert.deepEqual(trusted.parse(''), { list: false, error: null });
    assert.deepEqual(trusted.parse('127.0.0.1/32, ::1/128').list, ['127.0.0.1/32', '::1/128']);
    assert.deepEqual(trusted.parse('10.0.0.5').list, ['10.0.0.5']);
    assert.deepEqual(trusted.parse('10.20.0.0/16').list, ['10.20.0.0/16']);
    for (const value of ['1', '2', 'true', '*', 'loopback', 'uniquelocal', '0.0.0.0/0', '::/0', '0.0.0.0', '10.0.0.0/7',
        '::/16', '127.0.0.1/33', '::1/129', '127.0.0.1,', '127.0.0.1/-1', '127.0.0.1/a', 'proxy.example.com']) {
        const r = trusted.parse(value);
        assert.equal(r.list, false, value);
        assert.ok(r.error, value);
    }
});

test('public forms: one direct client is limited; customers behind an untrusted proxy share a larger allowance', async (t) => {
    const call = await start(t);
    const quote = (xff) => call('/api/public/overhead-quotes', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(xff ? { 'X-Forwarded-For': xff } : {}) }, body: '{}'
    });
    for (let i = 0; i < 10; i++) assert.notEqual((await quote()).status, 429);
    assert.equal((await quote()).status, 429); // a direct client: 10 per 10 minutes

    const viaProxy = await start(t);
    for (let i = 0; i < 30; i++) assert.notEqual((await (await viaProxy('/api/public/overhead-quotes', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${i}` }, body: '{}'
    })).status), 429);
});
