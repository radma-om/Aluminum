/* Shared by the customer calculators (rolling shutter, overhead): company texts,
   status messages and embedding in the company site (iframe via embed.js). */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n).toFixed(2);
// Isolate each part so mixed Arabic/Latin labels ("العماني Napco" — "1.5 ملم") keep their order
const parts = (...list) => list.filter(Boolean).map((p) => `<bdi>${esc(p)}</bdi>`).join(' — ');
const NOTE_ICONS = ['fa-info-circle', 'fa-exclamation-triangle', 'fa-shield-alt', 'fa-check-circle'];

function setStatus(kind, message) {
    const el = $('submitStatus');
    el.className = 'submit-status' + (kind ? ' status-' + kind : '');
    el.innerHTML = message || '';
}

/* Company name, notices, notes and footer from the admin settings */
function renderCompany(conf, title) {
    document.querySelectorAll('[data-bind]').forEach((el) => { el.textContent = conf[el.dataset.bind] || ''; });
    document.title = title + ' | ' + conf.company_name;
    const notice = conf.calculator_notice || '';
    $('topNotice').textContent = notice ? '🏷️' + notice + '🏷️' : '';
    $('bottomNotice').textContent = notice;
    $('notesBox').innerHTML = String(conf.calculator_notes || '').split('\n').filter((l) => l.trim())
        .map((l, i) => `<i class="fas ${NOTE_ICONS[i % NOTE_ICONS.length]}"></i> ${esc(l.trim())}`).join('<br>');
    const site = (conf.company_website || '').trim();
    if (site) {
        const href = /^https?:\/\//.test(site) ? site : 'https://' + site;
        $('siteLink').href = href; $('siteLink').textContent = site.replace(/^https?:\/\//, ''); $('siteLink').hidden = false;
        const a = $('footSite').querySelector('a'); a.href = href; a.textContent = $('siteLink').textContent; $('footSite').hidden = false;
    }
    if (conf.company_phone) {
        const a = $('footPhone').querySelector('a');
        a.href = 'tel:' + conf.company_phone.replace(/[^\d+]/g, '');
        a.textContent = conf.company_phone; $('footPhone').hidden = false;
    }
    if (conf.company_address) { $('footAddress').querySelector('span').textContent = conf.company_address; $('footAddress').hidden = false; }
    $('year').textContent = new Date().getFullYear();
}

/* ---------- Embedding (radma.co iframe via embed.js) ---------- */
const embedded = window.self !== window.top || new URLSearchParams(location.search).has('embed');
const tellParent = (msg) => { if (window.parent !== window) window.parent.postMessage({ source: 'radma-calculator', ...msg }, '*'); };

/* Inside an iframe, ask the host page to scroll; otherwise scroll this page */
function scrollToEl(el) {
    if (embedded) tellParent({ type: 'scroll', top: el === document.body ? 0 : el.getBoundingClientRect().top + window.scrollY - 40 });
    else if (el === document.body) window.scrollTo({ top: 0, behavior: 'smooth' });
    else el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

if (embedded) {
    document.documentElement.classList.add('embedded');
    // Keep the iframe exactly as tall as the calculator, so the host page never shows a scrollbar inside it
    // Measure the content (body), not the document: inside an iframe the document is never shorter than the frame
    const report = () => tellParent({ type: 'height', height: Math.ceil(document.body.getBoundingClientRect().height) });
    new ResizeObserver(report).observe(document.body);
    window.addEventListener('load', report);
}

/* ---- Customer discount (a promotion the company switched on) ---- */

/* «🎉 عرض الشتاء: خصم 10% …» and «🎁 هدية …» under the page title, when they cover this calculator */
function showPromoBanner(conf, kind) {
    const p = conf && conf.promotion;
    const header = document.querySelector('.calc-header');
    if (!p || !header || document.getElementById('promoBanner')) return;
    const mine = (p.applies_to || []).find((a) => a.key === kind);
    const gift = p.gift && p.gift.applies_to.some((a) => a.key === kind) ? p.gift : null;
    const lines = [];
    if (mine && p.percent) lines.push(`🎉 ${p.label}: خصم ${p.percent}%${mine.parts ? ` على ${mine.parts.join(' و')}` : ''}${p.until ? ` حتى ${p.until}` : ''} — يظهر في السعر تلقائياً`);
    if (gift) lines.push(`🎁 هدية مع كل بوابة: ${gift.name} (قيمتها ${Number(gift.price).toFixed(2)} ر.ع)${gift.until ? ` حتى ${gift.until}` : ''}`);
    if (!lines.length) return;
    const div = document.createElement('div');
    div.id = 'promoBanner';
    div.className = 'promo-banner';
    div.textContent = lines.join(' — ');
    header.appendChild(div);
}

/* The price before the discount, the promotion and the gift, for the breakdown (live price or saved quote) */
function promoRows(p) {
    const pr = p.promo || null;
    const d = p.details || {};
    const total = pr ? pr.amount : d.discount_total;
    if (!(total > 0)) return '';
    const gift = pr ? (pr.gift ? pr.gift.amount : 0) : Number(d.gift_amount) || 0;
    const giftName = pr ? (pr.gift ? pr.gift.name : '') : d.gift_name;
    const label = pr ? (pr.percent ? pr.label : '') : d.promo_label;
    const percent = pr ? pr.percent : d.promo_percent;
    const parts = pr ? pr.parts : d.promo_parts;
    const gross = pr ? pr.gross_subtotal : d.gross_subtotal;
    const grossTo = pr ? pr.gross_subtotal_to : d.gross_subtotal_to;
    const totalTo = pr ? pr.amount_to : d.discount_total_to;
    const cut = Math.round((total - gift) * 100) / 100;
    const cutTo = totalTo != null ? Math.round((totalTo - gift) * 100) / 100 : null;
    const span = (a, b) => (b != null && b !== a ? `${money(a)} - ${money(b)}` : money(a));
    const safe = (t) => String(t || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    return `<div><span>المجموع قبل الخصم</span><span dir="ltr">${span(gross, grossTo)}</span></div>`
        + (label && cut > 0 ? `<div class="promo-row"><span>🎉 ${safe(label)} — خصم ${percent}%${parts && parts.length ? ` (${safe(parts.join(' و'))})` : ''}</span><span dir="ltr">-${span(cut, cutTo)}</span></div>` : '')
        + (gift > 0 ? `<div class="promo-row"><span>🎁 هدية: ${safe(giftName)} — خصم 100%</span><span dir="ltr">-${money(gift)}</span></div>` : '');
}
