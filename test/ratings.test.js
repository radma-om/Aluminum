/* «كيف كانت خدمتنا؟»: the day after a work order is done (from 10 am, Muscat) the customer gets the rating
   template; «5 ممتاز» is thanked (with the Google link), «2 مقبول» asks why and tells the managers, and the
   next message is kept as the comment. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, saveSettings } = require('../src/db');
const { saveQuote } = require('../src/server');
const staff = require('../src/staff');
const invoices = require('../src/invoices');
const workorders = require('../src/workorders');
const ratings = require('../src/ratings');
const notify = require('../src/order-notify');

const sent = [];
ratings.setSenderForTests(async (m) => { sent.push(m); return { ok: true }; });
// Muscat 10:30 on 2026-11-21 (UTC 06:30)
const AT_1030 = Date.parse('2026-11-21T06:30:00Z');

function setup(t) {
    sent.length = 0;
    process.env.MAZBOT_RATING_TEMPLATE_ID = '501';
    t.after(() => { delete process.env.MAZBOT_RATING_TEMPLATE_ID; });
    const db = openDatabase(':memory:');
    const tech = staff.create(db, { username: 'ahmed', display_name: 'أحمد', password: 'pass-12345', role: 'technician' });
    const order = (phone, completedUtc, kind = 'installation') => {
        const priced = { items: [{ name: 'بوابة', unit: 'piece', quantity: 1, unit_price: 400, line_total: 400, part: 'slats' }], subtotal: 400, vat_percent: 5, vat: 20, total: 420 };
        const q = saveQuote(db, { customer_name: 'خالد سالم', customer_phone: phone, source: 'staff', priced, details: { staff_quote: true, created_by: 'سارة' } });
        const row = db.prepare('SELECT * FROM quotes WHERE id = ?').get(q.id);
        const inv = invoices.createFromQuote(db, { ...row, items: JSON.parse(row.items_json), details: JSON.parse(row.details_json) }, {}, 'سارة');
        const o = workorders.create(db, { kind, description: 'تركيب', technician_id: tech.id }, 'المكتب', { source: { invoice: inv } });
        db.prepare("UPDATE work_orders SET status = 'done', completed_at = ? WHERE id = ?").run(completedUtc, o.id);
        return o;
    };
    return { db, order };
}
const logOf = (db, id) => db.prepare('SELECT text FROM work_order_events WHERE order_id = ? ORDER BY id').all(id).map((e) => e.text);

test('sent the day after, from 10 am, once per order; not the same day, not at night, not old orders', async (t) => {
    const { db, order } = setup(t);
    const yesterday = order('91234567', '2026-11-20 10:00:00');   // Muscat 2:00 pm yesterday
    order('92345678', '2026-11-21 03:00:00');                     // today (7:00 am Muscat): tomorrow
    order('93456789', '2026-11-10 10:00:00');                     // long ago: never

    assert.deepEqual(await ratings.sendDue(db, Date.parse('2026-11-21T05:00:00Z')), { sent: 0, failed: 0, skipped: 0 }, '9 am: not yet');
    let r = await ratings.sendDue(db, AT_1030);
    assert.equal(r.sent, 1);
    assert.deepEqual(sent[0], { mobile: '96891234567', templateId: '501', values: ['خالد', 'تركيب البوابة'], order: sent[0].order });
    assert.equal(sent[0].order.id, yesterday.id);
    assert.ok(logOf(db, yesterday.id).some((l) => l.includes('طلب تقييم')));
    // Once only
    r = await ratings.sendDue(db, AT_1030 + 3600_000);
    assert.equal(r.sent, 0);
    // 9 pm: nothing
    assert.equal((await ratings.sendDue(db, Date.parse('2026-11-22T17:00:00Z'))).sent, 0);
    // Switched off, or no template: nothing
    order('94567890', '2026-11-20 11:00:00');
    saveSettings(db, { wo_rating_requests: false });
    assert.equal((await ratings.sendDue(db, AT_1030)).sent, 0);
    saveSettings(db, { wo_rating_requests: true });
    delete process.env.MAZBOT_RATING_TEMPLATE_ID;
    assert.equal((await ratings.sendDue(db, AT_1030)).sent, 0);
});

test('one request a week per number; a muted number waits', async (t) => {
    const { db, order } = setup(t);
    order('91234567', '2026-11-20 08:00:00');
    order('91234567', '2026-11-20 09:00:00');
    const r = await ratings.sendDue(db, AT_1030);
    assert.deepEqual([r.sent, r.skipped], [1, 1]);
    const other = order('95555555', '2026-11-20 09:00:00');
    notify.mute(db, '95555555');
    assert.equal((await ratings.sendDue(db, AT_1030)).sent, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rating_requests WHERE order_id = ?').get(other.id).n, 0, 'tried again later');
});

test('5 → thanks with the Google link; 2 → asks why, managers told, the next message is the comment', async (t) => {
    const { db, order } = setup(t);
    saveSettings(db, { google_review_url: 'https://g.page/r/radma-review' });
    const a = order('91234567', '2026-11-20 08:00:00');
    const b = order('92222222', '2026-11-20 08:00:00');
    await ratings.sendDue(db, AT_1030);
    const now = AT_1030 + 3600_000;

    // A number never asked: not a rating
    assert.equal(ratings.handle(db, '96899999999', '5 ممتاز', now), null);

    let r = ratings.handle(db, '96891234567', '5 ممتاز', now);
    assert.equal(r.action, 'rated');
    assert.match(r.reply, /⭐⭐⭐⭐⭐/);
    assert.match(r.reply, /https:\/\/g\.page\/r\/radma-review/);
    assert.ok(logOf(db, a.id).includes('⭐⭐⭐⭐⭐ تقييم العميل: 5 ممتاز'));
    // An ordinary message afterwards is not taken for a comment
    assert.equal(ratings.handle(db, '96891234567', 'شكراً لكم', now), null);

    r = ratings.handle(db, '96892222222', '٢ مقبول', now);
    assert.equal(r.action, 'rated_low');
    assert.match(r.reply, /أخبرونا/);
    assert.doesNotMatch(r.reply, /g\.page/);
    assert.equal(ratings.handle(db, '96892222222', 'تتبع', now + 30_000), null, '«تتبع» is not a comment');
    r = ratings.handle(db, '96892222222', 'الريموت لا يعمل والفني تأخر ساعتين', now + 60_000);
    assert.equal(r.action, 'rating_comment');
    const row = db.prepare('SELECT rating, comment, status FROM rating_requests WHERE order_id = ?').get(b.id);
    assert.deepEqual({ ...row }, { rating: 2, comment: 'الريموت لا يعمل والفني تأخر ساعتين', status: 'commented' });
    assert.ok(logOf(db, b.id).some((l) => l.startsWith('💬 ملاحظة العميل')));

    const st = ratings.status(db);
    assert.equal(st.last_30_days.rated, 2);
    assert.equal(st.last_30_days.low, 1);
});

test('the buttons and typed answers are understood', () => {
    assert.equal(ratings.ratingOf('5 ممتاز'), 5);
    assert.equal(ratings.ratingOf('4 جيد جداً'), 4);
    assert.equal(ratings.ratingOf('٣'), 3);
    assert.equal(ratings.ratingOf('ضعيف'), 1);
    assert.equal(ratings.ratingOf('جيد جدا'), 4);
    assert.equal(ratings.ratingOf('السعر 500'), null);
    assert.equal(ratings.ratingOf('12'), null);
});

test('through the templates webhook handler: a rating press is answered, «تتبع» still works', async (t) => {
    const { db, order } = setup(t);
    order('91234567', '2026-11-20 08:00:00');
    await ratings.sendDue(db, AT_1030);
    // The press goes through the handler at today's time (answers count within 7 days of the request): sent just now
    db.prepare("UPDATE rating_requests SET sent_at = datetime('now')").run();
    const replies = [];
    const client = { sendTextToPhone: async (to, text) => { replies.push(text); return { ok: true }; } };
    const out = await notify.handleTemplatesEvent(db, { type: 'message.received', data: { contact: { phone: '96891234567' }, message: { value: '4 جيد جداً' } } }, { origin: 'https://x.test', client });
    assert.equal(out.action, 'rated');
    assert.match(replies.at(-1), /شكراً لتقييمكم/);
    const track = await notify.handleTemplatesEvent(db, { type: 'message.received', data: { contact: { phone: '96891234567' }, message: { value: 'تتبع' } } }, { origin: 'https://x.test', client });
    assert.equal(track.action, 'track');
});

test('a failed send is tried again 6 hours later, 3 attempts in all; a success stops it', async (t) => {
    const { db, order } = setup(t);
    const o = order('91234567', '2026-11-20 08:00:00');
    const results = [];
    let fail = true;
    ratings.setSenderForTests(async (m) => { results.push(m.mobile); return fail ? { ok: false, error: 'template not approved' } : { ok: true }; });
    t.after(() => ratings.setSenderForTests(async (m) => { sent.push(m); return { ok: true }; }));
    const row = () => db.prepare('SELECT status, attempts FROM rating_requests WHERE order_id = ?').get(o.id);

    assert.equal((await ratings.sendDue(db, AT_1030)).failed, 1);
    assert.deepEqual({ ...row() }, { status: 'failed', attempts: 1 });
    // Within 6 hours: not again
    assert.equal((await ratings.sendDue(db, AT_1030 + 2 * 3600_000)).failed, 0);
    // 6 hours later (4:30 pm): attempt 2
    assert.equal((await ratings.sendDue(db, AT_1030 + 6 * 3600_000)).failed, 1);
    assert.equal(row().attempts, 2);
    assert.ok(logOf(db, o.id).some((l) => l.includes('المحاولة 2 من 3') && l.includes('يُعاد بعد 6 ساعات')));
    // The next morning, 10:30: attempt 3 succeeds
    fail = false;
    assert.equal((await ratings.sendDue(db, AT_1030 + 24 * 3600_000)).sent, 1);
    assert.deepEqual({ ...row() }, { status: 'sent', attempts: 3 });
    assert.ok(logOf(db, o.id).some((l) => l.startsWith('📤') && l.includes('(المحاولة 3)')));
    // Sent: never again
    assert.equal(results.length, 3);
    await ratings.sendDue(db, AT_1030 + 30 * 3600_000);
    assert.equal(results.length, 3);
});

test('after 3 failed attempts it stops; a failed send does not block the number\'s other order', async (t) => {
    const { db, order } = setup(t);
    const a = order('91234567', '2026-11-20 08:00:00');
    let calls = 0;
    ratings.setSenderForTests(async () => { calls++; return { ok: false, error: 'down' }; });
    t.after(() => ratings.setSenderForTests(async (m) => { sent.push(m); return { ok: true }; }));
    for (const h of [0, 6, 24, 30, 48]) await ratings.sendDue(db, AT_1030 + h * 3600_000);
    assert.equal(calls, 3, 'three attempts, then no more');
    assert.ok(logOf(db, a.id).some((l) => l.includes('المحاولة 3 من 3') && l.includes('لن يُعاد')));
    // The same number, another order: the failed request did not count as «asked this week»
    ratings.setSenderForTests(async (m) => { sent.push(m); return { ok: true }; });
    order('91234567', '2026-11-22 08:00:00');
    assert.equal((await ratings.sendDue(db, Date.parse('2026-11-23T06:30:00Z'))).sent, 1);
});
