/* =============================================================
   Gate motors: sliding gates and swing (double-leaf) gates.
   - Kits (e.g. sliding motor 600 kg: motor + 4 m rack + sensors +
     2 remotes + warning lamp + exit button) and spare parts sold
     separately (rack per 1 m piece, remote, sensors set, lamp...).
   - Price = purchase cost × (1 + profit %), unless a fixed sell price
     is set; VAT is added on top.
   - Installation per wilayah (its own fee, × number of kits) and the
     wilayah delivery fee once per order.
   ============================================================= */
const { getSettings } = require('./db');
const { round2 } = require('./pricing');
const { getRegion, locations } = require('./doors');

const SECTIONS = { sliding: 'مكائن البوابات المنزلقة', swing: 'مكائن البوابات المتأرجحة (الدرفتين)' };
const KINDS = { kit: 'طقم مكينة', part: 'قطعة / إضافة' };
const UNITS = { set: 'طقم', piece: 'قطعة', meter: 'متر' };
const err400 = (message) => Object.assign(new Error(message), { status: 400 });

/* Starting catalog for a new database: only the 600 kg kit has a price; the rest are filled in the admin */
const SEED = [
    { section: 'sliding', kind: 'kit', name: 'مكينة بوابة منزلقة 600 كجم', unit: 'set', cost: 115, active: 1,
      description: 'طقم كامل: المكينة + 4 أمتار مسننات (4 قطع Rail rack) + طقم مستشعرات (سنسرات) + 2 ريموت + لمبة تحذير + زر خروج',
      link: 'https://mhkautomation.com/life-acer-600-kg-gate-motor-oman' },
    { section: 'sliding', kind: 'kit', name: 'مكينة بوابة منزلقة 800 كجم', unit: 'set', cost: null, active: 0,
      description: 'طقم كامل: المكينة + 4 أمتار مسننات + طقم مستشعرات + 2 ريموت + لمبة تحذير + زر خروج' },
    { section: 'sliding', kind: 'kit', name: 'مكينة بوابة منزلقة 1200 كجم', unit: 'set', cost: null, active: 0,
      description: 'طقم كامل: المكينة + 4 أمتار مسننات + طقم مستشعرات + 2 ريموت + لمبة تحذير + زر خروج' },
    { section: 'sliding', kind: 'kit', name: 'مكينة بوابة منزلقة 1500 كجم', unit: 'set', cost: null, active: 0,
      description: 'طقم كامل: المكينة + 4 أمتار مسننات + طقم مستشعرات + 2 ريموت + لمبة تحذير + زر خروج' },
    { section: 'sliding', kind: 'part', name: 'مسننات (Rail rack)', unit: 'piece', cost: null, active: 0, description: 'القطعة بطول 1 متر' },
    { section: 'sliding', kind: 'part', name: 'ريموت', unit: 'piece', cost: null, active: 0, description: '' },
    { section: 'sliding', kind: 'part', name: 'مستشعرات (Sensors)', unit: 'set', cost: null, active: 0, description: 'طقم' },
    { section: 'sliding', kind: 'part', name: 'لمبة تحذير', unit: 'piece', cost: null, active: 0, description: '' }
];

function seedMotors(db) {
    if (db.prepare('SELECT COUNT(*) AS n FROM motor_items').get().n) return;
    const ins = db.prepare(`INSERT INTO motor_items (section, kind, name, description, unit, cost, active, link, sort_order)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    SEED.forEach((m, i) => ins.run(m.section, m.kind, m.name, m.description, m.unit, m.cost, m.active, m.link || null, i));
}

const profitPercent = (settings) => {
    const p = Number(settings.motors_profit_percent);
    return Number.isFinite(p) ? p : Number(settings.profit_percent) || 0;
};

/* Sell price before VAT: fixed price if set, else cost + profit; null = no price yet */
function sellPrice(item, settings) {
    if (item.price != null) return round2(Number(item.price));
    if (item.cost == null) return null;
    return round2(Number(item.cost) * (1 + profitPercent(settings) / 100));
}

function loadItems(db, { includeInactive = false } = {}) {
    const settings = getSettings(db);
    const rows = db.prepare(`SELECT * FROM motor_items ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort_order, id`).all();
    return rows.map((r) => ({ ...r, sell_price: sellPrice(r, settings) }))
        // an item without a price is never offered to customers
        .filter((r) => includeInactive || r.sell_price != null);
}

/* Wilayat of the enabled governorates (installation fee may be missing: then it is set after a visit) */
function motorLocations(db) {
    return locations(db).map((g) => ({ ...g, wilayat: g.wilayat.map(({ id, name }) => ({ id, name })) }));
}

/* Catalog for the customer page (no prices: like the other calculators, the price comes with the request);
   withPrices for the AI agent, which quotes from the tools */
function publicMotors(db, { withPrices = false } = {}) {
    const items = loadItems(db);
    const view = (i) => ({
        id: i.id, name: i.name, description: i.description, unit: UNITS[i.unit] || i.unit,
        ...(withPrices ? { unit_price: i.sell_price } : {})
    });
    return {
        sections: Object.entries(SECTIONS).map(([key, label]) => ({
            key, label,
            kits: items.filter((i) => i.section === key && i.kind === 'kit').map(view),
            parts: items.filter((i) => i.section === key && i.kind === 'part').map(view)
        })),
        vat_percent: Number(getSettings(db).vat_percent) || 0,
        locations: motorLocations(db)
    };
}

const line = (name, type, unit, qty, price) => ({
    product_id: null, category: 'machine', name, type, unit, quantity: qty,
    unit_price: round2(price), line_total: round2(price * qty)
});

/**
 * Price of a motors order.
 * { section, kitId, kitCount, parts: [{ id, qty }], regionId, installation: true }
 */
function motorPrice(db, { section, kitId, kitCount = 1, parts = [], regionId, installation = true }) {
    if (!SECTIONS[section]) throw err400('اختر نوع البوابة (منزلقة أو متأرجحة)');
    const items = loadItems(db).filter((i) => i.section === section);
    const region = getRegion(db, regionId);
    if (!region) throw err400('اختر المحافظة والولاية');

    const lines = [];
    let kit = null;
    const count = Math.max(0, Math.min(50, parseInt(kitCount, 10) || 0));
    if (kitId) {
        kit = items.find((i) => i.kind === 'kit' && i.id === Number(kitId));
        if (!kit) throw err400('المكينة المختارة غير متوفرة');
        if (!count) throw err400('حدد عدد المكائن');
        lines.push(line(kit.name, kit.description ? 'طقم كامل' : null, 'set', count, kit.sell_price));
    }
    for (const p of Array.isArray(parts) ? parts : []) {
        const qty = Math.max(0, Math.min(500, parseInt(p.qty, 10) || 0));
        if (!qty) continue;
        const part = items.find((i) => i.kind === 'part' && i.id === Number(p.id));
        if (!part) throw err400('قطعة غير متوفرة');
        lines.push(line(part.name, part.description || null, part.unit, qty, part.sell_price));
    }
    if (!lines.length) throw err400('اختر مكينة أو قطعة واحدة على الأقل');

    const fee = db.prepare('SELECT motor_installation_fee AS fee FROM regions WHERE id = ?').get(region.id).fee;
    let installNote = 'بدون تركيب (توريد فقط)';
    if (kit && installation) {
        if (fee != null) {
            lines.push({ ...line('التركيب', region.name, 'service', count, fee), category: 'service' });
            installNote = 'شامل التركيب';
        } else {
            installNote = 'رسوم التركيب لهذه الولاية تُحدد بعد المعاينة';
        }
    }
    if (region.delivery_fee > 0) lines.push({ ...line('التوصيل', region.name, 'service', 1, region.delivery_fee), category: 'service' });

    const settings = getSettings(db);
    const vatPercent = Number(settings.vat_percent) || 0;
    const subtotal = round2(lines.reduce((s, l) => s + l.line_total, 0));
    const vat = round2(subtotal * vatPercent / 100);
    const spec = [['نوع البوابة', SECTIONS[section]]];
    if (kit) spec.push(['المكينة', `${kit.name}${count > 1 ? ` × ${count}` : ''}`]);
    return {
        items: lines, subtotal, vat_percent: vatPercent, vat, total: round2(subtotal + vat),
        spec, delivery_installation: installNote, region,
        order: {
            calculator: 'motors', section, section_label: SECTIONS[section],
            kit: kit ? kit.name : null, kit_count: kit ? count : 0,
            parts: lines.filter((l) => l.category === 'machine' && (!kit || l.name !== kit.name)).map((l) => `${l.name} × ${l.quantity}`),
            region: region.name, governorate: region.governorate
        }
    };
}

module.exports = { SECTIONS, KINDS, UNITS, seedMotors, sellPrice, loadItems, publicMotors, motorPrice, profitPercent };
