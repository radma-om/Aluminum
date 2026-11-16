/* The pricing review's notes, fixed:
   1) a line's amount = the quantity shown × the unit price;
   2) an older purchase invoice entered late does not replace the current purchase price;
   3) a promotion with no parts chosen covers the goods, never the installation / delivery by surprise;
   4) free lines (a price typed by hand) can be kept to managers, and are counted on the quote;
   5) the AI's comparison of options shows prices after the running promotion;
   6) the cost & profit is marked incomplete when a cost is missing. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase, getSettings, saveSettings } = require('../src/db');
const { createApp } = require('../src/server');
const doors = require('../src/doors');
const staff = require('../src/staff');
const sq = require('../src/staffquotes');
const costs = require('../src/costs');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const r2 = (n) => Math.round(n * 100) / 100;
const door = { widthCm: 333, heightCm: 277, count: 2, shutterTypeId: 3, variantId: 4, colorId: 14, optionIds: [2, 5, 8, 11], regionId: 1 };

async function start(t) {
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
    return { db, call, login };
}

test('1) every line: amount = the quantity shown × the unit price', () => {
    const db = openDatabase(':memory:');
    const priced = doors.finalPrice(db, door);
    for (const i of priced.items) assert.equal(i.line_total, r2(i.quantity * i.unit_price), `${i.name}: ${i.quantity} × ${i.unit_price}`);
    assert.equal(priced.subtotal, r2(priced.items.reduce((s, i) => s + i.line_total, 0)));
});

test('2) a purchase invoice dated before the newest one is recorded but keeps the current price', async (t) => {
    const { db, call } = await start(t);
    const add = (unit_price, purchased_at) => call('POST', '/api/admin/purchases', { product_id: 5, unit_price, purchased_at });
    const now = await add(1.4, '2026-11-10');
    assert.equal(now.body.product.purchase_price, 1.4);
    const older = await add(1.1, '2026-10-01');
    assert.equal(older.status, 201);
    assert.equal(older.body.price_kept, true);
    assert.equal(older.body.newer_purchase_on, '2026-11-10');
    assert.equal(db.prepare('SELECT purchase_price FROM products WHERE id = 5').get().purchase_price, 1.4, 'still the newest');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purchases WHERE product_id = 5').get().n, 2, 'both are in the history');
    const newer = await add(1.5, '2026-11-12');
    assert.ok(!newer.body.price_kept);
    assert.equal(newer.body.product.purchase_price, 1.5);
});

test('3) a promotion with no parts chosen: the goods are discounted, the installation is not', () => {
    const db = openDatabase(':memory:');
    const plain = doors.finalPrice(db, door);
    saveSettings(db, { promo_enabled: true, promo_percent: 10, promo_scope: ['rolling_shutter'], promo_parts: {} });
    const cut = doors.finalPrice(db, door);
    const goods = plain.items.filter((i) => !['installation', 'delivery'].includes(i.part)).reduce((s, i) => s + i.line_total, 0);
    assert.equal(cut.promo.percent_amount, r2(goods * 0.1));
    saveSettings(db, { promo_parts: { rolling_shutter: ['slats', 'accessories', 'motor', 'installation', 'delivery'] } });
    assert.equal(doors.finalPrice(db, door).promo.percent_amount, r2(plain.subtotal * 0.1), 'ticked: the installation too');
});

test('4) free lines: counted on the quote; when the manager switches them off, only managers add them', async (t) => {
    const { db, call, login } = await start(t);
    staff.create(db, { username: 'sara', display_name: 'سارة', password: 'pass-12345', permissions: ['quotes'] });
    const sara = await login('sara');
    const quote = { customer_name: 'عميل', customer_phone: '91234567', items: [{ name: 'بوابة خاصة', quantity: 1, unit_price: 5 }, { product_id: 7, quantity: 2 }] };
    const ok = await call('POST', '/api/admin/quotes', quote, sara);
    assert.equal(ok.status, 201);
    assert.equal(JSON.parse(db.prepare('SELECT details_json FROM quotes WHERE id = ?').get(ok.body.id).details_json).free_lines, 1);

    saveSettings(db, { staff_free_lines: false });
    const preview = await call('POST', '/api/admin/quotes/preview', quote, sara);
    assert.equal(preview.body.free_lines_allowed, false);
    const refused = await call('POST', '/api/admin/quotes', quote, sara);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /للمديرين فقط/);
    assert.equal((await call('PUT', `/api/admin/quotes/${ok.body.id}`, quote, sara)).status, 400, 'nor when editing a quote');
    // Catalog lines only: fine; and the manager may still add free lines
    assert.equal((await call('POST', '/api/admin/quotes', { ...quote, items: [quote.items[1]] }, sara)).status, 201);
    assert.equal((await call('POST', '/api/admin/quotes', quote)).status, 201);
    // Only managers change the switch
    assert.equal((await call('PUT', '/api/admin/settings', { staff_free_lines: true }, sara)).status, 403);
});

test('5) the AI compares options at the prices after the promotion', () => {
    const db = openDatabase(':memory:');
    const args = { widthCm: 300, heightCm: 250, count: 1, shutterTypeId: 1 };
    const before = doors.compareOptions(db, args);
    saveSettings(db, { promo_enabled: true, promo_percent: 10, promo_scope: ['rolling_shutter'], promo_parts: { rolling_shutter: ['slats'] } });
    const after = doors.compareOptions(db, args);
    assert.equal(after.promotion.percent, 10);
    assert.ok(Math.abs(after.thickness_options[0].colors[0].slats_price_with_vat - before.thickness_options[0].colors[0].slats_price_with_vat * 0.9) <= 0.011, 'the slats: 10% less');
    assert.deepEqual(after.accessories.map((g) => g.classes.map((c) => c.price_with_vat)), before.accessories.map((g) => g.classes.map((c) => c.price_with_vat)), 'not in the promotion: unchanged');
});

test('6) a missing cost marks the profit as incomplete', () => {
    const db = openDatabase(':memory:');
    const settings = getSettings(db);
    const gate = { region_id: 1, items: [{ calc: 'rolling_shutter', params: { width_cm: 300, height_cm: 250, count: 1, shutter_type_id: 1, variant_id: 1, color_id: 1, option_ids: [1, 4, 7, 10] } }] };
    const c = costs.quoteCost(db, gate, sq.price(db, gate, settings), settings);
    assert.equal(c.complete, false, 'the sample slats have no purchase price');
    assert.ok(c.missing.length);
    const motorOnly = { items: [{ product_id: 8, quantity: 1 }] };
    assert.equal(costs.quoteCost(db, motorOnly, sq.price(db, motorOnly, settings), settings).complete, true);
});
