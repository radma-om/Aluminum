const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveChoice } = require('../src/doors');
test('colors are required when available, and must belong to the chosen variant', () => {
    const variant = { id: 1, colors: [{ id: 7, fixed_fee: 160 }] };
    const catalog = { types: [{ id: 1, variants: [variant] }], groups: [] };
    for (const colorId of [undefined, null, '', 0]) assert.throws(() => resolveChoice(catalog, { shutterTypeId: 1, colorId }), { status: 400 });
    assert.throws(() => resolveChoice(catalog, { shutterTypeId: 1, colorId: 8 }), { status: 400 });
    assert.equal(resolveChoice(catalog, { shutterTypeId: 1, colorId: 7 }).color.fixed_fee, 160);
    variant.colors = [];
    assert.equal(resolveChoice(catalog, { shutterTypeId: 1 }).color, null);
});
