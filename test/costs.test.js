/* Cost & profit calculator in the quote builder: costs from the products, the overhead sizes / motors and the
   motor items; shown only to managers and the «أسعار الشراء» section; never to customers. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase, getSettings, saveSettings } = require('../src/db');
const { createApp } = require('../src/server');
const staff = require('../src/staff');
const { unitCost } = require('../src/pricing');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
const r2 = (n) => Math.round(n * 100) / 100;

async function start(t) {
    const db = openDatabase(':memory:');
    saveSettings(db, { vat_percent: 5 });
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = OWNER) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const login = async (u) => (await call('POST', '/api/auth/login', { username: u, password: 'pass-12345' }, null)).body.token;
    const { body: cat } = await call('GET', '/api/admin/quotes/catalog');
    const nizwa = cat.locations.flatMap((g) => g.wilayat).find((w) => w.name === 'نزوى');
    return { db, call, login, cat, nizwa };
}

test('overhead: the cost of the size and the motor, entered in the overhead section (hidden from others)', async (t) => {
    const { db, call, login, cat, nizwa } = await start(t);
    const oh = (await call('GET', '/api/admin/overhead')).body;
    assert.equal(oh.sees_cost, true);
    const gate = { gate_type: oh.sizes[0].gate_type, height_cm: oh.sizes[0].height_cm, width_cm: oh.sizes[0].width_cm, motor_id: null };
    // Before any cost is entered: listed as missing, never guessed
    const motorName = oh.motors[0].name;
    let p = (await call('POST', '/api/admin/quotes/preview', { region_id: nizwa.id, items: [{ calc: 'overhead', params: { ...gate, motor_id: cat.calculators.overhead.motors[0].id } }] })).body;
    assert.equal(p.cost.total_cost, 0);
    assert.equal(p.cost.missing.length, 2);

    // The manager enters the costs
    const sizes = oh.sizes.map((s, i) => ({ ...s, cost: i === 0 ? 250 : '' }));
    const motors = oh.motors.map((m, i) => ({ ...m, cost: i === 0 ? 90 : '' }));
    assert.equal((await call('PUT', '/api/admin/overhead', { sizes, motors })).status, 200);
    const motorId = db.prepare('SELECT id FROM overhead_motors WHERE name = ?').get(motorName).id;
    p = (await call('POST', '/api/admin/quotes/preview', { region_id: nizwa.id, extra_cost: 30, items: [{ calc: 'overhead', params: { ...gate, motor_id: motorId } }] })).body;
    assert.equal(p.cost.lines[0].cost, 340);
    assert.deepEqual(p.cost.missing, []);
    assert.equal(p.cost.revenue, p.subtotal);
    assert.equal(p.cost.total_cost, 370);
    assert.equal(p.cost.profit, r2(p.subtotal - 370));
    assert.equal(p.cost.margin_percent, Math.round(((p.subtotal - 370) / p.subtotal) * 10000) / 100);
    assert.equal(p.cost.markup_percent, Math.round(((p.subtotal - 370) / 370) * 10000) / 100);

    // An overhead editor without «أسعار الشراء»: sees no cost, and saving keeps the costs already there
    staff.create(db, { username: 'ohedit', display_name: 'محرر', password: 'pass-12345', permissions: ['overhead'] });
    const tok = await login('ohedit');
    const seen = (await call('GET', '/api/admin/overhead', null, tok)).body;
    assert.equal(seen.sees_cost, false);
    assert.ok(seen.sizes.every((s) => !('cost' in s)) && seen.motors.every((m) => !('cost' in m)));
    assert.equal((await call('PUT', '/api/admin/overhead', { sizes: seen.sizes.map((s) => ({ ...s, cost: 1 })), motors: seen.motors }, tok)).status, 200);
    assert.equal(db.prepare('SELECT cost FROM overhead_sizes WHERE gate_type = ? AND height_cm = ? AND width_cm = ?').get(gate.gate_type, gate.height_cm, gate.width_cm).cost, 250);
    assert.equal(db.prepare('SELECT cost FROM overhead_motors WHERE name = ?').get(motorName).cost, 90);

    // The customer pages never carry a cost
    const pub = JSON.stringify((await call('GET', '/api/public/overhead', null, '')).body);
    assert.ok(!pub.includes('cost'));
});

test('roller shutter, motors and catalog parts: costs from the products; free lines are flagged', async (t) => {
    const { db, call, cat, nizwa } = await start(t);
    const settings = getSettings(db);
    const rs = cat.calculators.rolling_shutter;
    const ty = rs.shutter_types[0];
    const v = ty.variants[0];
    const params = { shutter_type_id: ty.id, variant_id: v.id, color_id: v.colors[0] ? v.colors[0].id : null, width_cm: 300, height_cm: 250, count: 1,
        option_ids: rs.accessory_groups.filter((g) => !g.allow_none).map((g) => g.options[0].id) };
    const door = require('../src/doors').finalPrice(db, { widthCm: 300, heightCm: 250, count: 1, shutterTypeId: ty.id, variantId: v.id, colorId: params.color_id, optionIds: params.option_ids });
    let expected = 0;
    for (const it of door.items.filter((i) => i.product_id)) {
        const prod = db.prepare('SELECT * FROM products WHERE id = ?').get(it.product_id);
        const qty = it.unit === prod.unit ? it.quantity : it.quantity * settings.sqm_to_linear;
        expected += unitCost(prod, settings) * qty;
    }
    const sec = cat.calculators.motors.sections.find((s) => s.kits.length);
    db.prepare('UPDATE motor_items SET cost = 60 WHERE id = ?').run(sec.kits[0].id);
    const product = db.prepare('SELECT * FROM products WHERE active = 1 AND purchase_price > 0 LIMIT 1').get();
    const p = (await call('POST', '/api/admin/quotes/preview', { region_id: nizwa.id, items: [
        { calc: 'rolling_shutter', params },
        { calc: 'motors', params: { section_id: sec.id, kit_id: sec.kits[0].id, kit_count: 2, parts: [] } },
        { product_id: product.id, quantity: 3 },
        { name: 'قطعة خاصة', unit: 'piece', quantity: 1, unit_price: 40 }
    ] })).body;
    const c = p.cost;
    assert.equal(c.lines.length, 4);
    assert.ok(Math.abs(c.lines[0].cost - r2(expected)) <= 0.01, `${c.lines[0].cost} vs ${expected}`);
    assert.ok(c.lines[0].cost > 0 && c.lines[0].revenue > c.lines[0].cost);
    assert.equal(c.lines[1].cost, 120);
    assert.equal(c.lines[2].cost, r2(unitCost(product, settings) * 3));
    assert.equal(c.lines[3].cost, 0);
    assert.deepEqual(c.lines[3].missing, ['قطعة خاصة']);
    assert.equal(c.revenue, p.subtotal);
    assert.equal(c.total_cost, r2(c.lines.reduce((s, l) => s + l.cost, 0)));

    // The revenue follows the promotion and the discounts
    saveSettings(db, { promo_enabled: true, promo_percent: 20, promo_label: 'عرض', promo_scope: ['rolling_shutter'] });
    const promo = (await call('POST', '/api/admin/quotes/preview', { region_id: nizwa.id, items: [{ calc: 'rolling_shutter', params }], discount: { type: 'amount', value: 5 } })).body;
    assert.equal(promo.cost.revenue, promo.subtotal);
    assert.ok(promo.cost.lines[0].revenue < c.lines[0].revenue);
});

test('only managers and the «أسعار الشراء» section see costs; a saved quote carries none', async (t) => {
    const { db, call, login, nizwa, cat } = await start(t);
    staff.create(db, { username: 'sales', display_name: 'مبيعات', password: 'pass-12345', permissions: ['quotes'] });
    staff.create(db, { username: 'buyer', display_name: 'مشتريات', password: 'pass-12345', permissions: ['quotes', 'purchases'] });
    const og = cat.calculators.overhead;
    const body = { region_id: nizwa.id, items: [{ calc: 'overhead', params: { gate_type: og.gate_types[0].name, height_cm: og.gate_types[0].heights[0].height_cm, width_cm: og.gate_types[0].heights[0].widths[0], motor_id: og.motors[0].id } }] };
    const sales = await login('sales');
    assert.equal((await call('GET', '/api/admin/quotes/catalog', null, sales)).body.sees_cost, false);
    assert.equal((await call('POST', '/api/admin/quotes/preview', body, sales)).body.cost, undefined);
    const buyer = await login('buyer');
    assert.equal((await call('GET', '/api/admin/quotes/catalog', null, buyer)).body.sees_cost, true);
    assert.ok((await call('POST', '/api/admin/quotes/preview', body, buyer)).body.cost);
    const saved = await call('POST', '/api/admin/quotes', { ...body, extra_cost: 50, customer_phone: '91234567', customer_name: 'خالد' }, buyer);
    assert.equal(saved.status, 201);
    assert.ok(!JSON.stringify(saved.body).includes('cost'), 'no cost in the saved quote');
});
