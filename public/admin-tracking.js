/* =============================================================
   «تتبع الفريق»
   1) The technician's / marketer's own working day (the bar at the top):
      «بدء الدوام» asks once for their agreement, then their place goes
      every minute while the system is open on their screen, until
      «إنهاء الدوام». A snapshot with each work order step, and a marketer
      records customer visits with their place.
   2) The map for managers and those given «تتبع الفريق»: who is where now,
      and one person's day (path and stops). Google Maps when the server
      has GOOGLE_MAPS_API_KEY; otherwise «خرائط Google» links.
   Uses api(), $id(), esc(), setStatus(), askYes(), tell() and ME from admin.js.
   ============================================================= */

const isTracked = () => ME && (ME.role === 'technician' || ME.role === 'marketer');
let myShift = { tracked: false };
let shiftWatch = null;
let lastSentAt = 0;
let lastPos = null;

const gmapsLink = (lat, lng) => `https://www.google.com/maps?q=${encodeURIComponent(lat)},${encodeURIComponent(lng)}`;
const placeOf = (p) => ({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy });
const agoText = (at) => {
    const ms = Date.now() - Date.parse(String(at).replace(' ', 'T') + 'Z');
    const m = Math.max(0, Math.round(ms / 60000));
    if (m < 1) return 'الآن';
    if (m < 60) return `قبل ${m} دقيقة`;
    const h = Math.round(m / 60);
    if (h < 24) return `قبل ${h} ساعة`;
    return `قبل ${Math.round(h / 24)} يوم`;
};
// A stored time («2026-11-23 08:41:27», UTC) or a browser one (ISO): shown in Muscat time
const tkTime = (at) => new Date(/T.*Z$/.test(String(at)) ? at : String(at).replace(' ', 'T') + 'Z').toLocaleTimeString(APP_LOCALE, { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Muscat' });

/* The phone's place now (null when refused, unavailable or too slow) */
function currentPlace(timeout = 10000) {
    if (!navigator.geolocation) return Promise.resolve(null);
    return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition((p) => resolve(placeOf(p)), () => resolve(null), { enableHighAccuracy: true, timeout, maximumAge: 30000 });
    });
}

/* ---------------- 1) The technician's / marketer's day ---------------- */

async function initShift() {
    if (!isTracked()) return;
    try { myShift = await api('GET', '/api/admin/me/location'); } catch { return; }
    if (!myShift.tracked) return;
    $id('shiftBar').hidden = false;
    $id('visitBtn').hidden = ME.role !== 'marketer';
    renderShift();
    if (myShift.on_shift_since) startWatch();
}

function renderShift(note) {
    const on = Boolean(myShift.on_shift_since);
    $id('shiftBar').classList.toggle('on', on);
    $id('shiftState').innerHTML = on
        ? `<span class="live-dot"></span> في الدوام — موقعك يُشارك مع الإدارة${note ? ` <small class="muted">(${esc(note)})</small>` : ''}`
        : '<i class="fas fa-location-dot"></i> خارج الدوام — لا يُشارك موقعك';
    $id('shiftBtn').innerHTML = on ? '<i class="fas fa-circle-pause"></i> إنهاء الدوام' : '<i class="fas fa-play"></i> بدء الدوام';
}

async function toggleShift() {
    const on = !myShift.on_shift_since;
    const btn = $id('shiftBtn');
    if (on && !myShift.consent) {
        const ok = await askYes('مشاركة موقعك أثناء الدوام\n\n'
            + '• يرى المدير (ومن يعطيه صلاحية «تتبع الفريق») موقعك على الخريطة من «بدء الدوام» حتى «إنهاء الدوام» فقط.\n'
            + '• يُرسل موقعك كل دقيقة والنظام مفتوح على شاشتك، ومع كل خطوة في أمر العمل وكل زيارة عميل.\n'
            + '• تُحذف المواقع تلقائياً بعد 30 يوماً.\n\nهل توافق؟', { okLabel: 'أوافق' });
        if (!ok) return;
    }
    btn.disabled = true;
    const place = await currentPlace();
    if (on && !place) await tell('لم يصل موقع جوالك. اسمح للمتصفح بالوصول إلى الموقع (من إعدادات المتصفح أو الجوال) ثم حاول مرة أخرى — سيبدأ الدوام الآن ويُرسل الموقع حين يتاح.');
    try {
        myShift = await api('POST', '/api/admin/me/shift', { on, consent: on ? true : undefined, ...(place || {}) });
        if (place) lastSentAt = Date.now();
        renderShift();
        if (on) startWatch(); else stopWatch();
    } catch (err) { tell(err.message); }
    btn.disabled = false;
}

/* While on shift: the phone reports its place as it moves; one is sent each minute at most */
function startWatch() {
    if (!navigator.geolocation || shiftWatch !== null) return;
    shiftWatch = navigator.geolocation.watchPosition((p) => {
        lastPos = placeOf(p);
        if (Date.now() - lastSentAt >= (myShift.every_seconds || 60) * 1000) sendLive();
    }, (e) => { renderShift(e.code === 1 ? 'الموقع غير مسموح في المتصفح' : 'لا يصل الموقع الآن'); }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 });
}
function stopWatch() {
    if (shiftWatch !== null && navigator.geolocation) navigator.geolocation.clearWatch(shiftWatch);
    shiftWatch = null;
}
async function sendLive() {
    if (!lastPos || !myShift.on_shift_since) return;
    lastSentAt = Date.now();
    try {
        const r = await api('POST', '/api/admin/me/location', { ...lastPos, kind: 'live' });
        if (r.reason === 'off_shift') { myShift.on_shift_since = null; stopWatch(); }
        renderShift(r.kept ? `آخر إرسال ${tkTime(new Date().toISOString())}` : '');
    } catch { /* no signal: the next one will go */ }
}
// Back on the screen: send the place at once (the phone pauses the page in the background)
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && myShift.on_shift_since) {
        currentPlace(8000).then((p) => { if (p) { lastPos = p; lastSentAt = 0; sendLive(); } });
    }
});

/* A work order step («في الطريق», «بدأ العمل», «تم»): its place, for the map (silent when unavailable) */
async function trackEvent(label) {
    if (!isTracked() || !myShift.consent) return;
    const p = await currentPlace(8000);
    if (p) api('POST', '/api/admin/me/location', { ...p, kind: 'event', label }).catch(() => {});
}

/* A marketer's customer visit: the customer goes to «متابعة العملاء» with the visit and its place */
function openVisitForm() {
    $id('visitForm').hidden = false;
    $id('visitName').focus();
}
async function saveVisit() {
    const body = { name: $id('visitName').value.trim(), phone: $id('visitPhone').value.trim(), note: $id('visitNote').value.trim() };
    if (!body.name && !body.phone) return setStatus('visitStatus', 'اكتب اسم العميل أو رقمه', 'err');
    setStatus('visitStatus', 'جاري تحديد موقعك...');
    const p = await currentPlace();
    try {
        const r = await api('POST', '/api/admin/me/visit', { ...body, ...(p || {}) });
        ['visitName', 'visitPhone', 'visitNote'].forEach((id) => { $id(id).value = ''; });
        setStatus('visitStatus', r.located ? 'سُجّلت الزيارة بموقعها ✓ — العميل في «متابعة العملاء»' : 'سُجّلت الزيارة ✓ (بدون موقع: لم يصل موقع الجوال)', 'ok');
    } catch (err) { setStatus('visitStatus', err.message, 'err'); }
}

/* ---------------- 2) The map ---------------- */

let tracking = null;
let trackingDayUser = null;
let gmap = null;
let gmapLayers = [];
let mapsLoading = null;
let trackingTimer = null;

/* Google Maps, loaded once when the server has a key */
function loadGoogleMaps(key) {
    if (window.google && window.google.maps) return Promise.resolve(true);
    if (mapsLoading) return mapsLoading;
    mapsLoading = new Promise((resolve) => {
        window.__radmaMapsReady = () => resolve(true);
        const s = document.createElement('script');
        s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&language=ar&region=OM&callback=__radmaMapsReady`;
        s.async = true;
        s.onerror = () => { mapsLoading = null; resolve(false); };
        document.head.appendChild(s);
    });
    return mapsLoading;
}

function clearMap() {
    gmapLayers.forEach((l) => l.setMap(null));
    gmapLayers = [];
}

async function ensureMap() {
    const ok = tracking && tracking.maps_key ? await loadGoogleMaps(tracking.maps_key) : false;
    $id('trackingMap').hidden = !ok;
    $id('trackingNoMap').hidden = ok;
    if (ok && !gmap) {
        gmap = new google.maps.Map($id('trackingMap'), { center: { lat: 23.588, lng: 58.3829 }, zoom: 9, mapTypeControl: false, streetViewControl: false, fullscreenControl: true });
    }
    return ok;
}

const STATE = { live: ['مباشر الآن', 'on'], quiet: ['في الدوام — النظام مغلق على جواله', 'lme'], off: ['خارج الدوام', ''] };

async function loadTracking() {
    try { tracking = await api('GET', '/api/admin/tracking'); } catch (err) { $id('trackingPeople').innerHTML = `<p class="status-text">${esc(err.message)}</p>`; return; }
    $id('trackingUpdated').textContent = `آخر تحديث ${tkTime(new Date().toISOString())}`;
    const people = tracking.people;
    $id('trackingPeople').innerHTML = people.map((p) => {
        const [label, cls] = STATE[p.state];
        const last = p.last ? `${esc(p.last.kind_label)}${p.last.label ? `: ${esc(p.last.label)}` : ''} — ${esc(agoText(p.last.at))}` : 'لا موقع بعد';
        return `<div class="tp-row"><div class="tp-head"><b>${esc(p.name)}</b> <span class="pill">${esc(p.role_label)}</span> <span class="badge ${cls}">${label}</span></div>
            <div class="muted tp-last">${last}${!p.consent ? ' — لم يوافق على المشاركة بعد' : ''}</div>
            <div class="tp-actions">${p.last ? `<button class="btn btn-outline btn-sm" onclick="focusPerson(${p.id})"><i class="fas fa-location-crosshairs"></i> على الخريطة</button>
                <a class="btn btn-outline btn-sm" href="${gmapsLink(p.last.lat, p.last.lng)}" target="_blank" rel="noopener"><i class="fas fa-location-dot"></i> خرائط Google</a>` : ''}
                <button class="btn btn-outline btn-sm" onclick="openTrackingDay(${p.id})"><i class="fas fa-route"></i> مسار اليوم</button></div></div>`;
    }).join('') || '<p class="status-text">لا يوجد فنيون أو مسوقون مفعّلون بعد — أضفهم من «المستخدمون والصلاحيات».</p>';
    if (trackingDayUser) return loadTrackingDay();
    showTrackingTeam();
}

/* Everyone's last place */
async function showTrackingTeam() {
    trackingDayUser = null;
    $id('trackingDayBox').hidden = true;
    $id('trackingMapTitle').textContent = 'الفريق الآن';
    $id('trackingStops').innerHTML = '';
    if (!(await ensureMap())) return;
    clearMap();
    const bounds = new google.maps.LatLngBounds();
    for (const p of tracking.people.filter((x) => x.last)) {
        const pos = { lat: p.last.lat, lng: p.last.lng };
        const marker = new google.maps.Marker({ position: pos, map: gmap, title: p.name, label: { text: p.name.slice(0, 1), color: '#fff', fontWeight: '700' },
            opacity: p.state === 'live' ? 1 : 0.55 });
        const info = new google.maps.InfoWindow({ content: `<div dir="rtl" style="font-family:inherit"><b>${esc(p.name)}</b> (${esc(p.role_label)})<br>${esc(STATE[p.state][0])}<br>${esc(p.last.kind_label)} — ${esc(agoText(p.last.at))}</div>` });
        marker.addListener('click', () => info.open({ anchor: marker, map: gmap }));
        gmapLayers.push(marker);
        bounds.extend(pos);
    }
    if (gmapLayers.length > 1) gmap.fitBounds(bounds, 60);
    else if (gmapLayers.length === 1) { gmap.setCenter(bounds.getCenter()); gmap.setZoom(14); }
}

function focusPerson(id) {
    const p = tracking && tracking.people.find((x) => x.id === id);
    if (!p || !p.last) return;
    if (gmap) { if (trackingDayUser) showTrackingTeam(); gmap.setCenter({ lat: p.last.lat, lng: p.last.lng }); gmap.setZoom(15); }
    else window.open(gmapsLink(p.last.lat, p.last.lng), '_blank', 'noopener');
}

function openTrackingDay(id) {
    trackingDayUser = id;
    if (!$id('trackingDate').value) $id('trackingDate').value = localDay();
    loadTrackingDay();
}

/* One person's day: the path, and each stop (start / end of shift, work steps, visits) in order */
async function loadTrackingDay() {
    if (!trackingDayUser) return;
    let d;
    try { d = await api('GET', `/api/admin/tracking/${trackingDayUser}?date=${encodeURIComponent($id('trackingDate').value)}`); } catch (err) { return tell(err.message); }
    $id('trackingDayBox').hidden = false;
    $id('trackingMapTitle').textContent = `مسار ${d.user.name} — ${d.date}`;
    const stops = d.points.filter((p) => p.kind !== 'live');
    $id('trackingStops').innerHTML = stops.map((p) => `<li><b>${esc(tkTime(p.at))}</b> ${esc(p.kind_label)}${p.label && p.label !== p.kind_label ? `: ${esc(p.label)}` : ''}
        <a href="${gmapsLink(p.lat, p.lng)}" target="_blank" rel="noopener">خرائط Google</a></li>`).join('')
        || `<li class="muted">${d.points.length ? `${d.points.length} موقع مباشر بلا خطوات عمل أو زيارات` : 'لا مواقع في هذا اليوم'}</li>`;
    if (!(await ensureMap())) return;
    clearMap();
    if (!d.points.length) return;
    const path = d.points.map((p) => ({ lat: p.lat, lng: p.lng }));
    gmapLayers.push(new google.maps.Polyline({ path, map: gmap, strokeColor: '#1a5276', strokeOpacity: 0.85, strokeWeight: 4 }));
    stops.forEach((p, i) => {
        const marker = new google.maps.Marker({ position: { lat: p.lat, lng: p.lng }, map: gmap, label: { text: String(i + 1), color: '#fff' }, title: `${tkTime(p.at)} ${p.kind_label}` });
        const info = new google.maps.InfoWindow({ content: `<div dir="rtl"><b>${esc(tkTime(p.at))}</b> ${esc(p.kind_label)}${p.label ? `<br>${esc(p.label)}` : ''}</div>` });
        marker.addListener('click', () => info.open({ anchor: marker, map: gmap }));
        gmapLayers.push(marker);
    });
    const bounds = new google.maps.LatLngBounds();
    path.forEach((p) => bounds.extend(p));
    gmap.fitBounds(bounds, 60);
}

const switchTabBeforeTracking = window.switchTab;
window.switchTab = function (tabId) {
    switchTabBeforeTracking(tabId);
    clearInterval(trackingTimer);
    trackingTimer = null;
    if (tabId === 'tracking' && online) {
        loadTracking();
        // Live: refreshed every minute while the tab is open
        trackingTimer = setInterval(() => { if (document.visibilityState === 'visible') loadTracking(); }, 60_000);
    }
};
