/* Follow-up reminders and the weekly report. No real email is sent: the transport is a recorder. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase, saveSettings } = require('../src/db');
const { createApp } = require('../src/server');
const leads = require('../src/leads');
const staff = require('../src/staff');
const followup = require('../src/followup');
const mailer = require('../src/mailer');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const SMTP = { SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465', SMTP_USER: 'noreply@example.com', SMTP_PASS: 'mail-pass' };
const sent = [];
mailer.setTransportForTests(() => ({ sendMail: async (mail) => { sent.push(mail); return { messageId: 'x' }; } }));

function setup(t, env = SMTP) {
    for (const k of [...Object.keys(SMTP), 'BACKUP_EMAIL_TO', 'ALERT_EMAIL_TO']) delete process.env[k];
    Object.assign(process.env, env);
    t.after(() => { for (const k of [...Object.keys(SMTP), 'BACKUP_EMAIL_TO', 'ALERT_EMAIL_TO']) delete process.env[k]; });
    sent.length = 0;
    const db = openDatabase(':memory:');
    saveSettings(db, { public_base_url: 'https://calc.example.com' });
    return db;
}

const TODAY = leads.localToday();
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().replace('T', ' ').slice(0, 19);
const dayOffset = (n) => new Date(Date.parse(TODAY + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
function lead(db, { name, status = 'following', assigned = null, next = null, created = 10, staffAt = null }) {
    const id = Number(db.prepare(`INSERT INTO leads (contact_key, channel, name, phone, status, assigned_to, next_follow_up, created_at, last_activity_at, last_staff_at)
                                  VALUES (?, 'whatsapp', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('tel:' + Math.random(), name, '9689' + Math.floor(Math.random() * 1e7), status, assigned, next, daysAgo(created), daysAgo(0), staffAt === null ? null : daysAgo(staffAt)).lastInsertRowid);
    return id;
}

test('who needs following up: a date that came or passed, or nobody followed up for N days', (t) => {
    const db = setup(t);
    const due = lead(db, { name: 'موعده اليوم', next: TODAY });
    const overdue = lead(db, { name: 'فات موعده', next: dayOffset(-2) });
    const planned = lead(db, { name: 'موعد قادم', next: dayOffset(3), staffAt: 20 });
    const stale = lead(db, { name: 'منسي', staffAt: 5 });
    const fresh = lead(db, { name: 'تابعناه أمس', staffAt: 1 });
    const newcomer = lead(db, { name: 'جديد اليوم', status: 'new', created: 0 });
    const closed = lead(db, { name: 'تم البيع', status: 'won', staffAt: 30 });
    const list = leads.needingAttention(db, { staleDays: 3 });
    const byId = Object.fromEntries(list.map((l) => [l.id, l.attention]));
    assert.equal(byId[due].reason, 'due');
    assert.equal(byId[overdue].reason, 'overdue');
    assert.equal(byId[stale].reason, 'stale');
    assert.equal(byId[stale].days, 5);
    for (const id of [planned, fresh, newcomer, closed]) assert.equal(byId[id], undefined);
    assert.equal(leads.needingAttention(db, { staleDays: 7 }).some((l) => l.id === stale), false, 'the number of days is a setting');
});

test('writing a report, replying or setting a new date takes the customer off the list', (t) => {
    const db = setup(t);
    const a = lead(db, { name: 'أ', staffAt: 9 });
    const b = lead(db, { name: 'ب', staffAt: 9 });
    const c = lead(db, { name: 'ج', staffAt: 9 });
    const d = lead(db, { name: 'د', staffAt: 9 });
    leads.addNote(db, a, { kind: 'report', text: 'اتصلت به' }, 'سالم');
    leads.staffMessage(db, b, 'مرحباً، هل ما زلت مهتماً؟', 'سالم');
    leads.update(db, c, { next_follow_up: dayOffset(5) }, 'سالم');
    const ids = leads.needingAttention(db, { staleDays: 3 }).map((l) => l.id);
    assert.deepEqual(ids, [d]);
});

test('each employee gets their own list; customers of nobody go to the managers', (t) => {
    const db = setup(t);
    staff.create(db, { username: 'salem', display_name: 'سالم', email: 'salem@example.com', password: 'pass-12345', permissions: ['leads'] });
    staff.create(db, { username: 'noemail', display_name: 'بلا بريد', password: 'pass-12345', permissions: ['leads'] });
    staff.create(db, { username: 'boss', display_name: 'أحمد', email: 'boss@example.com', password: 'pass-12345', role: 'manager' });
    lead(db, { name: 'عميل سالم', assigned: 'سالم', next: TODAY });
    lead(db, { name: 'عميل سالم 2', assigned: 'سالم', staffAt: 6 });
    lead(db, { name: 'بلا موظف', staffAt: 6 });
    lead(db, { name: 'موظفه بلا بريد', assigned: 'بلا بريد', next: dayOffset(-1) });
    const digests = followup.buildDigests(db);
    const salem = digests.find((d) => d.name === 'سالم');
    const boss = digests.find((d) => d.name === 'أحمد');
    assert.equal(salem.items.length, 2);
    assert.equal(salem.others.length, 0);
    assert.deepEqual(boss.others.map((l) => l.name).sort(), ['بلا موظف', 'موظفه بلا بريد'].sort());
    const text = followup.digestText(db, salem);
    assert.match(text, /مرحباً سالم/);
    assert.match(text, /📅 موعد المتابعة اليوم/);
    assert.match(text, /💤 بلا متابعة منذ 6 أيام/);
    assert.match(text, /https:\/\/calc\.example\.com\/admin/);
    assert.match(followup.digestText(db, boss), /موظفه بلا بريد .*— بلا بريد/);
});

test('with no manager email, customers of nobody go to BACKUP_EMAIL_TO', (t) => {
    const db = setup(t, { ...SMTP, BACKUP_EMAIL_TO: 'owner@example.com' });
    lead(db, { name: 'بلا موظف', staffAt: 6 });
    const digests = followup.buildDigests(db);
    assert.equal(digests.length, 1);
    assert.deepEqual(digests[0].to, ['owner@example.com']);
});

test('the morning job sends once a day at 8:00 Muscat, and the weekly report on Sunday', async (t) => {
    const db = setup(t, { ...SMTP, BACKUP_EMAIL_TO: 'owner@example.com' });
    lead(db, { name: 'منسي', staffAt: 6 });
    // 2026-11-08 is a Sunday. 03:59 UTC = 07:59 Muscat: too early
    assert.deepEqual(await followup.tick(db, Date.parse('2026-11-08T03:59:00Z')), {});
    const r = await followup.tick(db, Date.parse('2026-11-08T04:01:00Z'));
    assert.equal(r.daily.sent, 1);
    assert.equal(r.weekly.sent, 1);
    assert.equal(sent.length, 2);
    assert.match(sent[1].subject, /تقرير الأسبوع/);
    assert.deepEqual(await followup.tick(db, Date.parse('2026-11-08T09:00:00Z')), {}, 'not again the same day (or after a restart)');
    const monday = await followup.tick(db, Date.parse('2026-11-09T05:00:00Z'));
    assert.ok(monday.daily && !monday.weekly, 'Monday: the daily list only');

    saveSettings(db, { follow_up_emails: false });
    assert.deepEqual(await followup.tick(db, Date.parse('2026-11-10T05:00:00Z')), {}, 'switched off');
});

test('the weekly report counts the week: customers, quotes, acceptance and each employee', (t) => {
    const db = setup(t);
    staff.create(db, { username: 'salem', display_name: 'سالم', email: 'salem@example.com', password: 'pass-12345', permissions: ['leads'] });
    const q = db.prepare("INSERT INTO quotes (ref, customer_name, customer_phone, items_json, subtotal, vat_percent, vat, total, status, created_at) VALUES (?, 'ع', '96890000000', '[]', ?, 5, 0, ?, ?, ?)");
    q.run('Q-1', 100, 100, 'accepted', daysAgo(1));
    q.run('Q-2', 200, 200, 'new', daysAgo(2));
    q.run('Q-3', 300, 300, 'rejected', daysAgo(3));
    q.run('Q-OLD', 999, 999, 'accepted', daysAgo(20));
    const a = lead(db, { name: 'أ', assigned: 'سالم', created: 2, staffAt: 5 });
    leads.addNote(db, a, { kind: 'report', text: 'زيارة موقع' }, 'سالم');
    leads.update(db, a, { status: 'won' }, 'سالم');
    lead(db, { name: 'قديم', created: 30, staffAt: 9 });
    const r = followup.buildWeekly(db);
    assert.equal(r.quotes.count, 3);
    assert.equal(r.quotes.value, 600);
    assert.equal(r.quotes.accepted, 1);
    assert.equal(r.quotes.rate, 33.3);
    assert.equal(r.quotes.rejected, 1);
    assert.equal(r.new_customers, 1);
    assert.equal(r.leads_won, 1);
    const salem = r.staff.find((s) => s.name === 'سالم');
    assert.equal(salem.reports, 1);
    assert.match(followup.weeklyText(db, r), /نسبة القبول 33\.3%/);
});

test('the panel: «بحاجة متابعة» filter, settings and send-now (managers only)', async (t) => {
    const db = setup(t, { ...SMTP, BACKUP_EMAIL_TO: 'owner@example.com' });
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = OWNER) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    lead(db, { name: 'منسي', staffAt: 6 });
    lead(db, { name: 'نشط', staffAt: 0 });
    const list = (await call('GET', '/api/admin/leads?open=1&attention=1')).body;
    assert.deepEqual(list.leads.map((l) => l.name), ['منسي']);
    assert.equal(list.leads[0].attention.reason, 'stale');
    assert.equal((await call('GET', '/api/admin/leads?open=1')).body.leads.length, 2);
    assert.equal((await call('GET', '/api/admin/dashboard')).body.kpis.due_follow_ups.value, 1);

    assert.equal((await call('PUT', '/api/admin/settings', { follow_up_stale_days: 0 })).status, 400);
    assert.equal((await call('PUT', '/api/admin/settings', { follow_up_stale_days: 10 })).body.follow_up_stale_days, 10);
    assert.equal((await call('GET', '/api/admin/leads?open=1&attention=1')).body.leads.length, 0);

    const preview = (await call('GET', '/api/admin/follow-up/weekly')).body;
    assert.deepEqual(preview.recipients, ['owner@example.com']);
    const w = await call('POST', '/api/admin/follow-up/send', { kind: 'weekly' });
    assert.equal(w.status, 200);
    assert.match(sent.at(-1).subject, /تقرير الأسبوع/);

    staff.create(db, { username: 'salem', display_name: 'سالم', password: 'pass-12345', permissions: ['leads'] });
    const token = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'salem', password: 'pass-12345' }) })).json()).token;
    assert.equal((await call('POST', '/api/admin/follow-up/send', { kind: 'daily' }, token)).status, 403);
    assert.equal((await call('PUT', '/api/admin/settings', { follow_up_stale_days: 1 }, token)).status, 403);
    assert.equal((await call('GET', '/api/admin/leads?open=1&attention=1', null, token)).status, 200, 'employees use the filter too');
});
