/* =============================================================
   «عرض السعر» — the customer's page of a quote: /q/<the quote's key>
   (the same random key as its PDF link; no sign-in).
   - The lines, the totals (from – to for a range quote), the validity,
     the notes and the terms — what the quote PDF shows, nothing more.
   - «أوافق على العرض»: a plain form (no script) with «اطلعت على البنود
     والشروط». The quote becomes «مقبول» (accepted), the time is kept,
     the managers and the quote's owner are told on their phone, and the
     customer's follow-up log records it. Then the office issues the
     invoice — its tracking page takes over.
   - Not possible when the quote expired (ask for a new price), was
     declined, or is invoiced already (the page links to the invoice).
   ============================================================= */
const tracking = require('./tracking');
const invoices = require('./invoices');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n || 0).toFixed(3);
const KEY_RE = /^[0-9a-f]{32}$/;
const localToday = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);

const path = (quote) => `/q/${quote.access_key}`;

const ready = new WeakSet(); // once per database, not on every page view
function ensureColumns(db) {
    if (ready.has(db)) return;
    ready.add(db);
    const cols = db.prepare('PRAGMA table_info(quotes)').all().map((c) => c.name);
    if (!cols.includes('accepted_at')) db.exec('ALTER TABLE quotes ADD COLUMN accepted_at TEXT');
    if (!cols.includes('accepted_via')) db.exec('ALTER TABLE quotes ADD COLUMN accepted_via TEXT');
}

function find(db, key) {
    const k = String(key || '').toLowerCase();
    if (!KEY_RE.test(k)) return null;
    ensureColumns(db);
    const row = db.prepare('SELECT * FROM quotes WHERE access_key = ?').get(k);
    if (!row) return null;
    const parse = (s, d) => { try { return JSON.parse(s) ?? d; } catch { return d; } };
    return { ...row, items: parse(row.items_json, []), details: parse(row.details_json, {}) || {} };
}

/* What the customer can do now */
function state(db, quote) {
    const inv = invoices.activeForQuote(db, quote.id);
    if (inv) return { key: 'invoiced', invoice: db.prepare('SELECT number, access_key FROM invoices WHERE id = ?').get(inv.id) };
    if (quote.status === 'rejected') return { key: 'declined' };
    if (quote.status === 'accepted' || quote.status === 'done') return { key: 'accepted' };
    if (quote.valid_until && quote.valid_until < localToday()) return { key: 'expired' };
    return { key: 'open' };
}

/**
 * The customer accepts the quote from its page. Returns { ok, state } — once only; an expired, declined or
 * invoiced quote is not accepted.
 */
function accept(db, quote) {
    ensureColumns(db);
    const s = state(db, quote);
    if (s.key !== 'open') return { ok: false, state: s.key };
    const info = db.prepare(`UPDATE quotes SET status = 'accepted', accepted_at = datetime('now'), accepted_via = 'customer_page'
                             WHERE id = ? AND status IN ('new', 'contacted')`).run(quote.id);
    if (!info.changes) return { ok: false, state: 'accepted' };
    const lead = db.prepare('SELECT * FROM leads WHERE phone = ?').get(quote.customer_phone);
    if (lead) require('./leads').addMessage(db, lead, 'system', `✅ وافق العميل على عرض السعر ${quote.ref} (${money(quote.total)} ر.ع) من صفحة العرض — أصدر الفاتورة`);
    const owner = (quote.details && quote.details.created_by) || null;
    const push = require('./push');
    const staff = require('./staff');
    // Who is told: the managers, the quote's owner, and every employee who issues invoices and may see this
    // customer — the first to call the customer and issue the invoice gets the sale
    const told = (u) => u.role === 'manager' || (owner && u.display_name === owner)
        || (u.permissions.includes('invoices') && staff.seesQuote(db, u, quote));
    push.send(db, push.accountsOf(db, told), {
        title: `✅ وافق ${quote.customer_name || 'العميل'} على عرض السعر ${quote.ref}`,
        body: `${money(quote.total)} ر.ع — أصدر الفاتورة من «عروض الأسعار»`,
        url: '/admin#tab=quotes', tag: `quote-accepted-${quote.id}`
    }).catch(() => {});
    return { ok: true, state: 'accepted' };
}

function page(db, quote, settings, { just = null } = {}) {
    const s = state(db, quote);
    const d = quote.details || {};
    const range = d.range || {};
    const company = settings.company_name || 'ردما للبوابات الإلكترونية';
    const phone = String(settings.company_phone || '').replace(/\D/g, '');
    const intl = phone.length === 8 ? '968' + phone : phone;
    const first = String(quote.customer_name || '').trim().split(/\s+/)[0] || 'عميلنا العزيز';
    const amount = (from, to) => (to != null && Math.abs(to - from) > 0.0005 ? `${money(from)} – ${money(to)}` : money(from));
    const sizeOf = (i) => require('./doors').sizeText(i, quote.details || {});
    const items = (quote.items || []).map((i) => `<tr><td>${esc(i.name)}${i.type ? `<small>${esc(i.type)}</small>` : ''}${sizeOf(i) ? `<small>${esc(sizeOf(i))}</small>` : ''}${i.description ? `<small>${esc(i.description)}</small>` : ''}</td>
        <td class="n">${esc(i.quantity)}</td><td class="n">${i.gift ? 'هدية' : amount(i.line_total, i.line_total_to)}</td></tr>`).join('');
    const terms = String(settings.quote_terms || '').split('\n').map((t) => t.trim()).filter(Boolean);
    const pdf = `/quotes/${encodeURIComponent(quote.ref)}.pdf?k=${quote.access_key}`;
    const status = {
        open: ['بانتظار موافقتكم', ''], accepted: ['تمت الموافقة ✅', ''], invoiced: ['صدرت الفاتورة 🧾', ''],
        expired: ['انتهت صلاحية العرض', ' off'], declined: ['العرض غير متاح', ' off']
    }[s.key];
    const action = {
        open: `<form method="post" action="${esc(path(quote))}/accept" class="accept">
            <label><input type="checkbox" name="confirm" value="1" required> اطلعت على البنود والمبالغ والشروط</label>
            <button type="submit" class="btn">✅ أوافق على العرض</button>
            <p class="mut">بعد موافقتكم يتواصل معكم فريقنا لإصدار الفاتورة وتحديد موعد التركيب.</p></form>`,
        accepted: `<p class="ok">✅ وافقتم على هذا العرض${quote.accepted_at ? ` في ${esc(String(quote.accepted_at).slice(0, 10))}` : ''}. شكراً لكم — سيتواصل معكم فريقنا لإصدار الفاتورة وتحديد موعد التركيب.</p>`,
        invoiced: s.invoice ? `<p class="ok">صدرت فاتورة هذا العرض: ${esc(s.invoice.number)}</p><a class="btn" href="/t/${esc(s.invoice.access_key)}">📦 تتبع طلبي والفاتورة</a>` : '',
        expired: `<p class="warn">انتهت صلاحية هذا العرض في ${esc(quote.valid_until)}. الأسعار قد تتغير — راسلونا لتحديث السعر.</p>`,
        declined: '<p class="warn">هذا العرض لم يعد متاحاً. للاستفسار راسلونا.</p>'
    }[s.key];
    const flash = just === 'accepted' ? '<section class="card"><p class="ok"><b>شكراً لكم! سُجّلت موافقتكم على العرض ✅</b></p></section>'
        : just === 'confirm' ? '<section class="card"><p class="warn">ضعوا علامة «اطلعت على البنود» ثم اضغطوا «أوافق على العرض».</p></section>' : '';
    return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><link rel="icon" href="/icons/icon-192.png"><title>عرض السعر ${esc(quote.ref)}</title>
<style>${tracking.STYLE}
.accept label{display:flex;gap:8px;align-items:flex-start;margin-bottom:10px;font-size:.95rem}.accept input{width:20px;height:20px;margin-top:2px;flex:none}
.accept button{width:100%;border:0;font:inherit;font-size:1.05rem;cursor:pointer;background:var(--ok)}
.ok{color:var(--ok);margin:0 0 8px}.warn{color:#a93226;margin:0 0 8px}ol.terms{margin:6px 0 0;padding-inline-start:20px;font-size:.88rem;color:#3a4654}</style></head><body>
<header><img src="/images/logo.png" alt=""><b>${esc(company)}</b></header>
<main>
${flash}
<section class="card"><h1>مرحباً ${esc(first)} 👋</h1><span class="status${status[1]}">${esc(status[0])}</span>
<p class="mut">عرض السعر ${esc(quote.ref)} — ${esc(String(quote.created_at).slice(0, 10))}${quote.valid_until ? ` — ساري حتى ${esc(quote.valid_until)}` : ''}</p></section>
${Array.isArray(d.spec) && d.spec.length ? `<section class="card"><table><tbody>${d.spec.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${esc(v)}</td></tr>`).join('')}</tbody></table></section>` : ''}
<section class="card"><table><thead><tr><th>البند</th><th class="n">الكمية</th><th class="n">المبلغ</th></tr></thead><tbody>${items}</tbody></table>
<div class="tot"><div><span>المجموع قبل الضريبة</span><span>${amount(quote.subtotal, range.subtotal_to)}</span></div>
<div><span>الضريبة ${esc(quote.vat_percent)}%</span><span>${amount(quote.vat, range.vat_to)}</span></div>
<div class="big"><span>الإجمالي</span><span>${amount(quote.total, range.total_to)} ر.ع</span></div></div>
${d.fees_note ? `<p class="mut">${esc(d.fees_note)}</p>` : ''}${d.extra_fees_note ? `<p class="mut">${esc(d.extra_fees_note)}</p>` : ''}${quote.notes ? `<p class="mut">ملاحظات: ${esc(quote.notes)}</p>` : ''}</section>
${terms.length ? `<section class="card"><b>الشروط والأحكام</b><ol class="terms">${terms.map((t) => `<li>${esc(t.replace(/^\d+[.)-]\s*/, ''))}</li>`).join('')}</ol></section>` : ''}
<section class="card">${action}</section>
<section class="card btns">
<a class="btn out" href="${esc(pdf)}">📄 عرض السعر PDF</a>
${intl ? `<a class="btn wa" href="https://wa.me/${esc(intl)}">💬 تواصل معنا على واتساب</a><a class="btn out" href="tel:+${esc(intl)}">📞 اتصال</a>` : ''}
</section>
<footer>هذا الرابط خاص بكم.<br>${esc(company)}</footer>
</main></body></html>`;
}

const HEADERS = {
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
    // No script; the only form posts back to this page
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
};
const notFound = (res) => res.status(404).type('html').send('<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>غير موجود</title><p style="font-family:Tahoma;padding:24px">الرابط غير صحيح.</p></html>');

/* GET /q/:key and POST /q/:key/accept */
function routes(app, db, getSettings, express) {
    app.get('/q/:key', (req, res) => {
        res.set(HEADERS);
        const quote = find(db, req.params.key);
        if (!quote) return notFound(res);
        const just = ['accepted', 'confirm'].includes(req.query.m) ? req.query.m : null;
        res.type('html').send(page(db, quote, getSettings(db), { just }));
    });
    app.post('/q/:key/accept', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
        res.set(HEADERS);
        const quote = find(db, req.params.key);
        if (!quote) return notFound(res);
        if (!req.body || req.body.confirm !== '1') return res.redirect(303, `${path(quote)}?m=confirm`);
        const r = accept(db, quote);
        res.redirect(303, `${path(quote)}${r.ok ? '?m=accepted' : ''}`);
    });
}

module.exports = { path, find, state, accept, page, routes, ensureColumns };
