/* Versions and the manager's notices to everyone using the panel (forced update, stop, info):
   who may send them, what each account sees, the 🔔 on the phones, and the version history. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/server');
const staff = require('../src/staff');
const push = require('../src/push');
const changelog = require('../src/changelog');
const { version } = require('../package.json');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const sent = [];
push.setSenderForTests(async (sub, payload) => { sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }); });
const device = (name) => ({ endpoint: `https://fcm.googleapis.com/send/${name}`, keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } });

async function start(t) {
    sent.length = 0;
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = OWNER) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const type = res.headers.get('content-type') || '';
        return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
    };
    const login = async (u) => (await call('POST', '/api/auth/login', { username: u, password: 'pass-12345' }, null)).body.token;
    return { db, call, login };
}

test('the version history starts with the version being released', () => {
    assert.equal(changelog[0].version, version, 'add an entry to src/changelog.js for this version');
    for (const v of changelog) {
        assert.match(v.version, /^\d+\.\d+\.\d+$/);
        assert.ok(v.ar.length && v.ar.length === v.en.length, `${v.version}: the same points in Arabic and English`);
    }
});

test('the page knows its own version; every account can read the status and the history', async (t) => {
    const { db, call, login } = await start(t);
    const page = await call('GET', '/admin', null, null);
    assert.match(page.body, new RegExp(`<meta name="app-version" content="${version.replace(/\./g, '\\.')}">`));
    assert.match(page.body, /admin-updates\.js\?v=/);
    staff.create(db, { username: 'fahad', display_name: 'فهد', password: 'pass-12345', role: 'technician' });
    const tech = await login('fahad');
    const st = await call('GET', '/api/admin/me/app-status', null, tech);
    assert.equal(st.status, 200);
    assert.equal(st.body.version, version);
    assert.deepEqual(st.body.notices, []);
    assert.equal((await call('GET', '/api/admin/me/changelog', null, tech)).body.versions[0].version, version);
    // Sending notices is for managers only
    assert.equal((await call('POST', '/api/admin/app-notices', { kind: 'info', title: 'x' }, tech)).status, 403);
    assert.equal((await call('GET', '/api/admin/app-notices', null, tech)).status, 403);
});

test('a manager sends notices: everyone sees them, the phones get them, a forced update / a stop stays until ended', async (t) => {
    const { db, call, login } = await start(t);
    staff.create(db, { username: 'sara', display_name: 'سارة', password: 'pass-12345', permissions: ['quotes'] });
    staff.create(db, { username: 'fahad', display_name: 'فهد', password: 'pass-12345', role: 'technician' });
    const sara = await login('sara');
    const fahad = await login('fahad');
    await call('POST', '/api/admin/me/push', { subscription: device('sara-phone') }, sara);
    await call('POST', '/api/admin/me/push', { subscription: device('fahad-phone') }, fahad);

    assert.equal((await call('POST', '/api/admin/app-notices', { kind: 'nope', title: 'x' })).status, 400);
    const force = await call('POST', '/api/admin/app-notices', { kind: 'force', title: 'تحديث مهم', body: 'حدّث التطبيق الآن' });
    assert.equal(force.status, 201);
    assert.equal(force.body.sent, 2, 'both phones');
    assert.ok(sent.every((s) => s.title.includes('تحديث مهم') && s.tag === 'app-notice-force'));

    await call('POST', '/api/admin/app-notices', { kind: 'maintenance', title: 'صيانة', body: 'نعود بعد ساعة' });
    await call('POST', '/api/admin/app-notices', { kind: 'info', title: 'اجتماع', body: 'غداً 9 صباحاً' });
    const seen = (await call('GET', '/api/admin/me/app-status', null, fahad)).body.notices.map((n) => n.kind).sort();
    assert.deepEqual(seen, ['force', 'info', 'maintenance']);

    // A second forced update replaces the first
    const force2 = await call('POST', '/api/admin/app-notices', { kind: 'force', title: 'تحديث آخر' });
    const now = (await call('GET', '/api/admin/me/app-status', null, sara)).body.notices.filter((n) => n.kind === 'force');
    assert.deepEqual(now.map((n) => n.id), [force2.body.notice.id]);

    // The manager ends the stop: it is gone for everyone
    const stop = (await call('GET', '/api/admin/app-notices')).body.notices.find((n) => n.kind === 'maintenance');
    assert.equal((await call('POST', `/api/admin/app-notices/${stop.id}/end`)).body.notice.active, false);
    assert.ok(!(await call('GET', '/api/admin/me/app-status', null, sara)).body.notices.some((n) => n.kind === 'maintenance'));
    // …and the activity log has it
    const log = (await call('GET', '/api/admin/audit')).body;
    const actions = (log.entries || log.rows || log).map((e) => e.action);
    assert.ok(actions.some((a) => /إرسال إشعار للموظفين/.test(a)) && actions.some((a) => /إنهاء إشعار للموظفين/.test(a)));
});

test('an info notice older than a week is no longer shown; a forced update is shown until ended', async (t) => {
    const { db, call } = await start(t);
    await call('POST', '/api/admin/app-notices', { kind: 'info', title: 'قديم' });
    await call('POST', '/api/admin/app-notices', { kind: 'force', title: 'إجباري' });
    db.prepare("UPDATE app_notices SET created_at = datetime('now', '-8 days')").run();
    assert.deepEqual((await call('GET', '/api/admin/me/app-status')).body.notices.map((n) => n.kind), ['force']);
});
