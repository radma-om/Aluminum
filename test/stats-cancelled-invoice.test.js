/* A cancelled invoice leaves every statistic: the quote is no longer «مقبول», the customer no longer «تم البيع»,
   and no tab counts it as a sale (dashboard, team, invoices, customers, commissions) */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { saveQuote } = require('../src/server');
const staff = require('../src/staff');
const invoices = require('../src/invoices');
const leads = require('../src/leads');
const team = require('../src/team');
const dashboard = require('../src/dashboard');
const customers = require('../src/customers');
const bonuses = require('../src/bonuses');

process.env.ADMIN_TOKEN = 'test-token-long-enough-1234';
const today = leads.localToday();
const MANAGER = { role: 'manager', owner: true, permissions: [] };

function sale(db, owner, phone, goods) {
    const priced = { items: [{ name: 'شرائح', unit: 'm2', quantity: 1, unit_price: goods, line_total: goods, part: 'slats' }], subtotal: goods, vat_percent: 0, vat: 0, total: goods };
    const q = saveQuote(db, { customer_name: 'عميل', customer_phone: phone, source: 'staff', priced, details: { staff_quote: true, created_by: owner }, lead_key: leads.phoneKey(phone) });
    const row = db.prepare('SELECT * FROM quotes WHERE id = ?').get(q.id);
    return invoices.createFromQuote(db, { ...row, items: JSON.parse(row.items_json), details: JSON.parse(row.details_json) }, {}, owner);
}

test('cancelled: the quote and the customer go back; no tab counts the sale', () => {
    const db = openDatabase(':memory:');
    const moh = staff.create(db, { username: 'mohd', display_name: 'محمد الحضرمي', password: 'pass-12345', permissions: ['quotes', 'invoices'] });
    bonuses.setPlan(db, moh.id, { target: 100, percent: 10 });
    const a = sale(db, 'محمد الحضرمي', '96891111111', 700);
    const b = sale(db, 'محمد الحضرمي', '96892222222', 400);
    const lead = () => db.prepare("SELECT status FROM leads WHERE phone = '96891111111'").get().status;
    assert.equal(lead(), 'won');
    invoices.cancel(db, a.id, 'تجربة', 'محمد');
    invoices.cancel(db, b.id, 'تجربة', 'محمد');

    assert.equal(db.prepare('SELECT status FROM quotes WHERE id = ?').get(a.quote_id).status, 'contacted');
    assert.equal(lead(), 'following');
    assert.match(db.prepare("SELECT text FROM lead_messages WHERE role = 'system' ORDER BY id DESC").get().text, /أُلغيت الفاتورة/);

    const r = team.report(db, { from: today, to: today });
    const me = r.staff.find((s) => s.name === 'محمد الحضرمي');
    assert.deepEqual([me.accepted_count, me.win_rate, me.invoice_count, me.invoice_value], [0, 0, 0, 0]);
    const d = dashboard.build(db, { days: 30, user: MANAGER });
    assert.equal(d.kpis.won_value.value, 0);
    assert.equal(d.kpis.win_rate.value, 0);
    const p = team.pulse(db, { days: 30 });
    assert.equal(p.invoices.count, 0);
    assert.equal(p.rates.win.part, 0, 'no accepted quote left');
    assert.equal(p.outstanding.value, 0);
    const sum = invoices.summary(db);
    assert.deepEqual([sum.issued_count, sum.issued_value, sum.outstanding], [0, 0, 0]);
    const listed = customers.list(db, {});
    const rows = Array.isArray(listed) ? listed : listed.customers || listed.rows || [];
    const c = rows.find((x) => x.phone === '96891111111');
    assert.equal(c ? Number(c.invoiced || 0) : 0, 0);
    const bm = bonuses.statement(db).people.find((x) => x.user_id === moh.id);
    assert.deepEqual([bm.base, bm.pending], [0, 0]);
});

test('invoices cancelled before this fix: their quotes and customers are repaired at start (once)', () => {
    const db = openDatabase(':memory:');
    const a = sale(db, 'المكتب', '96893333333', 500);
    // The old way: cancelled without reopening the quote and the customer
    db.prepare("UPDATE invoices SET status = 'cancelled', cancel_reason = 'قديم' WHERE id = ?").run(a.id);
    // Another customer whose invoice stands: untouched
    const b = sale(db, 'المكتب', '96894444444', 300);
    assert.equal(invoices.repairCancelled(db), 1);
    assert.equal(db.prepare('SELECT status FROM quotes WHERE id = ?').get(a.quote_id).status, 'contacted');
    assert.equal(db.prepare("SELECT status FROM leads WHERE phone = '96893333333'").get().status, 'following');
    assert.equal(db.prepare('SELECT status FROM quotes WHERE id = ?').get(b.quote_id).status, 'accepted');
    assert.equal(db.prepare("SELECT status FROM leads WHERE phone = '96894444444'").get().status, 'won');
    assert.equal(invoices.repairCancelled(db), 0, 'nothing left the next time');
});
