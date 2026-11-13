/* Quotes built by an employee, with line and total discounts within their limit */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase, getSettings, saveSettings } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const staffquotes = require('../src/staffquotes');
const staff = require('../src/staff');
const customers = require('../src/customers');
const webhooks = require('../src/webhooks');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;

async function start(t) {
    const db = openDatabase(':memory:');
    saveSettings(db, { vat_percent: 5 });
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = OWNER) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
        const type = res.headers.get('content-type') || '';
        return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
    };
    const login = async (u, p = 'pass-12345') => (await call('POST', '/api/auth/login', { username: u, password: p }, null)).body.token;
    const product = Number(db.prepare("INSERT INTO products (category, name, unit, purchase_price, sell_price, active) VALUES ('accessory', 'ريموت', 'piece', 5, 20, 1)").run().lastInsertRowid);
    return { db, call, login, product };
}

test('the calculation: catalog price (cannot be typed over), free lines, line and total discounts, VAT', async (t) => {
    const { db, product } = await start(t);
    const settings = getSettings(db);
    const unit = staffquotes.price(db, { items: [{ product_id: product, quantity: 1 }] }, settings).items[0].unit_price;
    const r = staffquotes.price(db, {
        items: [
            { product_id: product, quantity: 2, unit_price: 0.01, discount: { type: 'percent', value: 10 } }, // a typed price is ignored
            { name: 'تركيب', unit: 'service', quantity: 1, unit_price: 100, discount: { type: 'amount', value: 20 } }
        ],
        discount: { type: 'percent', value: 5 }
    }, settings);
    const g1 = Math.round(unit * 2 * 100) / 100;
    assert.equal(r.items[0].unit_price, unit);
    assert.equal(r.items[0].gross, g1);
    assert.equal(r.items[0].line_total, Math.round(g1 * 0.9 * 100) / 100);
    assert.equal(r.items[1].line_total, 80);
    const lines = r.items[0].line_total + 80;
    assert.equal(r.subtotal, Math.round((lines - Math.round(lines * 0.05 * 100) / 100) * 100) / 100);
    assert.equal(r.vat, Math.round(r.subtotal * 5) / 100);
    assert.equal(r.total, Math.round((r.subtotal + r.vat) * 100) / 100);
    assert.equal(r.pricing.gross_subtotal, Math.round((g1 + 100) * 100) / 100);
    assert.equal(r.pricing.discount_total, Math.round((r.pricing.gross_subtotal - r.subtotal) * 100) / 100);
    assert.ok(r.pricing.discount_percent > 0);
    for (const bad of [
        { items: [] },
        { items: [{ name: 'x', unit_price: 10, quantity: 0 }] },
        { items: [{ name: '', unit_price: 10, quantity: 1 }] },
        { items: [{ name: 'x', unit_price: 10, quantity: 1, discount: { type: 'percent', value: 120 } }] },
        { items: [{ name: 'x', unit_price: 10, quantity: 1, discount: { type: 'amount', value: 11 } }] },
        { items: [{ name: 'x', unit_price: 10, quantity: 1 }], discount: { type: 'amount', value: 11 } },
        { items: [{ product_id: 99999, quantity: 1 }] }
    ]) assert.throws(() => staffquotes.price(db, bad, settings), (e) => e.status === 400, JSON.stringify(bad));
});

test('an employee creates a quote for a customer within their limit; over it is refused; managers have no limit', async (t) => {
    const { db, call, login } = await start(t);
    const emitted = [];
    const originalEmit = webhooks.emit;
    webhooks.emit = (hookDb, event, data) => {
        emitted.push({ db: hookDb, event, data });
        return Promise.resolve([]);
    };
    t.after(() => { webhooks.emit = originalEmit; });
    staff.create(db, { username: 'sales', display_name: 'سالم', password: 'pass-12345', permissions: ['quotes', 'customers'] });
    const tok = await login('sales');
    const lines = (pct) => ({ customer_phone: '91234567', customer_name: 'خالد', customer_city: 'السيب', items: [{ name: 'بوابة خاصة', unit: 'piece', quantity: 1, unit_price: 1000 }], discount: { type: 'percent', value: pct } });

    const over = await call('POST', '/api/admin/quotes', lines(15), tok);
    assert.equal(over.status, 400);
    assert.match(over.body.error, /أكبر من الحد المسموح لك \(10%\)/);
    const preview = (await call('POST', '/api/admin/quotes/preview', lines(15), tok)).body;
    assert.equal(preview.over_limit, true);
    assert.equal(preview.discount_limit, 10);

    const r = await call('POST', '/api/admin/quotes', { ...lines(10), notes: 'يشمل التركيب', validity_days: 7 }, tok);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const q = r.body;
    assert.equal(q.source, 'staff');
    assert.equal(q.customer_phone, '96891234567');
    assert.equal(q.subtotal, 900);
    assert.equal(q.total, 945);
    assert.equal(q.details.staff_quote, true);
    assert.equal(q.details.created_by, 'سالم');
    assert.equal(q.details.discount_total, 100);
    assert.equal(q.details.discount_percent, 10);
    const in7 = new Date(Date.parse(require('../src/leads').localToday() + 'T00:00:00Z') + 7 * 86400000).toISOString().slice(0, 10);
    assert.equal(q.valid_until, in7);
    assert.equal(db.prepare('SELECT valid_until FROM quotes WHERE id = ?').get(q.id).valid_until, in7);
    const createdEvent = emitted.find((e) => e.event === 'quote.created' && e.data.id === q.id);
    assert.ok(createdEvent, 'the quote.created webhook was emitted');
    assert.equal(createdEvent.db, db);
    assert.equal(createdEvent.data.valid_until, in7, 'the webhook sees the selected validity before delivery');
    assert.ok(customers.byPhone(db, '96891234567'), 'the customer record exists');
    assert.ok(db.prepare("SELECT 1 FROM leads WHERE phone = '96891234567'").get(), 'and their follow-up');
    const pdf = await call('GET', `/api/admin/quotes/${q.id}/pdf`, null, tok);
    assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');

    // The employee's own limit replaces the general one; managers have none
    const u = db.prepare("SELECT id FROM staff_users WHERE username = 'sales'").get();
    await call('PUT', `/api/admin/users/${u.id}`, { max_discount_percent: 20 });
    assert.equal((await call('POST', '/api/admin/quotes', lines(15), tok)).status, 201);
    assert.equal((await call('POST', '/api/admin/quotes', lines(60))).status, 201, 'the general manager');
    assert.equal((await call('PUT', '/api/admin/settings', { staff_max_discount_percent: 150 })).status, 400);

    // From a customer record
    const c = customers.byPhone(db, '96891234567');
    const fromRecord = (await call('POST', '/api/admin/quotes', { customer_id: c.id, items: [{ name: 'صيانة', unit: 'service', quantity: 1, unit_price: 50 }] }, tok)).body;
    assert.equal(fromRecord.customer_name, 'خالد');
    const actions = (await call('GET', '/api/admin/audit')).body.entries.map((e) => e.action);
    assert.ok(actions.includes('إنشاء عرض سعر (موظف)'));
    assert.ok(!actions.some((a) => /preview/.test(a)), 'previews are not logged');
});

test('an own-customer employee cannot create a quote by typing another employee phone', async (t) => {
    const { db, call, login } = await start(t);
    saveQuote(db, { customer_name: 'عميل سالم', customer_phone: '96891111111', source: 'web', priced: { items: [], subtotal: 10, vat_percent: 5, vat: 0.5, total: 10.5 } });
    saveQuote(db, { customer_name: 'عميل مريم', customer_phone: '96892222222', source: 'web', priced: { items: [], subtotal: 10, vat_percent: 5, vat: 0.5, total: 10.5 } });
    db.prepare("UPDATE leads SET assigned_to = 'سالم' WHERE phone = '96891111111'").run();
    db.prepare("UPDATE leads SET assigned_to = 'مريم' WHERE phone = '96892222222'").run();
    staff.create(db, { username: 'salem-scope', display_name: 'سالم', password: 'pass-12345', permissions: ['quotes'], leads_scope: 'mine' });
    const token = await login('salem-scope');
    const body = { customer_name: 'عميل مريم', customer_phone: '96892222222', items: [{ name: 'خدمة', unit: 'service', quantity: 1, unit_price: 50 }] };
    assert.equal((await call('POST', '/api/admin/quotes', body, token)).status, 404);
    assert.equal((await call('POST', '/api/admin/quotes', { ...body, customer_name: 'عميل سالم', customer_phone: '96891111111' }, token)).status, 201);
});

test('the same limit applies when an invoice lowers the amount', async (t) => {
    const { db, call, login } = await start(t);
    staff.create(db, { username: 'acc', display_name: 'المحاسب', password: 'pass-12345', permissions: ['quotes', 'invoices'] });
    const tok = await login('acc');
    const q = (await call('POST', '/api/admin/quotes', { customer_phone: '96891111111', customer_name: 'عميل', items: [{ name: 'بوابة', unit: 'piece', quantity: 1, unit_price: 1000 }], discount: { type: 'percent', value: 8 } }, tok)).body;
    // 8% already given; lowering to 850 makes it 15% of the price before discounts
    const refused = await call('POST', `/api/admin/quotes/${q.id}/invoice`, { final_subtotal: 850 }, tok);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /15%/);
    assert.equal((await call('POST', `/api/admin/quotes/${q.id}/invoice`, { final_subtotal: 900 }, tok)).status, 201);
    // A calculator quote: the limit counts from its own price
    const calc = saveQuote(db, { customer_name: 'ب', customer_phone: '96892222222', source: 'web', priced: { items: [{ name: 'x', quantity: 1, unit: 'piece', unit_price: 100, line_total: 100 }], subtotal: 100, vat_percent: 5, vat: 5, total: 105 } });
    assert.equal((await call('POST', `/api/admin/quotes/${calc.id}/invoice`, { final_subtotal: 80 }, tok)).status, 400);
    assert.equal((await call('POST', `/api/admin/quotes/${calc.id}/invoice`, { final_subtotal: 80 })).status, 201, 'the general manager');
});

test('editing the lines: an employee quote before it is invoiced; calculator quotes are never rewritten', async (t) => {
    const { db, call } = await start(t);
    const q = (await call('POST', '/api/admin/quotes', { customer_phone: '96891111111', customer_name: 'عميل', items: [{ name: 'بوابة', unit: 'piece', quantity: 1, unit_price: 500 }] })).body;
    const edited = await call('PUT', `/api/admin/quotes/${q.id}`, { items: [{ name: 'بوابة', unit: 'piece', quantity: 2, unit_price: 500, discount: { type: 'amount', value: 50 } }], notes: 'بعد الزيارة' });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.subtotal, 950);
    assert.equal(edited.body.notes, 'بعد الزيارة');
    assert.equal(edited.body.ref, q.ref);
    await call('POST', `/api/admin/quotes/${q.id}/invoice`, {});
    assert.equal((await call('PUT', `/api/admin/quotes/${q.id}`, { items: [{ name: 'x', unit: 'piece', quantity: 1, unit_price: 1 }] })).status, 400, 'invoiced');
    const calc = saveQuote(db, { customer_name: 'ب', customer_phone: '96892222222', source: 'web', priced: { items: [{ name: 'x', quantity: 1, unit: 'piece', unit_price: 100, line_total: 100 }], subtotal: 100, vat_percent: 5, vat: 5, total: 105 } });
    const r = await call('PUT', `/api/admin/quotes/${calc.id}`, { items: [{ name: 'x', unit: 'piece', quantity: 1, unit_price: 1 }] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /حاسبة العملاء أو المساعد/);
});

test('permissions: building quotes needs the quotes section', async (t) => {
    const { db, call, login } = await start(t);
    staff.create(db, { username: 'leadsonly', display_name: 'مريم', password: 'pass-12345', permissions: ['leads'] });
    const tok = await login('leadsonly');
    assert.equal((await call('GET', '/api/admin/quotes/catalog', null, tok)).status, 403);
    assert.equal((await call('POST', '/api/admin/quotes', { customer_phone: '96891111111', customer_name: 'x', items: [{ name: 'x', unit: 'piece', quantity: 1, unit_price: 1 }] }, tok)).status, 403);
    const cat = (await call('GET', '/api/admin/quotes/catalog')).body;
    assert.ok(cat.products.length >= 1);
    assert.equal(cat.discount_limit, null, 'the general manager');
});

test('gates and motors by section: priced like the customer calculators, with the wilayah installation', async (t) => {
    const { db, call, login } = await start(t);
    const doors = require('../src/doors');
    const overhead = require('../src/overhead');
    const motors = require('../src/motors');
    const { body: cat } = await call('GET', '/api/admin/quotes/catalog');
    const nizwa = cat.locations.flatMap((g) => g.wilayat).find((w) => w.name === 'نزوى');
    assert.ok(nizwa && cat.calculators.overhead.gate_types.length && cat.calculators.motors.sections.length);
    const og = cat.calculators.overhead;
    const gate = { gate_type: og.gate_types[0].name, height_cm: og.gate_types[0].heights[0].height_cm, width_cm: og.gate_types[0].heights[0].widths[0], motor_id: og.motors[0].id };
    const sec = cat.calculators.motors.sections.find((s) => s.kits.length);
    const kit = { section_id: sec.id, kit_id: sec.kits[0].id, kit_count: 1, parts: [], installation: true };

    // A wilayah is needed for gates and motors
    const noRegion = await call('POST', '/api/admin/quotes/preview', { items: [{ calc: 'overhead', params: gate }] });
    assert.equal(noRegion.status, 400);

    const engineGate = overhead.overheadPrice(db, { gateType: gate.gate_type, heightCm: gate.height_cm, widthCm: gate.width_cm, motorId: gate.motor_id, regionId: nizwa.id });
    const engineKit = motors.motorPrice(db, { sectionId: kit.section_id, kitId: kit.kit_id, kitCount: 1, parts: [], regionId: nizwa.id, installation: true });
    const sum = (items, k = 'line_total') => Math.round(items.reduce((s, i) => s + (i[k] ?? i.line_total), 0) * 100) / 100;

    const items = [
        { calc: 'overhead', params: gate },
        { calc: 'overhead', params: gate, price_level: 'to' },
        { calc: 'motors', params: kit, discount: { type: 'percent', value: 5 } },
        { name: 'إزالة بوابة قديمة', unit: 'service', quantity: 1, unit_price: 15 }
    ];
    const p = (await call('POST', '/api/admin/quotes/preview', { region_id: nizwa.id, items })).body;
    assert.equal(p.groups.length, 3);
    assert.equal(p.groups[0].gross, sum(engineGate.items));
    assert.equal(p.groups[1].gross, sum(engineGate.items, 'line_total_to'));
    assert.ok(p.groups[1].gross > p.groups[0].gross, 'the upper end of the overhead range');
    assert.equal(p.groups[2].gross, sum(engineKit.items));
    assert.equal(p.groups[2].total, Math.round(p.groups[2].gross * 0.95 * 100) / 100);
    // The installation line of the wilayah is in each gate
    assert.ok(p.items.filter((i) => i.group === 0).some((i) => /تركيب/.test(i.name)));
    assert.equal(p.items.at(-1).group, undefined);
    assert.equal(p.items.at(-1).line_total, 15);

    // A roller shutter gate, if the catalog has one, with every accessory group chosen
    const rs = cat.calculators.rolling_shutter;
    if (rs.shutter_types.length) {
        const ty = rs.shutter_types[0];
        const v = ty.variants[0];
        const params = { shutter_type_id: ty.id, variant_id: v.id, color_id: v.colors[0] ? v.colors[0].id : null, width_cm: 300, height_cm: 250, count: 2,
            option_ids: rs.accessory_groups.filter((g) => !g.allow_none).map((g) => g.options[0].id) };
        const door = doors.finalPrice(db, { widthCm: 300, heightCm: 250, count: 2, shutterTypeId: ty.id, variantId: v.id, colorId: params.color_id, optionIds: params.option_ids, regionId: nizwa.id });
        const r = (await call('POST', '/api/admin/quotes/preview', { region_id: nizwa.id, items: [{ calc: 'rolling_shutter', params }] })).body;
        assert.equal(r.groups[0].gross, sum(door.items));
    }


    // Saved with the wilayah and each gate, so it can be edited later; the group discount counts towards the limit
    staff.create(db, { username: 'emp', display_name: 'موظف', password: 'pass-12345', permissions: ['quotes'] });
    const emp = await login('emp');
    const over = await call('POST', '/api/admin/quotes', { customer_phone: '96891234567', customer_name: 'خالد', region_id: nizwa.id, items: [{ calc: 'motors', params: kit, discount: { type: 'percent', value: 15 } }] }, emp);
    assert.match(over.body.error, /الحد المسموح/);
    assert.equal(over.status, 400);
    const ok = await call('POST', '/api/admin/quotes', { customer_phone: '96891234567', customer_name: 'خالد', region_id: nizwa.id, items }, OWNER);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const q = ok.body;
    const d = q.details;
    assert.equal(d.region_id, nizwa.id);
    assert.equal(d.calc_groups.length, 3);
    assert.equal(q.customer_city, 'نزوى');
    assert.equal(q.total, p.total);
    // Editing keeps the groups (here: drop the second gate)
    const ed = await call('PUT', `/api/admin/quotes/${ok.body.id}`, { region_id: nizwa.id, items: [items[0], items[2], items[3]] });
    assert.equal(ed.status, 200, JSON.stringify(ed.body));
    assert.equal(ed.body.details.calc_groups.length, 2);
    assert.equal(ed.body.details.created_by, q.details.created_by);
    // The PDF prints a heading for each gate
    const pdf = await call('GET', `/api/admin/quotes/${ok.body.id}/pdf`);
    assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
});

test('the manager\'s promotion applies by itself to employee quotes, and is not counted in the employee\'s limit', async (t) => {
    const { db, call, login } = await start(t);
    const overhead = require('../src/overhead');
    const { body: cat } = await call('GET', '/api/admin/quotes/catalog');
    const nizwa = cat.locations.flatMap((g) => g.wilayat).find((w) => w.name === 'نزوى');
    const og = cat.calculators.overhead;
    const gate = { gate_type: og.gate_types[0].name, height_cm: og.gate_types[0].heights[0].height_cm, width_cm: og.gate_types[0].heights[0].widths[0], motor_id: og.motors[0].id };
    saveSettings(db, { promo_enabled: true, promo_percent: 20, promo_label: 'عرض اليوم الوطني', promo_scope: ['overhead'] });
    assert.equal((await call('GET', '/api/admin/quotes/catalog')).body.promotion.percent, 20);

    // The same price the customer calculator gives with the promotion
    const customer = overhead.overheadPrice(db, { gateType: gate.gate_type, heightCm: gate.height_cm, widthCm: gate.width_cm, motorId: gate.motor_id, regionId: nizwa.id });
    assert.ok(customer.promo);
    const free = { name: 'إزالة بوابة قديمة', unit: 'service', quantity: 1, unit_price: 20 };
    const p = (await call('POST', '/api/admin/quotes/preview', { region_id: nizwa.id, items: [{ calc: 'overhead', params: gate }, free] })).body;
    assert.equal(p.groups[0].total, customer.subtotal);
    assert.equal(p.pricing.promo_amount, customer.promo.amount);
    assert.equal(p.pricing.promo_label, 'عرض اليوم الوطني');
    assert.equal(p.items.at(-1).line_total, 20, 'a free line is not part of the promotion');
    assert.equal(p.pricing.discount_percent, 0, 'the promotion is not the employee\'s discount');

    // An employee with a 10% limit: 10% on top of the promotion is fine, 15% is not
    staff.create(db, { username: 'sultan', display_name: 'سلطان', password: 'pass-12345', permissions: ['quotes', 'invoices'] });
    const tok = await login('sultan');
    const body = (pct) => ({ customer_phone: '91234567', customer_name: 'خالد', region_id: nizwa.id, items: [{ calc: 'overhead', params: gate, discount: { type: 'percent', value: pct } }] });
    const ok = await call('POST', '/api/admin/quotes', body(10), tok);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.details.discount_percent, 10);
    assert.equal(ok.body.details.promo_amount, customer.promo.amount);
    assert.equal(ok.body.subtotal, Math.round(customer.subtotal * 0.9 * 100) / 100);
    assert.equal((await call('POST', '/api/admin/quotes', body(15), tok)).status, 400);
    const pdf = await call('GET', `/api/admin/quotes/${ok.body.id}/pdf`, null, tok);
    assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');

    // An invoice from a customer's promotion quote: lowering it by 10% more stays within the limit
    const promoQuote = (await call('POST', '/api/admin/quotes', body(0), OWNER)).body;
    const inv = await call('POST', `/api/admin/quotes/${promoQuote.id}/invoice`, { final_subtotal: Math.round(promoQuote.subtotal * 0.91 * 100) / 100 }, tok);
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    const promoQuote2 = (await call('POST', '/api/admin/quotes', body(0), OWNER)).body;
    assert.equal((await call('POST', `/api/admin/quotes/${promoQuote2.id}/invoice`, { final_subtotal: Math.round(promoQuote2.subtotal * 0.8 * 100) / 100 }, tok)).status, 400);
    assert.equal(staffquotes.limitBase({ subtotal: 80, details: { promo_label: 'x', gross_subtotal: 100, discount_total: 20 } }), 80, 'customer calculator quote');

    // The promotion over: no promotion on a new quote
    saveSettings(db, { promo_enabled: false });
    const after = (await call('POST', '/api/admin/quotes/preview', { region_id: nizwa.id, items: [{ calc: 'overhead', params: gate }] })).body;
    assert.equal(after.pricing.promo_amount, undefined);
    assert.equal(after.subtotal, customer.promo.gross_subtotal);
});
