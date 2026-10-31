const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const leads = require('../src/leads');

process.env.ADMIN_TOKEN = 'test-token';

async function start() {
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = 'test-token', headers = {}) => {
        const res = await fetch(base + url, {
            method,
            headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
            body: body ? JSON.stringify(body) : undefined
        });
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        return { status: res.status, body: data };
    };
    const login = async (username, password) => {
        const r = await call('POST', '/api/auth/login', { username, password }, null);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        return r.body.token;
    };
    return { db, server, call, login };
}

test('the general manager creates staff accounts with sections; passwords are hashed and validated', async (t) => {
    const { db, server, call } = await start();
    t.after(() => server.close());
    const created = await call('POST', '/api/admin/users', {
        username: 'Salem', display_name: 'سالم', password: 'salem-pass-1', permissions: ['leads', 'quotes', 'nope'], leads_scope: 'mine'
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    assert.deepStrictEqual(created.body.permissions, ['leads', 'quotes']);
    assert.strictEqual(created.body.username, 'salem');
    assert.ok(!('password_hash' in created.body));
    assert.match(db.prepare('SELECT password_hash FROM staff_users').get().password_hash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);

    // Validation
    assert.strictEqual((await call('POST', '/api/admin/users', { username: 'salem', display_name: 'x', password: '12345678', permissions: ['leads'] })).status, 400); // taken
    assert.strictEqual((await call('POST', '/api/admin/users', { username: 'm', display_name: 'x', password: '12345678', permissions: ['leads'] })).status, 400); // too short
    assert.strictEqual((await call('POST', '/api/admin/users', { username: 'mariam', display_name: 'مريم', password: 'short', permissions: ['leads'] })).status, 400);
    assert.strictEqual((await call('POST', '/api/admin/users', { username: 'mariam', display_name: 'مريم', password: '12345678', permissions: [] })).status, 400);

    const list = await call('GET', '/api/admin/users');
    assert.strictEqual(list.body.users.length, 1);
    assert.ok(list.body.sections.leads && list.body.roles.manager);
});

test('an employee signs in and only reaches the sections given to them', async (t) => {
    const { server, call, login } = await start();
    t.after(() => server.close());
    await call('POST', '/api/admin/users', { username: 'salem', display_name: 'سالم', password: 'salem-pass-1', permissions: ['leads', 'quotes', 'pricing'] });

    assert.strictEqual((await call('POST', '/api/auth/login', { username: 'salem', password: 'wrong-pass' }, null)).status, 401);
    assert.strictEqual((await call('POST', '/api/auth/login', { username: 'ghost', password: 'whatever1' }, null)).status, 401);
    const token = await login('SALEM', 'salem-pass-1');
    assert.ok(token && token.length > 30);

    const me = await call('GET', '/api/admin/me', null, token);
    assert.strictEqual(me.body.user.display_name, 'سالم');
    assert.strictEqual(me.body.user.role, 'staff');

    for (const url of ['/api/admin/leads', '/api/admin/quotes', '/api/admin/settings']) {
        assert.strictEqual((await call('GET', url, null, token)).status, 200, url);
    }
    for (const url of ['/api/admin/system-status', '/api/admin/dashboard', '/api/admin/products', '/api/admin/motors', '/api/admin/overhead', '/api/admin/users',
        '/api/admin/backup.xlsx', '/api/admin/backups', '/api/admin/knowledge', '/api/admin/mazbot/status', '/api/admin/webhooks', '/api/admin/configurator']) {
        assert.strictEqual((await call('GET', url, null, token)).status, 403, url);
    }
    assert.strictEqual((await call('POST', '/api/admin/users', { username: 'x1x', display_name: 'x', password: '12345678', permissions: ['leads'] }, token)).status, 403);
    assert.strictEqual((await call('POST', '/api/admin/restore', null, token)).status, 403);

    // Settings: only the keys of their sections are saved
    const saved = await call('PUT', '/api/admin/settings', { lme: 2500, company_name: 'تغيير غير مسموح', agent_instructions: 'x' }, token);
    assert.strictEqual(saved.status, 200);
    assert.strictEqual(saved.body.lme, 2500);
    assert.notStrictEqual(saved.body.company_name, 'تغيير غير مسموح');
    assert.notStrictEqual(saved.body.agent_instructions, 'x');
    assert.strictEqual((await call('PUT', '/api/admin/settings', { company_name: 'x' }, token)).status, 403);
    assert.strictEqual((await call('PUT', '/api/admin/settings', { staff_members: ['x'] }, token)).status, 403);

    // A manager account sees everything
    await call('POST', '/api/admin/users', { username: 'boss', display_name: 'أحمد', password: 'boss-pass-1', role: 'manager' });
    const boss = await login('boss', 'boss-pass-1');
    assert.strictEqual((await call('GET', '/api/admin/users', null, boss)).status, 200);
    assert.strictEqual((await call('GET', '/api/admin/dashboard', null, boss)).status, 200);
});

test('wilayah fees: overhead / motors staff change only their own fee', async (t) => {
    const { db, server, call, login } = await start();
    t.after(() => server.close());
    await call('POST', '/api/admin/users', { username: 'khalid', display_name: 'خالد', password: 'oh-pass-12', permissions: ['overhead'] });
    const token = await login('khalid', 'oh-pass-12');
    const id = db.prepare("SELECT id FROM regions WHERE name = 'نزوى'").get().id;
    assert.strictEqual((await call('PUT', `/api/admin/regions/${id}`, { overhead_installation_fee: 70 }, token)).status, 200);
    assert.strictEqual((await call('PUT', `/api/admin/regions/${id}`, { installation_fee: 1 }, token)).status, 403);
    assert.strictEqual((await call('PUT', `/api/admin/regions/${id}`, { motor_installation_fee: 1 }, token)).status, 403);
    assert.strictEqual(db.prepare('SELECT overhead_installation_fee AS f FROM regions WHERE id = ?').get(id).f, 70);
});

test('follow-up: notes carry the account name; "own customers" employees never see the others\'', async (t) => {
    const { db, server, call, login } = await start();
    t.after(() => server.close());
    await call('POST', '/api/admin/users', { username: 'salem', display_name: 'سالم', password: 'salem-pass-1', permissions: ['leads'], leads_scope: 'mine' });
    await call('POST', '/api/admin/users', { username: 'mariam', display_name: 'مريم', password: 'mariam-pass', permissions: ['leads'] });
    const salem = await login('salem', 'salem-pass-1');
    const mariam = await login('mariam', 'mariam-pass');

    const mine = leads.customerMessage(db, { key: 'tel:96891111111', channel: 'whatsapp', name: 'أ', phone: '96891111111', text: 'مرحبا' });
    const other = leads.customerMessage(db, { key: 'tel:96892222222', channel: 'whatsapp', name: 'ب', phone: '96892222222', text: 'مرحبا' });
    const free = leads.customerMessage(db, { key: 'tel:96893333333', channel: 'whatsapp', name: 'ج', phone: '96893333333', text: 'مرحبا' });
    db.prepare("UPDATE leads SET assigned_to = 'سالم' WHERE id = ?").run(mine.id);
    db.prepare("UPDATE leads SET assigned_to = 'مريم' WHERE id = ?").run(other.id);

    const list = await call('GET', '/api/admin/leads', null, salem);
    assert.deepStrictEqual(list.body.leads.map((l) => l.id).sort(), [mine.id, free.id].sort());
    assert.deepStrictEqual(list.body.me, { name: 'سالم', scope: 'mine' });
    assert.ok(list.body.staff.includes('سالم') && list.body.staff.includes('مريم'));
    assert.strictEqual((await call('GET', `/api/admin/leads/${other.id}`, null, salem)).status, 404);
    assert.strictEqual((await call('POST', `/api/admin/leads/${other.id}/notes`, { kind: 'report', text: 'x' }, salem)).status, 404);
    assert.strictEqual((await call('PATCH', `/api/admin/leads/${other.id}`, { status: 'lost' }, salem)).status, 404);

    // The author is the account, whatever name the browser sends
    const noted = await call('POST', `/api/admin/leads/${mine.id}/notes`, { kind: 'report', text: 'اتصلت بالعميل' }, salem, { 'X-Staff-Name': encodeURIComponent('مريم') });
    assert.strictEqual(noted.body.notes[0].author, 'سالم');
    // Hand over to Mariam: Salem no longer sees the customer; Mariam (all customers) does
    await call('PATCH', `/api/admin/leads/${mine.id}`, { assigned_to: 'مريم', handover_text: 'يحتاج زيارة' }, salem);
    assert.strictEqual((await call('GET', `/api/admin/leads/${mine.id}`, null, salem)).status, 404);
    const seen = await call('GET', `/api/admin/leads/${mine.id}`, null, mariam);
    assert.match(seen.body.notes[0].text, /من سالم إلى مريم[^]*يحتاج زيارة/);
    assert.strictEqual(seen.body.notes[0].author, 'سالم');
    assert.strictEqual((await call('GET', '/api/admin/leads', null, mariam)).body.leads.length, 3);

    // Quote PDFs open from the follow-up too
    const q = saveQuote(db, { customer_name: 'ج', customer_phone: '93333333', source: 'web', priced: { items: [], subtotal: 1, vat_percent: 5, vat: 0.05, total: 1.05 } });
    assert.strictEqual((await call('GET', `/api/admin/quotes/${q.id}/pdf`, null, salem)).status, 200);
});

test('sessions: logout, deactivation and a new password end them; own password change', async (t) => {
    const { server, call, login } = await start();
    t.after(() => server.close());
    const { body: user } = await call('POST', '/api/admin/users', { username: 'salem', display_name: 'سالم', password: 'salem-pass-1', permissions: ['leads'] });

    let token = await login('salem', 'salem-pass-1');
    assert.strictEqual((await call('POST', '/api/auth/logout', null, token)).status, 204);
    assert.strictEqual((await call('GET', '/api/admin/me', null, token)).status, 401);

    token = await login('salem', 'salem-pass-1');
    assert.strictEqual((await call('POST', '/api/admin/me/password', { current: 'wrong-one', password: 'new-pass-22' }, token)).status, 400);
    assert.strictEqual((await call('POST', '/api/admin/me/password', { current: 'salem-pass-1', password: 'new-pass-22' }, token)).status, 200);
    assert.ok(await login('salem', 'new-pass-22'));
    assert.strictEqual((await call('POST', '/api/auth/login', { username: 'salem', password: 'salem-pass-1' }, null)).status, 401);

    // Deactivated: signed out and cannot sign in
    token = await login('salem', 'new-pass-22');
    await call('PUT', `/api/admin/users/${user.id}`, { active: false });
    assert.strictEqual((await call('GET', '/api/admin/me', null, token)).status, 401);
    assert.strictEqual((await call('POST', '/api/auth/login', { username: 'salem', password: 'new-pass-22' }, null)).status, 403);
    // Permission changes apply at once
    await call('PUT', `/api/admin/users/${user.id}`, { active: true, permissions: ['quotes'] });
    token = await login('salem', 'new-pass-22');
    assert.strictEqual((await call('GET', '/api/admin/leads', null, token)).status, 403);
    await call('PUT', `/api/admin/users/${user.id}`, { permissions: ['quotes', 'leads'] });
    assert.strictEqual((await call('GET', '/api/admin/leads', null, token)).status, 200);
    // Deleted
    assert.strictEqual((await call('DELETE', `/api/admin/users/${user.id}`)).status, 204);
    assert.strictEqual((await call('GET', '/api/admin/me', null, token)).status, 401);
    // The general manager has no password to change here
    assert.strictEqual((await call('POST', '/api/admin/me/password', { current: 'x', password: 'yyyyyyyy' })).status, 400);
});
