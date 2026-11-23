/* «تتبع الفريق»: a technician / marketer shares their place only on shift and after agreeing; live places
   at most every 20 s; a work-order step and a marketer's visit leave a snapshot; the map is for managers and
   those given «تتبع الفريق»; places go after 30 days and never into the audit log; the admin page alone may
   ask for the place and load Google Maps. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/server');
const staff = require('../src/staff');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;

test('field tracking: shift, consent, places, visits, the map and who may see it', async (t) => {
    process.env.GOOGLE_MAPS_API_KEY = 'maps-browser-key';
    t.after(() => { delete process.env.GOOGLE_MAPS_API_KEY; });
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = OWNER) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const login = async (username) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'pass-12345' }) })).json()).token;

    const tech = staff.create(db, { username: 'tech1', display_name: 'خالد الفني', password: 'pass-12345', role: 'technician' });
    const mk = staff.create(db, { username: 'mk1', display_name: 'سعيد المسوق', password: 'pass-12345', role: 'marketer', permissions: ['leads', 'quotes'] });
    staff.create(db, { username: 'office', display_name: 'موظفة', password: 'pass-12345', role: 'staff', permissions: ['leads'] });
    staff.create(db, { username: 'watcher', display_name: 'مشرف', password: 'pass-12345', role: 'staff', permissions: ['tracking'] });
    assert.throws(() => staff.create(db, { username: 'mk2', display_name: 'بلا أقسام', password: 'pass-12345', role: 'marketer', permissions: [] }), /قسماً/);
    const [T, M, O, W] = [await login('tech1'), await login('mk1'), await login('office'), await login('watcher')];
    const here = { lat: 23.588, lng: 58.3829, accuracy: 15 };

    // The technician: tracked, agrees once, then on shift
    assert.deepEqual((await call('GET', '/api/admin/me/location', null, T)).body, { tracked: true, consent: false, on_shift_since: null, every_seconds: 60 });
    assert.equal((await call('POST', '/api/admin/me/location', here, T)).body.kept, false, 'off shift: not kept');
    const noConsent = await call('POST', '/api/admin/me/shift', { on: true, ...here }, T);
    assert.equal(noConsent.status, 400);
    assert.equal(noConsent.body.need_consent, true);
    const on = await call('POST', '/api/admin/me/shift', { on: true, consent: true, ...here }, T);
    assert.ok(on.body.consent && on.body.on_shift_since);
    assert.equal((await call('POST', '/api/admin/me/location', { lat: 23.6, lng: 58.4 }, T)).body.kept, true);
    assert.deepEqual((await call('POST', '/api/admin/me/location', { lat: 23.61, lng: 58.41 }, T)).body, { kept: false, reason: 'too_soon' });
    assert.equal((await call('POST', '/api/admin/me/location', { lat: 23.62, lng: 58.42, kind: 'event', label: 'في الطريق — WO-1' }, T)).body.kept, true);
    assert.equal((await call('POST', '/api/admin/me/location', { lat: 200, lng: 58 }, T)).status, 400, 'a bad place');

    // An office employee does not share
    assert.equal((await call('GET', '/api/admin/me/location', null, O)).body.tracked, false);
    assert.equal((await call('POST', '/api/admin/me/shift', { on: true, consent: true }, O)).status, 403);

    // The marketer: works like an employee (quotes, customers) and records a visit with its place
    assert.equal((await call('GET', '/api/admin/leads', null, M)).status, 200);
    assert.equal((await call('POST', '/api/admin/me/visit', { name: 'سالم', phone: '99112233', note: 'يريد بوابة كراج', lat: 23.7, lng: 58.3 }, T)).status, 403, 'visits: marketers');
    const v = await call('POST', '/api/admin/me/visit', { name: 'سالم', phone: '99112233', note: 'يريد بوابة كراج', lat: 23.7, lng: 58.3 }, M);
    assert.equal(v.status, 201);
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(v.body.lead_id);
    assert.deepEqual([lead.channel, lead.assigned_to, lead.status], ['field', 'سعيد المسوق', 'following']);
    assert.match(db.prepare('SELECT text FROM lead_messages WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(lead.id).text, /زيارة ميدانية: يريد بوابة كراج[\s\S]*google\.com\/maps\?q=23\.7,58\.3/);

    // The map: managers and «تتبع الفريق»; not the technician, not an employee without it
    assert.equal((await call('GET', '/api/admin/tracking', null, T)).status, 403);
    assert.equal((await call('GET', '/api/admin/tracking', null, O)).status, 403);
    assert.equal((await call('GET', '/api/admin/tracking', null, W)).status, 200);
    const map = (await call('GET', '/api/admin/tracking')).body;
    assert.equal(map.maps_key, 'maps-browser-key');
    const tp = map.people.find((p) => p.id === tech.id);
    assert.deepEqual([tp.state, tp.last.kind, tp.last.label], ['live', 'event', 'في الطريق — WO-1']);
    assert.equal(map.people.find((p) => p.id === mk.id).state, 'off', 'the marketer has not started the shift');
    const dayOf = (await call('GET', `/api/admin/tracking/${tech.id}`)).body;
    assert.deepEqual(dayOf.points.map((p) => p.kind), ['shift_start', 'live', 'event']);

    // End of shift: live places stop; the audit log has the shift and the view, never the places
    await call('POST', '/api/admin/me/shift', { on: false, ...here }, T);
    assert.equal((await call('GET', '/api/admin/tracking')).body.people.find((p) => p.id === tech.id).state, 'off');
    const audit = db.prepare('SELECT path, details_json FROM audit_log').all();
    assert.ok(!audit.some((a) => a.path === '/me/location'), 'the places never go to the audit log');
    assert.ok(audit.some((a) => a.path === `/tracking/${tech.id}`), 'who looked at a route is recorded');
    assert.ok(!audit.some((a) => /23\.58/.test(a.details_json || '')), 'no coordinates in the audit log');

    // 30 days, then gone
    db.prepare("UPDATE staff_locations SET created_at = datetime('now', '-31 days') WHERE kind = 'live'").run();
    assert.equal(require('../src/fieldtrack').prune(db), 1);

    // Only the admin page may ask for the place and load Google Maps
    const adminRes = await fetch(base + '/admin');
    assert.match(adminRes.headers.get('permissions-policy'), /geolocation=\(self\)/);
    assert.match(adminRes.headers.get('content-security-policy'), /maps\.googleapis\.com/);
    const calc = await fetch(base + '/');
    assert.match(calc.headers.get('permissions-policy'), /geolocation=\(\)/);
    assert.doesNotMatch(calc.headers.get('content-security-policy'), /googleapis\.com\/|maps\.googleapis/);
});
