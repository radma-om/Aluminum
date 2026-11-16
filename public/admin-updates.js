/* =============================================================
   Versions and the manager's notices, for everyone using the panel.
   - The page knows the version it was loaded with (<meta name="app-version">)
     and asks the server every minute (and when the app comes back to the
     front, or a 🔔 notice arrives): a newer version → «إصدار جديد متاح —
     حدّث الآن».
   - The manager's notices (users tab): an info bar; «تحديث متاح»; a forced
     update that covers the app until «حدّث الآن» is pressed (once per
     device); a stop that covers it for staff until the manager ends it.
   - «الإصدارات»: the version history (sidebar and sign-in page), and
     «تم التحديث إلى …» once after an update.
   Uses api(), $id(), esc(), setStatus(), askYes(), closeSheet(), ME, APP_LANG.
   ============================================================= */
const LOADED_VERSION = ((document.querySelector('meta[name="app-version"]') || {}).content || '').replace(/^__.*__$/, '');
const upd = {
    get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
};
const POLL_MS = 60_000;
let appStatus = null;
let appStatusBusy = false;

/* 3.36.10 > 3.36.9 */
function compareVersions(a, b) {
    const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
    }
    return 0;
}
const isManagerNow = () => typeof ME !== 'undefined' && ME && (ME.role === 'manager' || ME.owner);
const seenIds = () => upd.get('appNoticesSeen').split(',').filter(Boolean);

document.querySelectorAll('.app-version-text').forEach((el) => { el.textContent = LOADED_VERSION; });
if ($id('sbVersion')) $id('sbVersion').textContent = LOADED_VERSION;

/* Reload with the newest files: the service worker checks for its own update first */
async function reloadApp() {
    try {
        const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration('/admin') : null;
        if (reg) await reg.update();
    } catch { /* offline: the reload still fetches the page */ }
    location.reload();
}

async function checkAppStatus() {
    if (appStatusBusy || typeof ME === 'undefined' || !ME || (typeof online !== 'undefined' && !online)) return;
    appStatusBusy = true;
    try {
        appStatus = await api('GET', '/api/admin/me/app-status');
        renderAppNotices();
    } catch { /* the next check tries again */ } finally { appStatusBusy = false; }
}

function block(kind, n) {
    const el = $id('appBlock');
    const force = kind === 'force';
    $id('appBlockIcon').textContent = force ? '⚠️' : '⛔';
    $id('appBlockTitle').textContent = n.title || (force ? 'تحديث إجباري' : 'التطبيق متوقف مؤقتاً');
    $id('appBlockBody').textContent = n.body || '';
    $id('appBlockHint').textContent = force
        ? 'يجب تحديث التطبيق للمتابعة. اضغط «حدّث الآن»، وإن لم يتحدث فأغلق التطبيق تماماً وافتحه من جديد.'
        : 'أغلق التطبيق الآن وافتحه لاحقاً. ستعود اللوحة تلقائياً عندما ينهي المدير الإيقاف.';
    const btn = $id('appBlockBtn');
    btn.textContent = force ? 'حدّث الآن' : 'إعادة المحاولة';
    btn.onclick = force
        ? () => { upd.set('appForceDone', String(n.id)); btn.disabled = true; reloadApp(); }
        : () => checkAppStatus();
    btn.disabled = false;
    el.dataset.kind = kind;
    el.hidden = false;
    document.documentElement.classList.add('app-blocked');
}
function unblock() {
    $id('appBlock').hidden = true;
    document.documentElement.classList.remove('app-blocked');
}

function renderAppNotices() {
    const st = appStatus || { version: LOADED_VERSION, notices: [] };
    const notices = st.notices || [];
    const manager = isManagerNow();
    const force = notices.find((n) => n.kind === 'force');
    const stop = notices.find((n) => n.kind === 'maintenance');
    if (force && upd.get('appForceDone') !== String(force.id)) block('force', force);
    else if (stop && !manager) block('maintenance', stop);
    else unblock();

    const bars = [];
    const bar = (cls, html) => bars.push(`<div class="app-notice ${cls}">${html}</div>`);
    // The manager's stop is running: managers see it with the button that ends it
    if (stop && manager) {
        bar('stop', `<span>⛔ <strong>التطبيق متوقف للموظفين:</strong> <span class="no-i18n">${esc(stop.title)}</span></span>
            <button class="btn btn-sm btn-primary" onclick="endAppNotice(${stop.id})">إنهاء الإيقاف</button>`);
    }
    // A newer version is on the server than the one this page was loaded with
    if (LOADED_VERSION && compareVersions(st.version, LOADED_VERSION) > 0 && upd.get('appLaterVersion') !== st.version) {
        bar('new', `<span>🆕 <strong>إصدار جديد متاح</strong> <bdi dir="ltr">${esc(st.version)}</bdi> — أنت تستخدم <bdi dir="ltr">${esc(LOADED_VERSION)}</bdi></span>
            <span class="app-notice-btns"><button class="btn btn-sm btn-outline" onclick="openVersions()">ما الجديد</button>
            <button class="btn btn-sm btn-primary" onclick="reloadApp()">حدّث الآن</button>
            <button class="link-btn" onclick="laterVersion('${esc(st.version)}')">لاحقاً</button></span>`);
    }
    // Just updated: once
    const seenVersion = upd.get('appVersionSeen');
    if (!seenVersion && LOADED_VERSION) upd.set('appVersionSeen', LOADED_VERSION);
    else if (LOADED_VERSION && compareVersions(LOADED_VERSION, seenVersion) > 0) {
        bar('done', `<span>✓ <strong>تم التحديث إلى الإصدار</strong> <bdi dir="ltr">${esc(LOADED_VERSION)}</bdi></span>
            <span class="app-notice-btns"><button class="btn btn-sm btn-outline" onclick="openVersions(); seenVersionNow()">ما الجديد</button>
            <button class="link-btn" onclick="seenVersionNow()">حسناً</button></span>`);
    }
    // The manager's info / «update available» notices, until closed on this device
    const seen = seenIds();
    for (const n of notices.filter((x) => (x.kind === 'info' || x.kind === 'update') && !seen.includes(String(x.id)))) {
        bar(n.kind, `<span>${n.kind === 'update' ? '🆕' : '🔔'} <strong class="no-i18n">${esc(n.title)}</strong>${n.body ? ` — <span class="no-i18n">${esc(n.body)}</span>` : ''}</span>
            <span class="app-notice-btns">${n.kind === 'update' ? `<button class="btn btn-sm btn-primary" onclick="seenNotice(${n.id}); reloadApp()">حدّث الآن</button>` : ''}
            <button class="link-btn" onclick="seenNotice(${n.id})">حسناً</button></span>`);
    }
    const box = $id('appNotices');
    box.innerHTML = bars.join('');
    box.hidden = !bars.length;
}

function seenNotice(id) { upd.set('appNoticesSeen', [...seenIds(), String(id)].slice(-50).join(',')); renderAppNotices(); }
function laterVersion(v) { upd.set('appLaterVersion', v); renderAppNotices(); }
function seenVersionNow() { upd.set('appVersionSeen', LOADED_VERSION); renderAppNotices(); }

/* ------------------------------ «الإصدارات» ------------------------------ */

async function openVersions() {
    $id('versionsBody').innerHTML = '<p class="status-text">جاري التحميل...</p>';
    $id('versionsSheet').hidden = false;
    try {
        const r = await api('GET', '/api/admin/me/changelog');
        const en = typeof APP_LANG !== 'undefined' && APP_LANG === 'en';
        $id('versionsBody').innerHTML = `
            <div class="money-grid">
                <div><small>الإصدار عندك</small><strong dir="ltr">${esc(LOADED_VERSION || '—')}</strong></div>
                <div><small>أحدث إصدار منشور</small><strong dir="ltr">${esc(r.version)}</strong></div>
            </div>
            ${compareVersions(r.version, LOADED_VERSION) > 0 ? '<div class="form-buttons" style="margin-top:0"><button class="btn btn-primary" onclick="reloadApp()">حدّث الآن</button></div>' : ''}
            ${r.versions.map((v) => `<div class="version-entry${v.version === LOADED_VERSION ? ' current' : ''}">
                <div class="version-head"><strong dir="ltr">${esc(v.version)}</strong><small>${esc(v.date || '')}</small>
                    ${v.version === LOADED_VERSION ? '<span class="badge">الإصدار عندك</span>' : compareVersions(v.version, LOADED_VERSION) > 0 ? '<span class="badge new">جديد</span>' : ''}</div>
                <ul class="no-i18n">${(en ? v.en : v.ar).map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>`).join('')}`;
    } catch (err) { $id('versionsBody').innerHTML = `<p class="status-text err">${esc(err.message)}</p>`; }
}

/* ------------------------------ The manager's card (users tab) ------------------------------ */

const AN_STATE = (n) => (!n.active ? 'منتهٍ' : n.kind === 'force' || n.kind === 'maintenance' ? 'يعمل الآن' : 'ظاهر للموظفين');

async function loadAppNotices() {
    if (!isManagerNow()) return;
    try {
        const r = await api('GET', '/api/admin/app-notices');
        $id('anBody2').innerHTML = r.notices.map((n) => `<tr>
            <td data-label="النوع">${esc(n.kind_label)}</td>
            <td data-label="العنوان"><strong class="no-i18n">${esc(n.title)}</strong>${n.body ? `<br><small class="no-i18n">${esc(n.body)}</small>` : ''}</td>
            <td data-label="أرسله"><small class="no-i18n">${esc(n.created_by || '—')}</small></td>
            <td data-label="التاريخ"><small dir="ltr">${esc(String(n.created_at).slice(0, 16))}</small></td>
            <td data-label="الحالة"><span class="badge${n.active ? ' st-won' : ''}">${esc(AN_STATE(n))}</span></td>
            <td data-label="">${n.active ? `<button class="btn btn-outline btn-sm" onclick="endAppNotice(${n.id})">${n.kind === 'maintenance' ? 'إنهاء الإيقاف' : 'إنهاء'}</button>` : ''}</td></tr>`).join('')
            || '<tr><td colspan="6">لم يُرسل أي إشعار بعد.</td></tr>';
    } catch (err) { setStatus('anStatus', err.message, 'err'); }
}

async function sendAppNotice() {
    const kind = $id('anKind').value;
    const title = $id('anTitle').value.trim();
    const body = $id('anBody').value.trim();
    if (!title && !body) return setStatus('anStatus', 'اكتب العنوان أو الرسالة', 'err');
    if (kind === 'force' && !(await askYes('إرسال تحديث إجباري؟ يُغطى التطبيق عند كل الموظفين حتى يضغطوا «حدّث الآن».', { okLabel: 'إرسال' }))) return;
    if (kind === 'maintenance' && !(await askYes('إيقاف التطبيق للموظفين والفنيين؟ لن يستطيعوا استخدامه حتى تضغط «إنهاء الإيقاف».', { okLabel: 'إيقاف', danger: true }))) return;
    try {
        setStatus('anStatus', 'جاري الإرسال...');
        const r = await api('POST', '/api/admin/app-notices', { kind, title, body });
        if (kind === 'force') upd.set('appForceDone', String(r.notice.id)); // this device is the one sending it
        seenNotice(r.notice.id);
        $id('anTitle').value = '';
        $id('anBody').value = '';
        setStatus('anStatus', `تم الإرسال ✓ — وصل إشعاراً على ${r.sent} جهاز`, 'ok');
        await loadAppNotices();
        checkAppStatus();
    } catch (err) { setStatus('anStatus', err.message, 'err'); }
}

async function endAppNotice(id) {
    try {
        await api('POST', `/api/admin/app-notices/${id}/end`);
        await Promise.all([loadAppNotices(), checkAppStatus()]);
    } catch (err) { alert(err.message); }
}

const switchTabBeforeUpdates = window.switchTab;
window.switchTab = function (tabId) {
    switchTabBeforeUpdates(tabId);
    if (tabId === 'users') loadAppNotices();
};

/* ------------------------------ When to check ------------------------------ */

setInterval(() => { if (document.visibilityState === 'visible') checkAppStatus(); }, POLL_MS);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkAppStatus(); });
// A 🔔 notice pushed to this device: look now, not in a minute
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'app-status') checkAppStatus(); });
}
// After sign-in (ME is set by initAdmin)
(function waitForSignIn(tries = 0) {
    if (typeof ME !== 'undefined' && ME) return checkAppStatus();
    if (tries < 120) setTimeout(() => waitForSignIn(tries + 1), 500);
})();
