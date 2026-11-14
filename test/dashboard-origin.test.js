/* The dashboard: quotes made by employees and by customers, each with its acceptance rate;
   customers' acceptance also per customer (one customer often prices several options) */
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { saveQuote } = require('../src/server');
const dashboard = require('../src/dashboard');

process.env.ADMIN_TOKEN = 'test-token-long-enough-1234';

test('quotes by who made them, with acceptance rates', () => {
    const db = openDatabase(':memory:');
    const priced = (total) => ({ items: [{ name: 'بوابة', unit: 'piece', quantity: 1, unit_price: total, line_total: total }], subtotal: total, vat_percent: 0, vat: 0, total });
    const q = (phone, source, total, staff = false) => saveQuote(db, { customer_name: 'ع', customer_phone: phone, source, priced: priced(total),
        details: staff ? { staff_quote: true, created_by: 'سلطان' } : null });
    // A customer prices 4 options on the calculator and accepts one; another prices 2 and accepts none
    const a = ['web', 'web', 'web', 'web'].map((s) => q('96891111111', s, 100));
    q('96892222222', 'mazbot', 200); q('96892222222', 'website_chat', 200);
    // Employees: 4 quotes, 2 accepted
    const s = [q('96893333333', 'staff', 500, true), q('96894444444', 'staff', 300, true), q('96895555555', 'staff', 400, true), q('96896666666', 'staff', 600, true)];
    const accept = (x) => db.prepare("UPDATE quotes SET status = 'accepted' WHERE id = ?").run(x.id);
    accept(a[2]); accept(s[0]); accept(s[3]);

    const d = dashboard.build(db, { days: 30, user: { role: 'manager', owner: true } });
    const st = d.by_origin.staff;
    const cu = d.by_origin.customers;
    assert.deepEqual([st.count, st.accepted, st.win_rate, st.value, st.accepted_value], [4, 2, 50, 1800, 1100]);
    assert.deepEqual([cu.count, cu.accepted, cu.win_rate], [6, 1, 16.7], 'by quotes: low, the options inflate it');
    assert.deepEqual([cu.customers, cu.customers_won, cu.customer_win_rate], [2, 1, 50], 'by customer: one of two bought');
    assert.equal(st.previous.count, 0);
    // The whole-company figures stay as they were
    assert.equal(d.kpis.quotes.value, 10);
    assert.equal(d.kpis.win_rate.value, 30);
});
