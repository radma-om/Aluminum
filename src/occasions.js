/* =============================================================
   «تقويم المناسبات» — the year's occasions (National Day, the Eids,
   Ramadan…) kept by the manager in «العروض والهدايا», so an offer
   or a greeting is ready in time:
   - The dashboard warns the managers ⚠️ from a week before each one
     (and on the day), saying whether a discount, a gift or a greeting
     already covers that day.
   - An offer has a first and a last day, so it starts and ends by itself.
   - Hijri dates are estimates (the moon sighting may move them a day).
   ============================================================= */
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX = 100;
const WARN_DAYS = 7;

const localToday = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
const validDate = (d) => DATE.test(String(d || '')) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));
const daysBetween = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400_000);

/* 2027 (from the company's calendar) */
const DEFAULT_OCCASIONS = [
    { name: 'الإسراء والمعراج — 27 رجب 1448هـ', date: '2027-01-05' },
    { name: 'يوم تولّي السلطان مقاليد الحكم', date: '2027-01-11' },
    { name: 'بداية رمضان — 1 رمضان 1448هـ', date: '2027-02-08' },
    { name: 'يوم المعلم العُماني', date: '2027-02-24' },
    { name: 'عيد الفطر — 1 شوال 1448هـ', date: '2027-03-09' },
    { name: 'بداية ذي الحجة — 1 ذي الحجة 1448هـ', date: '2027-05-07' },
    { name: 'عيد الأضحى — 10 ذي الحجة 1448هـ', date: '2027-05-16' },
    { name: 'رأس السنة الهجرية — 1 محرم 1449هـ', date: '2027-06-06' },
    { name: 'المولد النبوي — 12 ربيع الأول 1449هـ', date: '2027-08-14' },
    { name: 'يوم المرأة العُمانية', date: '2027-10-17' },
    { name: 'اليوم الوطني العُماني', date: '2027-11-20' },
    { name: 'الإسراء والمعراج — 27 رجب 1449هـ', date: '2027-12-25' }
];

/* The list as saved: each a name (up to 60 letters) and a date, by date; throws a message for a bad one */
function clean(list) {
    if (!Array.isArray(list) || list.length > MAX) throw new Error(`قائمة المناسبات غير صالحة (${MAX} مناسبة كحد أقصى)`);
    return list.map((o) => {
        const name = String((o && o.name) || '').trim().replace(/\s+/g, ' ');
        const date = String((o && o.date) || '').trim();
        if (!name) throw new Error('اكتب اسم كل مناسبة');
        if (name.length > 60) throw new Error(`اسم المناسبة طويل (60 حرفاً كحد أقصى): ${name.slice(0, 30)}…`);
        if (!validDate(date)) throw new Error(`تاريخ المناسبة غير صالح: ${name}`);
        return { name, date };
    }).sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

/* Whether an offer (on, with its first and last day) runs on a given day */
const runsOn = (enabled, from, until, day) => Boolean(enabled) && !(from && from > day) && !(until && until < day);

/* The occasions of the coming week (today included), each with the days left and what already covers it */
function upcoming(settings, today = localToday(), within = WARN_DAYS) {
    const s = settings || {};
    const list = Array.isArray(s.occasions) ? s.occasions : [];
    return list.filter((o) => o && validDate(o.date))
        .map((o) => ({ name: o.name, date: o.date, days_left: daysBetween(today, o.date) }))
        .filter((o) => o.days_left >= 0 && o.days_left <= within)
        .sort((a, b) => a.days_left - b.days_left)
        .map((o) => ({
            ...o,
            promo: runsOn(s.promo_enabled && Number(s.promo_percent) > 0, s.promo_from, s.promo_until, o.date) ? String(s.promo_label || '').trim() || 'خصم' : null,
            gift: runsOn(s.gift_enabled && String(s.gift_name || '').trim(), s.gift_from, s.gift_until, o.date) ? String(s.gift_name).trim() : null,
            greeting: runsOn(s.greeting_enabled, s.greeting_from, s.greeting_until, o.date)
        }));
}

module.exports = { DEFAULT_OCCASIONS, WARN_DAYS, clean, upcoming, runsOn, validDate, localToday };
