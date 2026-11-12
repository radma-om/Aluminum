/* Product descriptions: written once in the pricing settings, shown under each line of a quote,
   an invoice and their PDFs; the employee can reword or remove them in the quote builder */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase, getSettings } = require('../src/db');
const { createApp } = require('../src/server');
const staffquotes = require('../src/staffquotes');
const overhead = require('../src/overhead');
const motors = require('../src/motors');
const backup = require('../src/backup');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;

async function start(t) {
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OWNER }, body: body ? JSON.stringify(body) : undefined });
        const type = res.headers.get('content-type') || '';
        return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
    };
    const conf = (await call('GET', '/api/public/configurator')).body;
    const type = conf.shutter_types.find((x) => x.variants.length === 1);
    const region = conf.locations[0].wilayat[0].id;
    return { db, call, conf, type, region };
}

test('roller shutters: the type, thickness and accessory class descriptions under their lines; kept in the quote, the invoice and the PDFs', async (t) => {
    const { db, call, conf, type, region } = await start(t);
    db.prepare('UPDATE shutter_types SET description = ? WHERE id = ?').run('شرائح ألمنيوم معزولة بالفوم', type.id);
    db.prepare('UPDATE shutter_variants SET description = ? WHERE id = ?').run('سماكة 1.1 ملم', type.variants[0].id);
    const opt = conf.accessory_groups[0].options[0];
    db.prepare('UPDATE accessory_options SET details = ? WHERE id = ?').run('مجاري ألمنيوم مع فرشاة عازلة', opt.id);
    const door = { width_cm: 300, height_cm: 250, count: 1, shutter_type_id: type.id, color_id: type.variants[0].colors[0].id,
        option_ids: conf.accessory_groups.map((g) => g.options[0].id), region_id: region };
    const p = (await call('POST', '/api/public/door-price', door)).body;
    assert.equal(p.items.find((i) => i.part === 'slats').description, 'شرائح ألمنيوم معزولة بالفوم — سماكة 1.1 ملم');
    assert.equal(p.items.find((i) => i.name === conf.accessory_groups[0].name).description, 'مجاري ألمنيوم مع فرشاة عازلة');
    assert.ok(!p.items.find((i) => i.part === 'installation').description);

    const saved = await call('POST', '/api/public/door-quotes', { ...door, customer_name: 'خالد', customer_phone: '91234567' });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const q = db.prepare('SELECT * FROM quotes ORDER BY id DESC').get();
    assert.match(q.items_json, /شرائح ألمنيوم معزولة بالفوم/);
    const pdf = await call('GET', `/api/admin/quotes/${q.id}/pdf`);
    assert.equal(pdf.body.subarray(0, 4).toString(), '%PDF');
    const inv = await call('POST', `/api/admin/quotes/${q.id}/invoice`, {});
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    assert.equal(inv.body.items.find((i) => i.part === 'slats').description, 'شرائح ألمنيوم معزولة بالفوم — سماكة 1.1 ملم');
    assert.equal((await call('GET', `/api/admin/invoices/${inv.body.id}/pdf`)).body.subarray(0, 4).toString(), '%PDF');
});

test('overhead: a description per gate type and per motor, saved from the admin; motors: the item description', async (t) => {
    const { db, call, region } = await start(t);
    const cur = (await call('GET', '/api/admin/overhead')).body;
    const gateType = cur.sizes[0].gate_type;
    const motorsIn = cur.motors.map((m, i) => ({ ...m, description: i === 0 ? 'محرك سقفي 800 نيوتن مع ريموتين' : '' }));
    const put = await call('PUT', '/api/admin/overhead', { sizes: cur.sizes, motors: motorsIn,
        type_descriptions: { [gateType]: 'بوابة مقطعية معزولة 40 ملم', 'نوع غير موجود': 'يُهمل' } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual(put.body.type_descriptions, { [gateType]: 'بوابة مقطعية معزولة 40 ملم' });
    assert.equal(put.body.motors[0].description, 'محرك سقفي 800 نيوتن مع ريموتين');
    const s = cur.sizes[0];
    const o = overhead.overheadPrice(db, { gateType, heightCm: s.height_cm, widthCm: s.width_cm, motorId: put.body.motors[0].id, regionId: region });
    assert.equal(o.items.find((i) => i.part === 'gate').description, 'بوابة مقطعية معزولة 40 ملم');
    assert.equal(o.items.find((i) => i.part === 'motor').description, 'محرك سقفي 800 نيوتن مع ريموتين');
    // Saving without the descriptions box keeps them
    await call('PUT', '/api/admin/overhead', { sizes: cur.sizes, motors: motorsIn });
    assert.equal(overhead.loadOverhead(db).type_descriptions[gateType], 'بوابة مقطعية معزولة 40 ملم');
    assert.ok(backup.TABLES.some(([name]) => name === 'overhead_types'), 'in the backup file');

    const sec = motors.publicMotors(db).sections.find((x) => x.kits.length);
    db.prepare('UPDATE motor_items SET description = ? WHERE id = ?').run('مكينة منزلقة 600 كغ — صنع إيطالي', sec.kits[0].id);
    const m = motors.motorPrice(db, { sectionId: sec.id, kitId: sec.kits[0].id, kitCount: 1, parts: [], regionId: region });
    assert.equal(m.items.find((i) => i.part === 'kit').description, 'مكينة منزلقة 600 كغ — صنع إيطالي');
});

test('the employee: rewords or removes a gate line description; a free line has its own; reopened as saved', async (t) => {
    const { db, call, type, region, conf } = await start(t);
    db.prepare('UPDATE shutter_types SET description = ? WHERE id = ?').run('وصف من الإعدادات', type.id);
    db.prepare('UPDATE shutter_variants SET description = NULL WHERE id = ?').run(type.variants[0].id);
    const params = { shutter_type_id: type.id, variant_id: null, color_id: type.variants[0].colors[0].id, width_cm: 300, height_cm: 250, count: 1,
        option_ids: conf.accessory_groups.map((g) => g.options[0].id) };
    const base = staffquotes.price(db, { region_id: region, items: [{ calc: 'rolling_shutter', params }] }, getSettings(db));
    const slat = base.items.findIndex((i) => i.part === 'slats');
    assert.equal(base.items[slat].description, 'وصف من الإعدادات');

    const body = { customer_phone: '91234567', customer_name: 'خالد', region_id: region, items: [
        { calc: 'rolling_shutter', params, item_notes: { [slat]: 'شرائح بلون خشبي حسب طلب العميل' } },
        { name: 'صيانة سنوية', unit: 'service', unit_price: 30, quantity: 1, description: 'زيارتان في السنة مع تزييت المجاري' }
    ] };
    const saved = await call('POST', '/api/admin/quotes', body);
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal(saved.body.items[slat].description, 'شرائح بلون خشبي حسب طلب العميل');
    assert.equal(saved.body.items.at(-1).description, 'زيارتان في السنة مع تزييت المجاري');
    assert.deepEqual(saved.body.details.calc_groups[0].item_notes, { [slat]: 'شرائح بلون خشبي حسب طلب العميل' });
    // Removed: an empty wording
    const r = staffquotes.price(db, { region_id: region, items: [{ calc: 'rolling_shutter', params, item_notes: { [slat]: '' } }] }, getSettings(db));
    assert.ok(!('description' in r.items[slat]));
    // The same wording as the settings is not stored as a change
    const same = staffquotes.price(db, { region_id: region, items: [{ calc: 'rolling_shutter', params, item_notes: { [slat]: 'وصف من الإعدادات' } }] }, getSettings(db));
    assert.equal(same.groups[0].item_notes, undefined);
    // A long description still fits the PDF
    const long = await call('POST', '/api/admin/quotes', { ...body, items: [{ name: 'بند', unit: 'piece', unit_price: 10, quantity: 1, description: 'كلمة '.repeat(110) }] });
    assert.equal(long.status, 201);
    assert.equal((await call('GET', `/api/admin/quotes/${long.body.id}/pdf`)).body.subarray(0, 4).toString(), '%PDF');
});
