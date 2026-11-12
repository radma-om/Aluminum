/* =============================================================
   The admin panel as a phone app:
   - registers the service worker (/sw.js, scope /admin) — installable
     to the home screen;
   - «تثبيت التطبيق»: the browser's install prompt (Android / desktop
     Chrome / Edge), or the steps for iPhone (Share → Add to Home Screen);
   - the bell: notifications on this device (Web Push) for the account
     signed in, a test, and stopping them;
   - links inside the app (#tab=quotes, #lead=12): from a notification,
     a home-screen shortcut, or a link.
   Uses api(), $id(), esc(), setStatus(), switchTab(), openLead(), ME.
   ============================================================= */

const swSupported = 'serviceWorker' in navigator;
const pushSupported = swSupported && 'PushManager' in window && 'Notification' in window;
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let installPrompt = null;
let swReady = null;

if (swSupported) {
    swReady = navigator.serviceWorker.register('/sw.js', { scope: '/admin' })
        .then(() => navigator.serviceWorker.ready)
        .catch((err) => { console.warn('[pwa]', err.message); return null; });
    // A tapped notification while the app is open: go to its page
    navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'open') openAppLink(new URL(e.data.url, location.origin).hash);
    });
}

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    $id('installBtn').hidden = false;
});
window.addEventListener('appinstalled', () => { installPrompt = null; $id('installBtn').hidden = true; });

async function installApp() {
    if (installPrompt) {
        installPrompt.prompt();
        await installPrompt.userChoice.catch(() => null);
        installPrompt = null;
        $id('installBtn').hidden = true;
        return;
    }
    openPushSheet();
}

/* ------------------------------ Links inside the app ------------------------------ */

function openAppLink(hash) {
    const q = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    if (!q.toString()) return;
    history.replaceState(null, '', location.pathname);
    const lead = Number(q.get('lead'));
    if (lead && canSee('leads')) {
        switchTab('leads');
        setTimeout(() => openLead(lead).catch(() => {}), 300);
        return;
    }
    const tab = q.get('tab');
    if (tab && document.querySelector(`.sidebar .tab-btn[data-tab="${CSS.escape(tab)}"]:not([hidden])`)) {
        if (tab === 'work_orders' && q.get('requests') && typeof woFilter !== 'undefined') woFilter = 'requests';
        switchTab(tab);
    }
}
window.addEventListener('hashchange', () => openAppLink(location.hash));

/* ------------------------------ Notifications ------------------------------ */

const b64ToBytes = (b64) => {
    const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

async function currentSubscription() {
    const reg = swReady && await swReady;
    return reg ? reg.pushManager.getSubscription() : null;
}

/* The bell: green when this device receives notifications */
async function refreshBell() {
    const btn = $id('pushBtn');
    btn.hidden = !(pushSupported || isIos);
    const sub = pushSupported ? await currentSubscription().catch(() => null) : null;
    btn.classList.toggle('on', Boolean(sub) && Notification.permission === 'granted');
    btn.title = sub ? 'الإشعارات مفعّلة على هذا الجهاز' : 'تفعيل الإشعارات';
}

async function openPushSheet() {
    const state = $id('pushState');
    const help = $id('installHelp');
    let sub = null;
    let msg = '';
    let ok = false;
    if (!pushSupported) {
        msg = isIos && !isStandalone()
            ? 'على الآيفون تعمل الإشعارات بعد تثبيت التطبيق على الشاشة الرئيسية (الخطوات أدناه)، ثم فتحه من أيقونته.'
            : 'هذا المتصفح لا يدعم الإشعارات. استخدم Chrome أو Edge أو Safari حديثاً.';
    } else if (Notification.permission === 'denied') {
        msg = 'الإشعارات محظورة لهذا الموقع في إعدادات المتصفح/الجوال. اسمح بها من إعدادات الموقع ثم أعد المحاولة.';
    } else {
        sub = await currentSubscription().catch(() => null);
        ok = Boolean(sub) && Notification.permission === 'granted';
        msg = ok ? '✓ الإشعارات مفعّلة على هذا الجهاز لحساب ' + (ME ? ME.display_name : '') : 'الإشعارات غير مفعّلة على هذا الجهاز.';
    }
    state.textContent = msg;
    state.className = 'push-state ' + (ok ? 'ok' : '');
    renderPushDevices(sub).catch(() => {});
    $id('pushOn').hidden = !pushSupported || ok || Notification.permission === 'denied';
    $id('pushTest').hidden = !ok;
    $id('pushOff').hidden = !ok;
    // How to install: the browser's button, or the iPhone steps
    if (isStandalone()) {
        help.hidden = true;
    } else {
        help.hidden = false;
        help.innerHTML = installPrompt
            ? '<b>📲 ثبّت التطبيق على الشاشة الرئيسية:</b> <button type="button" class="btn btn-outline btn-sm" onclick="installApp()">تثبيت الآن</button>'
            : isIos
                ? '<b>📲 التثبيت على الآيفون:</b><ol><li>افتح اللوحة في <b>Safari</b>.</li><li>اضغط زر <b>المشاركة</b> <i class="fas fa-arrow-up-from-bracket"></i> أسفل الشاشة.</li><li>اختر <b>«إضافة إلى الشاشة الرئيسية»</b> ثم «إضافة».</li><li>افتح «RADMA» من أيقونته، ثم فعّل الإشعارات من الجرس 🔔.</li></ol>'
                : '<b>📲 التثبيت:</b> من قائمة المتصفح (⋮) اختر <b>«تثبيت التطبيق»</b> أو <b>«إضافة إلى الشاشة الرئيسية»</b>.';
    }
    $id('pushSheet').hidden = false;
}

async function enablePush() {
    try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') throw new Error('لم يُسمح بالإشعارات — اسمح بها من إعدادات المتصفح ثم أعد المحاولة');
        const reg = await swReady;
        if (!reg) throw new Error('تعذّر تشغيل التطبيق في الخلفية (Service Worker)');
        const { public_key: key } = await api('GET', '/api/admin/me/push');
        let sub = await reg.pushManager.getSubscription();
        if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
        await api('POST', '/api/admin/me/push', { subscription: sub.toJSON(), device: deviceName() });
        await refreshBell();
        await openPushSheet();
    } catch (err) {
        $id('pushState').textContent = err.message;
        $id('pushState').className = 'push-state err';
    }
}

async function testPush() {
    $id('pushState').textContent = '… جارٍ الإرسال';
    try {
        const r = await api('POST', '/api/admin/me/push/test');
        $id('pushState').textContent = `✓ قبلت خدمة الإشعارات الإرسال إلى ${r.sent} جهاز — يصل خلال ثوانٍ. إن لم يظهر فالسبب في إعدادات الجوال (التركيز / عدم الإزعاج، أو إشعارات التطبيق مغلقة).`
            + (r.failed && r.failed.length ? ` لم يصل إلى: ${r.failed.map((f) => `${f.device || 'جهاز'} (${f.error})`).join('، ')}` : '');
        $id('pushState').className = 'push-state ok';
    } catch (err) {
        $id('pushState').textContent = err.message;
        $id('pushState').className = 'push-state err';
    }
    renderPushDevices(await currentSubscription().catch(() => null)).catch(() => {});
}

/* The account's devices on the server: when each last received something, and the last error */
async function renderPushDevices(sub) {
    const box = $id('pushDevices');
    if (!box) return;
    const r = await api('GET', '/api/admin/me/push');
    const mine = sub ? sub.endpoint.slice(-12) : null;
    const when = (s) => (s ? new Date(String(s).replace(' ', 'T') + 'Z').toLocaleString('ar-OM', { dateStyle: 'short', timeStyle: 'short' }) : '—');
    // This browser allowed notifications but the server does not know it: register it again
    if (sub && Notification.permission === 'granted' && !r.devices.some((d) => d.tail === mine)) {
        await api('POST', '/api/admin/me/push', { subscription: sub.toJSON(), device: deviceName() }).catch(() => {});
        return renderPushDevices(sub);
    }
    box.innerHTML = r.devices.length ? `<div class="sub-heading" style="margin:10px 0 4px">أجهزتك المشتركة</div>` + r.devices.map((d) => `<div class="push-dev${d.tail === mine ? ' me' : ''}">
        <b>${esc(d.device || 'جهاز')}</b>${d.tail === mine ? ' <span class="badge on">هذا الجهاز</span>' : ''} <small>(${esc(d.service || '')})</small>
        <div class="status-text">آخر إشعار وصل للخدمة: ${esc(when(d.last_sent_at))}</div>
        ${d.last_error ? `<div class="status-text bad">آخر خطأ (${esc(when(d.last_error_at))}): ${esc(d.last_error)}</div>` : ''}
    </div>`).join('') : '';
}

/* This device stops: unsubscribed in the browser and forgotten by the server */
async function pushForget() {
    const sub = pushSupported ? await currentSubscription().catch(() => null) : null;
    if (!sub) return;
    await api('DELETE', '/api/admin/me/push', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
}

async function disablePush() {
    await pushForget();
    await refreshBell();
    await openPushSheet();
}

function deviceName() {
    const ua = navigator.userAgent;
    const os = /iphone/i.test(ua) ? 'iPhone' : /ipad/i.test(ua) ? 'iPad' : /android/i.test(ua) ? 'Android' : /windows/i.test(ua) ? 'Windows' : /mac os/i.test(ua) ? 'Mac' : 'جهاز';
    const br = /edg\//i.test(ua) ? 'Edge' : /chrome|crios/i.test(ua) ? 'Chrome' : /safari/i.test(ua) ? 'Safari' : /firefox/i.test(ua) ? 'Firefox' : '';
    return `${os}${br ? ' — ' + br : ''}${isStandalone() ? ' (التطبيق)' : ''}`;
}

document.addEventListener('admin-ready', () => {
    refreshBell().catch(() => {});
    if (isIos && !isStandalone()) $id('installBtn').hidden = false; // iPhone: the button shows the steps
    // Opened from a notification or a shortcut (#tab=… / #lead=…)
    setTimeout(() => openAppLink(location.hash), 400);
    // A device that already allowed notifications re-registers (keeps the server's list right after a new sign-in)
    if (pushSupported && Notification.permission === 'granted') {
        currentSubscription().then((sub) => sub && api('POST', '/api/admin/me/push', { subscription: sub.toJSON(), device: deviceName() })).catch(() => {});
    }
});
