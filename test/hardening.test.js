const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/server');
const { assertPublicUrl, isPublicAddress } = require('../src/safe-url');
const webhooks = require('../src/webhooks');

process.env.ADMIN_TOKEN = 'test-token-long-enough-1234';

async function start(t, db = openDatabase(':memory:')) {
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = 'test-token-long-enough-1234') => {
        const res = await fetch(base + url, {
            method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
            body: body && !['GET', 'DELETE'].includes(method) ? JSON.stringify(body) : undefined
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        return { status: res.status, body: data, headers: res.headers };
    };
    const login = async (username, password) => (await call('POST', '/api/auth/login', { username, password }, null)).body.token;
    return { db, base, call, login };
}

/* A local receiver that records what reaches it */
async function sink(t, handler = (req, res) => res.end('ok')) {
    const hits = [];
    const server = http.createServer((req, res) => { hits.push(req.url); handler(req, res); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    return { hits, url: (p) => `http://127.0.0.1:${server.address().port}${p}` };
}

/* ---------------- 1. Webhooks: public addresses only, managers only ---------------- */

test('internal, local and cloud-metadata addresses are never valid webhook targets', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.5.4', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0',
        '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '224.0.0.1']) {
        assert.equal(isPublicAddress(ip), false, ip);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);

    for (const url of ['http://127.0.0.1:3000/api/admin/settings', 'http://localhost/x', 'http://api.localhost/x', 'http://10.0.0.5/hook',
        'http://169.254.169.254/latest/meta-data', 'http://[::1]/x', 'http://[fd12::1]/x', 'http://0.0.0.0/', 'http://2130706433/',
        'ftp://example.com/x', 'file:///etc/passwd', 'not a url', 'https://user:pw@8.8.8.8/x']) {
        await assert.rejects(assertPublicUrl(url), (e) => e.status === 400, url);
    }
    assert.equal((await assertPublicUrl('https://8.8.8.8/hook')).hostname, '8.8.8.8');
});

test('webhooks are managed by managers only, and the API refuses internal targets', async (t) => {
    const { call, login } = await start(t);
    await call('POST', '/api/admin/users', { username: 'integr', display_name: 'خالد', password: 'integr-pass-1', permissions: Object.keys(require('../src/staff').SECTIONS) });
    const staffToken = await login('integr', 'integr-pass-1');
    for (const [method, url] of [['GET', '/api/admin/webhooks'], ['POST', '/api/admin/webhooks'], ['PUT', '/api/admin/webhooks/1'],
        ['DELETE', '/api/admin/webhooks/1'], ['POST', '/api/admin/webhooks/1/test'], ['GET', '/api/admin/webhooks/1/deliveries']]) {
        assert.equal((await call(method, url, { name: 'x', url: 'https://8.8.8.8/h' }, staffToken)).status, 403, `${method} ${url}`);
    }
    const r = await call('POST', '/api/admin/webhooks', { name: 'self', url: 'http://127.0.0.1:3000/api/admin/settings', events: '*' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /الداخلية أو المحلية/);
    assert.equal((await call('POST', '/api/admin/webhooks', { name: 'meta', url: 'http://169.254.169.254/latest', events: '*' })).status, 400);
    assert.equal((await call('POST', '/api/admin/webhooks', { name: 'ok', url: 'https://8.8.8.8/hook', events: '*', active: false })).status, 201);
});

test('a delivery re-checks the address and never follows a redirect', async (t) => {
    const db = openDatabase(':memory:');
    // Saved earlier (or pointed to an internal address later): refused at delivery, nothing reaches it
    const inside = await sink(t);
    const hook = { id: Number(db.prepare("INSERT INTO webhooks (name, url, events) VALUES ('x', ?, '*')").run(inside.url('/hook')).lastInsertRowid), url: inside.url('/hook'), secret: null };
    const [r1] = await webhooks.emit(db, 'webhook.test', {}, hook);
    assert.equal(r1.ok, false);
    assert.match(r1.error, /الداخلية أو المحلية/);
    assert.deepEqual(inside.hits, []);

    // With private targets allowed (tests / local development), a redirect is still not followed
    process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = '1';
    t.after(() => { delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS; });
    const target = await sink(t);
    const redirector = await sink(t, (req, res) => { res.writeHead(302, { Location: target.url('/secret') }); res.end(); });
    const [r2] = await webhooks.emit(db, 'webhook.test', {}, { ...hook, url: redirector.url('/hook') });
    assert.equal(r2.ok, false);
    assert.match(r2.error, /302[^]*إعادة توجيه/);
    assert.deepEqual(target.hits, []);
});

/* ---------------- 2. Where customers and sales alerts go: managers only ---------------- */

test('staff cannot divert customers or sales alerts: WhatsApp number, sales recipients and public address', async (t) => {
    const { call, login } = await start(t);
    await call('PUT', '/api/admin/settings', { company_whatsapp: '96871111111', mazbot_recipients: '76979066', public_base_url: 'https://calcshutter.radma.co' });
    await call('POST', '/api/admin/users', { username: 'integr', display_name: 'خالد', password: 'integr-pass-1', permissions: ['integrations'] });
    const staffToken = await login('integr', 'integr-pass-1');

    // Only manager-owned keys: refused outright
    assert.equal((await call('PUT', '/api/admin/settings', { company_whatsapp: '96899999999' }, staffToken)).status, 403);
    // Mixed with their own keys: theirs are saved, the others ignored
    const r = await call('PUT', '/api/admin/settings', {
        company_name: 'اسم جديد', company_whatsapp: '96899999999', mazbot_recipients: '99999999', public_base_url: 'https://evil.example'
    }, staffToken);
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.company_name, r.body.company_whatsapp, r.body.mazbot_recipients, r.body.public_base_url],
        ['اسم جديد', '96871111111', '76979066', 'https://calcshutter.radma.co']);
    // Customers' «تابع عبر واتساب» link still goes to the company number
    const cfg = await call('GET', '/api/public/chat/config', null, null);
    assert.equal(cfg.body.whatsapp, '96871111111');
    // The manager still changes them
    assert.equal((await call('PUT', '/api/admin/settings', { company_whatsapp: '96872222222' })).body.company_whatsapp, '96872222222');
});

/* ---------------- 3–4. Memory and old logs ---------------- */

test('rate-limit and login-lockout counters forget old addresses', (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const { rateLimit, makeLoginGuard } = require('../src/server');
    const limiter = rateLimit({ windowMs: 10 * 60_000, max: 3 });
    const res = { status: () => ({ json: () => null }) };
    for (let i = 0; i < 500; i++) limiter({ ip: `198.51.100.${i % 250}.${i}` }, res, () => {});
    assert.equal(limiter.size(), 500);
    t.mock.timers.tick(5 * 60_000);
    assert.equal(limiter.size(), 500); // still inside the window
    t.mock.timers.tick(6 * 60_000);
    assert.equal(limiter.size(), 0);

    const guard = makeLoginGuard();
    guard.fail('203.0.113.1');
    guard.fail('203.0.113.2');
    assert.equal(guard.size(), 2);
    t.mock.timers.tick(16 * 60_000);
    assert.equal(guard.size(), 0);
    assert.equal(guard.blocked('203.0.113.1'), false);
});

test('logs older than 90 days are removed; business data never is', () => {
    const { pruneOldLogs } = require('../src/server');
    const db = openDatabase(':memory:');
    const hook = Number(db.prepare("INSERT INTO webhooks (name, url, events) VALUES ('x', 'https://8.8.8.8/h', '*')").run().lastInsertRowid);
    const del = db.prepare("INSERT INTO webhook_deliveries (webhook_id, event, ok, created_at) VALUES (?, 'quote.created', 1, datetime('now', ?))");
    del.run(hook, '-120 days'); del.run(hook, '-91 days'); del.run(hook, '-2 days');
    const conv = db.prepare("INSERT INTO agent_conversations (conversation_key, channel, messages_json, updated_at) VALUES (?, 'mazbot', '[]', datetime('now', ?))");
    conv.run('old', '-100 days'); conv.run('new', '-1 days');
    db.prepare("INSERT INTO leads (contact_key, created_at, last_activity_at) VALUES ('tel:1', datetime('now', '-400 days'), datetime('now', '-400 days'))").run();
    db.prepare("INSERT INTO audit_log (actor, action, at) VALUES ('x', 'old', datetime('now', '-400 days')), ('x', 'new', datetime('now', '-300 days'))").run();
    db.prepare(`INSERT INTO phone_verification_challenges
        (public_id, phone, provider, status, expires_at, created_at)
        VALUES ('old', '96891234567', 'infocomm', 'expired', datetime('now','-40 days'), datetime('now','-40 days')),
               ('new', '96892345678', 'infocomm', 'pending', datetime('now','+5 minutes'), datetime('now','-1 day'))`).run();
    assert.deepEqual(pruneOldLogs(db), { webhook_deliveries: 2, agent_conversations: 1, staff_sessions: 0, audit_log: 1, system_alerts: 0, password_resets: 0, offsite_backups: 0, phone_verification_challenges: 1 });
    assert.equal(db.prepare('SELECT action FROM audit_log').get().action, 'new'); // the activity log is kept a year
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM webhook_deliveries').get().n, 1);
    assert.equal(db.prepare("SELECT conversation_key FROM agent_conversations").get().conversation_key, 'new');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leads').get().n, 1); // customers are kept
    assert.equal(db.prepare('SELECT public_id FROM phone_verification_challenges').get().public_id, 'new');
});

/* ---------------- 5–6. Page security headers, password strength ---------------- */

test('pages limit where scripts, styles and requests may go; HSTS only over HTTPS', async (t) => {
    const { base } = await start(t);
    for (const page of ['/admin', '/', '/overhead', '/motors', '/chat']) {
        const csp = (await fetch(base + page)).headers.get('content-security-policy');
        assert.match(csp, /default-src 'self'/, page);
        assert.match(csp, /script-src 'self' 'unsafe-inline' https:\/\/cdnjs\.cloudflare\.com(;|$)/, page);
        assert.match(csp, /connect-src 'self'/, page);
        assert.match(csp, /object-src 'none'/, page);
        assert.match(csp, /frame-ancestors/, page);
    }
    assert.match((await fetch(base + '/')).headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/radma\.co/);
    // Data, PDFs and the webhook keep their short header (a full page policy is for pages)
    assert.equal((await fetch(base + '/api/public/configurator')).headers.get('content-security-policy'), "frame-ancestors 'none'");
    const res = await fetch(base + '/admin');
    assert.equal(res.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=(), payment=()');
    assert.equal(res.headers.get('strict-transport-security'), null); // plain http here
});

test('HSTS is sent when the trusted proxy says the visitor used HTTPS', async (t) => {
    process.env.TRUSTED_PROXIES = '127.0.0.1/32,::1/128';
    t.after(() => { delete process.env.TRUSTED_PROXIES; });
    const { base } = await start(t);
    const res = await fetch(base + '/admin', { headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '198.51.100.7' } });
    assert.equal(res.headers.get('strict-transport-security'), 'max-age=15552000');
});

test('the system status warns about a short ADMIN_TOKEN and allowed private webhook targets', async (t) => {
    const saved = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = 'short-token';
    process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = '1';
    t.after(() => { process.env.ADMIN_TOKEN = saved; delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS; });
    const { call } = await start(t);
    const text = (await call('GET', '/api/admin/system-status', null, 'short-token')).body.warnings.map((w) => w.text).join('\n');
    assert.match(text, /ADMIN_TOKEN\) قصيرة/);
    assert.match(text, /WEBHOOK_ALLOW_PRIVATE_TARGETS=1 مفعّل/);
    process.env.ADMIN_TOKEN = saved;
    delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
    const ok = (await call('GET', '/api/admin/system-status')).body.warnings.map((w) => w.text).join('\n');
    assert.doesNotMatch(ok, /قصيرة|WEBHOOK_ALLOW_PRIVATE_TARGETS/);
});

/* ---------------- 9. "Talk to a person" alerts from the website chat ---------------- */

test('website "talk to a person" alerts are capped per session and per visitor address', (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    const { makeHumanAlertGuard } = require('../src/server');
    const guard = makeHumanAlertGuard();
    assert.equal(guard.allow('s1', '198.51.100.9'), true);
    assert.equal(guard.allow('s1', '198.51.100.9'), false, 'same session again soon: no second alert');
    assert.equal(guard.allow('s2', '198.51.100.9'), true);
    assert.equal(guard.allow('s3', '198.51.100.9'), true);
    assert.equal(guard.allow('s4', '198.51.100.9'), false, 'a 4th session from the same address in a day');
    assert.equal(guard.allow('s5', '203.0.113.4'), true, 'another visitor is not affected');
    t.mock.timers.tick(6 * 3600_000 + 1);
    assert.equal(guard.allow('s1', '203.0.113.4'), true, 'the session may alert again after 6 hours');
    t.mock.timers.tick(24 * 3600_000);
    assert.equal(guard.size(), 0, 'old entries are swept');
    assert.equal(guard.allow('s9', '198.51.100.9'), true, 'the address limit resets after a day');
});
