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

/* Arabic-Indic digits and separators as typed on Arabic phones → «23.58, 58.38» */
const asciiDigits = (s) => String(s || '').replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/٫/g, '.').replace(/،/g, ',');

/* The coordinates written in a link or text, or null. The pin of a place (!3d…!4d…) comes before a search
   (q=…) and before the map's centre (@…). */
function parseCoords(text) {
    let s = asciiDigits(text).trim();
    if (!s) return null;
    try { s = decodeURIComponent(s); } catch { /* keep as is */ }
    const tries = [
        /!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/,
        /[?&](?:q|query|ll|destination|daddr|center|sll)=(?:loc:)?\s*(-?\d{1,2}\.\d+)\s*,\s*\+?(-?\d{1,3}\.\d+)/,
        /\/maps\/search\/(-?\d{1,2}\.\d+),\+?(-?\d{1,3}\.\d+)/,
        /@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/,
        /^(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)$/
    ];
    for (const re of tries) {
        const m = s.match(re);
        const c = m && pair(m[1], m[2]);
        if (c) return c;
    }
    return null;
}

/* The place in a Google Maps page (a place shared by name has no coordinates in its link): its pin, the
   preview image's marker or centre, or the map's starting view (longitude first there) */
function coordsInPage(html) {
    const s = String(html || '').slice(0, 3_000_000);
    const tries = [
        [/!3d(-?\d{1,2}\.\d{3,})!4d(-?\d{1,3}\.\d{3,})/, false],
        [/markers=(-?\d{1,2}\.\d{3,})(?:%2C|,)(-?\d{1,3}\.\d{3,})/, false],
        [/staticmap\?center=(-?\d{1,2}\.\d{3,})(?:%2C|,)(-?\d{1,3}\.\d{3,})/, false],
        [/APP_INITIALIZATION_STATE=\[\[\[[-\d.e+]+,(-?\d{1,3}\.\d{3,}),(-?\d{1,2}\.\d{3,})\]/, true],
        [/\/@(-?\d{1,2}\.\d{3,}),(-?\d{1,3}\.\d{3,})/, false]
    ];
    for (const [re, lngFirst] of tries) {
        const m = s.match(re);
        const c = m && (lngFirst ? pair(m[2], m[1]) : pair(m[1], m[2]));
        if (c) return c;
    }
    return null;
}

/* The first link in what was pasted (a share from the Google Maps app is «the place's name + the link») */
const firstUrl = (text) => { const m = String(text || '').match(/https?:\/\/[^\s<>"']+/i); return m ? m[0].replace(/[).,،]+$/, '') : null; };

const allowedHost = (host) => SHORT_HOSTS.has(host) || GOOGLE_HOST.test(host) || host === 'consent.google.com';
// As a phone's browser, and past Google's cookie-consent page (servers in Europe are shown it first)
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Accept-Language': 'en-US,en;q=0.8,ar;q=0.6',
    Cookie: 'CONSENT=YES+cb; SOCS=CAI'
};

/**
 * A place from a link or text: { lat, lng } or null. Coordinates written in it are read directly; else a Google
 * Maps link (short maps.app.goo.gl or a place shared by name) is followed — up to 5 steps, Google's addresses only —
 * and the place is read from the address it leads to, or from the Google Maps page itself.
 * resolve.detail(text) also says why it failed ({ place, reason }) for the server's log.
 */
async function resolveDetail(text) {
    const direct = parseCoords(text);
    if (direct) return { place: direct };
    const link = firstUrl(text);
    if (!link) return { place: null, reason: 'no_link' };
    const inLink = parseCoords(link);
    if (inLink) return { place: inLink };
    let url;
    try { url = new URL(link); } catch { return { place: null, reason: 'bad_link' }; }
    for (let step = 0; step < 5; step++) {
        const host = url.hostname.toLowerCase();
        if (url.protocol !== 'https:' || !allowedHost(host)) return { place: null, reason: `not_google:${host}` };
        // Google's consent page carries the address it was going to
        if (host === 'consent.google.com' && url.searchParams.get('continue')) {
            const cont = url.searchParams.get('continue');
            const c = parseCoords(cont);
            if (c) return { place: c };
            try { url = new URL(cont); } catch { return { place: null, reason: 'consent' }; }
            continue;
        }
        let res;
        try { res = await fetcher(url.href, { method: 'GET', redirect: 'manual', headers: HEADERS, signal: AbortSignal.timeout(6000) }); } catch (e) { return { place: null, reason: `fetch:${String(e.message || e).slice(0, 60)}` }; }
        const loc = res.headers && res.headers.get && res.headers.get('location');
        if (loc) {
            const c = parseCoords(loc);
            if (c) return { place: c };
            try { url = new URL(loc, url); } catch { return { place: null, reason: 'bad_redirect' }; }
            continue;
        }
        // The page itself (a place shared by its name): read the place from it
        const html = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
        const c = coordsInPage(html);
        return c ? { place: c } : { place: null, reason: `no_coords:${host}:${res.status || ''}` };
    }
    return { place: null, reason: 'too_many_redirects' };
}
/* What the user is told when a link cannot be read (with the reason, to pass on if it happens again) */
const unreadable = (reason) => `لم أستطع قراءة الموقع من الرابط. جرّب: في خرائط Google اضغط مطولاً على مكان العميل حتى يظهر الدبوس، ثم «مشاركة» ← «نسخ الرابط»، أو الصق الإحداثيات مثل 23.588, 58.383${reason && reason !== 'no_link' ? ` (السبب: ${reason})` : ''}`;

async function resolve(text) {
    const r = await resolveDetail(text);
    if (!r.place && r.reason && r.reason !== 'no_link') console.error('[routing] could not read the place from the link:', r.reason);
    return r.place;
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

module.exports = { unreadable, parseCoords, coordsInPage, firstUrl, resolve, resolveDetail, route, haversine, navUrl, durationText, distanceText, setFetchForTests };
