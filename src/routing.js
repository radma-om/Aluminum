/* =============================================================
   Where a customer is, and how far / how long to get there.
   - A place from what people paste: a Google Maps link (full or short
     maps.app.goo.gl), a WhatsApp shared location, or «23.58, 58.38».
     A short link is followed (Google's own addresses only) to read it.
   - The road distance and time with traffic from Google Routes
     (GOOGLE_ROUTES_API_KEY, the server's key); without it, or when
     Google does not answer, an estimate: the straight line × 1.3 at
     60 km/h (marked «تقريبي»).
   ============================================================= */
const SHORT_HOSTS = new Set(['maps.app.goo.gl', 'goo.gl']);
const GOOGLE_HOST = /^(www\.|maps\.)?google\.[a-z.]{2,8}$/i;
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

let fetcher = (...a) => fetch(...a);
const setFetchForTests = (fn) => { fetcher = fn || ((...a) => fetch(...a)); };

const ok = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
const pair = (a, b) => {
    const lat = Number(a);
    const lng = Number(b);
    return ok(lat, lng) ? { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 } : null;
};

/* The coordinates written in a link or text, or null. The pin of a place (!3d…!4d…) comes before a search
   (q=…) and before the map's centre (@…). */
function parseCoords(text) {
    let s = String(text || '').trim();
    if (!s) return null;
    try { s = decodeURIComponent(s); } catch { /* keep as is */ }
    const tries = [
        /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/,
        /[?&](?:q|query|ll|destination|daddr|center)=(?:loc:)?\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/,
        /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/,
        /^(-?\d{1,2}\.\d+)\s*[,،]\s*(-?\d{1,3}\.\d+)$/
    ];
    for (const re of tries) {
        const m = s.match(re);
        const c = m && pair(m[1], m[2]);
        if (c) return c;
    }
    return null;
}

/* A place from a link or text; a short Google link is followed (up to 4 steps, Google's addresses only).
   Returns { lat, lng } or null. */
async function resolve(text) {
    const direct = parseCoords(text);
    if (direct) return direct;
    let url;
    try { url = new URL(String(text || '').trim()); } catch { return null; }
    if (url.protocol !== 'https:' || !SHORT_HOSTS.has(url.hostname.toLowerCase())) return null;
    for (let step = 0; step < 4; step++) {
        let res;
        try { res = await fetcher(url.href, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000) }); } catch { return null; }
        const loc = res.headers && res.headers.get && res.headers.get('location');
        if (!loc) return null;
        const c = parseCoords(loc);
        if (c) return c;
        try { url = new URL(loc, url); } catch { return null; }
        const host = url.hostname.toLowerCase();
        if (url.protocol !== 'https:' || !(SHORT_HOSTS.has(host) || GOOGLE_HOST.test(host))) return null;
    }
    return null;
}

/* The straight line between two places, in metres */
function haversine(a, b) {
    const R = 6371000;
    const rad = (d) => d * Math.PI / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

const estimate = (from, to) => {
    const meters = Math.round(haversine(from, to) * 1.3);
    return { meters, seconds: Math.round(meters / (60000 / 3600)), polyline: null, estimate: true };
};

/**
 * The drive from one place to another: { meters, seconds, polyline, estimate }. Google Routes with traffic when
 * GOOGLE_ROUTES_API_KEY is set; the estimate otherwise (and when Google fails: error says why).
 */
async function route(from, to) {
    const key = String(process.env.GOOGLE_ROUTES_API_KEY || '').trim();
    if (!key) return estimate(from, to);
    const point = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
    try {
        const res = await fetcher(ROUTES_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline' },
            body: JSON.stringify({ origin: point(from), destination: point(to), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE', languageCode: 'ar', regionCode: 'OM' }),
            signal: AbortSignal.timeout(6000)
        });
        const body = await res.json().catch(() => ({}));
        const r = body && Array.isArray(body.routes) && body.routes[0];
        if (!res.ok || !r) {
            const why = (body && body.error && body.error.message) || `HTTP ${res.status}`;
            return { ...estimate(from, to), error: String(why).slice(0, 200) };
        }
        return { meters: Number(r.distanceMeters) || 0, seconds: parseInt(String(r.duration || '0'), 10) || 0, polyline: (r.polyline && r.polyline.encodedPolyline) || null, estimate: false };
    } catch (e) {
        return { ...estimate(from, to), error: String(e.message || e).slice(0, 200) };
    }
}

const navUrl = (to) => `https://www.google.com/maps/dir/?api=1&destination=${to.lat},${to.lng}&travelmode=driving`;

/* «18 دقيقة» / «1 س 5 د» and «12.4 كم» / «850 م» */
function durationText(seconds) {
    const m = Math.max(1, Math.round(Number(seconds || 0) / 60));
    if (m < 60) return `${m} دقيقة`;
    return `${Math.floor(m / 60)} س ${m % 60 ? `${m % 60} د` : ''}`.trim();
}
const distanceText = (meters) => (meters >= 1000 ? `${(meters / 1000).toFixed(1)} كم` : `${Math.max(0, Math.round(meters / 10) * 10)} م`);

module.exports = { parseCoords, resolve, route, haversine, navUrl, durationText, distanceText, setFetchForTests };
