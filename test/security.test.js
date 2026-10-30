const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/server');
const { trustedProxies } = require('../src/trusted-proxies');

async function start(t, env = {}) {
    for (const key of ['ADMIN_TOKEN', 'TRUST_PROXY', 'TRUSTED_PROXIES', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN']) {
        const before = process.env[key];
        t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
        delete process.env[key];
    }
    Object.assign(process.env, { ADMIN_TOKEN: 'test-admin', ...env });
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(async () => { await new Promise((r) => server.close(r)); db.close(); });
    const base = `http://127.0.0.1:${server.address().port}`;
    return (url, options) => fetch(base + url, options);
}

const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
const signature = (text, secret = 'test-app-secret') => 'sha256=' + crypto.createHmac('sha256', secret).update(text).digest('hex');
const post = (call, body, sig) => call('/webhooks/whatsapp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(sig ? { 'X-Hub-Signature-256': sig } : {}) }, body
});

test('WhatsApp rejects even a signed POST when the app secret is absent', async (t) => {
    const call = await start(t);
    assert.equal((await post(call, payload, signature(payload))).status, 401);
});

test('WhatsApp rejects missing, malformed, wrong and tampered signatures, accepts raw-body HMAC', async (t) => {
    const call = await start(t, { WHATSAPP_APP_SECRET: 'test-app-secret' });
    for (const sig of [undefined, 'sha256=invalid', 'sha256=' + 'z'.repeat(64), signature(payload, 'wrong')]) {
        assert.equal((await post(call, payload, sig)).status, 401);
    }
    assert.equal((await post(call, payload + ' ', signature(payload))).status, 401);
    assert.equal((await post(call, payload, signature(payload))).status, 200);
});

test('WhatsApp GET verification still works independently of POST signing', async (t) => {
    const call = await start(t, { WHATSAPP_VERIFY_TOKEN: 'verify-test' });
    const res = await call('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-test&hub.challenge=42');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), '42');
    assert.equal((await call('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42')).status, 403);
});

const attempt = (call, forwarded) => call('/api/admin/products', {
    headers: { Authorization: 'Bearer wrong', 'X-Forwarded-For': forwarded }
});

for (const [name, env, forwarded] of [
    ['default', {}, (i) => `192.0.2.${i}`],
    ['legacy trust-all setting', { TRUST_PROXY: '1' }, (i) => `192.0.2.${i}`],
    ['untrusted direct peer', { TRUSTED_PROXIES: '192.0.2.100/32' }, (i) => `192.0.2.${i}`],
    ['trusted proxy with forged leftmost address', { TRUSTED_PROXIES: '127.0.0.1/32' }, (i) => `192.0.2.${i}, 198.51.100.10`]
]) {
    test(`changing spoofed forwarded addresses cannot reset the login limit: ${name}`, async (t) => {
        const call = await start(t, env);
        for (let i = 1; i <= 10; i++) assert.equal((await attempt(call, forwarded(i))).status, 401);
        assert.equal((await attempt(call, forwarded(11))).status, 429);
    });
}

test('explicit trusted proxy preserves separate limits for real clients', async (t) => {
    const call = await start(t, { TRUSTED_PROXIES: '127.0.0.1/32' });
    for (let i = 0; i < 10; i++) assert.equal((await attempt(call, '198.51.100.10')).status, 401);
    assert.equal((await attempt(call, '198.51.100.10')).status, 429);
    assert.equal((await attempt(call, '198.51.100.11')).status, 401);
});

test('proxy configuration accepts only explicit IPs and CIDRs', () => {
    assert.equal(trustedProxies(), false);
    assert.deepEqual(trustedProxies('127.0.0.1/32, ::1/128'), ['127.0.0.1/32', '::1/128']);
    assert.deepEqual(trustedProxies('10.0.0.5'), ['10.0.0.5']);
    for (const value of ['1', 'true', '*', 'loopback', '0.0.0.0/0', '::/0', '127.0.0.1/33', '::1/129', '127.0.0.1,', '127.0.0.1/-1']) {
        assert.throws(() => trustedProxies(value), /TRUSTED_PROXIES/);
    }
});
