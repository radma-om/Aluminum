/* =============================================================
   Which business a customer's message is about — no extra model call:
   RADMA (gates, roller shutters, overhead, motors, aluminium),
   PANORAMA (cameras, recorders, networks, intercoms, attendance…),
   MIXED (both in one message), NONE (a greeting, «كم السعر؟»).
   The conversation's current business carries a NONE message: after a
   question about cameras, «السلام عليكم» stays with Panorama. With no
   current business it is MIXED: the model sees both and asks.
   ============================================================= */

/* Without diacritics; أ/إ/آ → ا, ة → ه, ى → ي; Arabic digits → 0-9; lower case */
function normalize(text) {
    return String(text || '')
        .replace(/[ً-ٰٟـ]/g, '')
        .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
        .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
        .toLowerCase();
}

/* A word's forms without its prefixes: «والكاميرات» → والكاميرات, الكاميرات, كاميرات */
function forms(word) {
    const out = new Set([word]);
    const m = word.match(/^([وف]?)([بلك]?)(ال|لل)?(.+)$/);
    if (m) {
        out.add(word.slice(m[1].length));
        out.add(word.slice(m[1].length + m[2].length));
        if (m[3]) out.add(m[4]);
    }
    return [...out].filter((w) => w.length >= 2);
}

const STEMS = {
    PANORAMA: ['كامير', 'كمير', 'مراقب', 'هارديسك', 'هاردسك', 'هارد', 'انتركوم', 'انتركم', 'بصم', 'راوتر', 'رواتر', 'سويتش', 'سوتش', 'شبك', 'مكبر', 'سماع', 'بانوراما', 'نظام حضور'],
    RADMA: ['شتر', 'رول', 'اوفرهيد', 'بواب', 'مكين', 'ماكين', 'المنيوم', 'الومنيوم', 'منيوم', 'ردما']
};
const PHRASES = {
    PANORAMA: ['حضور وانصراف', 'حضور والانصراف', 'واي فاي', 'وايفاي', 'اكسس بوينت', 'اكسيس بوينت'],
    RADMA: ['اوفر هيد', 'باب كراج', 'باب الكراج', 'ابواب كراج', 'محرك بواب', 'محرك الباب', 'ريموت بواب', 'ريموت الباب']
};
const LATIN = {
    PANORAMA: /(?:^|[^a-z0-9])i?ds-\d|\b(nvr|dvr|ups|wi-?fi|router|switch|cctv|cameras?|hikvision|dahua|intercom|access point)\b/i,
    RADMA: /\b(shutters?|roller|overhead|gates?|garage|radma)\b/i
};
/* A size with numbers (roller shutters / gates): «مقاس 3», «ارتفاع 250», «عرض 4», «3×2.5» */
const SIZE = /(مقاس|ارتفاع|عرض)\s*(الفتحه|البوابه|الباب)?\s*[:=]?\s*\d|\d+(\.\d+)?\s*(×|x|\*)\s*\d/;

function matches(business, text) {
    const n = normalize(text);
    if (LATIN[business].test(n)) return true;
    if (PHRASES[business].some((p) => n.includes(p))) return true;
    if (business === 'RADMA' && SIZE.test(n)) return true;
    const words = n.split(/[^\p{L}\p{N}-]+/u).filter(Boolean);
    return words.some((w) => forms(w).some((f) => STEMS[business].some((s) => (s.includes(' ') ? n.includes(s) : f.startsWith(s)))));
}

/**
 * classify(text, state) → { kind, route, business }
 *   kind: what the message itself says (RADMA | PANORAMA | MIXED | NONE)
 *   route: what the model sees this time (NONE → the current business, or MIXED)
 *   business: the conversation's current business after this message (RADMA | PANORAMA | null)
 * state: { current_business }
 */
function classify(text, state = {}) {
    const p = matches('PANORAMA', text);
    const r = matches('RADMA', text);
    const current = ['RADMA', 'PANORAMA'].includes(state && state.current_business) ? state.current_business : null;
    const kind = p && r ? 'MIXED' : p ? 'PANORAMA' : r ? 'RADMA' : 'NONE';
    if (kind === 'RADMA' || kind === 'PANORAMA') return { kind, route: kind, business: kind };
    if (kind === 'MIXED') return { kind, route: 'MIXED', business: current };
    return { kind, route: current || 'MIXED', business: current };
}

module.exports = { classify, normalize };
