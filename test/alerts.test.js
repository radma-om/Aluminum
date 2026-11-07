/* Failure alerts. No real email is sent: the mail transport is replaced by a recorder. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase, saveSettings } = require('../src/db');
const { createApp } = require('../src/server');
const alerts = require('../src/alerts');
const mailer = require('../src/mailer');
const webhooks = require('../src/webhooks');
const staff = require('../src/staff');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const ENV = { SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465', SMTP_USER: 'noreply@example.com', SMTP_PASS: 'mail-pass', ALERT_EMAIL_TO: 'owner@example.com' };

const sent = [];
mailer.setTransportForTests(() => ({ sendMail: async (mail) => { sent.push(mail); return { messageId: 'x' }; } }));

function setup(t, env = ENV) {
    for (const k of [...Object.keys(ENV), 'BACKUP_EMAIL_TO']) delete process.env[k];
    Object.assign(process.env, env);
    t.after(() => { for (const k of [...Object.keys(ENV), 'BACKUP_EMAIL_TO']) delete process.env[k]; });
    sent.length = 0;
    const db = openDatabase(':memory:');
    saveSettings(db, { public_base_url: 'https://calc.example.com' });
    return db;
}
const settle = () => new Promise((r) => setTimeout(r, 20));

test('one failure is not an alert; a repeated failure is, once, then "back to normal"', async (t) => {
    const db = setup(t);
    alerts.fail(db, 'ai', 'insufficient_quota');
    await settle();
    assert.equal(sent.length, 0, 'a single blip stays quiet');
    assert.equal(alerts.list(db)[0].alerting, false);

    alerts.fail(db, 'ai', 'insufficient_quota: You exceeded your current quota');
    await settle();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'owner@example.com');
    assert.match(sent[0].subject, /عطل: المساعد الذكي/);
    assert.match(sent[0].text, /exceeded your current quota/);
    assert.match(sent[0].text, /OPENAI_API_KEY/, 'says what to check');
    assert.match(sent[0].text, /https:\/\/calc\.example\.com\/admin/);

    for (let i = 0; i < 5; i++) alerts.fail(db, 'ai', 'still failing');
    await settle();
    assert.equal(sent.length, 1, 'no flood while it keeps failing');

    alerts.ok(db, 'ai');
    await settle();
    assert.equal(sent.length, 2);
    assert.match(sent[1].subject, /عاد للعمل: المساعد الذكي/);
    assert.equal(alerts.list(db)[0].state, 'ok');
    alerts.ok(db, 'ai');
    await settle();
    assert.equal(sent.length, 2, 'only one recovery message');
});

test('a fault that lasts gets a reminder every 6 hours; a quiet recovery sends nothing', async (t) => {
    const db = setup(t);
    alerts.fail(db, 'backup_local', 'ENOSPC: no space left on device');
    await settle();
    assert.equal(sent.length, 1, 'backups alert on the first failure');
    db.prepare("UPDATE system_alerts SET notified_at = datetime('now', '-7 hours'), window_start = datetime('now', '-30 minutes')").run();
    alerts.fail(db, 'backup_local', 'ENOSPC again');
    await settle();
    assert.equal(sent.length, 2);
    assert.match(sent[1].subject, /ما زال/);

    // Below the threshold and then fixed: never mentioned by email
    alerts.fail(db, 'mazbot_reply', 'HTTP 500');
    alerts.ok(db, 'mazbot_reply');
    await settle();
    assert.equal(sent.length, 2);
});

test('failures far apart do not add up', async (t) => {
    const db = setup(t);
    alerts.fail(db, 'ai', 'timeout');
    db.prepare("UPDATE system_alerts SET window_start = datetime('now', '-2 hours')").run(); // the AI window is 30 minutes
    alerts.fail(db, 'ai', 'timeout');
    await settle();
    assert.equal(sent.length, 0);
    assert.equal(alerts.list(db)[0].fail_count, 1);
});

test('each webhook has its own alert, named in the message', async (t) => {
    const db = setup(t);
    process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = '1';
    t.after(() => { delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS; });
    const dead = http.createServer((req, res) => { res.statusCode = 500; res.end(); });
    await new Promise((r) => dead.listen(0, '127.0.0.1', r));
    t.after(() => dead.close());
    const url = `http://127.0.0.1:${dead.address().port}/hook`;
    db.prepare("INSERT INTO webhooks (name, url, events, active) VALUES ('n8n المبيعات', ?, '*', 1)").run(url);
    for (let i = 0; i < 3; i++) await webhooks.emit(db, 'quote.created', { id: i });
    await settle();
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /Webhook «n8n المبيعات»/);
    assert.match(sent[0].text, /HTTP 500/);
});

test('without mail the faults still show in the panel; with BACKUP_EMAIL_TO only, alerts go there', async (t) => {
    const db = setup(t, {});
    alerts.fail(db, 'backup_local', 'disk full');
    await settle();
    assert.equal(sent.length, 0);
    assert.equal(alerts.status(db).email_ready, false);
    assert.equal(alerts.list(db)[0].alerting, true);
    assert.throws(() => alerts.sendTest(db), /SMTP/);

    const db2 = setup(t, { ...ENV, ALERT_EMAIL_TO: '', BACKUP_EMAIL_TO: 'backup@example.com' });
    alerts.fail(db2, 'backup_local', 'disk full');
    await settle();
    assert.equal(sent[0].to, 'backup@example.com');
});

test('managers see faults in the system status and send a test alert; staff cannot', async (t) => {
    const db = setup(t);
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, token = OWNER) => {
        const res = await fetch(base + url, { method, headers: { Authorization: 'Bearer ' + token } });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    alerts.fail(db, 'mazbot_sales', 'عرض Q-1: فشل 2/2: template not approved');
    alerts.fail(db, 'mazbot_sales', 'عرض Q-2: فشل 2/2: template not approved');
    await settle();
    const warnings = (await call('GET', '/api/admin/system-status')).body.warnings;
    assert.ok(warnings.some((w) => w.level === 'danger' && /عطل قائم: تنبيهات الطلبات/.test(w.text)));
    const status = (await call('GET', '/api/admin/alerts')).body;
    assert.equal(status.email_ready, true);
    assert.equal(status.alerts[0].alerting, true);
    assert.match(status.alerts[0].hint, /MAZBOT_TEMPLATE_ID/);

    sent.length = 0;
    const r = await call('POST', '/api/admin/alerts/test');
    assert.equal(r.status, 200);
    assert.match(sent[0].subject, /تجربة تنبيهات الأعطال/);

    staff.create(db, { username: 'salem', display_name: 'سالم', password: 'salem-pass-1', permissions: Object.keys(staff.SECTIONS) });
    const token = (await (await fetch(base + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'salem', password: 'salem-pass-1' })
    })).json()).token;
    assert.equal((await call('GET', '/api/admin/alerts', token)).status, 403);
    assert.equal((await call('POST', '/api/admin/alerts/test', token)).status, 403);
});

test('an alert that cannot be stored or emailed never breaks the work it reports on', async (t) => {
    const db = setup(t);
    mailer.setTransportForTests(() => ({ sendMail: async () => { throw new Error('SMTP down'); } }));
    t.after(() => mailer.setTransportForTests(() => ({ sendMail: async (mail) => { sent.push(mail); return { messageId: 'x' }; } })));
    assert.doesNotThrow(() => { alerts.fail(db, 'backup_local', 'x'); alerts.ok(db, 'backup_local'); });
    db.close();
    assert.doesNotThrow(() => alerts.fail(db, 'ai', 'x'), 'a closed database is logged, not thrown');
    await settle();
});
