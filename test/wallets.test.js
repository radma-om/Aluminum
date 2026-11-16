/* Petty cash (العهدة): the office hands over money, the employee spends from it (with a receipt photo),
   asks for more; managers see every book, get told of each expense and of a balance below the limit. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase, saveSettings } = require('../src/db');
const { createApp } = require('../src/server');
const staff = require('../src/staff');
const push = require('../src/push');

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
    const call = async (method, url, body, token = OWNER, type = 'application/json') => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': type, Authorization: 'Bearer ' + token }, body: body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : body });
        const ct = res.headers.get('content-type') || '';
        return { status: res.status, type: ct, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
    };
    const login = async (u) => (await call('POST', '/api/auth/login', { username: u, password: 'pass-12345' }, '')).body.token;
    return { db, call, login };
}

test('the book: received, spent, returned — the balance goes down; managers are told; below the limit they are warned', async (t) => {
    const { db, call, login } = await start(t);
    const tech = staff.create(db, { username: 'ahmed', display_name: 'أحمد الفني', password: 'pass-12345', role: 'technician' });
    staff.create(db, { username: 'boss', display_name: 'المدير', password: 'pass-12345', role: 'manager' });
    const tk = await login('ahmed');
    await call('POST', '/api/admin/me/push', { subscription: device('boss') }, await login('boss').catch(() => OWNER)).catch(() => {});
    await call('POST', '/api/admin/me/push', { subscription: device('owner') });
    await call('POST', '/api/admin/me/push', { subscription: device('ahmed') }, tk);
    saveSettings(db, { wallet_min_default: 20 });

    // The employee who records money received says where it came from
    assert.equal((await call('POST', `/api/admin/wallet/${tech.id}/entries`, { kind: 'receive', amount: 50 }, tk)).status, 400);
    sent.length = 0;
    const got = await call('POST', `/api/admin/wallet/${tech.id}/entries`, { kind: 'receive', amount: 50, details: 'عهدة الأسبوع' });
    assert.equal(got.status, 201);
    assert.equal(got.body.balance, 50);
    assert.ok(sent.some((s) => s.endpoint.endsWith('/ahmed') && /استلمت 50.00/.test(s.title)), 'the technician is told');

    sent.length = 0;
    const petrol = await call('POST', `/api/admin/wallet/${tech.id}/entries`, { kind: 'expense', amount: 4, category: 'بترول', details: 'بترول السيارة' }, tk);
    assert.equal(petrol.body.balance, 46);
    assert.ok(sent.some((s) => s.endpoint.endsWith('/owner') && /صرف 4.00/.test(s.title) && /الرصيد 46.00/.test(s.body)), 'the managers hear of each expense');
    assert.equal((await call('POST', `/api/admin/wallet/${tech.id}/entries`, { kind: 'expense', amount: 0, category: 'أكل' }, tk)).status, 400);

    sent.length = 0;
    const motor = await call('POST', `/api/admin/wallet/${tech.id}/entries`, { kind: 'expense', amount: 28, category: 'منتجات وقطع', details: 'Motor sarwis' }, tk);
    assert.equal(motor.body.balance, 18);
    assert.equal(motor.body.low, true);
    assert.ok(sent.some((s) => /أقل من الحد/.test(s.title)), 'crossing the limit warns the managers');
    const warn = (await call('GET', '/api/admin/system-status')).body.warnings.map((w) => w.text);
    assert.ok(warn.some((w) => /رصيد عهدة أحمد الفني: 18.00/.test(w)), 'and a warning at the top of the panel');

    // A receipt photo, seen by the employee and the managers only
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    assert.equal((await call('POST', `/api/admin/wallet/entries/${motor.body.entry.id}/receipt`, jpeg, tk, 'image/jpeg')).status, 201);
    const photo = await call('GET', `/api/admin/wallet/entries/${motor.body.entry.id}/receipt`, undefined, tk);
    assert.equal(photo.status, 200);
    assert.match(photo.type, /image\/jpeg/);
    assert.equal(Buffer.compare(photo.body, jpeg), 0);

    // The book: newest first, the balance after each
    const book = (await call('GET', '/api/admin/wallet/me', undefined, tk)).body;
    assert.equal(book.balance, 18);
    assert.deepEqual(book.entries.map((e) => [e.kind, e.signed, e.balance_after]), [['expense', -28, 18], ['expense', -4, 46], ['receive', 50, 50]]);
    assert.equal(book.entries[0].has_receipt, true);
    assert.equal(book.spent_this_month, 32);

    // A manager cancels an entry (it stays, struck through); the balance follows
    assert.equal((await call('POST', `/api/admin/wallet/entries/${petrol.body.entry.id}/cancel`, { reason: 'مكرر' }, tk)).status, 403);
    assert.equal((await call('POST', `/api/admin/wallet/entries/${petrol.body.entry.id}/cancel`, { reason: 'مكرر' })).body.entry.cancelled, true);
    assert.equal((await call('GET', `/api/admin/wallet/${tech.id}`)).body.balance, 22);
});

test('a request: the employee asks, the manager approves (another amount) or declines; others\' books are closed', async (t) => {
    const { db, call, login } = await start(t);
    const tech = staff.create(db, { username: 'ahmed', display_name: 'أحمد الفني', password: 'pass-12345', role: 'technician' });
    const other = staff.create(db, { username: 'omar', display_name: 'عمر', password: 'pass-12345', role: 'technician' });
    const tk = await login('ahmed');
    await call('POST', '/api/admin/me/push', { subscription: device('owner') });
    await call('POST', '/api/admin/me/push', { subscription: device('ahmed') }, tk);

    assert.equal((await call('GET', `/api/admin/wallet/${other.id}`, undefined, tk)).status, 404, 'not someone else\'s book');
    assert.equal((await call('GET', '/api/admin/wallet', undefined, tk)).status, 403, 'the overview is for managers');
    assert.equal((await call('POST', `/api/admin/wallet/${other.id}/entries`, { kind: 'expense', amount: 3, category: 'أكل' }, tk)).status, 404);

    sent.length = 0;
    assert.equal((await call('POST', '/api/admin/wallet/requests', { amount: 40, reason: '' }, tk)).status, 400);
    const req1 = await call('POST', '/api/admin/wallet/requests', { amount: 40, reason: 'بترول ومواد لأعمال الأسبوع' }, tk);
    assert.equal(req1.status, 201);
    assert.ok(sent.some((s) => s.endpoint.endsWith('/owner') && /يطلب 40.00/.test(s.title)));
    const overview = (await call('GET', '/api/admin/wallet')).body;
    assert.equal(overview.requests.length, 1);

    sent.length = 0;
    const ok = await call('POST', `/api/admin/wallet/requests/${req1.body.id}/decide`, { approve: true, amount: 30, note: 'الباقي الأسبوع القادم' });
    assert.equal(ok.body.request.status, 'approved');
    assert.equal(ok.body.added.balance, 30);
    assert.ok(sent.some((s) => s.endpoint.endsWith('/ahmed') && /30.00/.test(s.title)));
    assert.equal((await call('POST', `/api/admin/wallet/requests/${req1.body.id}/decide`, { approve: true })).status, 400, 'once');

    const req2 = await call('POST', '/api/admin/wallet/requests', { amount: 100, reason: 'أدوات' }, tk);
    const no = await call('POST', `/api/admin/wallet/requests/${req2.body.id}/decide`, { approve: false, note: 'استخدم أدوات المخزن' });
    assert.equal(no.body.request.status, 'declined');
    assert.equal((await call('GET', '/api/admin/wallet/me', undefined, tk)).body.balance, 30);

    // The manager sets a lowest balance for this employee
    assert.equal((await call('PUT', `/api/admin/wallet/${tech.id}/min`, { min: 50 })).body.low, true);
    assert.equal((await call('PUT', `/api/admin/wallet/${tech.id}/min`, { min: 10 }, tk)).status, 403);
});

test('«استلمت مبلغ» counts at once; «إرجاع مبلغ للمكتب» waits for the manager to confirm (or decline) it', async (t) => {
    const { db, call, login } = await start(t);
    const tech = staff.create(db, { username: 'ahmed', display_name: 'أحمد الفني', password: 'pass-12345', role: 'technician' });
    const tk = await login('ahmed');
    await call('POST', '/api/admin/me/push', { subscription: device('owner') });
    await call('POST', '/api/admin/me/push', { subscription: device('ahmed') }, tk);
    saveSettings(db, { wallet_min_default: 20 });

    sent.length = 0;
    const got = await call('POST', `/api/admin/wallet/${tech.id}/entries`, { kind: 'receive', amount: 60, details: 'من المدير نقداً' }, tk);
    assert.equal(got.status, 201);
    assert.equal(got.body.balance, 60);
    assert.ok(sent.some((s) => s.endpoint.endsWith('/owner') && /استلمت 60.00/.test(s.title)), 'the managers are told');

    sent.length = 0;
    const back = await call('POST', `/api/admin/wallet/${tech.id}/entries`, { kind: 'return', amount: 45, details: 'باقي الأسبوع' }, tk);
    assert.equal(back.status, 201);
    assert.equal(back.body.entry.pending, true);
    assert.equal(back.body.entry.kind_label, 'إرجاع مبلغ للمكتب');
    assert.equal(back.body.balance, 60, 'not counted before the manager confirms');
    assert.ok(sent.some((s) => s.endpoint.endsWith('/owner') && /بانتظار تأكيدك/.test(s.body)));
    let mine = (await call('GET', '/api/admin/wallet/me', undefined, tk)).body;
    assert.equal(mine.pending_return, 45);
    assert.equal(mine.entries[0].balance_after, 60);
    const overview = (await call('GET', '/api/admin/wallet')).body;
    assert.deepEqual(overview.returns.map((r) => [r.id, r.amount, r.name]), [[back.body.entry.id, 45, 'أحمد الفني']]);

    // Only a manager confirms, once
    assert.equal((await call('POST', `/api/admin/wallet/entries/${back.body.entry.id}/confirm`, {}, tk)).status, 403);
    sent.length = 0;
    const ok = await call('POST', `/api/admin/wallet/entries/${back.body.entry.id}/confirm`, {});
    assert.equal(ok.status, 200);
    assert.equal(ok.body.balance, 15);
    assert.ok(sent.some((s) => s.endpoint.endsWith('/ahmed') && /أكدت الإدارة استلام 45.00/.test(s.title)));
    assert.ok(sent.some((s) => /أقل من الحد/.test(s.title)), 'the balance now below the limit warns');
    assert.equal((await call('POST', `/api/admin/wallet/entries/${back.body.entry.id}/confirm`, {})).status, 400);
    mine = (await call('GET', '/api/admin/wallet/me', undefined, tk)).body;
    assert.equal(mine.pending_return, 0);
    assert.equal(mine.entries[0].confirmed_by, 'المدير العام');

    // Declined: the manager cancels it with the reason; the balance does not change
    const again = await call('POST', `/api/admin/wallet/${tech.id}/entries`, { kind: 'return', amount: 10 }, tk);
    sent.length = 0;
    await call('POST', `/api/admin/wallet/entries/${again.body.entry.id}/cancel`, { reason: 'لم يصلني المبلغ' });
    assert.ok(sent.some((s) => s.endpoint.endsWith('/ahmed') && /لم تؤكد الإدارة/.test(s.title) && /لم يصلني/.test(s.body)));
    assert.equal((await call('GET', '/api/admin/wallet/me', undefined, tk)).body.balance, 15);

    // A return the manager records in the employee's book counts at once
    const direct = await call('POST', `/api/admin/wallet/${tech.id}/entries`, { kind: 'return', amount: 5 });
    assert.equal(direct.body.entry.pending, false);
    assert.equal(direct.body.balance, 10);
});

test('the low balance warning: only for those who use petty cash; a limit of their own, or none (0)', async (t) => {
    const { db, call, login } = await start(t);
    const tech = staff.create(db, { username: 'ahmed', display_name: 'أحمد الفني', password: 'pass-12345', role: 'technician' });
    const office = staff.create(db, { username: 'mona', display_name: 'منى', password: 'pass-12345', permissions: ['quotes'] });
    const driver = staff.create(db, { username: 'ali', display_name: 'علي', password: 'pass-12345', role: 'technician' });
    saveSettings(db, { wallet_min_default: 20 });
    const warnings = async () => (await call('GET', '/api/admin/system-status')).body.warnings.map((w) => w.text).filter((w) => /رصيد عهدة/.test(w));

    // Nobody has petty cash yet: no warning, though every balance (0) is under 20
    assert.deepEqual(await warnings(), []);
    let all = (await call('GET', '/api/admin/wallet')).body.accounts;
    assert.equal(all.find((a) => a.id === office.id).low, false);
    assert.equal((await call('GET', '/api/admin/wallet/me', undefined, await login('mona'))).body.low, false);

    // The technician uses it and goes under the general limit: warned
    await call('POST', `/api/admin/wallet/${tech.id}/entries`, { kind: 'receive', amount: 10, details: 'عهدة' });
    await call('POST', `/api/admin/wallet/${driver.id}/entries`, { kind: 'receive', amount: 10, details: 'عهدة' });
    assert.equal((await warnings()).length, 2);

    // A limit of his own for one (5: 10 is fine), none at all (0) for the other
    await call('PUT', `/api/admin/wallet/${tech.id}/min`, { min: 5 });
    await call('PUT', `/api/admin/wallet/${driver.id}/min`, { min: 0 });
    assert.deepEqual(await warnings(), []);
    all = (await call('GET', '/api/admin/wallet')).body.accounts;
    assert.deepEqual([all.find((a) => a.id === tech.id).min, all.find((a) => a.id === driver.id).own_min], [5, 0]);
    // A limit given to an employee who has no entries yet: they use petty cash — warned (0 < 20)
    await call('PUT', `/api/admin/wallet/${office.id}/min`, { min: 20 });
    assert.ok((await warnings()).some((w) => /منى/.test(w)));
    await call('PUT', `/api/admin/wallet/${office.id}/min`, { min: null });
    assert.ok(!(await warnings()).some((w) => /منى/.test(w)), 'back to the general limit: no entries, no warning');
    // Back to the general limit (empty)
    await call('PUT', `/api/admin/wallet/${tech.id}/min`, { min: null });
    assert.equal((await warnings()).length, 1);
});
