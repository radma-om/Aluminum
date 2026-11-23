/* =============================================================
   «تتبع الفريق» — where the technicians and marketers are, on a map, for
   the managers (and an employee given the «تتبع الفريق» section).
   - Shared only during the working day: the technician / marketer presses
     «بدء الدوام» (the first time after reading what is shared and agreeing),
     and their phone sends its place every minute while the system is open
     on its screen (a web page cannot send it from the background), until
     «إنهاء الدوام».
   - A snapshot with each step of a work order («في الطريق», «بدأ العمل»,
     «تم») and with each customer visit a marketer records.
   - Kept 30 days, then deleted by itself (personal data: no longer than needed).
   ============================================================= */
const leads = require('./leads');
const routing = require('./routing');

const TRACKED_ROLES = { technician: 'فني', marketer: 'مسوق' };
const KINDS = { live: 'موقع مباشر', shift_start: 'بدء الدوام', shift_end: 'إنهاء الدوام', event: 'خطوة عمل', visit: 'زيارة عميل' };
const RETENTION_DAYS = 30;
const LIVE_MIN_SECONDS = 20;   // a phone sending faster is ignored (one place per 20 s at most)
const LIVE_FRESH_MINUTES = 3;  // a place newer than this: «مباشر الآن»
const TZ = '+4 hours';

const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, expose: true, ...extra });
const clip = (s, n) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, n);
const sqlNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const tracked = (user) => Boolean(user && TRACKED_ROLES[user.role]);

const ready = new WeakSet();
function ensureTable(db) {
    if (ready.has(db)) return;
    ready.add(db);
    db.exec(`CREATE TABLE IF NOT EXISTS staff_locations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL,
        lat        REAL NOT NULL,
        lng        REAL NOT NULL,
        accuracy   REAL,
        kind       TEXT NOT NULL,
        label      TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS staff_locations_user ON staff_locations (user_id, created_at);
    CREATE INDEX IF NOT EXISTS staff_locations_at ON staff_locations (created_at);`);
    const cols = db.prepare('PRAGMA table_info(staff_users)').all().map((c) => c.name);
    if (!cols.includes('location_consent_at')) db.exec('ALTER TABLE staff_users ADD COLUMN location_consent_at TEXT');
    if (!cols.includes('on_shift_since')) db.exec('ALTER TABLE staff_users ADD COLUMN on_shift_since TEXT');
    // The trip under way: where to, and the time / distance left (JSON; see startTrip)
    if (!cols.includes('trip_json')) db.exec('ALTER TABLE staff_users ADD COLUMN trip_json TEXT');
    // A work order's place, read from its map link (or set by the technician on site)
    const wo = db.prepare('PRAGMA table_info(work_orders)').all().map((c) => c.name);
    if (!wo.includes('dest_lat')) db.exec('ALTER TABLE work_orders ADD COLUMN dest_lat REAL');
    if (!wo.includes('dest_lng')) db.exec('ALTER TABLE work_orders ADD COLUMN dest_lng REAL');
}

/* A place from the phone: real coordinates, and how sure the phone is (metres) */
function coords(b) {
    const lat = Number(b && b.lat);
    const lng = Number(b && b.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
        throw err(400, 'الموقع غير صالح — تأكد من السماح للمتصفح بالوصول إلى الموقع');
    }
    const acc = Number(b.accuracy);
    return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, accuracy: Number.isFinite(acc) && acc >= 0 ? Math.min(Math.round(acc), 100000) : null };
}

function insert(db, userId, c, kind, label = null) {
    db.prepare('INSERT INTO staff_locations (user_id, lat, lng, accuracy, kind, label) VALUES (?, ?, ?, ?, ?, ?)')
        .run(userId, c.lat, c.lng, c.accuracy, kind, label ? clip(label, 120) : null);
}

const row = (db, id) => db.prepare('SELECT id, display_name, role, active, location_consent_at, on_shift_since, trip_json FROM staff_users WHERE id = ?').get(Number(id));
const tripOf = (u) => { try { return u && u.trip_json ? JSON.parse(u.trip_json) : null; } catch { return null; } };
const saveTrip = (db, userId, trip) => db.prepare('UPDATE staff_users SET trip_json = ? WHERE id = ?').run(trip ? JSON.stringify(trip) : null, userId);

/* What a screen shows of a trip: where to, the time and distance left, and the navigation link */
function tripView(trip) {
    if (!trip) return null;
    const left = trip.seconds !== undefined && trip.seconds !== null;
    return {
        order_id: trip.order_id || null, label: trip.label, lat: trip.lat, lng: trip.lng, started_at: trip.started_at,
        arrived_at: trip.arrived_at || null, computed_at: trip.computed_at || null, estimate: Boolean(trip.estimate),
        seconds: left ? trip.seconds : null, meters: left ? trip.meters : null, polyline: trip.polyline || null,
        eta_text: left && !trip.arrived_at ? routing.durationText(trip.seconds) : null,
        distance_text: left && !trip.arrived_at ? routing.distanceText(trip.meters) : null,
        nav_url: routing.navUrl(trip)
    };
}

/* This account's sharing: whether it shares at all, agreed, and is on shift now */
function mine(db, user) {
    ensureTable(db);
    if (!tracked(user) || !user.id) return { tracked: false };
    const u = row(db, user.id);
    return { tracked: true, consent: Boolean(u && u.location_consent_at), on_shift_since: (u && u.on_shift_since) || null, every_seconds: 60, trip: tripView(tripOf(u)) };
}

/**
 * «بدء الدوام» / «إنهاء الدوام». Starting needs the account's agreement once (consent: true after reading the
 * notice); refused with need_consent otherwise. The place at that moment is recorded when the phone gives it.
 */
function shift(db, user, b = {}) {
    ensureTable(db);
    if (!tracked(user) || !user.id) throw err(403, 'مشاركة الموقع للفنيين والمسوقين فقط');
    const u = row(db, user.id);
    const on = Boolean(b.on);
    if (on) {
        if (!u.location_consent_at && b.consent !== true) throw err(400, 'يلزم موافقتك على مشاركة موقعك أثناء الدوام', { need_consent: true });
        if (!u.location_consent_at) db.prepare('UPDATE staff_users SET location_consent_at = ? WHERE id = ?').run(sqlNow(), u.id);
        if (!u.on_shift_since) db.prepare('UPDATE staff_users SET on_shift_since = ? WHERE id = ?').run(sqlNow(), u.id);
    } else {
        db.prepare('UPDATE staff_users SET on_shift_since = NULL, trip_json = NULL WHERE id = ?').run(u.id); // the trip ends with the day
    }
    if (b.lat !== undefined) {
        try { insert(db, u.id, coords(b), on ? 'shift_start' : 'shift_end'); } catch { /* the shift changes even without a place */ }
    }
    return mine(db, user);
}

/**
 * A place from the phone: kind «live» (every minute during the shift) or «event» (a work order step, with
 * its label). A live place off shift, or sooner than 20 s after the last, is not kept ({ kept: false }).
 */
function record(db, user, b = {}) {
    ensureTable(db);
    if (!tracked(user) || !user.id) throw err(403, 'مشاركة الموقع للفنيين والمسوقين فقط');
    const kind = b.kind === 'event' ? 'event' : 'live';
    const c = coords(b);
    const u = row(db, user.id);
    if (kind === 'live') {
        if (!u.on_shift_since) return { kept: false, reason: 'off_shift' };
        const last = db.prepare("SELECT created_at FROM staff_locations WHERE user_id = ? AND kind = 'live' ORDER BY id DESC LIMIT 1").get(u.id);
        if (last && Date.now() - Date.parse(last.created_at.replace(' ', 'T') + 'Z') < LIVE_MIN_SECONDS * 1000) return { kept: false, reason: 'too_soon' };
    } else if (!u.location_consent_at) {
        return { kept: false, reason: 'no_consent' };
    }
    insert(db, u.id, c, kind, kind === 'event' ? clip(b.label, 120) || 'خطوة عمل' : null);
    return { kept: true };
}

/**
 * A marketer's customer visit: the customer joins «متابعة العملاء» (a new one is theirs to follow), the visit
 * is written in the customer's log with a map link, and its place is kept for the map.
 */
function visit(db, user, b = {}) {
    ensureTable(db);
    if (!user || user.role !== 'marketer' || !user.id) throw err(403, 'تسجيل الزيارات للمسوقين');
    const name = clip(b.name, 120);
    const phone = String(b.phone || '').replace(/[^\d+]/g, '').slice(0, 20);
    const note = clip(b.note, 1000);
    if (!name && !phone) throw err(400, 'اكتب اسم العميل أو رقمه');
    let c = null;
    try { c = coords(b); } catch { c = null; }
    const key = leads.phoneKey(phone) || `visit:${user.id}:${Date.now()}`;
    let lead = leads.touch(db, { key, channel: 'field', name: name || null, phone: phone || null });
    if (!lead.assigned_to) lead = { ...lead, ...leads.update(db, lead.id, { assigned_to: user.display_name }, user.display_name) };
    const where = c ? `\n📍 الموقع: https://www.google.com/maps?q=${c.lat},${c.lng}` : '';
    leads.staffMessage(db, lead.id, `🚶 زيارة ميدانية${note ? `: ${note}` : ''}${where}`, user.display_name);
    if (c) insert(db, user.id, c, 'visit', name || phone);
    return { lead_id: lead.id, located: Boolean(c) };
}

/* The team now: each active technician / marketer, their last place and whether it is live */
function overview(db) {
    ensureTable(db);
    const users = db.prepare(`SELECT id, display_name, role, location_consent_at, on_shift_since, trip_json FROM staff_users
                              WHERE active = 1 AND role IN (${Object.keys(TRACKED_ROLES).map(() => '?').join(', ')}) ORDER BY role, display_name`).all(...Object.keys(TRACKED_ROLES));
    const lastOf = db.prepare('SELECT lat, lng, accuracy, kind, label, created_at AS at FROM staff_locations WHERE user_id = ? ORDER BY id DESC LIMIT 1');
    const freshMs = LIVE_FRESH_MINUTES * 60_000;
    return {
        people: users.map((u) => {
            const last = lastOf.get(u.id) || null;
            const age = last ? Date.now() - Date.parse(last.at.replace(' ', 'T') + 'Z') : Infinity;
            const state = !u.on_shift_since ? 'off' : age <= freshMs ? 'live' : 'quiet';
            return { id: u.id, name: u.display_name, role: u.role, role_label: TRACKED_ROLES[u.role], consent: Boolean(u.location_consent_at),
                on_shift_since: u.on_shift_since || null, state, last: last && { ...last, kind_label: KINDS[last.kind] || last.kind },
                trip: u.on_shift_since ? tripView(tripOf(u)) : null };
        }),
        kinds: KINDS,
        retention_days: RETENTION_DAYS,
        maps_key: String(process.env.GOOGLE_MAPS_API_KEY || '').trim() || null
    };
}

/* One person's day (Muscat time): every place in order, for the path and its stops */
function day(db, userId, date) {
    ensureTable(db);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : leads.localToday();
    const u = row(db, userId);
    if (!u || !TRACKED_ROLES[u.role]) throw err(404, 'الموظف غير موجود');
    const points = db.prepare(`SELECT lat, lng, accuracy, kind, label, created_at AS at FROM staff_locations
                               WHERE user_id = ? AND date(created_at, '${TZ}') = ? ORDER BY id LIMIT 3000`).all(u.id, d);
    return { user: { id: u.id, name: u.display_name, role: u.role, role_label: TRACKED_ROLES[u.role] }, date: d,
        points: points.map((p) => ({ ...p, kind_label: KINDS[p.kind] || p.kind })) };
}

/* Older than 30 days: deleted (run with the daily clean-up) */
function prune(db) {
    ensureTable(db);
    return Number(db.prepare("DELETE FROM staff_locations WHERE created_at < datetime('now', ?)").run(`-${RETENTION_DAYS} days`).changes);
}

/* ---------------- The trip: to a customer, the time and distance left ---------------- */

const ARRIVED_METERS = 150;    // this close: arrived
const REFRESH_SECONDS = 120;   // Google is asked again after 2 minutes…
const REFRESH_METERS = 300;    // …or sooner when the phone moved this far

/**
 * A trip starts (a technician's «في الطريق», or a marketer's «وجهتي»): to { lat, lng } with a label, for a work
 * order or not. `from` (the phone's place now) computes the time and distance at once.
 */
async function startTrip(db, user, { lat, lng, label, order_id = null }, from = null) {
    ensureTable(db);
    if (!tracked(user) || !user.id) throw err(403, 'الرحلات للفنيين والمسوقين فقط');
    const to = coords({ lat, lng });
    saveTrip(db, user.id, { ...to, label: clip(label, 120) || 'الوجهة', order_id: order_id ? Number(order_id) : null, started_at: sqlNow() });
    if (from) await refreshTrip(db, user, from, { force: true });
    return tripView(tripOf(row(db, user.id)));
}

/* The trip ends: arrived and started the work, the order closed, «إلغاء الوجهة», or the end of the day.
   With order_id: only the trips to that order (whoever is on it). */
function endTrip(db, { userId = null, orderId = null } = {}) {
    ensureTable(db);
    if (userId) return saveTrip(db, Number(userId), null);
    if (orderId) {
        for (const u of db.prepare('SELECT id, trip_json FROM staff_users WHERE trip_json IS NOT NULL').all()) {
            const t = tripOf(u);
            if (t && t.order_id === Number(orderId)) saveTrip(db, u.id, null);
        }
    }
}

/**
 * The time and distance left from the phone's place now; asked of Google at most every 2 minutes (sooner
 * after 300 m). Closer than 150 m: arrived. Returns the trip as screens show it (or null without a trip).
 */
async function refreshTrip(db, user, here, { force = false } = {}) {
    ensureTable(db);
    const u = row(db, user.id);
    const trip = tripOf(u);
    if (!trip || trip.arrived_at) return tripView(trip);
    const from = coords(here);
    const straight = routing.haversine(from, trip);
    if (straight <= ARRIVED_METERS) {
        saveTrip(db, u.id, { ...trip, arrived_at: sqlNow(), seconds: 0, meters: 0, polyline: null, computed_at: sqlNow() });
        return tripView(tripOf(row(db, u.id)));
    }
    const age = trip.computed_at ? (Date.now() - Date.parse(trip.computed_at.replace(' ', 'T') + 'Z')) / 1000 : Infinity;
    const moved = trip.from ? routing.haversine(from, trip.from) : Infinity;
    if (!force && age < REFRESH_SECONDS && moved < REFRESH_METERS) return tripView(trip);
    const r = await routing.route(from, trip);
    if (r.error) console.error('[routing]', r.error);
    // The trip may have ended while Google was asked
    const now = tripOf(row(db, u.id));
    if (!now || now.started_at !== trip.started_at) return tripView(now);
    saveTrip(db, u.id, { ...now, seconds: r.seconds, meters: r.meters, polyline: r.polyline, estimate: r.estimate, from, computed_at: sqlNow() });
    return tripView(tripOf(row(db, u.id)));
}

/* A work order's place: kept with the order, else read from its map link (a short link is followed once) */
async function orderPlace(db, order) {
    ensureTable(db);
    if (!order) return null;
    const o = db.prepare('SELECT id, map_url, dest_lat, dest_lng FROM work_orders WHERE id = ?').get(order.id);
    if (!o) return null;
    if (o.dest_lat !== null && o.dest_lng !== null) return { lat: o.dest_lat, lng: o.dest_lng };
    if (!o.map_url) return null;
    const c = await routing.resolve(o.map_url);
    if (c) db.prepare('UPDATE work_orders SET dest_lat = ?, dest_lng = ? WHERE id = ?').run(c.lat, c.lng, o.id);
    return c;
}

/* The office changed the map link: the place is read again from it */
async function replaceOrderPlace(db, orderId) {
    ensureTable(db);
    db.prepare('UPDATE work_orders SET dest_lat = NULL, dest_lng = NULL WHERE id = ?').run(Number(orderId));
    const place = await orderPlace(db, { id: Number(orderId) });
    movedTrips(db, Number(orderId), place);
    return place;
}

/* Trips to this order follow its new place (asked again at the next place from the phone) */
function movedTrips(db, orderId, place) {
    for (const u of db.prepare('SELECT id, trip_json FROM staff_users WHERE trip_json IS NOT NULL').all()) {
        const t = tripOf(u);
        if (!t || t.order_id !== orderId) continue;
        if (!place) { saveTrip(db, u.id, null); continue; }
        const { computed_at, from, seconds, meters, polyline, arrived_at, ...rest } = t; // eslint-disable-line no-unused-vars
        saveTrip(db, u.id, { ...rest, lat: place.lat, lng: place.lng });
    }
}

/**
 * The technician (or the office) sets where the customer is: a Google Maps / WhatsApp link, or the phone's
 * place now («أنا عند العميل الآن»). Kept with the order (and its map link), for every later trip.
 */
async function setOrderPlace(db, orderId, b = {}) {
    ensureTable(db);
    const id = Number(orderId);
    let place = null;
    let link = String(b.map_url || '').trim().slice(0, 500);
    if (link) {
        const r = await routing.resolveDetail(link);
        place = r.place;
        if (!place) { console.error('[routing] could not read the place from the link:', r.reason); throw err(400, routing.unreadable(r.reason)); }
        if (!/^https:\/\//i.test(link)) link = `https://www.google.com/maps?q=${place.lat},${place.lng}`;
    } else {
        place = coords(b);
        link = `https://www.google.com/maps?q=${place.lat},${place.lng}`;
    }
    db.prepare("UPDATE work_orders SET map_url = ?, dest_lat = ?, dest_lng = ?, updated_at = datetime('now') WHERE id = ?").run(link, place.lat, place.lng, id);
    movedTrips(db, id, place);
    return { ...place, map_url: link };
}

/* For the customer's «تتبع طلبي»: a technician on the way to this order — the time and distance left (no place) */
function orderTrip(db, orderId) {
    ensureTable(db);
    for (const u of db.prepare("SELECT id, display_name, trip_json FROM staff_users WHERE trip_json IS NOT NULL AND on_shift_since IS NOT NULL AND role = 'technician'").all()) {
        const t = tripOf(u);
        if (!t || t.order_id !== Number(orderId)) continue;
        const fresh = t.computed_at && Date.now() - Date.parse(t.computed_at.replace(' ', 'T') + 'Z') < 15 * 60_000;
        if (t.arrived_at) return { arrived: true };
        return fresh ? { arrived: false, eta_text: routing.durationText(t.seconds), distance_text: routing.distanceText(t.meters), estimate: Boolean(t.estimate) } : { arrived: false };
    }
    return null;
}

module.exports = {
    TRACKED_ROLES, KINDS, RETENTION_DAYS, ensureTable, mine, shift, record, visit, overview, day, prune,
    startTrip, endTrip, refreshTrip, orderTrip, orderPlace, replaceOrderPlace, setOrderPlace, coords
};
