/* The customer discount (promotion) switched on by the manager */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase, getSettings, saveSettings } = require('../src/db');
const { createApp } = require('../src/server');
const promotions = require('../src/promotions');
const doors = require('../src/doors');
const agent = require('../src/agent');
const staff = require('../src/staff');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const ON = { promo_enabled: true, promo_percent: 10, promo_label: 'عرض الشتاء', promo_until: '', promo_scope: ['rolling_shutter', 'overhead', 'motors'] };

async function start(t) {
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = OWNER) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const type = res.headers.get('content-type') || '';
        return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
    };
    return { db, call };
}

async function doorRequest(call) {
    const conf = (await call('GET', '/api/public/configurator', null, null)).body;
    const type = conf.shutter_types.find((x) => x.variants.length === 1);
    return {
        conf,
        door: { width_cm: 300, height_cm: 250, count: 1, shutter_type_id: type.id, color_id: type.variants[0].colors[0].id,
            option_ids: conf.accessory_groups.map((g) => g.options[0].id), region_id: conf.locations[0].wilayat[0].id }
    };
}

test('when it runs: switched on, a valid %, the chosen calculators, until its last day', () => {
    const s = { ...ON };
    assert.equal(promotions.active(s, 'overhead').percent, 10);
    assert.equal(promotions.active({ ...s, promo_enabled: false }, 'overhead'), null);
    assert.equal(promotions.active({ ...s, promo_percent: 0 }, 'overhead'), null);
    assert.equal(promotions.active({ ...s, promo_percent: 80 }, 'overhead'), null, 'above 50% is never applied');
    assert.equal(promotions.active({ ...s, promo_scope: ['motors'] }, 'overhead'), null);
    assert.equal(promotions.active({ ...s, promo_until: '2020-01-01' }, 'overhead'), null, 'ended');
    assert.ok(promotions.active({ ...s, promo_until: '2099-12-31' }, 'overhead'));
    const p = promotions.apply(s, { subtotal: 1000, vat_percent: 5, vat: 50, total: 1050, range: { subtotal_to: 1200, vat_to: 60, total_to: 1260 } }, 'overhead');
    assert.deepEqual([p.subtotal, p.vat, p.total], [900, 45, 945]);
    assert.deepEqual(p.range, { subtotal_to: 1080, vat_to: 54, total_to: 1134 });
    assert.equal(p.promo.amount, 100);
    assert.equal(p.promo.amount_to, 120);
});

test('the roller-shutter calculator: live price, saved quote and PDF show the discount; a second press is not a duplicate', async (t) => {
    const { db, call } = await start(t);
    const { door } = await doorRequest(call);
    const before = (await call('POST', '/api/public/door-price', door, null)).body;
    saveSettings(db, ON);
    const conf = (await call('GET', '/api/public/configurator', null, null)).body;
    assert.equal(conf.promotion.percent, 10);
    assert.equal(conf.promotion.label, 'عرض الشتاء');
    const live = (await call('POST', '/api/public/door-price', door, null)).body;
    assert.equal(live.promo.percent, 10);
    assert.equal(live.promo.gross_subtotal, before.subtotal);
    assert.equal(live.subtotal, Math.round(before.subtotal * 0.9 * 100) / 100);
    assert.ok(live.total < before.total);

    const body = { ...door, customer_name: 'أحمد', customer_phone: '99123456' };
    const q = (await call('POST', '/api/public/door-quotes', body, null)).body;
    assert.equal(q.total, live.total);
    const row = db.prepare('SELECT details_json FROM quotes WHERE ref = ?').get(q.ref);
    const d = JSON.parse(row.details_json);
    assert.equal(d.promo_label, 'عرض الشتاء');
    assert.equal(d.discount_total, live.promo.amount);
    assert.equal(d.gross_subtotal, before.subtotal);
    const again = (await call('POST', '/api/public/door-quotes', body, null)).body;
    assert.equal(again.ref, q.ref, 'same request again: the same quote');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quotes').get().n, 1);
    const pdf = await call('GET', `/quotes/${q.ref}.pdf?k=${db.prepare('SELECT access_key FROM quotes').get().access_key}`, null, null);
    assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
});

test('the overhead range is discounted at both ends; a calculator outside the scope keeps its price', async (t) => {
    const { db, call } = await start(t);
    const conf = (await call('GET', '/api/public/overhead', null, null)).body;
    const motor = conf.motors[0];
    const region = conf.locations.flatMap((g) => g.wilayat).find((w) => w.overhead_installation_fee !== null) || conf.locations[0].wilayat[0];
    const req = { gate_type: 'Type A', width_cm: 415, height_cm: 250, motor_id: motor.id, region_id: region.id };
    const full = (await call('POST', '/api/public/overhead-price', req, null)).body;
    saveSettings(db, { ...ON, promo_scope: ['overhead'] });
    const cut = (await call('POST', '/api/public/overhead-price', req, null)).body;
    assert.equal(cut.subtotal, Math.round(full.subtotal * 0.9 * 100) / 100);
    assert.equal(cut.range.subtotal_to, Math.round(full.range.subtotal_to * 0.9 * 100) / 100);
    // Roller shutter is not in the scope
    const { door } = await doorRequest(call);
    assert.equal((await call('POST', '/api/public/door-price', door, null)).body.promo, null);
});

test('the AI assistant knows the offer and its prices already include it; employee quotes are untouched', async (t) => {
    const { db, call } = await start(t);
    saveSettings(db, { ...ON, promo_until: '2099-12-31' });
    const prompt = agent.systemPrompt(getSettings(db), db);
    assert.match(prompt, /عرض حالي للعملاء: «عرض الشتاء» خصم 10%/);
    assert.match(prompt, /لا تخصمه مرة ثانية/);
    const range = doors.priceRange(db, { widthCm: 300, heightCm: 250 });
    assert.equal(range.promotion.percent, 10);
    saveSettings(db, { promo_enabled: false });
    assert.doesNotMatch(agent.systemPrompt(getSettings(db), db), /عرض حالي/);
    const off = doors.priceRange(db, { widthCm: 300, heightCm: 250 });
    assert.ok(off.from > range.from, 'with the offer the AI quotes lower prices');

    saveSettings(db, ON);
    const q = (await call('POST', '/api/admin/quotes', { customer_phone: '96891111111', customer_name: 'x', items: [{ name: 'بوابة', unit: 'piece', quantity: 1, unit_price: 100 }] })).body;
    assert.equal(q.subtotal, 100, 'an employee quote keeps its own discounts only');
});

test('only managers set the offer; values are checked', async (t) => {
    const { db, call } = await start(t);
    assert.equal((await call('PUT', '/api/admin/settings', { promo_percent: 60 })).status, 400);
    assert.equal((await call('PUT', '/api/admin/settings', { promo_until: 'next week' })).status, 400);
    assert.equal((await call('PUT', '/api/admin/settings', { promo_scope: ['everything'] })).status, 400);
    assert.equal((await call('PUT', '/api/admin/settings', ON)).body.promo_enabled, true);
    staff.create(db, { username: 'sales', display_name: 'سالم', password: 'pass-12345', permissions: ['quotes', 'pricing'] });
    const tok = (await call('POST', '/api/auth/login', { username: 'sales', password: 'pass-12345' }, null)).body.token;
    assert.equal((await call('PUT', '/api/admin/settings', { promo_percent: 40 }, tok)).status, 403);
    assert.equal(getSettings(db).promo_percent, 10);
});

test('the PDF drops symbols its fonts cannot draw (an emoji or a flag in the promotion name)', () => {
    const { drawable, tokenize } = require('../src/pdf');
    assert.equal(drawable('عرض اليوم الوطني 🇴🇲 — خصم 20% ✨'), 'عرض اليوم الوطني — خصم 20%');
    assert.equal(drawable('Type A — 1.5 ملم (×2) «جديد»'), 'Type A — 1.5 ملم (×2) «جديد»');
    assert.ok(!tokenize('عرض 🎉 الشتاء').join('').includes('🎉'));
});
