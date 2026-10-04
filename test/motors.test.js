const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/server');
const { executeTool } = require('../src/agent');
const { exportWorkbook, restoreWorkbook } = require('../src/backup');

process.env.ADMIN_TOKEN = 'test-token';

async function start() {
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = 'test-token') => {
        const res = await fetch(base + url, {
            method,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: body ? JSON.stringify(body) : undefined
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    return { db, server, base, call };
}

const wilayah = (conf, name) => conf.locations.flatMap((g) => g.wilayat).find((w) => w.name === name);
const customer = { customer_name: 'سالم', customer_phone: '91234567' };

test('the customer page offers only priced, active items — without prices', async (t) => {
    const { server, base, call } = await start();
    t.after(() => server.close());
    const { body: conf } = await call('GET', '/api/public/motors', null, '');
    // Only sections with something to sell are shown (swing and parking barrier wait for their items)
    assert.deepStrictEqual(conf.sections.map((s) => s.name), ['مكائن البوابات المنزلقة']);
    const [sliding] = conf.sections;
    assert.match(sliding.description, /منزلقة/);
    assert.strictEqual(sliding.extra_fees.length, 2);
    // Only the 600 kg kit has a cost (115) in a new database; 800/1200/1500 and the parts wait for prices
    assert.deepStrictEqual(sliding.kits.map((k) => k.name), ['مكينة بوابة منزلقة 600 كجم']);
    assert.match(sliding.kits[0].description, /4 أمتار مسننات/);
    assert.deepStrictEqual(sliding.parts, []);
    assert.ok(!JSON.stringify(conf).includes('price') && !JSON.stringify(conf).includes('cost'));
    assert.ok(wilayah(conf, 'نزوى'));
    assert.strictEqual((await fetch(base + '/motors')).status, 200);
});

test('kit price = cost + profit, installation per kit by wilayah, delivery once, plus VAT', async (t) => {
    const { db, server, call } = await start();
    t.after(() => server.close());
    const { body: admin } = await call('GET', '/api/admin/motors');
    assert.strictEqual(admin.profit_percent, 15);
    const items = admin.items.map((i) => ({ ...i, active: true, cost: i.cost ?? (i.kind === 'part' ? 4 : 150) }));
    assert.strictEqual((await call('PUT', '/api/admin/motors', { items, profit_percent: 15 })).status, 200);

    const { body: conf } = await call('GET', '/api/public/motors', null, '');
    const nizwa = wilayah(conf, 'نزوى');
    db.prepare('UPDATE regions SET motor_installation_fee = 25, delivery_fee = 10 WHERE id = ?').run(nizwa.id);
    const kit = conf.sections[0].kits.find((k) => k.name.includes('600'));
    const rack = conf.sections[0].parts.find((p) => p.name.includes('Rail rack'));
    assert.strictEqual(rack.unit, 'قطعة');

    const res = await call('POST', '/api/public/motor-quotes', {
        ...customer, section_id: conf.sections[0].id, kit_id: kit.id, kit_count: 2, parts: [{ id: rack.id, qty: 3 }], region_id: nizwa.id
    }, '');
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    const p = res.body;
    // 115 × 1.15 = 132.25 per kit; rack 4 × 1.15 = 4.60 per piece; installation 25 per kit; delivery 10 once
    assert.deepStrictEqual(p.items.map((i) => [i.name, i.quantity, i.unit_price, i.line_total]), [
        ['مكينة بوابة منزلقة 600 كجم', 2, 132.25, 264.5],
        ['مسننات (Rail rack)', 3, 4.6, 13.8],
        ['التركيب', 2, 25, 50],
        ['التوصيل', 1, 10, 10]
    ]);
    assert.strictEqual(p.subtotal, 338.3);
    assert.strictEqual(p.total, 355.22);
    assert.strictEqual(p.details.calculator, 'motors');
    assert.deepStrictEqual(p.details.parts, ['مسننات (Rail rack) × 3']);
    assert.strictEqual(p.details.fees_note, 'شامل التركيب');
    assert.match(p.details.extra_fees_note, /التسليكات الكهربائية: تُحدد بعد المعاينة/);

    const pdf = await fetch(new URL(p.pdf_url, 'http://127.0.0.1:' + server.address().port));
    assert.strictEqual(pdf.status, 200);
    assert.strictEqual(pdf.headers.get('content-type'), 'application/pdf');

    // Parts only (no kit): no installation; a wilayah without a motor fee: installation after a visit
    const partsOnly = await call('POST', '/api/public/motor-quotes', {
        ...customer, section_id: conf.sections[0].id, kit_id: null, parts: [{ id: rack.id, qty: 1 }], region_id: nizwa.id
    }, '');
    assert.deepStrictEqual(partsOnly.body.items.map((i) => i.name), ['مسننات (Rail rack)', 'التوصيل']);
    assert.strictEqual(partsOnly.body.details.extra_fees_note, null); // no installation, no installation fees
    const ibri = wilayah(conf, 'عبري');
    db.prepare('UPDATE regions SET motor_installation_fee = NULL, delivery_fee = 0 WHERE id = ?').run(ibri.id);
    // Old pages may still send the section key ('sliding')
    const visit = await call('POST', '/api/public/motor-quotes', { ...customer, section: 'sliding', kit_id: kit.id, kit_count: 1, region_id: ibri.id }, '');
    assert.strictEqual(visit.body.total, 138.86); // 132.25 + 5% VAT
    assert.match(visit.body.details.fees_note, /بعد المعاينة/);

    // Nothing chosen, or a section without items
    assert.strictEqual((await call('POST', '/api/public/motor-quotes', { ...customer, section: 'sliding', region_id: nizwa.id }, '')).status, 400);
    assert.strictEqual((await call('POST', '/api/public/motor-quotes', { ...customer, section: 'swing', kit_id: kit.id, region_id: nizwa.id }, '')).status, 400);
    assert.strictEqual((await call('POST', '/api/public/motor-quotes', { ...customer, section_id: 999, kit_id: kit.id, region_id: nizwa.id }, '')).status, 400);
});

test('admin: sections with a description and an installation extra; profit % per item', async (t) => {
    const { db, server, call } = await start();
    t.after(() => server.close());
    assert.strictEqual((await call('GET', '/api/admin/motors', null, 'wrong')).status, 401);
    const { body: admin } = await call('GET', '/api/admin/motors');
    assert.strictEqual(admin.items.length, 8);
    assert.deepStrictEqual(admin.sections.map((x) => [x.name, x.install_extra]), [
        ['مكائن البوابات المنزلقة', 0], ['مكائن البوابات المتأرجحة (الدرفتين)', 20], ['بوابات المواقف (Parking Barrier)', 50]
    ]);
    const [sliding, swing, parking] = admin.sections;

    // A new section (e.g. garage doors) with its description
    const { body: withNew } = await call('PUT', '/api/admin/motors/sections', {
        sections: [...admin.sections, { name: 'مكائن أبواب الكراجات', description: 'لأبواب الكراجات العلوية', install_extra: 10, active: true }]
    });
    const garage = withNew.sections[3];
    assert.strictEqual(garage.name, 'مكائن أبواب الكراجات');
    assert.strictEqual(garage.install_extra, 10);
    // A section that still has items cannot be deleted
    const refusedDelete = await call('PUT', '/api/admin/motors/sections', { sections: withNew.sections.slice(1) });
    assert.strictEqual(refusedDelete.status, 400);
    assert.match(refusedDelete.body.error, /المنزلقة/);

    // Active items need a price; an item uses its own profit %, or the default when empty
    const unpriced = admin.items.map((i) => (i.name.includes('800') ? { ...i, active: true } : i));
    const refused = await call('PUT', '/api/admin/motors', { items: unpriced });
    assert.strictEqual(refused.status, 400);
    assert.match(refused.body.error, /800/);

    const items = [
        { ...admin.items[0], profit_percent: '' },                                                   // 115 + default 20%
        { section_id: swing.id, kind: 'kit', name: 'مكينة درفتين', unit: 'set', cost: 200, profit_percent: 25, active: true },
        { section_id: parking.id, kind: 'kit', name: 'حاجز مواقف', unit: 'set', cost: 300, price: 420, active: true },
        { section_id: parking.id, kind: 'part', name: 'ريموت حاجز', unit: 'piece', cost: 5, profit_percent: 100, active: true }
    ];
    const { body: saved } = await call('PUT', '/api/admin/motors', {
        items, profit_percent: 20,
        extra_fees: [...admin.extra_fees, { section_id: parking.id, name: 'قص وتمديد كيبل أرضي', amount: 15, active: true }]
    });
    assert.strictEqual(saved.profit_percent, 20);
    assert.deepStrictEqual(saved.items.map((i) => i.sell_price), [138, 250, 420, 10]);
    assert.strictEqual(saved.items[0].id, admin.items[0].id); // same row kept
    assert.strictEqual(saved.extra_fees.length, 3);

    // Installation: the wilayah's base fee + the section's extra (Nizwa 30 → sliding 30, swing 50, parking 80)
    const nizwa = db.prepare("SELECT id FROM regions WHERE name = 'نزوى'").get().id;
    db.prepare('UPDATE regions SET motor_installation_fee = 30, delivery_fee = 0 WHERE id = ?').run(nizwa);
    const install = async (section, kit) => {
        const r = await call('POST', '/api/public/motor-quotes', { ...customer, section_id: section.id, kit_id: kit.id, kit_count: 1, region_id: nizwa }, '');
        assert.ok([200, 201].includes(r.status), JSON.stringify(r.body)); // 200 = the same request again
        return r.body;
    };
    assert.strictEqual((await install(sliding, saved.items[0])).items.find((i) => i.name === 'التركيب').line_total, 30);
    assert.strictEqual((await install(swing, saved.items[1])).items.find((i) => i.name === 'التركيب').line_total, 50);
    const barrier = await install(parking, saved.items[2]);
    assert.strictEqual(barrier.items.find((i) => i.name === 'التركيب').line_total, 80);
    assert.strictEqual(barrier.total, 525); // (420 + 80) × 1.05
    // Fees for all sections + the parking one, told but not added
    assert.match(barrier.details.extra_fees_note, /التسليكات[^]*التأسيس[^]*قص وتمديد كيبل أرضي: 15\.00 ر\.ع/);
    const swingQuote = await install(swing, saved.items[1]);
    assert.ok(!swingQuote.details.extra_fees_note.includes('كيبل'));

    // The customer page lists the new sections with their descriptions
    const { body: conf } = await call('GET', '/api/public/motors', null, '');
    assert.deepStrictEqual(conf.sections.map((x) => x.name), ['مكائن البوابات المنزلقة', 'مكائن البوابات المتأرجحة (الدرفتين)', 'بوابات المواقف (Parking Barrier)']);
    assert.match(conf.sections[2].description, /حواجز المواقف/);

    // Copy installation fees from the overhead ones — only where empty
    const { body: fresh } = await call('GET', '/api/admin/motors');
    const before = fresh.regions.filter((r) => r.motor_installation_fee == null && r.overhead_installation_fee != null).length;
    assert.ok(before > 0);
    const { body: copied } = await call('POST', '/api/admin/motors/copy-installation', { from: 'overhead' });
    assert.strictEqual(copied.copied, before);
    const r = copied.regions.find((x) => x.overhead_installation_fee != null && x.id !== nizwa);
    assert.strictEqual(r.motor_installation_fee, r.overhead_installation_fee);
    assert.strictEqual(copied.regions.find((x) => x.id === nizwa).motor_installation_fee, 30);
});

test('a database of version 3.0.0 (fixed sections) moves its items into the sections', () => {
    const db = openDatabase(':memory:');
    db.prepare("UPDATE motor_items SET section = 'swing', section_id = NULL WHERE name LIKE '%800%'").run();
    db.prepare('UPDATE motor_items SET section_id = NULL').run();
    require('../src/motors').ensureSections(db);
    const rows = db.prepare('SELECT m.name, s.key FROM motor_items m JOIN motor_sections s ON s.id = m.section_id').all();
    assert.strictEqual(rows.length, 8);
    assert.strictEqual(rows.find((x) => x.name.includes('800')).key, 'swing');
    assert.strictEqual(rows.find((x) => x.name.includes('600')).key, 'sliding');
});

test('the AI agent lists, prices and quotes gate motors', async (t) => {
    const db = openDatabase(':memory:');
    const nizwa = db.prepare("SELECT id FROM regions WHERE name = 'نزوى'").get().id;
    db.prepare('UPDATE regions SET motor_installation_fee = 20, delivery_fee = 0 WHERE id = ?').run(nizwa);
    const quotes = [];
    const ctx = { db, phone: '96899123456', channel: 'whatsapp', events: [], createQuote: (q) => { quotes.push(q); return { ref: 'Q-1', total: q.priced.total }; } };

    const options = await executeTool('list_motor_options', {}, ctx);
    assert.deepStrictEqual(options.sections.map((x) => x.available), [true, false, false]);
    assert.match(options.sections[2].name, /Parking Barrier/);
    const kit = options.sections[0].kits[0];
    assert.strictEqual(kit.price_before_vat, 132.25);

    const input = { section_id: options.sections[0].section_id, kit_id: kit.kit_id, kit_count: 1, parts: [], installation: true, region_id: nizwa };
    const price = await executeTool('calculate_motor_price', input, ctx);
    assert.strictEqual(price.total_with_vat, 159.86); // (132.25 + 20) × 1.05
    assert.strictEqual(price.note, 'شامل التركيب');
    assert.strictEqual(price.extra_fees.length, 2);
    assert.strictEqual(price.extra_fees[0].amount, 'تُحدد بعد المعاينة');

    const r = await executeTool('create_motor_quote', { ...input, customer_name: 'سالم', customer_phone: null, notes: 'وزن البوابة 500 كجم' }, ctx);
    assert.strictEqual(r.ref, 'Q-1');
    assert.strictEqual(quotes[0].customer_phone, '96899123456');
    assert.strictEqual(quotes[0].details.calculator, 'motors');
    assert.match(quotes[0].details.extra_fees_note, /التسليكات/);
    assert.strictEqual(ctx.events[0].type, 'quote_created');
});

test('the motors items are in the Excel backup', async () => {
    const db = openDatabase(':memory:');
    db.prepare("UPDATE motor_items SET cost = 99 WHERE name LIKE '%800%'").run();
    const file = await exportWorkbook(db);
    const other = openDatabase(':memory:');
    const counts = await restoreWorkbook(other, file);
    assert.strictEqual(counts.motor_items, 8);
    assert.strictEqual(counts.motor_sections, 3);
    assert.strictEqual(counts.motor_extra_fees, 2);
    assert.strictEqual(other.prepare("SELECT cost FROM motor_items WHERE name LIKE '%800%'").get().cost, 99);
    assert.strictEqual(other.prepare('SELECT COUNT(*) AS n FROM motor_items WHERE section_id IS NULL').get().n, 0);
});
