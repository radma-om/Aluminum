/* =============================================================
   Petty cash (العهدة) — like a cash book.
   - «عهدتي» (every staff and technician account): the balance, «صرف»
     (amount, category, details, a photo of the receipt), «طلب مبلغ»,
     «تسليم للمكتب», the book with the balance after each entry, and the
     requests with their answers.
   - Managers: every account's balance and lowest balance, the requests to
     approve (another amount is possible) or decline, money handed over,
     an employee's book (entries can be cancelled, never edited), and the
     general lowest balance and the expense categories.
   Uses api(), $id(), esc(), setStatus(), askText(), askYes(), closeSheet(), ME, APP_LOCALE.
   ============================================================= */
const W_KINDS = { receive: 'استلام', expense: 'صرف', return: 'تسليم للمكتب' };
const wMoney = (n) => Number(n || 0).toFixed(2);
const wIsManager = () => ME && ME.role === 'manager';
let walletMine = null;
let walletAll = null;
let walletTarget = null; // { id, name } of the book an entry is written to
let walletKind = 'expense';
let walletCat = '';

const wWhen = (s) => {
    const d = new Date(String(s).replace(' ', 'T') + ':00');
    if (Number.isNaN(d.getTime())) return esc(s);
    const today = new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
    const day = String(s).slice(0, 10);
    const time = d.toLocaleTimeString(APP_LOCALE, { hour: 'numeric', minute: '2-digit' });
    return day === today ? `اليوم ${time}` : `${d.toLocaleDateString(APP_LOCALE, { day: 'numeric', month: 'long' })} ${time}`;
};

/* The book: kind and date on one side, the amount (− spent / + received) and the balance after on the other */
function walletBookHtml(book, { manage = false } = {}) {
    if (!book.entries.length) return '<p class="status-text">لا توجد عمليات بعد.</p>';
    return `<div class="wallet-book">${book.entries.map((e) => `
        <div class="wallet-entry ${esc(e.kind)}${e.cancelled ? ' cancelled' : ''}">
            <div class="we-main">
                <div><b class="we-kind">${esc(e.kind_label)}</b> <small>${wWhen(e.occurred_on)}</small></div>
                <div class="we-details no-i18n">${esc([e.category, e.details].filter(Boolean).join(' — ') || '')}</div>
                ${e.cancelled ? `<div class="we-cancel">ملغاة: ${esc(e.cancel_reason || '')}</div>` : ''}
                ${e.has_receipt ? `<button class="link-btn we-photo" onclick="walletPhoto(${e.id})"><i class="fas fa-image"></i> صورة الإيصال</button>` : ''}
                ${manage && !e.cancelled ? `<button class="link-btn we-photo" style="color:#a93226" onclick="walletCancel(${e.id})">إلغاء</button>` : ''}
            </div>
            <div class="we-amount"><span dir="ltr">${e.signed > 0 ? '+' : '−'}${wMoney(Math.abs(e.signed))}</span>
                <small>الرصيد <span dir="ltr">${wMoney(e.balance_after)}</span></small></div>
        </div>`).join('')}</div>`;
}

const REQ_STATE = { pending: 'بانتظار الإدارة', approved: 'تمت الموافقة', declined: 'مرفوض' };

async function loadWalletMine() {
    if (!ME || ME.owner) return;
    try {
        walletMine = await api('GET', '/api/admin/wallet/me');
        const b = walletMine;
        $id('walletHero').innerHTML = `
            <div class="wh-balance ${b.low ? 'low' : ''}"><small>رصيد العهدة</small><strong dir="ltr">${wMoney(b.balance)}</strong><span>ر.ع</span></div>
            <div class="wh-figs"><span>صُرف هذا الشهر <b>${wMoney(b.spent_this_month)}</b></span>${b.min ? `<span>الحد الأدنى <b>${wMoney(b.min)}</b></span>` : ''}</div>
            ${b.low ? '<p class="wh-low">⚠️ الرصيد أقل من الحد — اطلب مبلغاً من الإدارة</p>' : ''}`;
        const open = b.requests.filter((r) => r.status === 'pending' || Date.now() - Date.parse(String(r.decided_at || r.created_at).replace(' ', 'T') + 'Z') < 3 * 86400_000);
        $id('walletMineRequests').innerHTML = open.length ? `<p class="sub-heading">طلباتي</p>${open.map((r) => `
            <div class="wallet-req ${esc(r.status)}"><span><b>${wMoney(r.amount)} ر.ع</b> — <span class="no-i18n">${esc(r.reason || '')}</span></span>
                <span class="badge">${esc(REQ_STATE[r.status] || r.status)}</span>${r.note ? `<small class="no-i18n">${esc(r.note)}</small>` : ''}</div>`).join('')}` : '';
        $id('walletMineBook').innerHTML = `<p class="sub-heading">العمليات</p>${walletBookHtml(b)}`;
    } catch (err) { $id('walletMineBook').innerHTML = `<p class="status-text err">${esc(err.message)}</p>`; }
}

async function loadWalletAll() {
    if (!wIsManager()) return;
    try {
        walletAll = await api('GET', '/api/admin/wallet');
        const w = walletAll;
        const low = w.accounts.filter((a) => a.low).length;
        $id('walletTotals').innerHTML = `
            <div><small>مجموع العهد عند الموظفين</small><strong>${wMoney(w.total_out)}</strong></div>
            <div><small>طلبات بانتظارك</small><strong style="color:${w.requests.length ? '#8a5a00' : 'inherit'}">${w.requests.length}</strong></div>
            <div><small>أقل من الحد</small><strong style="color:${low ? '#a93226' : 'inherit'}">${low}</strong></div>`;
        $id('walletRequests').innerHTML = w.requests.length ? `<p class="sub-heading">طلبات المبالغ</p>${w.requests.map((r) => `
            <div class="wallet-req pending"><span><b class="no-i18n">${esc(r.name)}</b> يطلب <b>${wMoney(r.amount)} ر.ع</b> — <span class="no-i18n">${esc(r.reason || '')}</span></span>
                <span class="wallet-req-btns"><button class="btn btn-primary btn-sm" onclick="walletDecide(${r.id}, true, ${r.amount})">موافقة</button>
                <button class="btn btn-outline btn-sm" onclick="walletDecide(${r.id}, false)">رفض</button></span></div>`).join('')}` : '';
        $id('walletBody').innerHTML = w.accounts.map((a) => `<tr>
            <td data-label="الموظف"><strong class="no-i18n">${esc(a.name)}</strong> <small class="status-text">${a.role === 'technician' ? 'فني' : a.role === 'manager' ? 'مدير' : 'موظف'}</small>${a.pending ? ` <span class="badge" style="background:#fdf2e1;color:#8a5a00">طلب</span>` : ''}</td>
            <td data-label="الرصيد"><strong style="color:${a.low ? '#a93226' : a.balance < 0 ? '#a93226' : 'inherit'}">${wMoney(a.balance)}</strong>${a.low ? ' ⚠️' : ''}</td>
            <td data-label="الحد الأدنى"><button class="link-btn" style="margin:0" onclick="walletSetMin(${a.id}, ${a.own_min === null ? 'null' : a.own_min})">${a.min ? wMoney(a.min) : '—'}${a.own_min === null && a.min ? ' <small>(عام)</small>' : ''}</button></td>
            <td data-label="آخر عملية"><small>${a.last ? `${esc(a.last.kind_label)} ${wMoney(a.last.amount)} — ${wWhen(a.last.occurred_on)}` : '—'}</small></td>
            <td data-label=""><button class="btn btn-primary btn-sm" onclick="walletGive(${a.id}, '${esc(a.name).replace(/'/g, '&#39;')}')">إعطاء مبلغ</button>
                <button class="btn btn-outline btn-sm" onclick="walletOpenBook(${a.id})">الحركات</button></td></tr>`).join('')
            || '<tr><td colspan="5">لا توجد حسابات موظفين بعد.</td></tr>';
        $id('walletMinDefault').value = w.min_default || 0;
        $id('walletCats').value = w.categories.join('، ');
        const badge = $id('walletBadge');
        badge.textContent = w.requests.length;
        badge.hidden = !w.requests.length;
    } catch (err) { $id('walletBody').innerHTML = `<tr><td colspan="5">${esc(err.message)}</td></tr>`; }
}

function loadWallet() {
    $id('walletMineCard').hidden = !ME || Boolean(ME.owner);
    $id('walletAdminCard').hidden = !wIsManager();
    return Promise.all([loadWalletMine(), loadWalletAll()]);
}

/* ---- One entry: spent / returned (the employee), money handed over (a manager) ---- */
function walletNew(kind, target = null) {
    walletKind = kind;
    walletTarget = target || { id: ME.id, name: ME.display_name, self: true };
    $id('walletSheetTitle').innerHTML = { expense: '<i class="fas fa-cart-shopping"></i> صرف من العهدة', return: '<i class="fas fa-rotate-left"></i> تسليم للمكتب', receive: '<i class="fas fa-hand-holding-dollar"></i> إعطاء مبلغ للعهدة' }[kind];
    $id('walletFor').textContent = walletTarget.self ? '' : `عهدة: ${walletTarget.name}`;
    $id('walletForm').reset();
    const now = new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 16);
    $id('wWhen').value = now;
    $id('wWhen').max = now;
    $id('wCatBox').hidden = kind !== 'expense';
    $id('wPhotoBox').hidden = kind === 'receive';
    const cats = (walletMine && walletMine.categories) || (walletAll && walletAll.categories) || [];
    walletCat = '';
    $id('wCats').innerHTML = cats.map((c) => `<button type="button" class="wallet-cat" data-c="${esc(c)}" onclick="walletPickCat(this)">${esc(c)}</button>`).join('');
    $id('wSave').textContent = kind === 'receive' ? 'إعطاء المبلغ' : 'حفظ';
    $id('wSave').disabled = false;
    setStatus('wStatus', '');
    $id('walletSheet').hidden = false;
    setTimeout(() => $id('wAmount').focus(), 60);
}
function walletPickCat(btn) {
    walletCat = btn.dataset.c;
    $id('wCats').querySelectorAll('.wallet-cat').forEach((b) => b.classList.toggle('on', b === btn));
}

/* The phone's photo, shrunk to at most 1280 px (a receipt stays readable at a fraction of the size) */
function shrinkPhoto(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
            const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
            const c = document.createElement('canvas');
            c.width = Math.round(img.width * scale);
            c.height = Math.round(img.height * scale);
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            URL.revokeObjectURL(url);
            c.toBlob((b) => (b ? resolve(b) : reject(new Error('تعذرت قراءة الصورة'))), 'image/jpeg', 0.72);
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('تعذرت قراءة الصورة')); };
        img.src = url;
    });
}

async function walletSave() {
    const amount = Number($id('wAmount').value);
    if (!(amount > 0)) return setStatus('wStatus', 'اكتب المبلغ', 'err');
    if (walletKind === 'expense' && !walletCat) return setStatus('wStatus', 'اختر التصنيف', 'err');
    $id('wSave').disabled = true;
    setStatus('wStatus', 'جاري الحفظ...');
    try {
        const r = await api('POST', `/api/admin/wallet/${walletTarget.id}/entries`, {
            kind: walletKind, amount, category: walletCat, details: $id('wDetails').value.trim(), occurred_on: $id('wWhen').value
        });
        const file = $id('wPhoto').files[0];
        if (file && walletKind !== 'receive') {
            setStatus('wStatus', 'جاري رفع الصورة...');
            const blob = await shrinkPhoto(file);
            let token = '';
            try { token = localStorage.getItem('adminToken') || ''; } catch { /* ignore */ }
            const up = await fetch(`/api/admin/wallet/entries/${r.entry.id}/receipt`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', Authorization: 'Bearer ' + token }, body: blob });
            if (!up.ok) await tell('حُفظت العملية، لكن تعذر رفع الصورة: ' + ((await up.json().catch(() => ({}))).error || up.status));
        }
        closeSheet('walletSheet');
        if (r.low && walletTarget.self) await tell(`حُفظت ✓ — رصيدك الآن ${wMoney(r.balance)} ر.ع، وهو أقل من الحد. اطلب مبلغاً من الإدارة.`);
        await loadWallet();
        if (!walletTarget.self && !$id('walletBookSheet').hidden) walletOpenBook(walletTarget.id);
    } catch (err) {
        setStatus('wStatus', err.message, 'err');
        $id('wSave').disabled = false;
    }
}

async function walletAsk() {
    const amount = await askText('المبلغ المطلوب (ر.ع):', '', { type: 'number', okLabel: 'التالي' });
    if (amount === null) return;
    if (!(Number(amount) > 0)) return tell('اكتب المبلغ');
    const reason = await askText('سبب الطلب (مثلاً: بترول ومواد لأعمال الأسبوع):', '', { multiline: true, okLabel: 'إرسال الطلب' });
    if (reason === null || !reason.trim()) return;
    try {
        await api('POST', '/api/admin/wallet/requests', { amount: Number(amount), reason: reason.trim() });
        await tell('أُرسل الطلب ✓ — يصلك إشعار عند رد الإدارة');
        await loadWalletMine();
    } catch (err) { tell(err.message); }
}

async function walletPhoto(entryId) {
    let token = '';
    try { token = localStorage.getItem('adminToken') || ''; } catch { /* ignore */ }
    const res = await fetch(`/api/admin/wallet/entries/${entryId}/receipt`, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return tell('تعذر فتح الصورة');
    const url = URL.createObjectURL(await res.blob());
    const w = window.open(url, '_blank');
    if (!w) location.href = url;
}

/* ---- Managers ---- */
function walletGive(id, name) { walletNew('receive', { id, name }); }

async function walletOpenBook(id) {
    try {
        const b = await api('GET', `/api/admin/wallet/${id}`);
        $id('walletBookBody').innerHTML = `
            <h3><i class="fas fa-wallet"></i> <span class="no-i18n">${esc(b.user.name)}</span></h3>
            <div class="wallet-hero"><div class="wh-balance ${b.low ? 'low' : ''}"><small>الرصيد</small><strong dir="ltr">${wMoney(b.balance)}</strong><span>ر.ع</span></div>
                <div class="wh-figs"><span>صُرف هذا الشهر <b>${wMoney(b.spent_this_month)}</b></span>${b.min ? `<span>الحد الأدنى <b>${wMoney(b.min)}</b></span>` : ''}</div></div>
            <div class="wallet-actions">
                <button class="btn wallet-btn ask" onclick="walletGive(${b.user.id}, '${esc(b.user.name).replace(/'/g, '&#39;')}')">إعطاء مبلغ</button>
                <button class="btn wallet-btn expense" onclick="walletNew('expense', { id: ${b.user.id}, name: '${esc(b.user.name).replace(/'/g, '&#39;')}' })">تسجيل صرف</button>
                <button class="btn wallet-btn return" onclick="walletNew('return', { id: ${b.user.id}, name: '${esc(b.user.name).replace(/'/g, '&#39;')}' })">استلام من الموظف</button>
            </div>
            ${walletBookHtml(b, { manage: true })}`;
        walletMine = walletMine || { categories: b.categories };
        $id('walletBookSheet').hidden = false;
    } catch (err) { tell(err.message); }
}

async function walletCancel(entryId) {
    const why = await askText('سبب إلغاء العملية (تبقى في الدفتر مشطوبة):', '', { okLabel: 'إلغاء العملية', danger: true });
    if (!why || !why.trim()) return;
    try {
        const r = await api('POST', `/api/admin/wallet/entries/${entryId}/cancel`, { reason: why.trim() });
        await loadWallet();
        walletOpenBook(r.entry.user_id);
    } catch (err) { tell(err.message); }
}

async function walletDecide(id, approve, asked) {
    try {
        let amount;
        let note = '';
        if (approve) {
            amount = await askText('المبلغ الذي تعطيه (ر.ع) — يمكن أن يختلف عن المطلوب:', String(asked), { type: 'number', okLabel: 'موافقة' });
            if (amount === null) return;
            note = (await askText('ملاحظة للموظف (اختياري):', '')) || '';
        } else {
            note = await askText('سبب الرفض (يصل للموظف):', '', { okLabel: 'رفض', danger: true });
            if (note === null) return;
        }
        await api('POST', `/api/admin/wallet/requests/${id}/decide`, { approve, amount: amount === undefined ? undefined : Number(amount), note });
        await loadWallet();
    } catch (err) { tell(err.message); }
}

async function walletSetMin(id, current) {
    const v = await askText('الحد الأدنى لعهدة هذا الموظف (ر.ع) — أقل منه يصلك تنبيه. اتركه فارغاً لاستخدام الحد العام:', current === null ? '' : String(current), { type: 'number' });
    if (v === null) return;
    try { await api('PUT', `/api/admin/wallet/${id}/min`, { min: v.trim() === '' ? null : Number(v) }); await loadWalletAll(); } catch (err) { tell(err.message); }
}

async function walletSaveSettings() {
    try {
        await api('PUT', '/api/admin/wallet/settings', { min_default: Number($id('walletMinDefault').value) || 0, categories: $id('walletCats').value });
        setStatus('walletSetStatus', 'تم الحفظ ✓', 'ok');
        await loadWalletAll();
    } catch (err) { setStatus('walletSetStatus', err.message, 'err'); }
}

const switchTabBeforeWallet = window.switchTab;
window.switchTab = function (tabId) {
    switchTabBeforeWallet(tabId);
    if (tabId === 'wallet') loadWallet().catch(() => {});
};
// The badge of requests waiting (managers), once signed in
document.addEventListener('admin-ready', () => { if (wIsManager()) loadWalletAll().catch(() => {}); });
