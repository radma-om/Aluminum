/* The time and distance left to a customer: the place read from the work order's map link (full, short, a
   WhatsApp location, or «23.5, 58.3»), or set by the technician on site; the trip starts with «في الطريق»
   and is refreshed from the phone's place (Google Routes when its key is set, else an estimate); arrived
   within 150 m; ends when the work starts. The office, the technician and the customer's page see it —
   the customer never the technician's place. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const staff = require('../src/staff');
const invoices = require('../src/invoices');
const workorders = require('../src/workorders');
const routing = require('../src/routing');
const notify = require('../src/order-notify');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
notify.setSenderForTests(async () => ({ ok: true }));

test('a place from what people paste', async (t) => {
    assert.deepEqual(routing.parseCoords('https://www.google.com/maps?q=23.5880,58.3829'), { lat: 23.588, lng: 58.3829 });
    assert.deepEqual(routing.parseCoords('https://maps.google.com/?q=23.61%2C58.54'), { lat: 23.61, lng: 58.54 });
    assert.deepEqual(routing.parseCoords('https://www.google.com/maps/place/X/@23.60,58.40,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d23.6012!4d58.4056'), { lat: 23.6012, lng: 58.4056 }, 'the pin, not the map centre');
    assert.deepEqual(routing.parseCoords(' 23.5880, 58.3829 '), { lat: 23.588, lng: 58.3829 });
    assert.equal(routing.parseCoords('مسقط، الخوير'), null);
    assert.equal(routing.parseCoords('https://www.google.com/maps?q=0,0'), null);

    // A short link is followed — Google's addresses only
    const asked = [];
    routing.setFetchForTests(async (url) => {
        asked.push(url);
        if (url.includes('maps.app.goo.gl/abc')) return { headers: { get: () => 'https://www.google.com/maps/place/Home/@23.58,58.38,17z/data=!3d23.5811!4d58.3822' } };
        if (url.includes('maps.app.goo.gl/evil')) return { headers: { get: () => 'https://evil.example.com/?q=1,1' } };
        return { headers: { get: () => null } };
    });
    t.after(() => routing.setFetchForTests(null));
    assert.deepEqual(await routing.resolve('https://maps.app.goo.gl/abc'), { lat: 23.5811, lng: 58.3822 });
    assert.equal(await routing.resolve('https://maps.app.goo.gl/evil'), null, 'not followed outside Google');
    assert.equal(await routing.resolve('https://example.com/maps?x=1'), null);
    assert.equal(asked.filter((u) => u.includes('example.com')).length, 0, 'other sites are never fetched');
});

test('links as phones share them: with the place\'s name, a place by name only, Google\'s consent page, Arabic digits', async (t) => {
    t.after(() => routing.setFetchForTests(null));
    const asked = [];
    const page = (html) => ({ status: 200, headers: { get: () => null }, text: async () => html });
    const go = (to) => ({ status: 302, headers: { get: (h) => (h === 'location' ? to : null) } });
    routing.setFetchForTests(async (url, opts) => {
        asked.push({ url, ua: opts.headers['User-Agent'] });
        if (url.includes('maps.app.goo.gl/named')) return go('https://maps.google.com/?q=Lulu+Hypermarket,+Muscat&ftid=0x3e91f:0x12ab&entry=gps&g_st=iw');
        if (url.startsWith('https://maps.google.com/?q=Lulu')) return go('https://www.google.com/maps?q=Lulu+Hypermarket,+Muscat&ftid=0x3e91f:0x12ab');
        if (url.startsWith('https://www.google.com/maps?q=Lulu')) return page('<html><meta content="https://maps.google.com/maps/api/staticmap?center=23.6143%2C58.545&amp;zoom=15&amp;size=900x900" property="og:image"></html>');
        if (url.includes('maps.app.goo.gl/eu')) return go('https://consent.google.com/m?continue=https://www.google.com/maps/place/Home/data%3D!3d23.5811!4d58.3822&gl=DE');
        if (url.includes('maps.app.goo.gl/empty')) return page('<html>nothing here</html>');
        return { status: 404, headers: { get: () => null }, text: async () => '' };
    });
    // The Google Maps app's «Share»: the name, a line break, the short link
    assert.deepEqual(await routing.resolve('لولو هايبرماركت - مسقط\nhttps://maps.app.goo.gl/named'), { lat: 23.6143, lng: 58.545 }, 'a place by name: read from its page');
    assert.ok(asked.every((a) => /iPhone/.test(a.ua)), 'asked as a phone\'s browser');
    assert.deepEqual(await routing.resolve('https://maps.app.goo.gl/eu'), { lat: 23.5811, lng: 58.3822 }, 'past the consent page');
    assert.deepEqual(await routing.resolveDetail('https://maps.app.goo.gl/empty'), { place: null, reason: 'no_coords:maps.app.goo.gl:200' });
    assert.deepEqual(await routing.resolve('٢٣٫٥٨٨، ٥٨٫٣٨٢٩'), { lat: 23.588, lng: 58.3829 }, 'Arabic digits');
    assert.deepEqual(await routing.resolve('https://www.google.com/maps/search/23.588,+58.3829?entry=tts'), { lat: 23.588, lng: 58.3829 });
});

test('Google Routes: road distance and time with traffic; the estimate without a key or on failure', async (t) => {
    const from = { lat: 23.588, lng: 58.3829 };
    const to = { lat: 23.6143, lng: 58.545 };
    const est = await routing.route(from, to);
    assert.equal(est.estimate, true);
    assert.ok(est.meters > 16000 && est.meters < 26000, String(est.meters));
    process.env.GOOGLE_ROUTES_API_KEY = 'routes-key';
    t.after(() => { delete process.env.GOOGLE_ROUTES_API_KEY; routing.setFetchForTests(null); });
    let sentReq = null;
    routing.setFetchForTests(async (url, opts) => {
        sentReq = { url, headers: opts.headers, body: JSON.parse(opts.body) };
        return { ok: true, status: 200, json: async () => ({ routes: [{ distanceMeters: 21450, duration: '1260s', polyline: { encodedPolyline: '_p~iF~ps|U' } }] }) };
    });
    assert.deepEqual(await routing.route(from, to), { meters: 21450, seconds: 1260, polyline: '_p~iF~ps|U', estimate: false });
    assert.equal(sentReq.headers['X-Goog-Api-Key'], 'routes-key');
    assert.equal(sentReq.body.routingPreference, 'TRAFFIC_AWARE');
    routing.setFetchForTests(async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'API not enabled' } }) }));
    const failed = await routing.route(from, to);
    assert.equal(failed.estimate, true);
    assert.match(failed.error, /not enabled/);
    assert.equal(routing.durationText(1260), '21 دقيقة');
    assert.equal(routing.durationText(4500), '1 س 15 د');
    assert.equal(routing.distanceText(21460), '21.5 كم');
    assert.equal(routing.distanceText(840), '840 م');
});

test('on the way → time and distance left (office, technician, customer) → arrived → the work starts', async (t) => {
    delete process.env.GOOGLE_ROUTES_API_KEY;
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = OWNER) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const login = async (u) => (await call('POST', '/api/auth/login', { username: u, password: 'pass-12345' }, '')).body.token;
    const tech = staff.create(db, { username: 'ahmed', display_name: 'أحمد', password: 'pass-12345', role: 'technician' });
    const mk = staff.create(db, { username: 'mk1', display_name: 'سعيد', password: 'pass-12345', role: 'marketer', permissions: ['leads'] });
    const T = await login('ahmed');
    const M = await login('mk1');
    const priced = { items: [{ name: 'بوابة', unit: 'piece', quantity: 1, unit_price: 400, line_total: 400, part: 'slats' }], subtotal: 400, vat_percent: 5, vat: 20, total: 420 };
    const q = saveQuote(db, { customer_name: 'خالد سالم', customer_phone: '91234567', source: 'staff', priced, details: { staff_quote: true, created_by: 'سارة' } });
    const row = db.prepare('SELECT * FROM quotes WHERE id = ?').get(q.id);
    const inv = invoices.createFromQuote(db, { ...row, items: JSON.parse(row.items_json), details: JSON.parse(row.details_json) }, {}, 'سارة');

    // The office creates the order with the customer's map link: its place is read at once
    const created = await call('POST', '/api/admin/work-orders', { invoice_id: inv.id, kind: 'installation', description: 'تركيب', technician_id: tech.id,
        scheduled_date: '2099-01-01', map_url: 'https://www.google.com/maps?q=23.6143,58.5450' });
    assert.equal(created.status, 201);
    const id = created.body.id;
    assert.deepEqual([workorders.get(db, id).dest_lat, workorders.get(db, id).dest_lng], [23.6143, 58.545]);

    // On shift, «في الطريق» from the technician's place: the trip with the time and distance left
    await call('POST', '/api/admin/me/shift', { on: true, consent: true, lat: 23.588, lng: 58.3829 }, T);
    const way = await call('POST', `/api/admin/work-orders/${id}/on-the-way`, { lat: 23.588, lng: 58.3829 }, T);
    assert.equal(way.status, 200);
    assert.equal(way.body.need_place, false);
    assert.equal(way.body.trip.order_id, id);
    assert.ok(way.body.trip.seconds > 600 && way.body.trip.estimate, 'an estimate without the Routes key');
    assert.match(way.body.trip.nav_url, /destination=23\.6143,58\.545/);
    const office = (await call('GET', '/api/admin/tracking')).body.people.find((p) => p.id === tech.id);
    assert.match(office.trip.eta_text, /دقيقة/);

    // The customer's page: on the way, how long and how far — never where the technician is
    const page = await (await fetch(`${base}/t/${inv.access_key}`)).text();
    assert.match(page, /الفني في الطريق إليكم/);
    assert.match(page, /يصل خلال <b>\d+ دقيقة<\/b>/);
    assert.match(page, /http-equiv="refresh" content="60"/);
    assert.doesNotMatch(page, /23\.588|58\.3829/);

    // Closer than 150 m: arrived (the next place from the phone)
    db.prepare("UPDATE staff_locations SET created_at = datetime('now', '-1 minute')").run();
    const near = await call('POST', '/api/admin/me/location', { lat: 23.6144, lng: 58.5451 }, T);
    assert.ok(near.body.trip.arrived_at);
    assert.match(await (await fetch(`${base}/t/${inv.access_key}`)).text(), /وصل الفني إلى موقعكم/);

    // The work starts: the trip ends
    await call('POST', `/api/admin/work-orders/${id}/status`, { status: 'in_progress' }, T);
    assert.equal((await call('GET', '/api/admin/me/location', null, T)).body.trip, null);
    assert.doesNotMatch(await (await fetch(`${base}/t/${inv.access_key}`)).text(), /في الطريق إليكم/);

    // An order without a place: «في الطريق» asks for it; the technician sets it on site
    const bare = workorders.create(db, { invoice_id: inv.id, kind: 'maintenance', description: 'صيانة', technician_id: tech.id, scheduled_date: '2099-01-02' }, 'المكتب', { source: { invoice: inv } });
    const noPlace = await call('POST', `/api/admin/work-orders/${bare.id}/on-the-way`, { lat: 23.588, lng: 58.3829 }, T);
    assert.deepEqual([noPlace.body.need_place, noPlace.body.trip], [true, null]);
    assert.equal((await call('POST', `/api/admin/work-orders/${bare.id}/place`, { map_url: 'مكان ما' }, T)).status, 400);
    const set = await call('POST', `/api/admin/work-orders/${bare.id}/place`, { map_url: '23.5000, 58.2000' }, T);
    assert.equal(set.body.map_url, 'https://www.google.com/maps?q=23.5,58.2');
    const trip = await call('POST', `/api/admin/work-orders/${bare.id}/trip`, { lat: 23.588, lng: 58.3829 }, T);
    assert.equal(trip.body.trip.order_id, bare.id);
    // The office moves the place: the trip follows (time asked again)
    await call('PATCH', `/api/admin/work-orders/${bare.id}`, { map_url: 'https://www.google.com/maps?q=23.45,58.10' });
    const moved = (await call('GET', '/api/admin/me/location', null, T)).body.trip;
    assert.deepEqual([moved.lat, moved.lng, moved.seconds], [23.45, 58.1, null]);
    // Cancelled: the trip ends
    await call('POST', `/api/admin/work-orders/${bare.id}/cancel`, { reason: 'العميل ألغى' });
    assert.equal((await call('GET', '/api/admin/me/location', null, T)).body.trip, null);

    // A marketer's «وجهتي» from a link; ends with the day
    await call('POST', '/api/admin/me/shift', { on: true, consent: true }, M);
    assert.equal((await call('POST', '/api/admin/me/trip', { map_url: 'لا شيء' }, M)).status, 400);
    const mt = await call('POST', '/api/admin/me/trip', { map_url: 'https://maps.google.com/?q=23.62,58.50', label: 'مكتب العميل', from: { lat: 23.588, lng: 58.3829 } }, M);
    assert.deepEqual([mt.body.trip.label, Boolean(mt.body.trip.eta_text)], ['مكتب العميل', true]);
    await call('POST', '/api/admin/me/shift', { on: false }, M);
    assert.equal((await call('GET', '/api/admin/me/location', null, M)).body.trip, null);
    assert.equal(mk.role, 'marketer');
});
