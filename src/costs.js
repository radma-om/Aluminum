/* =============================================================
   Cost & profit of a quote being built by an employee (never shown to
   customers; only to managers and the «أسعار الشراء» section).
   - Roller shutter: each slat / accessory line at its product's cost
     (purchase price, or the LME formula), in the product's own unit.
   - Overhead: the cost entered for the size and for the motor.
   - Motors: the cost of the kit / part.
   - Catalog parts: the product's cost. Free lines: no known cost.
   - Installation, delivery and colour fees have no recorded cost: the
     employee types the installation & transport cost by hand.
   Anything without a cost is listed, so the profit is never overstated
   silently.
   ============================================================= */
const { unitCost, round2 } = require('./pricing');

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 10000) / 100 : null);

/* Cost of one line of the quote (as sent to staffquotes.price), from the engine's own priced lines */
function lineCost(db, line, pricedItems, settings) {
    const missing = [];
    let cost = 0;
    const products = new Map();
    const product = (id) => {
        if (!products.has(id)) products.set(id, db.prepare('SELECT * FROM products WHERE id = ?').get(Number(id)) || null);
        return products.get(id);
    };
    const productCost = (id, quantity, unit, name) => {
        const p = product(id);
        if (!p) { missing.push(name); return; }
        const c = unitCost(p, settings);
        if (!(c > 0)) { missing.push(name); return; }
        // A colour sold per m² while the slat is bought per meter: the same area in meters (13 m / m² rule)
        const qty = unit === p.unit ? quantity : unit === 'm2' && p.unit !== 'm2' ? quantity * settings.sqm_to_linear : quantity;
        cost += c * qty;
    };

    if (line.calc === 'rolling_shutter') {
        // The same engine run as the quote line (it keeps which product each slat / accessory line is)
        const p = line.params || {};
        const n = (v) => (v === '' || v === null || v === undefined ? undefined : Number(v));
        const door = require('./doors').finalPrice(db, {
            widthCm: n(p.width_cm), heightCm: n(p.height_cm), count: Number(p.count) || 1,
            shutterTypeId: p.shutter_type_id, variantId: p.variant_id, colorId: p.color_id,
            optionIds: Array.isArray(p.option_ids) ? p.option_ids.filter(Boolean) : []
        });
        for (const it of door.items) if (it.product_id) productCost(it.product_id, it.quantity, it.unit, it.type ? `${it.name} — ${it.type}` : it.name);
    } else if (line.calc === 'overhead') {
        const p = line.params || {};
        const size = db.prepare('SELECT * FROM overhead_sizes WHERE gate_type = ? AND height_cm = ? AND width_cm = ?').get(String(p.gate_type), Number(p.height_cm), Number(p.width_cm));
        const motor = db.prepare('SELECT * FROM overhead_motors WHERE id = ?').get(Number(p.motor_id));
        if (size && size.cost != null) cost += Number(size.cost); else missing.push(`بوابة أوفرهيد ${p.gate_type} ${p.width_cm}×${p.height_cm}`);
        if (motor && motor.cost != null) cost += Number(motor.cost); else missing.push(motor ? motor.name : 'المحرك');
    } else if (line.calc === 'motors') {
        const p = line.params || {};
        const item = (id) => db.prepare('SELECT * FROM motor_items WHERE id = ?').get(Number(id));
        const add = (id, qty) => {
            const i = item(id);
            if (i && i.cost != null) cost += Number(i.cost) * qty; else missing.push(i ? i.name : 'قطعة');
        };
        if (p.kit_id) add(p.kit_id, Number(p.kit_count) || 1);
        for (const part of Array.isArray(p.parts) ? p.parts : []) if (Number(part.qty) > 0) add(part.id, Number(part.qty));
    } else if (line.product_id) {
        const it = pricedItems[0];
        productCost(line.product_id, it.quantity, it.unit, it.name);
    } else {
        missing.push(String(line.name || 'بند حر'));
    }
    return { cost: round2(cost), missing };
}

/**
 * input: the body sent to staffquotes.price; priced: its result.
 * extra_cost: installation, transport, labour… typed by the employee.
 */
function quoteCost(db, input, priced, settings) {
    const lines = Array.isArray(input.items) ? input.items : [];
    let n = 0;
    let g = 0;
    const out = lines.map((line) => {
        let items;
        let revenue;
        let label;
        if (line && line.calc) {
            items = [];
            while (priced.items[n] && priced.items[n].group === g) items.push(priced.items[n++]);
            revenue = priced.groups[g].total;
            label = priced.groups[g].label;
            g++;
        } else {
            items = [priced.items[n++]];
            revenue = items[0].line_total;
            label = items[0].name;
        }
        const { cost, missing } = lineCost(db, line, items, settings);
        return { label, cost, revenue: round2(revenue), profit: round2(revenue - cost), margin_percent: pct(revenue - cost, revenue), missing };
    });
    const extra = Math.max(0, round2(Number(input.extra_cost) || 0));
    const totalCost = round2(out.reduce((s, l) => s + l.cost, 0) + extra);
    // The revenue is the price before VAT, after every discount (the promotion, the lines and the total)
    const revenue = priced.subtotal;
    const profit = round2(revenue - totalCost);
    return {
        lines: out, extra_cost: extra, total_cost: totalCost, revenue, profit,
        margin_percent: pct(profit, revenue),    // profit / selling price
        markup_percent: pct(profit, totalCost),  // profit / cost
        missing: out.flatMap((l) => l.missing)
    };
}

module.exports = { quoteCost, lineCost };
