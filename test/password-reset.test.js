/* Forgotten password by email. No real email is sent: the mail transport is replaced by a recorder. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase, saveSettings } = require('../src/db');
const { createApp } = require('../src/server');
const staff = require('../src/staff');
const totp = require('../src/totp');
const mailer = require('../src/mailer');
const backup = require('../src/backup');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const SMTP = { SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465', SMTP_USER: 'noreply@example.com', SMTP_PASS: 'mail-pass' };

const sent = [];
mailer.setTransportForTests(() => ({ sendMail: async (mail) => { sent.push(mail); return { messageId: 'x' }; } }));

async function start(t, { smtp = true, baseUrl = 'https://calc.example.com' } = {}) {
    for (const k of Object.keys(SMTP)) delete process.env[k];
    if (smtp) Object.assign(process.env, SMTP);
    t.after(() => { for (const k of Object.keys(SMTP)) delete process.env[k]; });
    sent.length = 0;
    const db = openDatabase(':memory:');
    if (baseUrl) saveSettings(db, { public_base_url: baseUrl });
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = OWNER, headers = {}) => {
        const res = await fetch(base + url, {
            method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
            body: body && !['GET', 'DELETE'].includes(method) ? JSON.stringify(body) : undefined
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        return { status: res.status, body: data };
    };
    const login = (username, password, code) => call('POST', '/api/auth/login', { username, password, code }, null);
    return { db, call, login };
}

const waitForMail = async (n = 1) => {
    for (let i = 0; i < 50 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 10));
    return sent;
};
const tokenFrom = (mail) => /#reset=([A-Za-z0-9_-]+)/.exec(mail.text)[1];

test('a staff member resets a forgotten password from an emailed link (once, then it is spent)', async (t) => {
    const { db, call, login } = await start(t);
    const u = staff.create(db, { username: 'salem', display_name: 'سالم', email: 'Salem@Example.com', password: 'old-pass-123', permissions: ['leads'] });
    assert.equal(u.email, 'salem@example.com');
    const before = (await login('salem', 'old-pass-123')).body.token;

    const r = await call('POST', '/api/auth/forgot', { identifier: 'SALEM@example.com' }, null, { Host: 'evil.example.net' });
    assert.equal(r.status, 200);
    assert.match(r.body.message, /إذا كان الحساب موجوداً/);
    const [mail] = await waitForMail();
    assert.equal(mail.to, 'salem@example.com');
    assert.match(mail.text, /https:\/\/calc\.example\.com\/admin#reset=/, 'the link uses the configured address, never the Host header');
    assert.ok(!mail.text.includes('evil.example.net'));
    const token = tokenFrom(mail);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM password_resets WHERE token_hash = ?').get(token).n, 0, 'only a hash of the code is stored');

    assert.equal((await call('POST', '/api/auth/reset', { token, password: 'short' }, null)).status, 400);
    const ok = await call('POST', '/api/auth/reset', { token, password: 'new-pass-456' }, null);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.username, 'salem');
    assert.equal((await call('GET', '/api/admin/me', null, before)).status, 401, 'every earlier session ends');
    assert.equal((await login('salem', 'old-pass-123')).status, 401);
    assert.equal((await login('salem', 'new-pass-456')).status, 200);
    const again = await call('POST', '/api/auth/reset', { token, password: 'another-pass-789' }, null);
    assert.equal(again.status, 400, 'a link works once');
    assert.match(again.body.error, /غير صالح أو منتهي/);

    const actions = (await call('GET', '/api/admin/audit')).body.entries.map((e) => e.action);
    assert.ok(actions.includes('طلب رابط استعادة كلمة المرور'));
    assert.ok(actions.includes('تعيين كلمة مرور جديدة عبر رابط البريد'));
    assert.ok(!JSON.stringify((await call('GET', '/api/admin/audit')).body).includes(token), 'the code is never logged');
});

test('the answer is the same whether or not the account exists; no email without one', async (t) => {
    const { db, call } = await start(t);
    staff.create(db, { username: 'noemail', display_name: 'بدون بريد', password: 'pass-12345', permissions: ['leads'] });
    staff.create(db, { username: 'off', display_name: 'موقوف', email: 'off@example.com', password: 'pass-12345', permissions: ['leads'], active: false });
    const answers = [];
    for (const identifier of ['ghost', 'ghost@example.com', 'noemail', 'off', '']) {
        const r = await call('POST', '/api/auth/forgot', { identifier }, null);
        assert.equal(r.status, 200, identifier);
        answers.push(r.body.message);
    }
    assert.equal(new Set(answers).size, 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sent.length, 0);
});

test('links expire after 30 minutes; a new password or a new email cancels older links', async (t) => {
    const { db, call } = await start(t);
    const u = staff.create(db, { username: 'mariam', display_name: 'مريم', email: 'm@example.com', password: 'pass-12345', permissions: ['leads'] });
    const first = staff.requestReset(db, 'mariam');
    db.prepare("UPDATE password_resets SET expires_at = datetime('now', '-1 minute')").run();
    assert.equal((await call('POST', '/api/auth/reset', { token: first.token, password: 'new-pass-1234' }, null)).status, 400, 'expired');

    const second = staff.requestReset(db, 'mariam');
    await call('PUT', `/api/admin/users/${u.id}`, { password: 'manager-set-123' });
    assert.equal((await call('POST', '/api/auth/reset', { token: second.token, password: 'new-pass-1234' }, null)).status, 400, 'cancelled by a new password');

    const third = staff.requestReset(db, 'mariam');
    await call('PUT', `/api/admin/users/${u.id}`, { email: 'new@example.com' });
    assert.equal((await call('POST', '/api/auth/reset', { token: third.token, password: 'new-pass-1234' }, null)).status, 400, 'cancelled by a new email');
    assert.equal((await call('POST', '/api/auth/reset', { token: 'x'.repeat(43), password: 'new-pass-1234' }, null)).status, 400);
});

test('at most 3 links an hour per account', async (t) => {
    const { db, call } = await start(t);
    staff.create(db, { username: 'khalid', display_name: 'خالد', email: 'k@example.com', password: 'pass-12345', permissions: ['leads'] });
    for (let i = 0; i < 4; i++) assert.equal((await call('POST', '/api/auth/forgot', { identifier: 'khalid' }, null)).status, 200);
    await waitForMail(3);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sent.length, 3);
});

test('after a reset, two-step sign-in is still required', async (t) => {
    const { db, call, login } = await start(t);
    staff.create(db, { username: 'boss', display_name: 'أحمد', email: 'boss@example.com', password: 'boss-pass-12', role: 'manager' });
    const secret = totp.generateSecret();
    db.prepare("UPDATE staff_users SET totp_secret = ? WHERE username = 'boss'").run(secret);
    await call('POST', '/api/auth/forgot', { identifier: 'boss' }, null);
    const [mail] = await waitForMail();
    const r = await call('POST', '/api/auth/reset', { token: tokenFrom(mail), password: 'boss-new-pass' }, null);
    assert.equal(r.status, 200);
    assert.equal(r.body.totp_enabled, true);
    const noCode = await login('boss', 'boss-new-pass');
    assert.equal(noCode.status, 401);
    assert.equal(noCode.body.need_code, true, 'the email alone never opens a manager account');
    assert.equal((await login('boss', 'boss-new-pass', totp.codeAt(secret, totp.currentStep()))).status, 200);
});

test('without mail settings or the public address, the reset is refused and the panel says why', async (t) => {
    const a = await start(t, { smtp: false });
    const r = await a.call('POST', '/api/auth/forgot', { identifier: 'x' }, null);
    assert.equal(r.status, 503);
    assert.match(r.body.error, /غير مفعّلة/);

    const b = await start(t, { baseUrl: '' });
    assert.equal((await b.call('POST', '/api/auth/forgot', { identifier: 'x' }, null)).status, 503);
    const warn = (await b.call('GET', '/api/admin/system-status')).body.warnings.map((w) => w.text).join('\n');
    assert.match(warn, /الرابط العام للنظام» فارغ/);
});

test('account emails are validated, unique, and kept in backups', async (t) => {
    const { db, call } = await start(t);
    assert.equal((await call('POST', '/api/admin/users', { username: 'a1a', display_name: 'أ', email: 'not-an-email', password: 'pass-12345', permissions: ['leads'] })).status, 400);
    assert.equal((await call('POST', '/api/admin/users', { username: 'a1a', display_name: 'أ', email: 'same@example.com', password: 'pass-12345', permissions: ['leads'] })).status, 201);
    const dup = await call('POST', '/api/admin/users', { username: 'b2b', display_name: 'ب', email: 'SAME@example.com', password: 'pass-12345', permissions: ['leads'] });
    assert.equal(dup.status, 400);
    assert.match(dup.body.error, /مستخدم لحساب آخر/);
    const file = await backup.exportWorkbook(db);
    db.prepare("UPDATE staff_users SET email = NULL").run();
    await backup.restoreWorkbook(db, file);
    assert.equal(db.prepare("SELECT email FROM staff_users WHERE username = 'a1a'").get().email, 'same@example.com');
});
