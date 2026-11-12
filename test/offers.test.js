/* The manager's offers: a promotion on chosen parts only, a gift given in full with every gate,
   and an employee's discount on single lines of a gate */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase, getSettings, saveSettings } = require('../src/db');
const { createApp } = require('../src/server');
const promotions = require('../src/promotions');
const staffquotes = require('../src/staffquotes');
const overhead = require('../src/overhead');
const motors = require('../src/motors');
const agent = require('../src/agent');
const staff = require('../src/staff');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const PROMO = { promo_enabled: true, promo_percent: 15, promo_label: 'اليوم الوطني', promo_until: '', promo_scope: ['rolling_shutter', 'overhead'] };
const GIFT = { gift_enabled: true, gift_name: 'جهاز GSM opener', gift_price: 15, gift_until: '', gift_scope: ['rolling_shutter', 'overhead', 'motors'] };

async function start(t) {
    const db = openDatabase(':memory:');
    saveSettings(db, { vat_percent: 5 });
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = OWNER) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const type = res.headers.get('content-type') || '';
        return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
    };
    const conf = (await call('GET', '/api/public/configurator', null, null)).body;
    const type = conf.shutter_types.find((x) => x.variants.length === 1);
    const region = conf.locations[0].wilayat[0].id;
    const door = { width_cm: 300, height_cm: 250, count: 2, shutter_type_id: type.id, color_id: type.variants[0].colors[0].id,
        option_ids: conf.accessory_groups.map((g) => g.options[0].id), region_id: region };
    const oh = overhead.publicOverhead(db);
    const gate = { gateType: oh.gate_types[0].name, heightCm: oh.gate_types[0].heights[0].height_cm, widthCm: oh.gate_types[0].heights[0].widths[0], motorId: oh.motors[0].id, regionId: region };
    return { db, call, door, gate, region };
}

test('a promotion on chosen parts only: the slats of a roller shutter, an overhead gate without motor and installation', async (t) => {
    const { db, call, door, gate } = await start(t);
    const plain = (await call('POST', '/api/public/door-price', door, null)).body;
    const ohPlain = overhead.overheadPrice(db, gate);
    saveSettings(db, { ...PROMO, promo_parts: { rolling_shutter: ['slats'], overhead: ['gate'] } });

    const p = (await call('POST', '/api/public/door-price', door, null)).body;
    const slats = plain.items.filter((i) => /شرائح|لون|الصبغ/.test(i.name)).reduce((s, i) => s + i.line_total, 0);
    assert.equal(p.promo.amount, r2(slats * 0.15));
    assert.equal(p.subtotal, r2(plain.subtotal - r2(slats * 0.15)));
    assert.deepEqual(p.promo.parts, ['الشرائح']);

    const o = overhead.overheadPrice(db, gate);
    const g = ohPlain.items[0];
    assert.equal(o.promo.amount, r2(g.line_total * 0.15));
    assert.equal(o.promo.amount_to, r2(g.line_total_to * 0.15), 'the upper end of the range: the gate only');
    assert.deepEqual(o.promo.parts, ['البوابة']);

    // No parts chosen = every part (as before)
    saveSettings(db, { promo_parts: {} });
    assert.equal(overhead.overheadPrice(db, gate).promo.amount, r2(ohPlain.subtotal * 0.15));
    assert.equal(overhead.overheadPrice(db, gate).promo.parts.length, 0);

    // Settings are checked; only managers change them
    assert.equal((await call('PUT', '/api/admin/settings', { promo_parts: { overhead: ['slats'] } })).status, 400);
    assert.equal((await call('PUT', '/api/admin/settings', { promo_parts: { nope: ['gate'] } })).status, 400);
    assert.equal((await call('PUT', '/api/admin/settings', { gift_price: 5000 })).status, 400);
    staff.create(db, { username: 'sultan', display_name: 'سلطان', password: 'pass-12345', permissions: ['quotes'] });
    const tok = (await call('POST', '/api/auth/login', { username: 'sultan', password: 'pass-12345' }, null)).body.token;
    await call('PUT', '/api/admin/settings', { gift_enabled: true, gift_name: 'x', gift_price: 99, gift_scope: ['overhead'] }, tok);
    assert.equal(getSettings(db).gift_enabled, false, 'an employee cannot switch a gift on');
});

test('the gift: its price shown and given in full, one per gate, part of the total discount', async (t) => {
    const { db, call, door, gate, region } = await start(t);
    const plain = (await call('POST', '/api/public/door-price', door, null)).body;
    saveSettings(db, GIFT);
    const p = (await call('POST', '/api/public/door-price', door, null)).body;
    const line = p.items.find((i) => i.gift);
    assert.equal(line.quantity, 2, 'two roller shutters: two gifts');
    assert.equal(line.unit_price, 15);
    assert.equal(line.line_total, 30);
    assert.equal(p.subtotal, plain.subtotal, 'the customer pays the same');
    assert.equal(p.promo.amount, 30);
    assert.equal(p.promo.gift.amount, 30);
    assert.equal(p.promo.gross_subtotal, r2(plain.subtotal + 30));

    // Saved quote keeps the gift; PDF shows it; an invoice measured from the price after the offers
    const saved = await call('POST', '/api/public/door-quotes', { ...door, customer_name: 'خالد', customer_phone: '91234567' }, null);
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const q = db.prepare('SELECT * FROM quotes ORDER BY id DESC').get();
    const d = JSON.parse(q.details_json);
    assert.equal(d.gift_amount, 30);
    assert.equal(d.discount_total, 30);
    assert.equal(staffquotes.limitBase({ subtotal: q.subtotal, details: d }), q.subtotal);
    const pdf = await call('GET', `/api/admin/quotes/${q.id}/pdf`);
    assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');

    // Overhead: one gift, range kept; with a promotion both are in the total discount
    saveSettings(db, { ...PROMO, promo_parts: { overhead: ['gate'] } });
    const o = overhead.overheadPrice(db, gate);
    assert.equal(o.items.filter((i) => i.gift).length, 1);
    assert.equal(o.promo.amount, r2(o.promo.percent_amount + 15));
    assert.equal(o.promo.amount_to, r2(o.promo.percent_amount_to + 15));
    // Motors: a gift per kit; parts only: none
    const secs = motors.publicMotors(db).sections;
    const withKit = secs.find((s) => s.kits.length);
    const kits = motors.motorPrice(db, { sectionId: withKit.id, kitId: withKit.kits[0].id, kitCount: 2, parts: [], regionId: region });
    assert.equal(kits.items.find((i) => i.gift).quantity, 2);
    const withParts = secs.find((s) => s.parts.length);
    if (withParts) {
        const parts = motors.motorPrice(db, { sectionId: withParts.id, kitId: null, kitCount: 0, parts: [{ id: withParts.parts[0].id, qty: 1 }], regionId: region });
        assert.ok(!parts.items.some((i) => i.gift), 'parts only: no gift');
    }

    // The customer pages and the AI hear about it
    const info = promotions.publicInfo(getSettings(db));
    assert.equal(info.gift.name, 'جهاز GSM opener');
    assert.match(agent.systemPrompt(getSettings(db)), /جهاز GSM opener/);
    saveSettings(db, { gift_until: '2020-01-01' });
    assert.equal(promotions.activeGift(getSettings(db), 'overhead'), null, 'ended');
});

test('an employee quote: the offers per gate, a discount on one line, and only the employee\'s own discount counts', async (t) => {
    const { db, call, door } = await start(t);
    saveSettings(db, { ...PROMO, promo_parts: { rolling_shutter: ['slats'] }, ...GIFT });
    const params = { shutter_type_id: door.shutter_type_id, variant_id: null, color_id: door.color_id, width_cm: 300, height_cm: 250, count: 1, option_ids: door.option_ids };
    const base = staffquotes.price(db, { region_id: door.region_id, items: [{ calc: 'rolling_shutter', params }] }, getSettings(db));
    const lines = base.items.filter((i) => i.group === 0);
    const slat = lines.findIndex((i) => i.part === 'slats');
    const accessory = lines.findIndex((i) => i.part === 'accessories');
    const gift = lines.find((i) => i.gift);
    assert.ok(gift && gift.promo === 15 && gift.line_total === 0);
    assert.ok(lines[slat].promo > 0, 'the promotion on the slats');
    assert.ok(!lines[accessory].promo, 'not on the accessories');
    assert.equal(base.pricing.gift_amount, 15);
    assert.equal(base.pricing.gift_name, 'جهاز GSM opener');
    assert.equal(base.pricing.discount_percent, 0, 'the offers are not the employee\'s discount');

    // 10% on the accessory line only
    const acc = lines[accessory];
    const r = staffquotes.price(db, { region_id: door.region_id, items: [{ calc: 'rolling_shutter', params, item_discounts: { [accessory]: { type: 'percent', value: 10 } } }] }, getSettings(db));
    const after = r.items.filter((i) => i.group === 0)[accessory];
    assert.equal(after.discount.amount, r2(acc.gross * 0.1));
    assert.equal(r.subtotal, r2(base.subtotal - r2(acc.gross * 0.1)));
    assert.deepEqual(r.groups[0].item_discounts, { [accessory]: { type: 'percent', value: 10 } });
    const afterOffers = r2(r.pricing.gross_subtotal - r.pricing.promo_amount - r.pricing.gift_amount);
    assert.equal(r.pricing.discount_percent, Math.round((r2(acc.gross * 0.1) / afterOffers) * 10000) / 100);

    // Saved by an employee, edited, printed
    staff.create(db, { username: 'sultan', display_name: 'سلطان', password: 'pass-12345', permissions: ['quotes'] });
    const tok = (await call('POST', '/api/auth/login', { username: 'sultan', password: 'pass-12345' }, null)).body.token;
    const saved = await call('POST', '/api/admin/quotes', { customer_phone: '91234567', customer_name: 'خالد', region_id: door.region_id,
        items: [{ calc: 'rolling_shutter', params, item_discounts: { [accessory]: { type: 'percent', value: 10 } } }] }, tok);
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal(saved.body.details.gift_amount, 15);
    assert.deepEqual(saved.body.details.calc_groups[0].item_discounts, { [accessory]: { type: 'percent', value: 10 } });
    const pdf = await call('GET', `/api/admin/quotes/${saved.body.id}/pdf`, null, tok);
    assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
    // A discount larger than the line is refused
    assert.equal((await call('POST', '/api/admin/quotes/preview', { region_id: door.region_id, items: [{ calc: 'rolling_shutter', params, item_discounts: { [accessory]: { type: 'amount', value: 99999 } } }] }, tok)).status, 400);
});
