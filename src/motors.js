/* =============================================================
   Gate motors, by section (sliding gates, swing gates, parking
   barriers... — sections are added in the admin panel).
   - Each section has kits (e.g. sliding motor 600 kg: motor + 4 m rack +
     sensors + 2 remotes + warning lamp + exit button) and accessories
     sold separately (rack per 1 m piece, remote, sensors set, lamp...).
   - Price = purchase cost × (1 + the item's profit %), unless a fixed sell
     price is set; VAT is added on top.
   - Installation per kit = the wilayah's base motor fee + the section's
     extra (e.g. Nizwa 30; swing +20 → 50; parking barrier +50 → 80).
     Delivery: the wilayah delivery fee, once per order.
   - Possible extra fees (incomplete wiring, foundation...) are told to the
     customer; they are not added to the total.
   ============================================================= */
const { getSettings } = require('./db');
const { round2 } = require('./pricing');
const { getRegion, locations } = require('./doors');

const KINDS = { kit: 'طقم مكينة', part: 'إكسسوار / قطعة' };
const UNITS = { set: 'طقم', piece: 'قطعة', meter: 'متر' };
const err400 = (message) => Object.assign(new Error(message), { status: 400 });

/* Starting sections (key = for databases of version 3.0.0, which had them fixed) */
const SEED_SECTIONS = [
    { key: 'sliding', name: 'مكائن البوابات المنزلقة', install_extra: 0,
      description: 'مكائن سحب للبوابات المنزلقة (السحّابة) بقوة تناسب وزن البوابة.' },
    { key: 'swing', name: 'مكائن البوابات المتأرجحة (الدرفتين)', install_extra: 20,
      description: 'مكائن ذراع للبوابات المتأرجحة ذات الدرفتين.' },
    { key: 'parking', name: 'بوابات المواقف (Parking Barrier)', install_extra: 50,
      description: 'حواجز المواقف الآلية لمداخل المباني والمواقف.' }
];

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

/* Fees the customer is told about (amount empty = set after a site visit) */
const SEED_EXTRA_FEES = [
    { name: 'في حال عدم اكتمال التسليكات الكهربائية', amount: null },
    { name: 'في حال عدم جاهزية التأسيس (القاعدة / المسار)', amount: null }
];

/* Sections always exist (also with SEED_SAMPLE=0), and items of older versions are linked to them */
function ensureSections(db) {
    if (!db.prepare('SELECT COUNT(*) AS n FROM motor_sections').get().n) {
        const ins = db.prepare('INSERT INTO motor_sections (key, name, description, install_extra, sort_order) VALUES (?, ?, ?, ?, ?)');
        SEED_SECTIONS.forEach((s, i) => ins.run(s.key, s.name, s.description, s.install_extra, i));
        const fee = db.prepare('INSERT INTO motor_extra_fees (section_id, name, amount, sort_order) VALUES (NULL, ?, ?, ?)');
        if (!db.prepare('SELECT COUNT(*) AS n FROM motor_extra_fees').get().n) SEED_EXTRA_FEES.forEach((f, i) => fee.run(f.name, f.amount, i));
    }
    linkItems(db);
}

/* Items without a section (version 3.0.0 or an old backup): by their old key, else the first section */
function linkItems(db) {
    const first = db.prepare('SELECT id FROM motor_sections ORDER BY sort_order, id LIMIT 1').get();
    if (!first) return;
    db.prepare(`UPDATE motor_items SET section_id = COALESCE(
                    (SELECT s.id FROM motor_sections s WHERE s.key = motor_items.section), ?)
                WHERE section_id IS NULL OR section_id NOT IN (SELECT id FROM motor_sections)`).run(first.id);
}

function seedMotors(db) {
    ensureSections(db);
    if (db.prepare('SELECT COUNT(*) AS n FROM motor_items').get().n) return;
    const sectionId = (key) => db.prepare('SELECT id FROM motor_sections WHERE key = ?').get(key).id;
    const ins = db.prepare(`INSERT INTO motor_items (section, section_id, kind, name, description, unit, cost, active, link, sort_order)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    SEED.forEach((m, i) => ins.run(m.section, sectionId(m.section), m.kind, m.name, m.description, m.unit, m.cost, m.active, m.link || null, i));
}

/* Default profit: used by items whose own profit % is empty */
const profitPercent = (settings) => {
    const p = Number(settings.motors_profit_percent);
    return Number.isFinite(p) ? p : Number(settings.profit_percent) || 0;
};

const itemProfit = (item, settings) => (item.profit_percent != null ? Number(item.profit_percent) : profitPercent(settings));

/* Sell price before VAT: fixed price if set, else cost + the item's profit; null = no price yet */
function sellPrice(item, settings) {
    if (item.price != null) return round2(Number(item.price));
    if (item.cost == null) return null;
    return round2(Number(item.cost) * (1 + itemProfit(item, settings) / 100));
}

function loadSections(db, { includeInactive = false } = {}) {
    return db.prepare(`SELECT * FROM motor_sections ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort_order, id`).all();
}

function loadItems(db, { includeInactive = false } = {}) {
    const settings = getSettings(db);
    const rows = db.prepare(`SELECT * FROM motor_items ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort_order, id`).all();
    return rows.map((r) => ({ ...r, sell_price: sellPrice(r, settings), effective_profit: itemProfit(r, settings) }))
        // an item without a price is never offered to customers
        .filter((r) => includeInactive || r.sell_price != null);
}

function loadExtraFees(db, { includeInactive = false } = {}) {
    return db.prepare(`SELECT * FROM motor_extra_fees ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort_order, id`).all();
}

/* The possible extra fees of a section (its own and those for all sections) */
const sectionFees = (fees, sectionId) => fees.filter((f) => f.section_id == null || f.section_id === sectionId)
    .map((f) => ({ name: f.name, amount: f.amount }));

const feeText = (f) => `${f.name}: ${f.amount != null ? `${Number(f.amount).toFixed(2)} ر.ع` : 'تُحدد بعد المعاينة'}`;
const extraFeesNote = (fees) => (fees.length ? 'رسوم إضافية عند الحاجة (غير مشمولة في السعر): ' + fees.map(feeText).join('، ') : '');

/* Wilayat of the enabled governorates (installation fee may be missing: then it is set after a visit) */
function motorLocations(db) {
    return locations(db).map((g) => ({ ...g, wilayat: g.wilayat.map(({ id, name }) => ({ id, name })) }));
}

/**
 * Sections with their kits and accessories.
 * Customer page: no prices (like the other calculators, the price comes with the request),
 * and only sections that have something to sell. withPrices (AI agent): prices, and all sections.
 */
function publicMotors(db, { withPrices = false } = {}) {
    const items = loadItems(db);
    const fees = loadExtraFees(db);
    const view = (i) => ({
        id: i.id, name: i.name, description: i.description, unit: UNITS[i.unit] || i.unit,
        ...(withPrices ? { unit_price: i.sell_price } : {})
    });
    const sections = loadSections(db).map((s) => ({
        id: s.id, name: s.name, description: s.description || '',
        kits: items.filter((i) => i.section_id === s.id && i.kind === 'kit').map(view),
        parts: items.filter((i) => i.section_id === s.id && i.kind === 'part').map(view),
        extra_fees: sectionFees(fees, s.id)
    }));
    return {
        sections: withPrices ? sections : sections.filter((s) => s.kits.length || s.parts.length),
        vat_percent: Number(getSettings(db).vat_percent) || 0,
        locations: motorLocations(db)
    };
}

/* A section by id, or by its old key ('sliding' / 'swing') */
function findSection(db, ref) {
    if (ref == null || ref === '') return null;
    const s = /^\d+$/.test(String(ref))
        ? db.prepare('SELECT * FROM motor_sections WHERE id = ?').get(Number(ref))
        : db.prepare('SELECT * FROM motor_sections WHERE key = ?').get(String(ref));
    return s && s.active ? s : null;
}

const line = (name, type, unit, qty, price) => ({
    product_id: null, category: 'machine', name, type, unit, quantity: qty,
    unit_price: round2(price), line_total: round2(price * qty)
});

/**
 * Price of a motors order.
 * { sectionId, kitId, kitCount, parts: [{ id, qty }], regionId, installation: true }
 */
function motorPrice(db, { sectionId, kitId, kitCount = 1, parts = [], regionId, installation = true }) {
    const section = findSection(db, sectionId);
    if (!section) throw err400('اختر نوع البوابة');
    const items = loadItems(db).filter((i) => i.section_id === section.id);
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
    const partNames = [];
    for (const p of Array.isArray(parts) ? parts : []) {
        const qty = Math.max(0, Math.min(500, parseInt(p.qty, 10) || 0));
        if (!qty) continue;
        const part = items.find((i) => i.kind === 'part' && i.id === Number(p.id));
        if (!part) throw err400('قطعة غير متوفرة');
        lines.push(line(part.name, part.description || null, part.unit, qty, part.sell_price));
        partNames.push(`${part.name} × ${qty}`);
    }
    if (!lines.length) throw err400('اختر مكينة أو قطعة واحدة على الأقل');

    // Installation per kit = the wilayah's base fee + the section's extra
    const base = db.prepare('SELECT motor_installation_fee AS fee FROM regions WHERE id = ?').get(region.id).fee;
    let installNote = 'بدون تركيب (توريد فقط)';
    if (kit && installation) {
        if (base != null) {
            const fee = Number(base) + (Number(section.install_extra) || 0);
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
    const spec = [['نوع البوابة', section.name]];
    if (kit) spec.push(['المكينة', `${kit.name}${count > 1 ? ` × ${count}` : ''}`]);
    // Possible extra fees only concern an installation
    const extraFees = kit && installation ? sectionFees(loadExtraFees(db), section.id) : [];
    return {
        items: lines, subtotal, vat_percent: vatPercent, vat, total: round2(subtotal + vat),
        spec, delivery_installation: installNote, region,
        extra_fees: extraFees, extra_fees_note: extraFeesNote(extraFees),
        order: {
            calculator: 'motors', section_id: section.id, section_label: section.name,
            kit: kit ? kit.name : null, kit_count: kit ? count : 0, parts: partNames,
            region: region.name, governorate: region.governorate
        }
    };
}

module.exports = {
    KINDS, UNITS, ensureSections, linkItems, seedMotors, sellPrice, loadSections, loadItems, loadExtraFees,
    publicMotors, motorPrice, profitPercent, findSection
};
