/* «تقويم المناسبات» and the offers' first day: the 2027 calendar by default, a check of what is saved, the
   week's warning on the dashboard (managers) with what already covers the day, and a discount, a gift, a
   greeting or a reminder that waits for its first day and starts by itself. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase, getSettings, saveSettings } = require('../src/db');
const { createApp } = require('../src/server');
const occasions = require('../src/occasions');
const promotions = require('../src/promotions');
const promoReminders = require('../src/promo-reminders');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;

test('the 2027 calendar by default; a saved list is checked and kept by date', () => {
    const db = openDatabase(':memory:');
    const list = getSettings(db).occasions;
    assert.equal(list.length, 12);
    assert.deepEqual(list.find((o) => /الوطني/.test(o.name)), { name: 'اليوم الوطني العُماني', date: '2027-11-20' });
    assert.ok(list.every((o, i) => i === 0 || list[i - 1].date <= o.date), 'by date');

    const saved = saveSettings(db, { occasions: [{ name: '  عيد  الفطر ', date: '2027-03-09' }, { name: 'يوم المعلم العُماني', date: '2027-02-24' }] }).occasions;
    assert.deepEqual(saved, [{ name: 'يوم المعلم العُماني', date: '2027-02-24' }, { name: 'عيد الفطر', date: '2027-03-09' }]);
    assert.throws(() => saveSettings(db, { occasions: [{ name: '', date: '2027-03-09' }] }), /اسم/);
    assert.throws(() => saveSettings(db, { occasions: [{ name: 'عيد', date: '09-03-2027' }] }), /تاريخ/);
    assert.throws(() => saveSettings(db, { occasions: [{ name: 'ع'.repeat(61), date: '2027-03-09' }] }), /60/);
    assert.throws(() => saveSettings(db, { occasions: 'x' }), /غير صالحة/);
    assert.throws(() => saveSettings(db, { promo_from: '2027/11/14' }), /بداية/);
});

test('a week before each occasion (and on the day), with what already covers it', () => {
    const s = { occasions: occasions.DEFAULT_OCCASIONS };
    assert.deepEqual(occasions.upcoming(s, '2027-11-12'), [], 'eight days before: not yet');
    const week = occasions.upcoming(s, '2027-11-13');
    assert.deepEqual(week.map((o) => [o.name, o.days_left]), [['اليوم الوطني العُماني', 7]]);
    assert.deepEqual([week[0].promo, week[0].gift, week[0].greeting], [null, null, false], 'nothing ready yet');
    assert.equal(occasions.upcoming(s, '2027-11-20')[0].days_left, 0, 'on the day');
    assert.deepEqual(occasions.upcoming(s, '2027-11-21'), [], 'passed');

    const ready = occasions.upcoming({
        ...s, promo_enabled: true, promo_percent: 10, promo_label: 'عرض اليوم الوطني', promo_from: '2027-11-18', promo_until: '2027-11-22',
        gift_enabled: true, gift_name: 'GSM', gift_from: '2027-11-21', greeting_enabled: true, greeting_from: '2027-11-20', greeting_until: '2027-11-20'
    }, '2027-11-15')[0];
    assert.equal(ready.promo, 'عرض اليوم الوطني');
    assert.equal(ready.gift, null, 'the gift starts after the day');
    assert.equal(ready.greeting, true);
});

test('a discount, a gift and a reminder wait for their first day, then start by themselves', () => {
    const st = { promo_enabled: true, promo_percent: 10, promo_label: 'عرض', promo_scope: ['motors'], promo_from: '2027-11-18', promo_until: '2027-11-22',
        gift_enabled: true, gift_name: 'GSM', gift_price: 15, gift_scope: ['motors'], gift_from: '2027-11-18', gift_until: '2027-11-22' };
    assert.equal(promotions.active(st, 'motors', '2027-11-17'), null, 'the day before');
    assert.equal(promotions.active(st, 'motors', '2027-11-18').percent, 10, 'its first day');
    assert.equal(promotions.active(st, 'motors', '2027-11-23'), null, 'after its last day');
    assert.equal(promotions.activeGift(st, 'motors', '2027-11-17'), null);
    assert.equal(promotions.activeGift(st, 'motors', '2027-11-22').name, 'GSM');
    assert.equal(promotions.active({ ...st, promo_from: '' }, 'motors', '2027-11-01').percent, 10, 'no first day: from now');
    assert.equal(promoReminders.running(st, '2027-11-17').key, '', 'no reminder before it starts');
    assert.ok(promoReminders.running(st, '2027-11-18').promo);
});

test('the dashboard warns the managers; the greeting waits for its first day; managers only set them', async (t) => {
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OWNER }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const today = occasions.localToday();
    const inDays = (n) => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10);
    saveSettings(db, { occasions: [{ name: 'مناسبة قريبة', date: inDays(3) }, { name: 'بعيدة', date: inDays(30) }] });
    const dash = (await call('GET', '/api/admin/dashboard')).body;
    assert.deepEqual(dash.occasions.map((o) => [o.name, o.days_left]), [['مناسبة قريبة', 3]]);

    saveSettings(db, { greeting_enabled: true, greeting_from: inDays(1) });
    assert.equal((await (await fetch(`${base}/api/public/greeting`)).json()).greeting, null, 'not before its first day');
    saveSettings(db, { greeting_from: today });
    assert.ok((await (await fetch(`${base}/api/public/greeting`)).json()).greeting, 'from its first day');
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'staff.js'), 'utf8');
    for (const key of ['occasions', 'promo_from', 'gift_from', 'greeting_from']) assert.match(src, new RegExp(`\\b${key}: 'manager'`), key);
});
