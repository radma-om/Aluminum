/* The in-house «حاسبة التسعير» gives the same price as the system (products, quotes, customer calculators):
   purchase VAT is reclaimed, so profit is on the cost before VAT and VAT is added once, on the sale. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { slatCostPerMeter, unitSellPrice } = require('../src/pricing');

test('the pricing calculator matches the system price for an LME slat', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
    const fn = html.match(/function calculateItem\([\s\S]*?\n {4}\}/)[0];
    const ctx = { SQM_TO_LINEAR: 13 };
    vm.runInNewContext(fn + '\nthis.calculateItem = calculateItem;', ctx);

    const settings = { lme: 2300, manufacturing: 800, painting: 200, exchange_rate: 0.385, profit_percent: 15, vat_percent: 5 };
    const inputs = { lme: 2300, manufacturing: 800, painting: 200, exchangeRate: 0.385, profitPercent: 15, vatPercent: 5 };
    for (const [weight, painted, length] of [[0.63, true, 1], [0.839, false, 3.2], [0.63, false, 6]]) {
        const product = { pricing_mode: 'lme', weight_per_meter: weight, painted: painted ? 1 : 0, sell_price: null, profit_percent: null };
        const cost = slatCostPerMeter(product, settings);
        const r = ctx.calculateItem(weight, painted, length, inputs);
        assert.ok(Math.abs(r.costPiece - cost * length) < 1e-9, 'cost before VAT');
        assert.ok(Math.abs(r.pricePerMeter - cost * 1.15) < 1e-9, 'price per meter before VAT = cost + profit');
        assert.ok(Math.abs(r.pricePerMeter - unitSellPrice(product, settings)) <= 0.005, 'the system price per meter (rounded)');
        assert.ok(Math.abs(r.sellPrice - cost * length * 1.15 * 1.05) < 1e-9, 'VAT once, on the sale');
        assert.ok(Math.abs(r.profit - cost * length * 0.15) < 1e-9, 'profit = the % of the cost before VAT');
    }
    assert.ok(!/name="taxMode"/.test(html), 'no tax mode choice: one formula');
});
