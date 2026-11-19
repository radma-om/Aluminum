/* =============================================================
   «تتبع طلبي» — the customer's own page for an invoice, opened from
   the WhatsApp message (no sign-in): /t/<the invoice's random key>.
   - The steps: quote → invoice → payment → installation appointment →
     work under way → done, with the one reached now highlighted.
   - The lines, the total, what is paid, the balance, the payments,
     the appointment and the technician, and the invoice PDF.
   - The same random key as the invoice PDF link is the access control;
     nothing internal is shown (notes, costs, who issued it, the log).
   - A static page: no script, its own strict Content-Security-Policy,
     never cached, never indexed, no referrer (the key is in the URL).
   ============================================================= */
const invoices = require('./invoices');
const workorders = require('./workorders');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => Number(n || 0).toFixed(3);
const KEY_RE = /^[0-9a-f]{32}$/;
const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const dayName = (d) => { const t = Date.parse(d + 'T00:00:00Z'); return Number.isNaN(t) ? '' : DAYS[new Date(t).getUTCDay()]; };

const path = (inv) => `/t/${inv.access_key}`;

/* The invoice of a tracking key (null: not found / malformed) */
function find(db, key) {
    const k = String(key || '').toLowerCase();
    if (!KEY_RE.test(k)) return null;
    const row = db.prepare('SELECT id FROM invoices WHERE access_key = ?').get(k);
    return row ? invoices.get(db, row.id) : null;
}

/* What the customer may see of the invoice and its work orders */
function view(db, inv) {
    const quote = inv.quote_id ? db.prepare('SELECT ref, created_at FROM quotes WHERE id = ?').get(inv.quote_id) : null;
    const orders = db.prepare(`SELECT w.kind, w.status, w.scheduled_date, w.scheduled_time, w.completed_at, u.display_name AS technician
                               FROM work_orders w LEFT JOIN staff_users u ON u.id = w.technician_id
                               WHERE w.invoice_id = ? AND w.status != 'cancelled' ORDER BY w.id`).all(inv.id);
    const cancelled = inv.state === 'cancelled';
    const paidAll = inv.balance <= 0.0005;
    const next = orders.find((o) => ['new', 'scheduled', 'in_progress'].includes(o.status)) || null;
    const allDone = orders.length > 0 && orders.every((o) => o.status === 'done');
    const working = orders.some((o) => o.status === 'in_progress');
    const scheduled = orders.find((o) => o.scheduled_date && o.status !== 'done') || null;
    const when = (o) => `${dayName(o.scheduled_date)} ${o.scheduled_date}${o.scheduled_time ? ` — ${o.scheduled_time}` : ''}`;

    // done / now / later for each step
    const steps = [
        { title: 'عرض السعر', note: quote ? `رقم ${quote.ref}` : '', state: 'done' },
        { title: 'صدرت الفاتورة', note: `${inv.number} — ${inv.issue_date}`, state: 'done' },
        {
            title: paidAll ? 'تم الدفع بالكامل' : inv.paid > 0.0005 ? 'دُفع جزء من المبلغ' : 'بانتظار الدفع',
            note: paidAll ? `${money(inv.total)} ر.ع` : `المدفوع ${money(inv.paid)} — المتبقي ${money(inv.balance)} ر.ع`,
            state: paidAll ? 'done' : 'now'
        },
        {
            title: 'موعد التركيب',
            note: scheduled ? `${when(scheduled)}${scheduled.technician ? ` — الفني ${scheduled.technician}` : ''}`
                : allDone ? 'تم' : 'سنتواصل معكم لتحديد الموعد',
            state: allDone || working ? 'done' : scheduled ? 'now' : 'later'
        },
        { title: 'جاري التنفيذ', note: working ? 'الفني يعمل على طلبكم الآن' : '', state: allDone ? 'done' : working ? 'now' : 'later' },
        { title: 'اكتمل العمل', note: allDone ? (inv.invoice_date || '') : '', state: allDone ? 'done' : 'later' }
    ];
    // The work went ahead while a balance is left: the payment is «due» (marked, not the step reached now)
    if (steps[2].state === 'now' && steps.slice(3).some((s) => s.state !== 'later')) steps[2].state = 'due';
    // Only one «now»: the first step not done yet, when nothing else is
    if (!steps.some((s) => s.state === 'now')) { const first = steps.find((s) => s.state === 'later'); if (first) first.state = 'now'; }

    return {
        cancelled, steps, quote, orders: orders.map((o) => ({ kind: workorders.KINDS[o.kind] || o.kind, status: workorders.STATUSES[o.status] || o.status, when: o.scheduled_date ? when(o) : null, technician: o.technician })),
        status: cancelled ? 'الفاتورة ملغاة' : allDone ? 'اكتمل العمل ✅' : working ? 'جاري التنفيذ 🔧' : scheduled ? 'تم تحديد موعد التركيب 📅' : next ? 'بانتظار تحديد الموعد' : paidAll ? 'تم الدفع ✅' : 'صدرت الفاتورة 🧾'
    };
}

function page(db, inv, settings) {
    const v = view(db, inv);
    const company = settings.company_name || 'رادما';
    const phone = String(settings.company_phone || '').replace(/\D/g, '');
    const wa = phone ? `https://wa.me/${phone.length === 8 ? '968' + phone : phone}` : null;
    const pdf = `/invoices/${encodeURIComponent(inv.number)}.pdf?k=${inv.access_key}`;
    const items = (inv.items || []).map((i) => `<tr><td>${esc(i.name)}${i.type ? `<small>${esc(i.type)}</small>` : ''}${i.description ? `<small>${esc(i.description)}</small>` : ''}</td>
        <td class="n">${esc(i.quantity)}</td><td class="n">${i.gift ? 'هدية' : money(i.line_total)}</td></tr>`).join('');
    const pays = (inv.payments || []).map((p) => `<li><span>${esc(p.paid_on)} — ${esc(invoices.METHODS[p.method] || p.method)}</span><b>${money(p.amount)}</b></li>`).join('');
    const dep = inv.deposit && !inv.deposit.paid && !v.cancelled ? `<p class="dep">${esc(inv.deposit.label)}: <b>${money(inv.deposit.amount)} ر.ع</b>${inv.paid > 0.0005 ? ` — المتبقي منه ${money(inv.deposit.remaining)} ر.ع` : ''}</p>` : '';
    const first = String(inv.customer_name || '').trim().split(/\s+/)[0] || 'عميلنا العزيز';
    return `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><link rel="icon" href="/icons/icon-192.png"><title>تتبع طلبك — ${esc(inv.number)}</title>
<style>
:root{--p:#1a5276;--ok:#1e8449;--now:#d35400;--mut:#6b7785;--bd:#e3e8ee;--bg:#f4f6f9}
*{box-sizing:border-box}body{margin:0;font-family:Tahoma,"Segoe UI",Arial,sans-serif;background:var(--bg);color:#1c2733;line-height:1.6}
header{background:var(--p);color:#fff;padding:14px 16px;display:flex;align-items:center;gap:10px}header img{height:34px;background:#fff;border-radius:8px;padding:3px}
header b{font-size:1.05rem}main{max-width:640px;margin:0 auto;padding:14px 16px 40px}
.card{background:#fff;border:1px solid var(--bd);border-radius:14px;padding:14px 16px;margin-bottom:12px}
h1{font-size:1.15rem;margin:0 0 4px}.status{display:inline-block;background:#eef6f1;color:var(--ok);border-radius:999px;padding:3px 12px;font-weight:700;font-size:.9rem}
.status.off{background:#fdecea;color:#a93226}.mut{color:var(--mut);font-size:.88rem;margin:6px 0 0}
ol.steps{list-style:none;margin:0;padding:0}ol.steps li{position:relative;padding:0 30px 16px 0}
ol.steps li:before{content:"";position:absolute;right:7px;top:6px;width:14px;height:14px;border-radius:50%;background:#fff;border:2px solid var(--bd)}
ol.steps li:after{content:"";position:absolute;right:13px;top:22px;bottom:-2px;width:2px;background:var(--bd)}ol.steps li:last-child:after{display:none}
ol.steps li.done:before{background:var(--ok);border-color:var(--ok)}ol.steps li.done:after{background:var(--ok)}
ol.steps li.now:before{background:var(--now);border-color:var(--now);box-shadow:0 0 0 4px #fbe3d2}ol.steps li.now b{color:var(--now)}
ol.steps li.later b{color:var(--mut)}ol.steps li.due:before{background:#f5b041;border-color:#f5b041}ol.steps li.due b{color:#9a6700}ol.steps small{display:block;color:var(--mut);font-size:.85rem}
table{width:100%;border-collapse:collapse;font-size:.92rem}td,th{padding:7px 4px;border-bottom:1px solid var(--bd);text-align:right;vertical-align:top}
th{color:var(--mut);font-weight:400;font-size:.82rem}td.n,th.n{text-align:left;white-space:nowrap}td small{display:block;color:var(--mut);font-size:.8rem}
.tot div{display:flex;justify-content:space-between;padding:4px 0}.tot .big{font-size:1.1rem;font-weight:700;border-top:1px solid var(--bd);margin-top:4px;padding-top:8px}
.tot .bal{color:#a93226;font-weight:700}.tot .paid{color:var(--ok)}.dep{background:#fff8ec;border-radius:10px;padding:8px 10px;margin:8px 0 0;font-size:.9rem}
ul.pays{list-style:none;margin:0;padding:0}ul.pays li{display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px dashed var(--bd);font-size:.9rem}
.btns{display:grid;gap:8px}.btn{display:block;text-align:center;text-decoration:none;border-radius:12px;padding:12px;font-weight:700;background:var(--p);color:#fff}
.btn.wa{background:#1e8449}.btn.out{background:#fff;color:var(--p);border:1px solid var(--p)}
footer{text-align:center;color:var(--mut);font-size:.8rem;margin-top:16px}
</style></head><body>
<header><img src="/images/logo.png" alt=""><b>${esc(company)}</b></header>
<main>
<section class="card"><h1>مرحباً ${esc(first)} 👋</h1>
<span class="status${v.cancelled ? ' off' : ''}">${esc(v.status)}</span>
<p class="mut">فاتورة ${esc(inv.number)} — صدرت ${esc(inv.issue_date)}</p></section>
${v.cancelled ? '<section class="card"><b>هذه الفاتورة ملغاة.</b><p class="mut">للاستفسار تواصلوا معنا.</p></section>' : `
<section class="card"><ol class="steps">${v.steps.map((s) => `<li class="${s.state}"><b>${esc(s.title)}</b>${s.note ? `<small>${esc(s.note)}</small>` : ''}</li>`).join('')}</ol></section>`}
<section class="card"><table><thead><tr><th>البند</th><th class="n">الكمية</th><th class="n">المبلغ</th></tr></thead><tbody>${items}</tbody></table>
<div class="tot">${Math.abs(inv.adjustment || 0) >= 0.0005 ? `<div><span>${inv.adjustment < 0 ? 'خصم' : 'تعديل'}</span><span>${money(inv.adjustment)}</span></div>` : ''}
<div><span>المجموع قبل الضريبة</span><span>${money(inv.subtotal)}</span></div>
<div><span>الضريبة ${esc(inv.vat_percent)}%</span><span>${money(inv.vat)}</span></div>
<div class="big"><span>الإجمالي</span><span>${money(inv.total)} ر.ع</span></div>
<div class="paid"><span>المدفوع</span><span>${money(inv.paid)}</span></div>
<div class="bal"><span>المتبقي</span><span>${money(inv.balance)} ر.ع</span></div></div>${dep}</section>
${pays ? `<section class="card"><b>الدفعات</b><ul class="pays">${pays}</ul></section>` : ''}
<section class="card btns">
<a class="btn" href="${esc(pdf)}">📄 الفاتورة PDF</a>
${wa ? `<a class="btn wa" href="${esc(wa)}">💬 تواصل معنا على واتساب</a>` : ''}
${phone ? `<a class="btn out" href="tel:+${esc(phone.length === 8 ? '968' + phone : phone)}">📞 اتصال</a>` : ''}
</section>
<footer>هذا الرابط خاص بكم — يُحدَّث تلقائياً مع كل خطوة.<br>${esc(company)}</footer>
</main></body></html>`;
}

/* Express handler: GET /t/:key */
function route(db, getSettings) {
    return (req, res) => {
        res.set({
            'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        });
        const inv = find(db, req.params.key);
        if (!inv) return res.status(404).type('html').send('<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>غير موجود</title><p style="font-family:Tahoma;padding:24px">الرابط غير صحيح أو انتهى.</p></html>');
        res.type('html').send(page(db, inv, getSettings(db)));
    };
}

module.exports = { path, find, view, page, route };
