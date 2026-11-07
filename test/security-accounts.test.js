/* Two-step sign-in, the activity log and the backup copy sent by email.
   No real email is sent: the mail transport is replaced by a recorder. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const ExcelJS = require('exceljs');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/server');
const staff = require('../src/staff');
const totp = require('../src/totp');
const backup = require('../src/backup');
const offsite = require('../src/offsite');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;

async function start(t, db = openDatabase(':memory:')) {
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = OWNER) => {
        const res = await fetch(base + url, {
            method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
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

const secretOf = (db, username) => db.prepare('SELECT totp_secret FROM staff_users WHERE username = ?').get(username).totp_secret;
const codeNow = (secret, offsetSteps = 0) => totp.codeAt(secret, totp.currentStep() + offsetSteps);

/* Sets up two-step sign-in through the API, as the panel does; returns the secret */
async function enroll(call, token) {
    const setup = await call('POST', '/api/admin/me/2fa/setup', {}, token);
    assert.equal(setup.status, 200, JSON.stringify(setup.body));
    assert.match(setup.body.uri, /^otpauth:\/\/totp\/Radma:/);
    assert.match(setup.body.qr_svg, /^<svg/);
    const secret = setup.body.secret.replace(/\s/g, '');
    const wrong = await call('POST', '/api/admin/me/2fa/enable', { code: codeNow(secret) === '000000' ? '111111' : '000000' }, token);
    assert.equal(wrong.status, 400);
    const ok = await call('POST', '/api/admin/me/2fa/enable', { code: codeNow(secret) }, token);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.user.totp_enabled, true);
    return secret;
}

/* ------------------------------ Codes ------------------------------ */

test('six-digit codes follow RFC 6238; each code works once, within ±30 seconds', () => {
    const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
    // RFC 6238 test vectors (last 6 digits)
    assert.equal(totp.codeAt(secret, Math.floor(59 / 30)), '287082');
    assert.equal(totp.codeAt(secret, Math.floor(1111111109 / 30)), '081804');
    assert.equal(totp.codeAt(secret, Math.floor(2000000000 / 30)), '279037');
    const now = 1_700_000_000_000;
    const step = totp.currentStep(now);
    assert.equal(totp.verify(secret, totp.codeAt(secret, step), { now }), step);
    assert.equal(totp.verify(secret, totp.codeAt(secret, step - 1), { now }), step - 1, 'the previous code (slow typing)');
    assert.equal(totp.verify(secret, totp.codeAt(secret, step - 2), { now }), null, 'older codes expire');
    assert.equal(totp.verify(secret, totp.codeAt(secret, step), { now, lastStep: step }), null, 'a used code cannot be replayed');
    assert.equal(totp.verify(secret, '12345', { now }), null);
    assert.equal(totp.verify(secret, 'abcdef', { now }), null);
    assert.equal(totp.base32Decode(totp.base32Encode(Buffer.from('hello'))).toString(), 'hello');
});

/* ------------------------------ Two-step sign-in ------------------------------ */

test('an employee turns on two-step sign-in; then the password alone is not enough', async (t) => {
    const { db, call, login } = await start(t);
    staff.create(db, { username: 'salem', display_name: 'سالم', password: 'salem-pass-1', permissions: ['leads'] });
    const first = await login('salem', 'salem-pass-1');
    assert.equal(first.status, 200);
    assert.equal(first.body.user.totp_enabled, false);
    const other = (await login('salem', 'salem-pass-1')).body.token; // another device
    const secret = await enroll(call, first.body.token);
    assert.equal((await call('GET', '/api/admin/me', null, first.body.token)).status, 200, 'this device stays signed in');
    assert.equal((await call('GET', '/api/admin/me', null, other)).status, 401, 'other devices sign out');

    const noCode = await login('salem', 'salem-pass-1');
    assert.equal(noCode.status, 401);
    assert.equal(noCode.body.need_code, true);
    assert.equal(noCode.body.token, undefined);
    assert.equal((await login('salem', 'wrong-pass', codeNow(secret))).status, 401, 'the code never replaces the password');
    const bad = await login('salem', 'salem-pass-1', codeNow(secret) === '000000' ? '111111' : '000000');
    assert.equal(bad.status, 401);
    assert.equal(bad.body.need_code, true);

    db.prepare('UPDATE staff_users SET totp_last_step = 0').run(); // the enable step used the current code
    const code = codeNow(secret);
    const ok = await login('salem', 'salem-pass-1', code);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.token);
    assert.equal((await login('salem', 'salem-pass-1', code)).status, 401, 'the same code cannot be used twice');

    // Turning it off needs the password; managers cannot turn it off
    assert.equal((await call('POST', '/api/admin/me/2fa/disable', { password: 'nope-nope' }, ok.body.token)).status, 400);
    const off = await call('POST', '/api/admin/me/2fa/disable', { password: 'salem-pass-1' }, ok.body.token);
    assert.equal(off.status, 200);
    assert.equal(off.body.user.totp_enabled, false);
    assert.equal((await login('salem', 'salem-pass-1')).status, 200);
});

test('wrong codes for one account are limited to 5 in 15 minutes, from any address', async (t) => {
    const { db, login } = await start(t);
    staff.create(db, { username: 'mariam', display_name: 'مريم', password: 'mariam-pass-1', permissions: ['leads'] });
    const secret = totp.generateSecret();
    db.prepare("UPDATE staff_users SET totp_secret = ? WHERE username = 'mariam'").run(secret);
    const wrong = codeNow(secret) === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) assert.equal((await login('mariam', 'mariam-pass-1', wrong)).status, 401);
    const locked = await login('mariam', 'mariam-pass-1', codeNow(secret));
    assert.equal(locked.status, 429, 'even the right code waits once the account is locked');
    assert.match(locked.body.error, /15 دقيقة/);
});

test('a manager account must set up two-step sign-in before using the panel', async (t) => {
    const { db, call, login } = await start(t);
    staff.create(db, { username: 'boss', display_name: 'أحمد', password: 'boss-pass-12', role: 'manager' });
    const r = await login('boss', 'boss-pass-12');
    assert.equal(r.status, 200);
    assert.equal(r.body.user.must_setup_2fa, true);
    const token = r.body.token;
    assert.equal((await call('GET', '/api/admin/me', null, token)).body.user.must_setup_2fa, true);
    for (const url of ['/api/admin/dashboard', '/api/admin/users', '/api/admin/settings', '/api/admin/audit']) {
        const res = await call('GET', url, null, token);
        assert.equal(res.status, 403, url);
        assert.equal(res.body.need_2fa_setup, true, url);
    }
    assert.equal((await call('POST', '/api/admin/me/2fa/disable', { password: 'boss-pass-12' }, token)).status, 403);
    await enroll(call, token);
    assert.equal((await call('GET', '/api/admin/dashboard', null, token)).status, 200);
    assert.equal((await call('GET', '/api/admin/users', null, token)).status, 200);
    const off = await call('POST', '/api/admin/me/2fa/disable', { password: 'boss-pass-12' }, token);
    assert.equal(off.status, 400, 'required for managers');
    // The general manager (ADMIN_TOKEN) has no account to set up
    assert.equal((await call('POST', '/api/admin/me/2fa/setup', {})).status, 400);
});

test('a manager resets the two-step sign-in of an employee who lost their phone', async (t) => {
    const { db, call, login } = await start(t);
    const u = staff.create(db, { username: 'khalid', display_name: 'خالد', password: 'khalid-pass-1', permissions: ['leads'] });
    const token = (await login('khalid', 'khalid-pass-1')).body.token;
    await enroll(call, token);
    assert.equal((await call('GET', '/api/admin/users')).body.users[0].totp_enabled, true);
    const r = await call('PUT', `/api/admin/users/${u.id}`, { reset_2fa: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.totp_enabled, false);
    assert.equal((await call('GET', '/api/admin/me', null, token)).status, 401, 'signed out everywhere');
    assert.equal((await login('khalid', 'khalid-pass-1')).status, 200, 'password alone until set up again');
});

test('ADMIN_TOKEN_LOGIN=off stops the general manager password, only once a two-step manager exists', async (t) => {
    process.env.ADMIN_TOKEN_LOGIN = 'off';
    t.after(() => { delete process.env.ADMIN_TOKEN_LOGIN; });
    const { db, call, login } = await start(t);
    // No manager account yet: ignored (otherwise nobody could get in), and the panel says so
    assert.equal((await call('GET', '/api/admin/me')).status, 200);
    const warn = (await call('GET', '/api/admin/system-status')).body.warnings.map((w) => w.text).join('\n');
    assert.match(warn, /ADMIN_TOKEN_LOGIN=off لم يُطبَّق/);

    staff.create(db, { username: 'boss', display_name: 'أحمد', password: 'boss-pass-12', role: 'manager' });
    await enroll(call, (await login('boss', 'boss-pass-12')).body.token);
    const refused = await call('GET', '/api/admin/me');
    assert.equal(refused.status, 401);
    assert.match(refused.body.error, /موقوف/);
    db.prepare('UPDATE staff_users SET totp_last_step = 0').run();
    const secret = secretOf(db, 'boss');
    const boss = await login('boss', 'boss-pass-12', codeNow(secret));
    assert.equal(boss.status, 200);
    assert.equal((await call('GET', '/api/admin/dashboard', null, boss.body.token)).status, 200);
});

test('backups never carry two-step secrets, and a restore keeps each account\'s current setup', async (t) => {
    const { db, call } = await start(t);
    staff.create(db, { username: 'salem', display_name: 'سالم', password: 'salem-pass-1', permissions: ['leads'] });
    const secret = totp.generateSecret();
    db.prepare("UPDATE staff_users SET totp_secret = ?, totp_pending = 'PENDINGSECRET' WHERE username = 'salem'").run(secret);
    const file = await backup.exportWorkbook(db);
    assert.equal(file.includes(Buffer.from(secret)), false);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file);
    const header = [];
    wb.getWorksheet('حسابات الموظفين').getRow(1).eachCell((c) => header.push(c.value));
    assert.ok(header.includes('password_hash'));
    for (const col of ['totp_secret', 'totp_pending', 'totp_last_step']) assert.ok(!header.includes(col), col);

    const r = await call('POST', '/api/admin/restore', null); // (needs a file — checked below via the module)
    assert.equal(r.status, 400);
    await backup.restoreWorkbook(db, file);
    assert.equal(secretOf(db, 'salem'), secret, 'restore keeps the current two-step secret');
});

/* ------------------------------ Activity log ------------------------------ */

test('the activity log records who changed what, before → after, without secrets', async (t) => {
    const { db, call, login } = await start(t);
    const lmeBefore = (await call('GET', '/api/admin/settings')).body.lme;
    assert.equal((await call('PUT', '/api/admin/settings', { lme: lmeBefore + 100 })).status, 200);
    await call('PUT', '/api/admin/settings', { lme: lmeBefore + 100 }); // unchanged: not logged

    const p = await call('POST', '/api/admin/products', { category: 'accessory', name: 'قفل تجربة', purchase_price: 2 });
    assert.equal(p.status, 201);
    await call('PUT', `/api/admin/products/${p.body.id}`, { purchase_price: 3.5 });
    await call('DELETE', `/api/admin/products/${p.body.id}`);
    await call('POST', '/api/admin/users', { username: 'salem', display_name: 'سالم', password: 'very-secret-pass', permissions: ['leads'] });
    await call('PUT', '/api/admin/products/999999', { purchase_price: 1 }); // 404: nothing changed, not logged
    await login('salem', 'wrong-password');
    const salem = (await login('salem', 'very-secret-pass')).body.token;
    await call('GET', '/api/admin/backup.xlsx');
    await call('GET', '/api/admin/me');
    await call('GET', '/api/admin/me'); // the same address again soon: recorded once

    const all = db.prepare('SELECT * FROM audit_log ORDER BY id').all();
    const text = JSON.stringify(all);
    assert.ok(!text.includes('very-secret-pass'), 'passwords are never stored');
    assert.ok(!text.includes('scrypt$'), 'nor password hashes');

    const { entries } = (await call('GET', '/api/admin/audit')).body;
    const find = (action) => entries.find((e) => e.action === action);
    const settings = entries.filter((e) => e.action === 'تعديل الإعدادات');
    assert.equal(settings.length, 1);
    assert.deepEqual(settings[0].details.changes.lme, [lmeBefore, lmeBefore + 100]);
    assert.equal(settings[0].actor, 'المدير العام (كلمة مرور الإدارة)');
    assert.ok(find('إضافة منتج'));
    assert.deepEqual(find('تعديل منتج').details.changes.purchase_price, [2, 3.5]);
    assert.equal(find('حذف منتج').details.deleted.name, 'قفل تجربة');
    assert.equal(find('إضافة حساب موظف').details.request.password, '***');
    assert.equal(find('محاولة دخول فاشلة (كلمة مرور خاطئة)').actor, 'salem');
    assert.equal(find('تسجيل دخول').actor, 'سالم (salem)');
    assert.ok(find('تنزيل نسخة احتياطية'));
    assert.equal(entries.filter((e) => e.action === 'فتح لوحة الإدارة بكلمة مرور الإدارة العامة').length, 1);
    assert.equal(entries.filter((e) => e.action === 'تعديل منتج').length, 1, 'refused changes are not logged');

    // Filters and paging
    const lme = (await call('GET', '/api/admin/audit?q=lme')).body.entries;
    assert.ok(lme.length >= 1 && lme.every((e) => JSON.stringify(e).toLowerCase().includes('lme')));
    const page = (await call('GET', '/api/admin/audit?limit=2')).body;
    assert.equal(page.entries.length, 2);
    assert.equal(page.more, true);
    const next = (await call('GET', `/api/admin/audit?limit=2&before_id=${page.entries[1].id}`)).body.entries;
    assert.ok(next[0].id < page.entries[1].id);

    // Employees' changes carry their name; they cannot read the log
    const lead = Number(db.prepare("INSERT INTO leads (contact_key) VALUES ('tel:96899000000')").run().lastInsertRowid);
    assert.equal((await call('POST', `/api/admin/leads/${lead}/notes`, { kind: 'call', text: 'اتصلت بالعميل' }, salem)).status, 201);
    const note = (await call('GET', '/api/admin/audit')).body.entries.find((e) => e.action === 'إضافة تقرير متابعة');
    assert.equal(note.actor, 'سالم (salem)');
    assert.equal(note.details.request.text, 'اتصلت بالعميل');
    assert.equal((await call('GET', '/api/admin/audit', null, salem)).status, 403);
});

/* ------------------------------ Backup by email ------------------------------ */

const SMTP_VARS = { SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465', SMTP_USER: 'backup@example.com', SMTP_PASS: 'mail-pass', BACKUP_EMAIL_TO: 'owner@example.com, second@example.com' };

test('without mail settings the panel warns that backups live only on this server', async (t) => {
    for (const k of Object.keys(SMTP_VARS)) delete process.env[k];
    const { call } = await start(t);
    const warn = (await call('GET', '/api/admin/system-status')).body.warnings.map((w) => w.text).join('\n');
    assert.match(warn, /على نفس الخادم فقط/);
    assert.equal((await call('GET', '/api/admin/offsite-backup')).body.configured, false);
    const r = await call('POST', '/api/admin/offsite-backup');
    assert.equal(r.status, 502);
    assert.match(r.body.error, /غير مضبوط/);
});

test('the daily backup is emailed as an Excel file; failures are logged and shown', async (t) => {
    Object.assign(process.env, SMTP_VARS);
    const sent = [];
    let fail = null;
    offsite.setTransportForTests((cfg) => ({
        sendMail: async (mail) => {
            if (fail) throw new Error(fail);
            sent.push({ cfg, mail });
            return { messageId: 'x' };
        }
    }));
    t.after(() => { for (const k of Object.keys(SMTP_VARS)) delete process.env[k]; });
    const { db, call, login } = await start(t);
    staff.create(db, { username: 'salem', display_name: 'سالم', password: 'salem-pass-1', permissions: Object.keys(staff.SECTIONS) });

    const r = await call('POST', '/api/admin/offsite-backup');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(sent.length, 1);
    const { cfg, mail } = sent[0];
    assert.equal(cfg.secure, true, 'port 465 uses SSL');
    assert.equal(mail.to, 'owner@example.com, second@example.com');
    assert.match(mail.subject, /نسخة احتياطية/);
    assert.match(mail.attachments[0].filename, /^radma-backup-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(mail.attachments[0].content);
    assert.ok(wb.getWorksheet('الإعدادات'), 'a real backup that can be restored');
    assert.ok(!JSON.stringify(mail).includes('mail-pass'));

    fail = 'Invalid login: 535 Authentication failed';
    const bad = await call('POST', '/api/admin/offsite-backup');
    assert.equal(bad.status, 502);
    assert.match(bad.body.error, /535/);
    const status = (await call('GET', '/api/admin/offsite-backup')).body;
    assert.equal(status.configured, true);
    assert.equal(status.last.ok, false);
    assert.ok(status.last_ok_at, 'the last good copy is still shown');
    assert.equal(status.history.length, 2);

    // Failing for more than two days: a red warning
    db.prepare("UPDATE offsite_backups SET at = datetime('now', '-3 days') WHERE ok = 1").run();
    const warn = (await call('GET', '/api/admin/system-status')).body.warnings;
    assert.ok(warn.some((w) => w.level === 'danger' && /أكثر من يومين/.test(w.text)));
    assert.ok((await call('GET', '/api/admin/audit')).body.entries.some((e) => e.action === 'إرسال نسخة احتياطية بالبريد'));

    // Managers only, even with every section
    const token = (await login('salem', 'salem-pass-1')).body.token;
    assert.equal((await call('GET', '/api/admin/offsite-backup', null, token)).status, 403);
    assert.equal((await call('POST', '/api/admin/offsite-backup', {}, token)).status, 403);
});
