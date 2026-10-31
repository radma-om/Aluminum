/* =============================================================
   Admin panel: the dashboard (KPI tiles, charts) and the customer
   follow-up (conversations, reports, recommendations, handovers).
   Uses api(), $id(), esc(), setStatus() and online from admin.js.
   ============================================================= */

const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const fmt2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = (n) => (Math.abs(n) >= 10000 ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n) : fmt.format(n));
const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const SVG = 'http://www.w3.org/2000/svg';

/* ---------------------------- Side menu ---------------------------- */

const isPhone = () => window.matchMedia('(max-width: 900px)').matches;

/* Desktop: fold to icons (remembered); phone: slide the menu in and out */
function toggleSidebar(open, { mobileOnly = false } = {}) {
    if (isPhone()) {
        document.body.classList.toggle('sb-open', open ?? !document.body.classList.contains('sb-open'));
        return;
    }
    if (mobileOnly) return;
    const folded = open === undefined ? !document.body.classList.contains('sb-collapsed') : !open;
    document.body.classList.toggle('sb-collapsed', folded);
    try { localStorage.setItem('sbCollapsed', folded ? '1' : ''); } catch { /* ignore */ }
    if (dash && $id('tab-dashboard').classList.contains('active')) setTimeout(renderTrend, 280); // chart width changed
}
try { if (localStorage.getItem('sbCollapsed')) document.body.classList.add('sb-collapsed'); } catch { /* ignore */ }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleSidebar(false, { mobileOnly: true }); });

/* ============================ Dashboard ============================ */

let dash = null;
let dashDays = 30;
let trendMetric = 'count';

async function loadDashboard() {
    if (!online) return;
    $id('dashBody').classList.add('dash-loading'); // keep the previous render while loading
    try {
        dash = await api('GET', '/api/admin/dashboard?days=' + dashDays);
        renderDashboard();
        $id('dashUpdated').textContent = 'آخر تحديث ' + new Date().toLocaleTimeString('ar-OM', { hour: '2-digit', minute: '2-digit' });
    } catch (err) {
        $id('dashUpdated').textContent = err.message;
    } finally {
        $id('dashBody').classList.remove('dash-loading');
    }
}

function renderDashboard() {
    renderKpis();
    renderAttention();
    renderTrend();
    renderStatus();
    renderBars('calcChart', dash.by_calculator);
    renderBars('sourceChart', dash.by_source);
    renderBars('placeChart', dash.by_place);
    renderBars('leadStatusChart', dash.leads_by_status.filter((x) => x.value));
    renderBars('staffChart', dash.leads_by_staff);
    updateLeadsBadge(dash.kpis.needs_staff.value);
}

/* Count up from 0 to the value */
function countUp(el, to, decimals = 0) {
    // Large amounts without decimals keep the tile readable (24,262 rather than 24,262.00)
    const dec = Math.abs(to) >= 1000 ? 0 : decimals;
    const f = new Intl.NumberFormat('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    const show = (v) => { el.textContent = f.format(v); };
    if (reduceMotion || !to) return show(to);
    const start = performance.now();
    const step = (t) => {
        const p = Math.min(1, (t - start) / 900);
        show(to * (1 - Math.pow(1 - p, 3)));
        if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

/* Change vs the previous period: up is good for every figure here */
function deltaHtml(k, { points = false } = {}) {
    if (k.previous == null) return '';
    const diff = k.value - k.previous;
    let text;
    // The arrow carries the sign (a "+" reads oddly in Arabic text)
    if (points) text = `${Math.abs(diff).toFixed(1)} نقطة`;
    else if (!k.previous) return k.value ? '<span class="up">▲ جديد</span> <span>مقارنة بالفترة السابقة</span>' : '<span>لا تغيير</span>';
    else text = `<bdi>${Math.abs(Math.round((diff / k.previous) * 100))}%</bdi>`;
    if (!diff) return '<span>بدون تغيير عن الفترة السابقة</span>';
    return `<span class="${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '▲' : '▼'} ${text}</span> <span>عن الفترة السابقة</span>`;
}

function sparkline(values) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'spark');
    svg.setAttribute('viewBox', '0 0 100 34');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const max = Math.max(...values, 1);
    // RTL: the newest day is on the left
    const pts = values.map((v, i) => [100 - (values.length > 1 ? (i / (values.length - 1)) * 100 : 50), 31 - (v / max) * 27]);
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
    svg.innerHTML = `<path d="${d} L0,34 L100,34 Z" fill="currentColor" opacity="0.10"></path>
        <path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"></path>`;
    return svg;
}

function renderKpis() {
    const k = dash.kpis;
    const tiles = [
        { key: 'value', label: 'قيمة عروض الأسعار', icon: 'fa-sack-dollar', unit: 'ر.ع', decimals: 2, hero: true, spark: dash.per_day.map((d) => d.value) },
        { key: 'quotes', label: 'طلبات عروض الأسعار', icon: 'fa-file-invoice', spark: dash.per_day.map((d) => d.count), accent: 'var(--series-1)' },
        { key: 'win_rate', label: 'نسبة القبول', icon: 'fa-handshake', unit: '%', decimals: 1, points: true, accent: 'var(--series-3)' },
        { key: 'won_value', label: 'قيمة العروض المقبولة', icon: 'fa-circle-check', unit: 'ر.ع', decimals: 2, accent: 'var(--series-3)' },
        { key: 'average', label: 'متوسط قيمة العرض', icon: 'fa-scale-balanced', unit: 'ر.ع', decimals: 2, accent: 'var(--series-2)' },
        { key: 'new_customers', label: 'عملاء جدد', icon: 'fa-user-plus', accent: 'var(--series-5)' }
    ];
    const grid = $id('kpiGrid');
    grid.innerHTML = '';
    for (const t of tiles) {
        const el = document.createElement('div');
        el.className = 'kpi' + (t.hero ? ' hero' : '');
        if (t.accent) el.style.setProperty('--kpi-accent', t.accent);
        el.innerHTML = `<div class="k-label"><i class="fas ${t.icon}"></i>${esc(t.label)}</div>
            <div class="k-value"><span class="num">0</span>${t.unit ? `<small>${esc(t.unit)}</small>` : ''}</div>
            <div class="k-delta">${deltaHtml(k[t.key], { points: t.points })}</div>`;
        if (t.spark) {
            const s = sparkline(t.spark);
            s.style.color = t.hero ? '#9ec5f4' : '#898781';
            el.appendChild(s);
        }
        grid.appendChild(el);
        countUp(el.querySelector('.num'), k[t.key].value, t.decimals || 0);
    }
}

function renderAttention() {
    const k = dash.kpis;
    const items = [
        { cls: 'critical', icon: 'fa-hand', n: k.needs_staff.value, label: 'عملاء يطلبون موظفاً', filter: { status: 'needs_staff' }, pulse: k.needs_staff.value > 0 },
        { cls: 'warning', icon: 'fa-calendar-day', n: k.due_follow_ups.value, label: 'متابعات مستحقة اليوم', filter: { status: 'open', due: true } },
        { cls: 'serious', icon: 'fa-user-slash', n: k.unassigned.value, label: 'عملاء بلا موظف متابع', filter: { status: 'open', assigned: '-' } },
        { cls: 'info', icon: 'fa-comments', n: k.open_leads.value, label: 'متابعات مفتوحة', filter: { status: 'open' } }
    ];
    $id('attention').innerHTML = '';
    for (const it of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `att ${it.cls}${it.pulse ? ' pulse' : ''}`;
        b.innerHTML = `<span class="a-icon"><i class="fas ${it.icon}"></i></span><span><div class="a-num">${fmt.format(it.n)}</div><div class="a-label">${esc(it.label)}</div></span>`;
        b.addEventListener('click', () => openLeadsWith(it.filter));
        $id('attention').appendChild(b);
    }
}

/* Clean axis maximum and ticks (0 … max in 4 steps) */
function niceScale(max) {
    if (max <= 0) return { max: 4, ticks: [0, 1, 2, 3, 4] };
    const raw = max / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const top = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = 0; v <= top + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
    return { max: top, ticks };
}

const shortDate = (iso) => { const [, m, d] = iso.split('-'); return `${Number(d)}/${Number(m)}`; };
const longDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('ar-OM', { weekday: 'long', day: 'numeric', month: 'long' });

/* Daily requests (or value): area + 2px line, RTL time axis, crosshair tooltip */
function renderTrend() {
    const wrap = $id('trendChart');
    const data = dash.per_day.map((d) => ({ date: d.date, v: trendMetric === 'count' ? d.count : d.value }));
    $id('trendTitle').textContent = trendMetric === 'count' ? 'طلبات عروض الأسعار يومياً' : 'قيمة عروض الأسعار يومياً (ر.ع)';
    const W = Math.max(320, wrap.clientWidth || 700);
    const H = 240;
    const m = { top: 16, right: 46, bottom: 26, left: 56 };
    const iw = W - m.left - m.right;
    const ih = H - m.top - m.bottom;
    const { max, ticks } = niceScale(Math.max(...data.map((d) => d.v)));
    // RTL: oldest day at the right, today at the left
    const x = (i) => m.left + iw - (data.length > 1 ? (i / (data.length - 1)) * iw : iw / 2);
    const y = (v) => m.top + ih - (v / max) * ih;

    const pts = data.map((d, i) => [x(i), y(d.v)]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const area = `${line} L${pts.at(-1)[0].toFixed(1)},${y(0)} L${pts[0][0].toFixed(1)},${y(0)} Z`;
    const every = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(iw / 64)))); // labels never crowd
    const xTicks = data.map((d, i) => ({ i, d })).filter(({ i }) => i % every === 0 || i === data.length - 1);
    const last = data.at(-1);
    const peak = data.reduce((a, b) => (b.v > a.v ? b : a), data[0]);
    const peakI = data.indexOf(peak);
    const fmtV = (v) => (trendMetric === 'count' ? fmt.format(v) : compact(v));

    wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" tabindex="0"
            aria-label="${esc($id('trendTitle').textContent)} — آخر قيمة ${esc(fmtV(last.v))}">
        ${ticks.map((t) => `<line class="gridline" x1="${m.left}" x2="${m.left + iw}" y1="${y(t)}" y2="${y(t)}"></line>
            <text class="tick" x="${m.left + iw + 8}" y="${y(t) + 4}" text-anchor="start">${esc(fmtV(t))}</text>`).join('')}
        <line class="baseline" x1="${m.left}" x2="${m.left + iw}" y1="${y(0)}" y2="${y(0)}"></line>
        ${xTicks.map(({ i, d }) => `<text class="tick" x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(shortDate(d.date))}</text>`).join('')}
        <path class="area fade-in" d="${area}"></path>
        <path class="line" d="${line}"></path>
        ${peak.v > 0 && peakI !== data.length - 1 ? `<circle class="dot" cx="${x(peakI)}" cy="${y(peak.v)}" r="4"></circle>
            <text class="end-label" x="${Math.min(x(peakI), m.left + iw - 26)}" y="${y(peak.v) - 10}" text-anchor="middle">${esc(fmtV(peak.v))}</text>` : ''}
        <circle class="dot" cx="${x(data.length - 1)}" cy="${y(last.v)}" r="4"></circle>
        <text class="end-label" x="${x(data.length - 1) - 8}" y="${y(last.v) - 10}" text-anchor="end">${esc(fmtV(last.v))}</text>
        <g class="hover" visibility="hidden">
            <line class="crosshair" y1="${m.top}" y2="${m.top + ih}"></line>
            <circle class="dot" r="5"></circle>
        </g>
        <rect x="${m.left}" y="${m.top}" width="${iw}" height="${ih}" fill="transparent"></rect>
    </svg><div class="tooltip" hidden></div>`;

    const svg = wrap.querySelector('svg');
    const path = svg.querySelector('.line');
    if (!reduceMotion && path.getTotalLength) {
        const len = path.getTotalLength();
        path.style.setProperty('--len', len);
        path.classList.add('draw');
    }
    const hover = svg.querySelector('.hover');
    const tip = wrap.querySelector('.tooltip');
    let current = data.length - 1;
    const show = (i) => {
        current = i;
        const px = x(i);
        const py = y(data[i].v);
        hover.setAttribute('visibility', 'visible');
        hover.querySelector('line').setAttribute('x1', px);
        hover.querySelector('line').setAttribute('x2', px);
        hover.querySelector('circle').setAttribute('cx', px);
        hover.querySelector('circle').setAttribute('cy', py);
        const scale = svg.getBoundingClientRect().width / W;
        tip.hidden = false;
        tip.style.left = px * scale + 'px';
        tip.style.top = py * scale + 'px';
        tip.replaceChildren();
        const v = document.createElement('div');
        v.className = 't-value';
        v.textContent = trendMetric === 'count' ? `${fmt.format(data[i].v)} طلب` : `${fmt2.format(data[i].v)} ر.ع`;
        const l = document.createElement('div');
        l.className = 't-label';
        l.innerHTML = '<span class="t-key"></span>';
        l.append(longDate(data[i].date));
        tip.append(v, l);
    };
    const hide = () => { hover.setAttribute('visibility', 'hidden'); tip.hidden = true; };
    svg.addEventListener('pointermove', (e) => {
        const r = svg.getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * W;
        const i = Math.round(((m.left + iw - px) / iw) * (data.length - 1));
        show(Math.max(0, Math.min(data.length - 1, i)));
    });
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('focus', () => show(current));
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') show(Math.min(data.length - 1, current + 1));
        else if (e.key === 'ArrowRight') show(Math.max(0, current - 1));
    });

    $id('trendTable').innerHTML = `<table class="mini"><thead><tr><th>اليوم</th><th>الطلبات</th><th>القيمة (ر.ع)</th></tr></thead><tbody>
        ${dash.per_day.slice().reverse().map((d) => `<tr><td>${esc(d.date)}</td><td class="num">${d.count}</td><td class="num">${fmt2.format(d.value)}</td></tr>`).join('')}</tbody></table>`;
}

/* Quote status: one whole split into parts (tall segmented bar + legend + table) */
const PART_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];
function renderStatus() {
    const parts = dash.by_status;
    const total = parts.reduce((s, p) => s + p.value, 0);
    const el = $id('statusChart');
    if (!total) {
        el.innerHTML = '<div class="empty-chart">لا توجد طلبات في هذه الفترة</div>';
    } else {
        el.innerHTML = `<div class="segbar" role="img" aria-label="${esc(parts.map((p) => `${p.label} ${p.value}`).join('، '))}">
            ${parts.map((p, i) => {
                const share = Math.round((p.value / total) * 100);
                return p.value ? `<div class="s-part${i === 3 ? ' dark-ink' : ''}" style="background:${PART_COLORS[i]};flex-grow:0"
                    data-grow="${p.value}" title="${esc(`${p.label}: ${p.value} (${share}%)`)}" tabindex="0">${share >= 14 ? share + '%' : ''}</div>` : '';
            }).join('')}</div>
            <div class="legend">${parts.map((p, i) => `<span><span class="sw" style="background:${PART_COLORS[i]}"></span>${esc(p.label)}</span>`).join('')}</div>
            <div class="hbars" style="margin-top:14px">${parts.map((p) => `<div class="hbar"><span class="h-label">${esc(p.label)}</span><span></span><span class="h-value">${fmt.format(p.value)}</span></div>`).join('')}</div>`;
        requestAnimationFrame(() => el.querySelectorAll('.s-part').forEach((s) => { s.style.flexGrow = s.dataset.grow; }));
    }
    $id('statusTable').innerHTML = `<table class="mini"><thead><tr><th>الحالة</th><th>العدد</th><th>النسبة</th></tr></thead><tbody>
        ${parts.map((p) => `<tr><td>${esc(p.label)}</td><td class="num">${p.value}</td><td class="num">${total ? Math.round((p.value / total) * 100) : 0}%</td></tr>`).join('')}</tbody></table>`;
}

/* Ranked horizontal bars, one hue, value at the tip */
function renderBars(id, rows) {
    const el = $id(id);
    if (!rows.length || !rows.some((r) => r.value)) {
        el.innerHTML = '<div class="empty-chart">لا توجد بيانات في هذه الفترة</div>';
        return;
    }
    const max = Math.max(...rows.map((r) => r.value));
    el.innerHTML = rows.map((r) => `<div class="hbar" title="${esc(`${r.label}: ${r.value}`)}">
        <span class="h-label">${esc(r.label)}</span>
        <span class="h-track"><span class="h-fill" data-w="${((r.value / max) * 100).toFixed(1)}"></span></span>
        <span class="h-value">${fmt.format(r.value)}</span></div>`).join('');
    requestAnimationFrame(() => el.querySelectorAll('.h-fill').forEach((f) => { f.style.width = f.dataset.w + '%'; }));
}

function updateLeadsBadge(n) {
    $id('leadsBadge').hidden = !n;
    $id('leadsBadge').textContent = n;
}

/* Toolbar: period, metric, table views */
$id('dashRange').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-days]');
    if (!b) return;
    dashDays = Number(b.dataset.days);
    $id('dashRange').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    loadDashboard();
});
$id('trendMetric').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-metric]');
    if (!b || !dash) return;
    trendMetric = b.dataset.metric;
    $id('trendMetric').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    renderTrend();
});
document.querySelectorAll('[data-table]').forEach((b) => b.addEventListener('click', () => {
    const t = $id(b.dataset.table + 'Table');
    t.hidden = !t.hidden;
    b.textContent = t.hidden ? 'عرض كجدول' : 'إخفاء الجدول';
}));
let resizeTimer = null;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (dash && $id('tab-dashboard').classList.contains('active')) renderTrend(); }, 150);
});

/* ========================= Customer follow-up ========================= */

let leadMeta = { statuses: {}, note_kinds: {}, channels: {}, staff: [], can_reply_whatsapp: false };
let leadFilter = { status: 'open', assigned: '', due: false };
let leadsCache = [];
let currentLeadId = null;
const AVATAR_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#6250d6', '#e34948', '#008300', '#d55181', '#c98500'];
const CH_ICONS = { whatsapp: 'fa-brands fa-whatsapp', website: 'fas fa-globe', calculator: 'fas fa-calculator' };

const parseUtc = (s) => new Date(String(s).replace(' ', 'T') + 'Z');
function ago(s) {
    const min = Math.round((Date.now() - parseUtc(s)) / 60000);
    if (min < 1) return 'الآن';
    if (min < 60) return `منذ ${min} د`;
    const h = Math.round(min / 60);
    if (h < 24) return `منذ ${h} س`;
    const d = Math.round(h / 24);
    return d < 30 ? `منذ ${d} يوم` : parseUtc(s).toLocaleDateString('ar-OM');
}
const timeOf = (s) => parseUtc(s).toLocaleTimeString('ar-OM', { hour: '2-digit', minute: '2-digit' });
const dayOf = (s) => parseUtc(s).toLocaleDateString('ar-OM', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const todayStr = () => new Date().toISOString().slice(0, 10);

function avatar(lead, cls = '') {
    const name = lead.name || lead.phone || '؟';
    const color = AVATAR_COLORS[lead.id % AVATAR_COLORS.length];
    return `<span class="avatar ${cls}" style="background:${color}">${esc([...name.replace(/^\+?\d+$/, '#')][0])}
        <span class="ch ${esc(lead.channel)}"><i class="${CH_ICONS[lead.channel] || 'fas fa-user'}"></i></span></span>`;
}

function renderLeadFilters() {
    const chips = [['open', 'المفتوحة'], ...Object.entries(leadMeta.statuses), ['', 'الكل']];
    $id('leadStatusChips').innerHTML = chips.map(([k, label]) =>
        `<button type="button" class="chip ${leadFilter.status === k && !leadFilter.due ? 'on' : ''}" data-status="${esc(k)}">${esc(label)}</button>`).join('') +
        `<button type="button" class="chip ${leadFilter.due ? 'on' : ''}" data-due="1"><i class="fas fa-calendar-day"></i> مستحقة اليوم</button>`;
    const keep = leadFilter.assigned;
    $id('leadAssigned').innerHTML = `<option value="">${ME && ME.leads_scope === 'mine' ? 'عملائي وغير المُسندين' : 'كل الموظفين'}</option><option value="__me">مهامي (${esc(currentMe())})</option>
        <option value="-">غير مُسند</option>${leadMeta.staff.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}`;
    $id('leadAssigned').value = keep;
}

$id('leadStatusChips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    leadFilter.due = Boolean(b.dataset.due);
    if (!leadFilter.due) leadFilter.status = b.dataset.status;
    else leadFilter.status = 'open';
    renderLeadFilters();
    loadLeads();
});

function openLeadsWith(filter) {
    if (!canSee('leads')) return;
    leadFilter = { status: filter.status ?? 'open', assigned: filter.assigned || '', due: Boolean(filter.due) };
    switchTab('leads');
}

let searchTimer = null;
function debouncedLoadLeads() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadLeads, 250);
}

async function loadLeads() {
    if (!online) return;
    const firstLoad = !Object.keys(leadMeta.statuses).length;
    const p = new URLSearchParams();
    if (leadFilter.status === 'open') p.set('open', '1');
    else if (leadFilter.status) p.set('status', leadFilter.status);
    const assigned = leadFilter.assigned;
    if (assigned) p.set('assigned', assigned === '__me' ? currentMe() : assigned);
    if ($id('leadChannel').value) p.set('channel', $id('leadChannel').value);
    if ($id('leadSearch').value.trim()) p.set('q', $id('leadSearch').value.trim());
    const r = await api('GET', '/api/admin/leads?' + p);
    leadMeta = { statuses: r.statuses, note_kinds: r.note_kinds, channels: r.channels, staff: r.staff, can_reply_whatsapp: r.can_reply_whatsapp };
    if (firstLoad) renderLeadFilters();
    leadsCache = leadFilter.due ? r.leads.filter((l) => l.next_follow_up && l.next_follow_up <= todayStr()) : r.leads;
    renderLeadItems();
    if (leadFilter.status === 'open' && !assigned) updateLeadsBadge(r.leads.filter((l) => l.status === 'needs_staff').length);
}

function renderLeadItems() {
    const el = $id('leadItems');
    if (!leadsCache.length) {
        el.innerHTML = '<div class="empty-chart" style="padding:40px 10px">لا يوجد عملاء بهذا التصنيف</div>';
        return;
    }
    el.innerHTML = leadsCache.map((l) => {
        const due = l.next_follow_up && l.next_follow_up <= todayStr() && leadMeta.statuses && ['new', 'needs_staff', 'following', 'waiting'].includes(l.status);
        const who = l.last_role === 'assistant' ? '🤖 ' : l.last_role === 'staff' ? '👤 ' : '';
        return `<div class="lead-item ${l.id === currentLeadId ? 'active' : ''}" data-id="${l.id}" tabindex="0">
            ${avatar(l)}
            <div class="lead-main">
                <div class="lead-top"><span class="lead-name">${esc(l.name || (l.phone ? '+' + l.phone : 'زائر الموقع'))}</span><span class="lead-time">${esc(ago(l.last_activity_at))}</span></div>
                <div class="lead-preview">${esc(who + (l.last_message || ''))}</div>
                <div class="lead-tags">
                    <span class="pill st-${esc(l.status)}">${esc(leadMeta.statuses[l.status] || l.status)}</span>
                    ${l.assigned_to ? `<span class="pill"><i class="fas fa-user"></i>${esc(l.assigned_to)}</span>` : ''}
                    ${l.quote_count ? `<span class="pill"><i class="fas fa-file-invoice"></i>${l.quote_count}</span>` : ''}
                    ${due ? `<span class="pill due"><i class="fas fa-bell"></i>${esc(l.next_follow_up)}</span>` : ''}
                </div>
            </div></div>`;
    }).join('');
}

$id('leadItems').addEventListener('click', (e) => {
    const item = e.target.closest('.lead-item');
    if (item) openLead(Number(item.dataset.id));
});
$id('leadItems').addEventListener('keydown', (e) => {
    const item = e.target.closest('.lead-item');
    if (item && e.key === 'Enter') openLead(Number(item.dataset.id));
});

async function openLead(id, { keepScroll = false } = {}) {
    currentLeadId = id;
    document.querySelectorAll('.lead-item').forEach((x) => x.classList.toggle('active', Number(x.dataset.id) === id));
    const data = await api('GET', '/api/admin/leads/' + id);
    renderLeadDetail(data, keepScroll);
}

function renderLeadDetail({ lead, messages, notes, quotes, agent_paused_until: pausedUntil }, keepScroll) {
    const el = $id('leadDetail');
    const oldTimeline = el.querySelector('.timeline');
    const atBottom = !oldTimeline || oldTimeline.scrollHeight - oldTimeline.scrollTop - oldTimeline.clientHeight < 40;
    const staffOptions = [...new Set([...leadMeta.staff, ...(lead.assigned_to ? [lead.assigned_to] : [])])];
    let lastDay = '';
    const timeline = messages.map((m) => {
        const d = dayOf(m.created_at);
        const sep = d !== lastDay ? `<div class="day-sep">${esc(d)}</div>` : '';
        lastDay = d;
        const who = { customer: '', assistant: '🤖 المساعد الذكي · ', staff: `👤 ${m.author || 'موظف'} · `, system: '' }[m.role] || '';
        return `${sep}<div class="msg ${esc(m.role)}">${esc(m.text)}<div class="m-meta">${esc(who)}${esc(timeOf(m.created_at))}</div></div>`;
    }).join('');
    const phone = lead.phone ? String(lead.phone).replace(/\D/g, '') : '';
    const canReply = phone && leadMeta.can_reply_whatsapp;

    el.innerHTML = `
        <div class="lead-head">
            ${avatar(lead)}
            <div style="flex:1;min-width:200px">
                <h3>${esc(lead.name || (phone ? '+' + phone : 'زائر الموقع'))}</h3>
                <div class="meta">
                    ${phone ? `<a href="https://wa.me/${esc(phone)}" target="_blank" rel="noopener"><i class="fa-brands fa-whatsapp"></i> +${esc(phone)}</a>` : '<span>بدون رقم</span>'}
                    <span><i class="${CH_ICONS[lead.channel] || 'fas fa-user'}"></i> ${esc(leadMeta.channels[lead.channel] || lead.channel)}</span>
                    <span><i class="far fa-clock"></i> أول تواصل ${esc(parseUtc(lead.created_at).toLocaleDateString('ar-OM'))}</span>
                    <span><i class="far fa-comment"></i> ${lead.message_count} رسالة</span>
                </div>
            </div>
        </div>
        ${pausedUntil ? `<div class="lead-paused"><i class="fas fa-circle-pause"></i> المساعد الذكي لا يرد على هذا العميل حتى ${esc(parseUtc(pausedUntil).toLocaleString('ar-OM', { dateStyle: 'medium', timeStyle: 'short' }))} (طلب موظفاً أو ردّ عليه موظف).
            <button class="btn btn-outline btn-sm" id="ldResume">ليرد المساعد عليه الآن</button></div>` : ''}
        <div class="lead-controls">
            <label>الحالة
                <select id="ldStatus">${Object.entries(leadMeta.statuses).map(([k, v]) => `<option value="${k}" ${k === lead.status ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
            <label>الموظف المتابع
                <select id="ldAssigned"><option value="">— غير مُسند —</option>${staffOptions.map((n) => `<option ${n === lead.assigned_to ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
            <label>موعد المتابعة القادمة
                <input type="date" id="ldNext" value="${esc(lead.next_follow_up || '')}"></label>
            <label>اسم العميل
                <input type="text" id="ldName" value="${esc(lead.name || '')}" placeholder="اكتب اسم العميل"></label>
        </div>
        ${quotes.length ? `<div class="panel-title"><i class="fas fa-file-invoice-dollar"></i> عروض الأسعار</div>
            <div class="quote-chips">${quotes.map((q) => `<button type="button" class="quote-chip" onclick="openQuotePdf(${q.id})" title="تحميل PDF">
                <strong>${esc(q.ref)}</strong> · ${fmt2.format(q.total)} ر.ع · ${esc(STATUS_NAMES[q.status] || q.status)}</button>`).join('')}</div>` : ''}
        <div class="lead-body">
            <div>
                <div class="panel-title"><i class="fas fa-comments"></i> المحادثة</div>
                <div class="timeline">${timeline || '<div class="day-sep">لا توجد رسائل بعد</div>'}</div>
                ${canReply ? `<div class="reply-box">
                    <textarea id="ldReply" placeholder="اكتب رداً للعميل على واتساب (يُرسل عبر MazBot باسمك)…"></textarea>
                    <div class="row">
                        <button class="btn btn-success btn-sm" id="ldSend"><i class="fa-brands fa-whatsapp"></i> إرسال عبر واتساب</button>
                        <label><input type="checkbox" id="ldPause" checked> إيقاف المساعد الذكي لهذا العميل 12 ساعة</label>
                        <span id="ldReplyStatus" class="status-text"></span>
                    </div>
                    <span class="status-text">واتساب يسمح بالرسائل الحرة خلال 24 ساعة من آخر رسالة للعميل فقط.</span>
                </div>` : (phone ? '<p class="status-text" style="margin-top:8px">لإرسال رد من هنا أكمل ربط MazBot في تبويب «الربط».</p>' : '')}
            </div>
            <div>
                <div class="panel-title"><i class="fas fa-clipboard-list"></i> تقارير المتابعة والتوصيات</div>
                <div class="note-form">
                    <div class="row">
                        <select id="ldNoteKind">${Object.entries(leadMeta.note_kinds).filter(([k]) => k !== 'handover').map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
                        <span>بقلم: <strong>${esc(currentMe())}</strong></span>
                    </div>
                    <textarea id="ldNoteText" placeholder="ماذا حدث في المتابعة؟ ما توصيتك للموظف التالي؟"></textarea>
                    <div class="row"><button class="btn btn-primary btn-sm" id="ldAddNote"><i class="fas fa-plus"></i> إضافة</button><span id="ldNoteStatus" class="status-text"></span></div>
                </div>
                <div class="notes">${notes.map((n) => `<div class="note k-${esc(n.kind)}">
                    <div class="n-head"><span class="n-kind">${esc(leadMeta.note_kinds[n.kind] || n.kind)}</span><span>${esc(n.author || '')} · ${esc(parseUtc(n.created_at).toLocaleString('ar-OM', { dateStyle: 'medium', timeStyle: 'short' }))}</span></div>
                    <div class="n-text">${esc(n.text)}</div></div>`).join('') || '<div class="empty-chart">لا توجد تقارير بعد — اكتب أول تقرير متابعة</div>'}</div>
            </div>
        </div>`;

    const tl = el.querySelector('.timeline');
    if (!keepScroll || atBottom) tl.scrollTop = tl.scrollHeight;

    const patch = async (body) => {
        try { renderLeadDetail(await api('PATCH', '/api/admin/leads/' + lead.id, body), true); loadLeads(); } catch (err) { alert(err.message); }
    };
    if (pausedUntil) {
        $id('ldResume').addEventListener('click', async () => {
            try { renderLeadDetail(await api('DELETE', `/api/admin/leads/${lead.id}/pause`), true); } catch (err) { alert(err.message); }
        });
    }
    $id('ldStatus').addEventListener('change', (e) => patch({ status: e.target.value }));
    $id('ldNext').addEventListener('change', (e) => patch({ next_follow_up: e.target.value }));
    $id('ldName').addEventListener('change', (e) => patch({ name: e.target.value }));
    $id('ldAssigned').addEventListener('change', (e) => {
        const to = e.target.value;
        const text = to ? prompt(`ملاحظة التسليم إلى ${to} (اختياري): ما الذي يجب أن يعرفه عن هذا العميل؟`, '') : '';
        if (text === null) { e.target.value = lead.assigned_to || ''; return; }
        patch({ assigned_to: to, handover_text: text || undefined });
    });
    $id('ldAddNote').addEventListener('click', async () => {
        const text = $id('ldNoteText').value.trim();
        if (!text) return setStatus('ldNoteStatus', 'اكتب النص أولاً', 'err');
        try { renderLeadDetail(await api('POST', `/api/admin/leads/${lead.id}/notes`, { kind: $id('ldNoteKind').value, text }), true); loadLeads(); } catch (err) { setStatus('ldNoteStatus', err.message, 'err'); }
    });
    if (canReply) {
        $id('ldSend').addEventListener('click', async () => {
            const text = $id('ldReply').value.trim();
            if (!text) return setStatus('ldReplyStatus', 'اكتب الرسالة أولاً', 'err');
            $id('ldSend').disabled = true;
            setStatus('ldReplyStatus', 'جاري الإرسال...');
            try {
                renderLeadDetail(await api('POST', `/api/admin/leads/${lead.id}/reply`, { text, pause_agent: $id('ldPause').checked }), false);
                loadLeads();
            } catch (err) {
                setStatus('ldReplyStatus', err.message, 'err');
                $id('ldSend').disabled = false;
            }
        });
    }
}

/* ------------------------------ Wiring ------------------------------ */

const switchTabBeforeCrm = window.switchTab;
window.switchTab = function (tabId) {
    switchTabBeforeCrm(tabId);
    const btn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
    if (btn) $id('pageTitle').textContent = btn.querySelector('.t-label').textContent;
    toggleSidebar(false, { mobileOnly: true });
    if (!online) return;
    if (tabId === 'dashboard') loadDashboard();
    if (tabId === 'leads') { renderLeadFilters(); loadLeads().then(() => { if (currentLeadId) openLead(currentLeadId, { keepScroll: true }); }).catch(() => {}); }
};

// Keep the follow-up fresh while it is open (new WhatsApp / website messages)
setInterval(() => {
    if (!online || document.hidden) return;
    if ($id('tab-leads').classList.contains('active')) {
        loadLeads().catch(() => {});
        if (currentLeadId && !document.activeElement.closest('#leadDetail textarea, #leadDetail input')) openLead(currentLeadId, { keepScroll: true }).catch(() => {});
    } else if ($id('tab-dashboard').classList.contains('active')) {
        loadDashboard();
    }
}, 30_000);

document.addEventListener('admin-ready', () => {
    // Load the data of the section that opened first (it depends on the account's permissions)
    const active = document.querySelector('.sidebar .tab-btn.active');
    if (active) switchTab(active.dataset.tab);
    if (canSee('leads')) {
        api('GET', '/api/admin/leads?open=1')
            .then((r) => updateLeadsBadge(r.leads.filter((l) => l.status === 'needs_staff').length)).catch(() => {});
    }
});
