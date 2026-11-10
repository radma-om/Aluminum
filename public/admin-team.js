/* =============================================================
   For managers:
   1) The dashboard's live part — today's figures, three rates, the
      sales path and the latest events (refreshed with the dashboard).
   2) «أداء الموظفين»: every employee between two dates, compared with
      the same length before, and one employee in detail.
   Uses api(), $id(), esc(), fmt, fmt2, ago(), countUp(), renderBars(),
   niceScale(), shortDate(), longDate(), switchTab(), ME, online.
   ============================================================= */

/* ------------------------------ Dashboard pulse ------------------------------ */

let pulseShown = false; // numbers count up only the first time, not on every 30-second refresh

const renderDashboardBeforePulse = renderDashboard;
renderDashboard = function () { // eslint-disable-line no-global-assign
    renderDashboardBeforePulse();
    renderPulse(dash && dash.pulse);
};

function vsYesterday(now, before, { money = false } = {}) {
    if (!before && !now) return 'لا شيء أمس أيضاً';
    if (!before) return 'لا شيء أمس';
    const f = money ? fmt2 : fmt;
    return `أمس: ${f.format(before)}`;
}

function renderPulse(p) {
    $id('pulse').hidden = !p;
    $id('pulseCharts').hidden = !p;
    if (!p) return;
    const visitsPct = p.visits.total ? Math.round((p.visits.done / p.visits.total) * 100) : 0;
    const day = new Date(p.today + 'T00:00:00').toLocaleDateString('ar-OM', { weekday: 'long', day: 'numeric', month: 'long' });
    const tiles = [
        { icon: 'fa-file-invoice', label: 'عروض اليوم', value: p.quotes.count, sub: `${fmt2.format(p.quotes.value)} ر.ع — ${vsYesterday(p.quotes.count, p.quotes.previous_count)}`, go: "switchTab('quotes')" },
        { icon: 'fa-receipt', label: 'فواتير اليوم', value: p.invoices.value, decimals: 2, unit: 'ر.ع', sub: `${fmt.format(p.invoices.count)} فاتورة — ${vsYesterday(p.invoices.value, p.invoices.previous_value, { money: true })}`, go: "switchTab('invoices')" },
        { icon: 'fa-hand-holding-dollar', label: 'المحصّل اليوم', value: p.collected.value, decimals: 2, unit: 'ر.ع', sub: `${fmt.format(p.collected.count)} دفعة — ${vsYesterday(p.collected.value, p.collected.previous_value, { money: true })}`, go: "switchTab('invoices')" },
        { icon: 'fa-calendar-check', label: 'مواعيد اليوم', value: p.visits.total, sub: p.visits.total ? `اكتمل ${fmt.format(p.visits.done)}${p.visits.running ? ` — قيد التنفيذ ${fmt.format(p.visits.running)}` : ''}` : 'لا مواعيد اليوم', bar: p.visits.total ? visitsPct : null, go: "switchTab('work_orders')" },
        { icon: 'fa-hourglass-half', label: 'طلبات مواعيد تنتظر', value: p.pending_requests, sub: p.pending_requests ? 'بانتظار موافقتك' : 'لا طلبات معلّقة', alert: p.pending_requests > 0, go: "woFilter='requests'; switchTab('work_orders')" },
        { icon: 'fa-coins', label: 'مستحقات لم تُحصّل', value: p.outstanding.value, decimals: 2, unit: 'ر.ع', sub: `${fmt.format(p.outstanding.count)} فاتورة مفتوحة`, go: "switchTab('invoices')" }
    ];
    $id('pulse').innerHTML = `<div class="pulse-head"><span class="live-dot"></span><strong>مباشر</strong><span>${esc(day)}</span>
            <span class="pulse-msg"><i class="fas fa-comments"></i> ${fmt.format(p.customer_messages)} رسالة من العملاء اليوم</span></div>
        <div class="pulse-grid">${tiles.map((t, i) => `<button type="button" class="pulse-tile${t.alert ? ' alert' : ''}" onclick="${t.go}">
            <span class="p-icon"><i class="fas ${t.icon}"></i></span>
            <span class="p-label">${esc(t.label)}</span>
            <span class="p-value"><span class="num" data-i="${i}">0</span>${t.unit ? `<small>${esc(t.unit)}</small>` : ''}</span>
            <span class="p-sub">${esc(t.sub)}</span>
            ${t.bar != null ? `<span class="p-bar" title="${t.bar}% مكتمل"><span style="width:${t.bar}%"></span></span>` : ''}
        </button>`).join('')}</div>`;
    $id('pulse').querySelectorAll('.num').forEach((el) => {
        const t = tiles[Number(el.dataset.i)];
        if (pulseShown) {
            const dec = Math.abs(t.value) >= 1000 ? 0 : t.decimals || 0;
            el.textContent = new Intl.NumberFormat('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(t.value);
        } else countUp(el, t.value, t.decimals || 0);
    });

    // Three rates as rings: the share, and the numbers it comes from
    const rings = [
        { key: 'win', label: 'قبول العروض', of: (r) => `${fmt.format(r.part)} من ${fmt.format(r.whole)} عرضاً` },
        { key: 'collection', label: 'تحصيل الفواتير', of: (r) => `${fmt.format(r.part)} من ${fmt.format(r.whole)} ر.ع` },
        { key: 'on_time', label: 'إنجاز في الموعد', of: (r) => `${fmt.format(r.part)} من ${fmt.format(r.whole)} عملاً` }
    ];
    const C = 2 * Math.PI * 34;
    $id('ratesSub').textContent = `آخر ${dash.days} يوماً`;
    $id('rateRings').innerHTML = rings.map((g) => {
        const r = p.rates[g.key];
        const has = r.percent != null;
        const len = has ? Math.min(100, r.percent) / 100 * C : 0;
        return `<div class="ring" title="${esc(g.label)}: ${has ? r.percent + '%' : 'لا بيانات'}">
            <svg viewBox="0 0 84 84" role="img" aria-label="${esc(g.label)} ${has ? r.percent + '%' : 'لا بيانات'}">
                <circle cx="42" cy="42" r="34" class="r-track"></circle>
                <circle cx="42" cy="42" r="34" class="r-fill" stroke-dasharray="${pulseShown ? len.toFixed(1) : 0} ${C.toFixed(1)}" data-len="${len.toFixed(1)}" data-c="${C.toFixed(1)}" transform="rotate(-90 42 42)"></circle>
                <text x="42" y="47" text-anchor="middle" class="r-num">${has ? Math.round(r.percent) + '%' : '—'}</text>
            </svg>
            <strong>${esc(g.label)}</strong><span>${has ? esc(g.of(r)) : 'لا بيانات في الفترة'}</span></div>`;
    }).join('');
    if (!pulseShown) requestAnimationFrame(() => $id('rateRings').querySelectorAll('.r-fill').forEach((c) => c.setAttribute('stroke-dasharray', `${c.dataset.len} ${c.dataset.c}`)));

    // The sales path: each step against the first, and how many passed from the step before
    const top = Math.max(p.funnel[0].value, 1);
    $id('salesFunnel').innerHTML = p.funnel[0].value ? p.funnel.map((s, i) => {
        const prev = i ? p.funnel[i - 1].value : null;
        const pass = prev ? Math.round((s.value / prev) * 100) : null;
        return `<div class="f-step" title="${esc(s.label)}: ${s.value}">
            <span class="f-label">${esc(s.label)}</span>
            <span class="f-track"><span class="f-fill" style="width:${Math.max(2, (s.value / top) * 100).toFixed(1)}%"></span></span>
            <span class="f-value">${fmt.format(s.value)}</span>
            <span class="f-pass">${pass != null ? `<bdi>${pass}%</bdi> من السابق` : ''}</span></div>`;
    }).join('') : '<div class="empty-chart">لا عروض في هذه الفترة</div>';

    $id('activityFeed').innerHTML = p.activity.length ? p.activity.map(feedItem).join('') : '<div class="empty-chart">لا أحداث بعد</div>';
    pulseShown = true;
}

const FEED_ICONS = { quote: 'fa-file-invoice', invoice: 'fa-receipt', payment: 'fa-hand-holding-dollar', job: 'fa-screwdriver-wrench', request: 'fa-calendar-plus',
    report: 'fa-clipboard-list', reply: 'fa-reply', assigned: 'fa-user-tag' };
function feedItem(e) {
    return `<div class="feed-item t-${esc(e.type)}"><span class="f-icon"><i class="fas ${FEED_ICONS[e.type] || 'fa-circle'}"></i></span>
        <span class="f-text">${esc(e.text)}${e.amount != null ? ` <b><bdi>${fmt2.format(e.amount)}</bdi> ر.ع</b>` : ''}</span>
        <span class="f-meta">${e.who ? esc(e.who) + ' · ' : ''}${esc(ago(e.at))}</span></div>`;
}

/* ------------------------------ Employees ------------------------------ */

let team = null;
let teamMetric = 'follow_ups';
const TEAM_METRICS = {
    follow_ups: { label: 'المتابعات', unit: '' },
    quotes: { label: 'العروض', unit: '' },
    quote_value: { label: 'قيمة العروض', unit: 'ر.ع' },
    invoice_value: { label: 'قيمة الفواتير', unit: 'ر.ع' }
};
const isoDay = (d) => d.toISOString().slice(0, 10);
const muscatToday = () => isoDay(new Date(Date.now() + 4 * 3600_000));
const plusDays = (iso, n) => isoDay(new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000));

function teamPreset(key) {
    const today = muscatToday();
    let from = today;
    let to = today;
    if (key === 'month') from = today.slice(0, 8) + '01';
    else if (key === 'last-month') { to = plusDays(today.slice(0, 8) + '01', -1); from = to.slice(0, 8) + '01'; } else if (key !== 'today') from = plusDays(today, -(Number(key) - 1));
    $id('teamFrom').value = from;
    $id('teamTo').value = to;
}

async function loadTeam() {
    if (!online || !ME || ME.role !== 'manager') return;
    if (!$id('teamFrom').value) teamPreset('30');
    const q = new URLSearchParams({ from: $id('teamFrom').value, to: $id('teamTo').value });
    if ($id('teamEmployee').value) q.set('employee', $id('teamEmployee').value);
    $id('teamBody').classList.add('dash-loading');
    try {
        team = await api('GET', '/api/admin/team?' + q);
        const keep = $id('teamEmployee').value;
        $id('teamEmployee').innerHTML = '<option value="">كل الموظفين</option>' + team.staff.map((s) => `<option value="${esc(s.name)}">${esc(s.name)} — ${esc(s.role_label)}</option>`).join('');
        $id('teamEmployee').value = keep;
        $id('teamStatus').textContent = `${team.days} يوماً — يُقارن مع ${shortDate(team.previous_from)} إلى ${shortDate(team.previous_to)}`;
        if (team.employee) renderTeamEmployee(); else renderTeamOverview();
    } catch (err) {
        $id('teamStatus').textContent = err.message;
        if (/غير موجود/.test(err.message)) { $id('teamEmployee').value = ''; loadTeam(); }
    } finally {
        $id('teamBody').classList.remove('dash-loading');
    }
}

/* A figure against the period before. lowerIsBetter: reply time */
function teamDelta(now, before, { lowerIsBetter = false } = {}) {
    if (now == null || before == null) return '<span>لا مقارنة</span>';
    if (!before) return now ? '<span class="up">▲ جديد</span>' : '<span>بدون تغيير</span>';
    const diff = now - before;
    if (!diff) return '<span>بدون تغيير</span>';
    const good = lowerIsBetter ? diff < 0 : diff > 0;
    return `<span class="${good ? 'up' : 'down'}">${diff > 0 ? '▲' : '▼'} <bdi>${Math.abs(Math.round((diff / before) * 100))}%</bdi></span> <span>عن الفترة السابقة</span>`;
}

const hoursText = (h) => (h == null ? '—' : h < 1 ? `${Math.round(h * 60)} د` : h < 48 ? `${h} س` : `${Math.round(h / 24)} يوم`);
const initials = (name) => String(name || '?').trim().slice(0, 1);

function teamTiles(tiles) {
    return `<div class="kpi-grid team-kpis">${tiles.map((t) => `<div class="kpi" style="--kpi-accent:${t.accent || 'var(--series-1)'}">
        <div class="k-label"><i class="fas ${t.icon}"></i>${esc(t.label)}</div>
        <div class="k-value">${t.text != null ? esc(t.text) : `<span>${t.money ? fmt2.format(t.value) : fmt.format(t.value)}</span>`}${t.unit ? `<small>${esc(t.unit)}</small>` : ''}</div>
        <div class="k-delta">${t.delta || (t.note ? `<span>${esc(t.note)}</span>` : '')}</div></div>`).join('')}</div>`;
}

function renderTeamOverview() {
    const t = team.totals;
    const p = team.previous_totals;
    const rows = team.staff;
    const maxInv = Math.max(...rows.map((s) => s.invoice_value), 1);
    const maxQuote = Math.max(...rows.map((s) => s.quote_value), 1);
    const bar = (v, max, cls = '') => `<span class="cell-bar ${cls}"><span style="width:${((v / max) * 100).toFixed(1)}%"></span></span>`;
    $id('teamBody').innerHTML = teamTiles([
        { icon: 'fa-receipt', label: 'قيمة الفواتير', value: t.invoice_value, money: true, unit: 'ر.ع', delta: teamDelta(t.invoice_value, p.invoice_value), accent: 'var(--series-3)' },
        { icon: 'fa-file-invoice', label: 'قيمة العروض', value: t.quote_value, money: true, unit: 'ر.ع', delta: teamDelta(t.quote_value, p.quote_value) },
        { icon: 'fa-hand-holding-dollar', label: 'المبالغ المحصّلة', value: t.collected, money: true, unit: 'ر.ع', delta: teamDelta(t.collected, p.collected), accent: 'var(--series-4)' },
        { icon: 'fa-handshake', label: 'نسبة قبول العروض', text: t.win_rate == null ? '—' : t.win_rate + '%', note: `${fmt.format(t.accepted_count)} من ${fmt.format(t.quote_count)} عرضاً`, accent: 'var(--series-3)' },
        { icon: 'fa-comments', label: 'المتابعات (ردود وتقارير)', value: t.replies + t.reports, delta: teamDelta(t.replies + t.reports, p.replies + p.reports), accent: 'var(--series-2)' },
        { icon: 'fa-stopwatch', label: 'متوسط زمن أول رد', text: hoursText(t.response_hours), delta: teamDelta(t.response_hours, p.response_hours, { lowerIsBetter: true }), accent: 'var(--series-5)' }
    ]) + `<div class="card">
        <div class="chart-head"><h3>الموظفون</h3><span class="sub">اضغط على موظف لعرض تفاصيله — مرتبون حسب قيمة الفواتير</span></div>
        ${rows.length ? `<div class="table-wrapper"><table class="team-table stack-table"><thead><tr>
            <th>الموظف</th><th>العروض</th><th>القبول</th><th>الفواتير</th><th>المحصّل</th><th>المتابعات</th><th>زمن أول رد</th><th>الآن</th><th>أيام النشاط</th>
        </tr></thead><tbody>${rows.map((s) => `<tr class="team-row${s.active ? '' : ' muted-row'}" onclick="openTeamEmployee('${esc(s.name).replace(/'/g, '&#39;')}')" tabindex="0">
            <td data-label="الموظف" class="text-start"><span class="team-who"><span class="avatar" style="background:${s.role === 'technician' ? 'var(--series-2)' : 'var(--primary)'}">${esc(initials(s.name))}</span>
                <span><strong>${esc(s.name)}</strong><small>${esc(s.role_label)}${s.active ? '' : ' — موقوف'}${s.last_seen ? ' · آخر نشاط ' + esc(ago(s.last_seen)) : ''}</small></span></span></td>
            <td data-label="العروض"><b>${fmt.format(s.quote_count)}</b> <small><bdi>${fmt2.format(s.quote_value)}</bdi> ر.ع</small>${bar(s.quote_value, maxQuote)}</td>
            <td data-label="القبول">${s.win_rate == null ? '—' : `<bdi>${s.win_rate}%</bdi>`}</td>
            <td data-label="الفواتير"><b>${fmt.format(s.invoice_count)}</b> <small><bdi>${fmt2.format(s.invoice_value)}</bdi> ر.ع</small>${bar(s.invoice_value, maxInv, 'green')}</td>
            <td data-label="المحصّل"><bdi>${fmt2.format(s.collected)}</bdi></td>
            <td data-label="المتابعات">${fmt.format(s.replies + s.reports)} <small>(${fmt.format(s.customers_handled)} عميل)</small>${s.role === 'technician' ? ` <small>· أعمال ${fmt.format(s.jobs_done)}</small>` : ''}</td>
            <td data-label="زمن أول رد">${hoursText(s.response_hours)}${s.assignments_waiting ? ` <small class="bad">(${fmt.format(s.assignments_waiting)} بلا رد)</small>` : ''}</td>
            <td data-label="الآن"><span class="now-chips"><span title="عملاء مفتوحون">${fmt.format(s.open_customers)} مفتوح</span>${s.needs_attention ? `<span class="warn" title="بحاجة متابعة">${fmt.format(s.needs_attention)} متابعة</span>` : ''}${s.overdue_48h ? `<span class="bad" title="لم يتابعها منذ 48 ساعة">${fmt.format(s.overdue_48h)} متأخر</span>` : ''}</span></td>
            <td data-label="أيام النشاط">${fmt.format(s.active_days)} / ${fmt.format(team.days)}</td>
        </tr>`).join('')}</tbody></table></div>` : '<div class="empty-chart">لا يوجد موظفون أو نشاط في هذه الفترة</div>'}
    </div>
    <div class="dash-grid">
        <div class="card span-6"><div class="chart-head"><h3>قيمة الفواتير لكل موظف</h3><span class="sub">ر.ع</span></div><div class="hbars" id="teamInvoiceBars"></div></div>
        <div class="card span-6"><div class="chart-head"><h3>المتابعات لكل موظف</h3><span class="sub">ردود وتقارير</span></div><div class="hbars" id="teamFollowBars"></div></div>
    </div>`;
    renderBars('teamInvoiceBars', rows.filter((s) => s.invoice_value).map((s) => ({ label: s.name, value: Math.round(s.invoice_value) })));
    renderBars('teamFollowBars', rows.filter((s) => s.replies + s.reports).map((s) => ({ label: s.name, value: s.replies + s.reports })));
}

function openTeamEmployee(name) {
    $id('teamEmployee').value = name;
    loadTeam();
}

function renderTeamEmployee() {
    const e = team.employee;
    const tech = e.role === 'technician';
    const followUps = e.replies + e.reports;
    $id('teamBody').innerHTML = `<div class="team-head card">
            <button class="btn btn-outline btn-sm" onclick="openTeamEmployee('')"><i class="fas fa-arrow-right"></i> كل الموظفين</button>
            <span class="avatar big" style="background:${tech ? 'var(--series-2)' : 'var(--primary)'}">${esc(initials(e.name))}</span>
            <div><h3>${esc(e.name)}</h3><span class="status-text">${esc(e.role_label)}${e.active ? '' : ' — حساب موقوف'}${e.last_seen ? ' · آخر نشاط ' + esc(ago(e.last_seen)) : ''} · نشط ${fmt.format(e.active_days)} من ${fmt.format(team.days)} يوماً</span></div>
        </div>` + teamTiles([
        { icon: 'fa-receipt', label: 'قيمة الفواتير', value: e.invoice_value, money: true, unit: 'ر.ع', delta: teamDelta(e.invoice_value, e.previous.invoice_value), accent: 'var(--series-3)' },
        { icon: 'fa-file-invoice', label: 'قيمة العروض', value: e.quote_value, money: true, unit: 'ر.ع', delta: teamDelta(e.quote_value, e.previous.quote_value) },
        { icon: 'fa-hand-holding-dollar', label: 'المحصّل', value: e.collected, money: true, unit: 'ر.ع', delta: teamDelta(e.collected, e.previous.collected), accent: 'var(--series-4)' },
        { icon: 'fa-handshake', label: 'نسبة القبول', text: e.win_rate == null ? '—' : e.win_rate + '%', note: `${fmt.format(e.accepted_count)} من ${fmt.format(e.quote_count)} عرضاً${e.average_discount != null ? ` — متوسط خصمه ${e.average_discount}%` : ''}`, accent: 'var(--series-3)' },
        tech ? { icon: 'fa-screwdriver-wrench', label: 'أعمال منجزة', value: e.jobs_done, note: `${fmt.format(e.jobs_on_time)} في موعدها`, delta: null, accent: 'var(--series-2)' }
            : { icon: 'fa-comments', label: 'المتابعات', value: followUps, delta: teamDelta(followUps, e.previous.replies + e.previous.reports), accent: 'var(--series-2)' },
        { icon: 'fa-stopwatch', label: 'زمن أول رد', text: hoursText(e.response_hours), note: `${fmt.format(e.assignments_answered)} من ${fmt.format(e.assignments_received)} إسناداً رُدّ عليها`, accent: 'var(--series-5)' }
    ]) + `<div class="dash-grid">
        <div class="card span-8">
            <div class="chart-head"><h3 id="teamDayTitle">النشاط يوماً بيوم</h3>
                <div class="seg" id="teamMetricSeg" role="group" aria-label="المقياس">${Object.entries(TEAM_METRICS).map(([k, m]) => `<button type="button" data-m="${k}" class="${k === teamMetric ? 'on' : ''}">${m.label}</button>`).join('')}</div>
                <button class="link-btn" onclick="const t = $id('teamDayTable'); t.hidden = !t.hidden; this.textContent = t.hidden ? 'عرض كجدول' : 'إخفاء الجدول'">عرض كجدول</button></div>
            <div class="chart-wrap" id="teamDayChart"></div>
            <div id="teamDayTable" hidden></div>
        </div>
        <div class="card span-4">
            <div class="chart-head"><h3>عروضه حسب الحالة</h3></div><div class="hbars" id="teamQuoteStatus"></div>
            <div class="chart-head" style="margin-top:18px"><h3>العملاء الآن</h3></div>
            <div class="now-chips big"><span>${fmt.format(e.open_customers)} مفتوح</span><span class="${e.needs_attention ? 'warn' : ''}">${fmt.format(e.needs_attention)} بحاجة متابعة</span><span class="${e.overdue_48h ? 'bad' : ''}">${fmt.format(e.overdue_48h)} متأخر +48س</span></div>
        </div>
        <div class="card span-6">
            <div class="chart-head"><h3>عملاء ينتظرونه الآن</h3><span class="sub">${fmt.format(e.waiting.length)}</span></div>
            <div class="feed">${e.waiting.length ? e.waiting.map((w) => `<button type="button" class="feed-item wait" onclick="teamOpenLead(${w.id})">
                <span class="f-icon"><i class="fas fa-user-clock"></i></span>
                <span class="f-text"><strong>${esc(w.name || (w.phone ? '+' + w.phone : 'عميل'))}</strong> — ${esc(w.status_label)}</span>
                <span class="f-meta ${w.overdue_hours ? 'bad' : ''}">${esc(waitReason(w))}</span></button>`).join('') : '<div class="empty-chart">لا أحد ينتظر 👍</div>'}</div>
        </div>
        <div class="card span-6">
            <div class="chart-head"><h3>آخر ما قام به</h3><span class="sub">خلال الفترة</span></div>
            <div class="feed tall">${e.timeline.length ? e.timeline.map(feedItem).join('') : '<div class="empty-chart">لا نشاط في هذه الفترة</div>'}</div>
        </div>
    </div>`;
    renderBars('teamQuoteStatus', e.quotes_by_status.filter((s) => s.value));
    $id('teamMetricSeg').addEventListener('click', (ev) => {
        const b = ev.target.closest('button[data-m]');
        if (!b) return;
        teamMetric = b.dataset.m;
        $id('teamMetricSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        renderTeamDays();
    });
    renderTeamDays();
}

function waitReason(w) {
    if (w.overdue_hours) return `لم يتابعه منذ ${fmt.format(w.overdue_hours)} ساعة`;
    if (w.reason === 'overdue') return `موعد المتابعة فات (${w.date})`;
    if (w.reason === 'due') return 'موعد المتابعة اليوم';
    return w.days ? `بلا متابعة منذ ${fmt.format(w.days)} يوم` : 'بحاجة متابعة';
}

function teamOpenLead(id) {
    switchTab('leads');
    if (typeof openLead === 'function') setTimeout(() => openLead(id).catch(() => {}), 400);
}

/* One series of daily columns (newest on the left, as the dashboard), with a hover tooltip and a table view */
function renderTeamDays() {
    const rows = team.employee.per_day;
    const m = TEAM_METRICS[teamMetric];
    const values = rows.map((r) => r[teamMetric]);
    const wrap = $id('teamDayChart');
    $id('teamDayTitle').textContent = `${m.label} يوماً بيوم`;
    $id('teamDayTable').innerHTML = `<table class="mini"><thead><tr><th>اليوم</th><th>المتابعات</th><th>العروض</th><th>قيمة العروض</th><th>قيمة الفواتير</th></tr></thead><tbody>${
        [...rows].reverse().map((r) => `<tr><td>${esc(r.date)}</td><td class="num">${fmt.format(r.follow_ups)}</td><td class="num">${fmt.format(r.quotes)}</td><td class="num">${fmt2.format(r.quote_value)}</td><td class="num">${fmt2.format(r.invoice_value)}</td></tr>`).join('')}</tbody></table>`;
    if (!values.some(Boolean)) { wrap.innerHTML = '<div class="empty-chart">لا نشاط من هذا النوع في الفترة</div>'; return; }
    const W = Math.max(wrap.clientWidth, 280);
    const H = 220;
    const pad = { t: 10, r: 8, b: 24, l: 40 };
    const scale = niceScale(Math.max(...values));
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    const step = iw / rows.length;
    const bw = Math.max(2, Math.min(26, step - 2));
    const y = (v) => pad.t + ih - (v / scale.max) * ih;
    const x = (i) => pad.l + iw - (i + 0.5) * step; // RTL: the first day on the right
    const every = Math.ceil(rows.length / 8);
    wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(m.label)} يوماً بيوم">
        ${scale.ticks.map((t) => `<line class="${t ? 'gridline' : 'baseline'}" x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"></line>
            <text class="tick" x="${pad.l - 6}" y="${y(t) + 4}" text-anchor="end">${fmt.format(t)}</text>`).join('')}
        ${rows.map((r, i) => (i % every === 0 ? `<text class="tick" x="${x(i)}" y="${H - 6}" text-anchor="middle">${shortDate(r.date)}</text>` : '')).join('')}
        ${rows.map((r, i) => {
        const v = r[teamMetric];
        const h = v ? Math.max(2, (v / scale.max) * ih) : 0;
        const rad = Math.min(4, bw / 2, h);
        return h ? `<path class="t-bar" d="M${x(i) - bw / 2},${pad.t + ih} v${-(h - rad)} q0,${-rad} ${rad},${-rad} h${bw - 2 * rad} q${rad},0 ${rad},${rad} v${h - rad} z"></path>` : '';
    }).join('')}
        ${rows.map((r, i) => `<rect class="t-hit" data-i="${i}" x="${x(i) - step / 2}" y="${pad.t}" width="${step}" height="${ih}" fill="transparent"></rect>`).join('')}
    </svg><div class="tooltip" hidden></div>`;
    const tip = wrap.querySelector('.tooltip');
    wrap.querySelectorAll('.t-hit').forEach((hit) => {
        hit.addEventListener('mousemove', () => {
            const i = Number(hit.dataset.i);
            const r = rows[i];
            tip.hidden = false;
            tip.innerHTML = `<div class="t-value">${teamMetric.endsWith('value') ? fmt2.format(r[teamMetric]) : fmt.format(r[teamMetric])} ${esc(m.unit)}</div><div class="t-label">${esc(m.label)} — ${esc(longDate(r.date))}</div>`;
            tip.style.left = Math.min(Math.max(x(i), 70), W - 70) + 'px';
            tip.style.top = y(r[teamMetric]) + 'px';
        });
        hit.addEventListener('mouseleave', () => { tip.hidden = true; });
    });
}

/* The employees' table as a file for Excel */
function teamCsv() {
    if (!team) return;
    const head = ['الموظف', 'الدور', 'عدد العروض', 'قيمة العروض', 'عروض مقبولة', 'نسبة القبول %', 'عدد الفواتير', 'قيمة الفواتير', 'المحصّل', 'ردود', 'تقارير', 'عملاء تابعهم',
        'إسنادات استلمها', 'متوسط زمن أول رد (ساعة)', 'أعمال منجزة', 'عملاء مفتوحون الآن', 'بحاجة متابعة', 'متأخر +48س', 'أيام النشاط'];
    const rows = team.staff.map((s) => [s.name, s.role_label, s.quote_count, s.quote_value, s.accepted_count, s.win_rate ?? '', s.invoice_count, s.invoice_value, s.collected, s.replies, s.reports,
        s.customers_handled, s.assignments_received, s.response_hours ?? '', s.jobs_done, s.open_customers, s.needs_attention, s.overdue_48h, s.active_days]);
    // A leading apostrophe stops Excel from reading a name that starts with = + - @ as a formula
    const cell = (v) => { const t = String(v); return `"${(/^[=+\-@]/.test(t) && typeof v === 'string' ? "'" + t : t).replace(/"/g, '""')}"`; };
    const csv = '﻿' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `اداء-الموظفين-${team.from}-${team.to}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

$id('teamRange').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]');
    if (!b) return;
    $id('teamRange').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    teamPreset(b.dataset.range);
    loadTeam();
});
for (const id of ['teamFrom', 'teamTo']) {
    $id(id).addEventListener('change', () => {
        $id('teamRange').querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        if ($id('teamFrom').value && $id('teamTo').value) loadTeam();
    });
}
$id('teamEmployee').addEventListener('change', loadTeam);

const switchTabBeforeTeam = window.switchTab;
window.switchTab = function (tabId) {
    switchTabBeforeTeam(tabId);
    if (online && tabId === 'team') loadTeam();
};
let teamResize = null;
window.addEventListener('resize', () => {
    clearTimeout(teamResize);
    teamResize = setTimeout(() => { if (team && team.employee && $id('tab-team').classList.contains('active')) renderTeamDays(); }, 150);
});
