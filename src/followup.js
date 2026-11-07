/* =============================================================
   Follow-up reminders and the weekly report (by email).
   - Every morning (8:00 Muscat time) each employee with an email gets
     the list of their customers that need following up: a follow-up
     date that is today or passed, or an open customer nobody followed
     up for N days (follow_up_stale_days). Customers with no employee —
     or an employee without an email — go to the managers.
   - Every Sunday morning the managers get the week's report: new
     customers, quotes, accepted, the acceptance rate, and each
     employee's follow-up work.
   - Sent once per day / week (kept in scheduled_runs, so a restart does
     not send again). Switched off with the follow_up_emails setting.
   ============================================================= */
const { getSettings } = require('./db');
const leads = require('./leads');
const mailer = require('./mailer');
const alerts = require('./alerts');

const SEND_HOUR = 8; // Muscat time
const MAX_LINES = 40;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const localNow = (nowMs = Date.now()) => new Date(nowMs + 4 * 3600_000); // read with getUTC*

const ownerEmails = () => String(process.env.ALERT_EMAIL_TO || process.env.BACKUP_EMAIL_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
const activeAccounts = (db) => db.prepare('SELECT * FROM staff_users WHERE active = 1').all();
const canFollow = (u) => u.role === 'manager' || JSON.parse(u.permissions_json || '[]').includes('leads');

function panelLink(db) {
    const base = String(getSettings(db).public_base_url || '').trim().replace(/\/+$/, '');
    return /^https?:\/\//.test(base) ? `${base}/admin` : null;
}

const daysText = (n) => (n === 1 ? 'يوم واحد' : n === 2 ? 'يومين' : n <= 10 ? `${n} أيام` : `${n} يوماً`);

function reasonText(a) {
    if (a.reason === 'due') return '📅 موعد المتابعة اليوم';
    if (a.reason === 'overdue') return `⏰ موعد المتابعة فات (${a.date})`;
    return `💤 بلا متابعة منذ ${daysText(a.days)}`;
}

function itemLines(list, { showEmployee = false } = {}) {
    const order = { overdue: 0, due: 1, stale: 2 };
    const sorted = [...list].sort((a, b) => order[a.attention.reason] - order[b.attention.reason]);
    const lines = sorted.slice(0, MAX_LINES).map((l, i) => {
        const who = l.name || (l.phone ? '+' + l.phone : 'زائر الموقع');
        const phone = l.name && l.phone ? ` (+${l.phone})` : '';
        const emp = showEmployee ? ` — ${l.assigned_to || 'غير مُسند'}` : '';
        return `${i + 1}) ${who}${phone} — ${leads.STATUSES[l.status] || l.status}${emp}\n   ${reasonText(l.attention)}`;
    });
    if (sorted.length > MAX_LINES) lines.push(`… و${sorted.length - MAX_LINES} عميلاً آخر في اللوحة`);
    return lines;
}

/* Who gets which customers today: [{ to, name, items, unassigned }] (nothing to send → not listed) */
function buildDigests(db, { today = leads.localToday() } = {}) {
    const settings = getSettings(db);
    const due = leads.needingAttention(db, { staleDays: settings.follow_up_stale_days, today });
    const accounts = activeAccounts(db).filter(canFollow);
    const reachable = new Map(accounts.filter((u) => u.email).map((u) => [u.display_name, u]));
    const managers = accounts.filter((u) => u.role === 'manager' && u.email);
    const digests = [];
    for (const u of reachable.values()) {
        const items = due.filter((l) => l.assigned_to === u.display_name);
        const others = u.role === 'manager' ? due.filter((l) => !l.assigned_to || !reachable.has(l.assigned_to)) : [];
        if (items.length || others.length) digests.push({ to: [u.email], name: u.display_name, items, others });
    }
    // No manager account with an email: customers of nobody go to the owner's address
    if (!managers.length) {
        const others = due.filter((l) => !l.assigned_to || !reachable.has(l.assigned_to));
        if (others.length && ownerEmails().length) digests.push({ to: ownerEmails(), name: 'المدير العام', items: [], others });
    }
    return digests;
}

function digestText(db, d) {
    const link = panelLink(db);
    const parts = [`مرحباً ${d.name}،`, ''];
    if (d.items.length) parts.push(`عملاؤك الذين يحتاجون متابعة اليوم (${d.items.length}):`, '', ...itemLines(d.items), '');
    if (d.others.length) parts.push(`عملاء بلا موظف متابع، أو موظفهم بلا بريد (${d.others.length}):`, '', ...itemLines(d.others, { showEmployee: true }), '');
    parts.push('اكتب تقرير المتابعة أو حدّد موعداً جديداً، فيخرج العميل من القائمة.');
    if (link) parts.push(`افتح «متابعة العملاء» ← «بحاجة متابعة»: ${link}`);
    return parts.join('\n');
}

async function sendDaily(db) {
    const company = getSettings(db).company_name || 'نظام التسعير';
    const digests = buildDigests(db);
    let sent = 0;
    for (const d of digests) {
        try {
            await mailer.send({
                to: d.to.join(', '),
                subject: `🔔 متابعة العملاء اليوم: ${d.items.length + d.others.length} — ${company}`,
                text: digestText(db, d)
            });
            sent++;
            alerts.ok(db, 'mail');
        } catch (err) {
            console.error('[follow-up] daily', err.message);
            alerts.fail(db, 'mail', err);
        }
    }
    return { sent, total: digests.length };
}

/* ------------------------------ Weekly report ------------------------------ */

function buildWeekly(db, { today = leads.localToday() } = {}) {
    const end = today;                                           // up to and including today (Muscat)
    const start = new Date(Date.parse(today + 'T00:00:00Z') - 6 * 86400000).toISOString().slice(0, 10);
    // Stored times are UTC: Muscat day D runs from (D-1) 20:00 to D 20:00 UTC
    const fromUtc = new Date(Date.parse(start + 'T00:00:00Z') - 4 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
    const toUtc = new Date(Date.parse(end + 'T00:00:00Z') + 20 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
    const between = 'BETWEEN ? AND ?';
    const quotes = db.prepare(`SELECT status, total FROM quotes WHERE created_at ${between}`).all(fromUtc, toUtc);
    const won = quotes.filter((q) => q.status === 'accepted' || q.status === 'done');
    const sum = (list) => round2(list.reduce((s, q) => s + Number(q.total || 0), 0));
    const newLeads = db.prepare(`SELECT channel, COUNT(*) AS n FROM leads WHERE created_at ${between} GROUP BY channel`).all(fromUtc, toUtc);
    const closed = (label) => db.prepare(`SELECT COUNT(DISTINCT lead_id) AS n FROM lead_messages WHERE role = 'system' AND text LIKE ? AND created_at ${between}`)
        .get(`%← ${label}%`, fromUtc, toUtc).n;
    const settings = getSettings(db);
    const attention = leads.needingAttention(db, { staleDays: settings.follow_up_stale_days, today });
    const open = db.prepare(`SELECT assigned_to FROM leads WHERE status IN (${leads.OPEN_STATUSES.map(() => '?').join(',')})`).all(...leads.OPEN_STATUSES);

    // Each employee: accounts that follow customers, plus anyone named on a customer, report or reply
    const names = new Set([
        ...activeAccounts(db).filter(canFollow).map((u) => u.display_name),
        ...open.map((l) => l.assigned_to).filter(Boolean),
        ...db.prepare(`SELECT DISTINCT author FROM lead_notes WHERE author IS NOT NULL AND author != 'النظام' AND created_at ${between}`).all(fromUtc, toUtc).map((r) => r.author)
    ]);
    const staff = [...names].map((name) => ({
        name,
        reports: db.prepare(`SELECT COUNT(*) AS n FROM lead_notes WHERE author = ? AND kind != 'handover' AND created_at ${between}`).get(name, fromUtc, toUtc).n,
        replies: db.prepare(`SELECT COUNT(*) AS n FROM lead_messages WHERE role = 'staff' AND author = ? AND created_at ${between}`).get(name, fromUtc, toUtc).n,
        open: open.filter((l) => l.assigned_to === name).length,
        needs_attention: attention.filter((l) => l.assigned_to === name).length
    })).sort((a, b) => (b.reports + b.replies) - (a.reports + a.replies) || b.open - a.open);

    return {
        from: start, to: end,
        new_customers: newLeads.reduce((s, r) => s + r.n, 0),
        new_by_channel: Object.fromEntries(newLeads.map((r) => [leads.CHANNELS[r.channel] || r.channel, r.n])),
        quotes: { count: quotes.length, value: sum(quotes), accepted: won.length, accepted_value: sum(won),
            rejected: quotes.filter((q) => q.status === 'rejected').length,
            rate: quotes.length ? Math.round((won.length / quotes.length) * 1000) / 10 : 0 },
        leads_won: closed(leads.STATUSES.won), leads_lost: closed(leads.STATUSES.lost),
        needs_attention: attention.length,
        unassigned_open: open.filter((l) => !l.assigned_to).length,
        staff
    };
}

function weeklyText(db, r) {
    const link = panelLink(db);
    const channels = Object.entries(r.new_by_channel).map(([k, n]) => `${k}: ${n}`).join('، ');
    const lines = [
        `تقرير الأسبوع من ${r.from} إلى ${r.to}`,
        '',
        `👥 عملاء جدد: ${r.new_customers}${channels ? ` (${channels})` : ''}`,
        `📄 عروض الأسعار: ${r.quotes.count} بقيمة ${r.quotes.value.toFixed(2)} ر.ع`,
        `✅ المقبولة: ${r.quotes.accepted} بقيمة ${r.quotes.accepted_value.toFixed(2)} ر.ع — نسبة القبول ${r.quotes.rate}%`,
        `❌ المرفوضة: ${r.quotes.rejected}`,
        `🏁 عملاء أُغلقوا هذا الأسبوع: تم البيع ${r.leads_won}، لم يتم ${r.leads_lost}`,
        '',
        `🔔 بحاجة متابعة الآن: ${r.needs_attention}${r.unassigned_open ? ` — وعملاء مفتوحون بلا موظف: ${r.unassigned_open}` : ''}`,
        '',
        'أداء الموظفين هذا الأسبوع:'
    ];
    if (!r.staff.length) lines.push('— لا يوجد موظفون للمتابعة بعد');
    for (const s of r.staff) {
        lines.push(`• ${s.name}: ${s.reports} تقرير، ${s.replies} رد على العملاء — لديه ${s.open} عميل مفتوح، منهم ${s.needs_attention} بحاجة متابعة`);
    }
    if (link) lines.push('', `لوحة الإدارة: ${link}`);
    return lines.join('\n');
}

const weeklyRecipients = (db) => [...new Set([
    ...activeAccounts(db).filter((u) => u.role === 'manager' && u.email).map((u) => u.email),
    ...ownerEmails()
])];

async function sendWeekly(db) {
    const to = weeklyRecipients(db);
    if (!to.length) return { sent: 0, total: 0 };
    const r = buildWeekly(db);
    const company = getSettings(db).company_name || 'نظام التسعير';
    try {
        await mailer.send({ to: to.join(', '), subject: `📊 تقرير الأسبوع (${r.from} — ${r.to}) — ${company}`, text: weeklyText(db, r) });
        alerts.ok(db, 'mail');
        return { sent: 1, total: 1, to };
    } catch (err) {
        console.error('[follow-up] weekly', err.message);
        alerts.fail(db, 'mail', err);
        return { sent: 0, total: 1, error: err.message };
    }
}

/* ------------------------------ Schedule ------------------------------ */

const lastRun = (db, name) => (db.prepare('SELECT last_key FROM scheduled_runs WHERE name = ?').get(name) || {}).last_key || null;
const setRun = (db, name, key) => db.prepare(`INSERT INTO scheduled_runs (name, last_key, at) VALUES (?, ?, datetime('now'))
                                              ON CONFLICT(name) DO UPDATE SET last_key = excluded.last_key, at = excluded.at`).run(name, key);

/* Runs what is due now; returns what it sent (exported for tests) */
async function tick(db, nowMs = Date.now()) {
    const local = localNow(nowMs);
    const today = local.toISOString().slice(0, 10);
    const done = {};
    if (!getSettings(db).follow_up_emails || !mailer.isConfigured() || local.getUTCHours() < SEND_HOUR) return done;
    if (lastRun(db, 'follow_up_daily') !== today) {
        setRun(db, 'follow_up_daily', today); // before sending: a failure is not retried every hour
        done.daily = await sendDaily(db);
    }
    if (local.getUTCDay() === 0 && lastRun(db, 'follow_up_weekly') !== today) { // Sunday
        setRun(db, 'follow_up_weekly', today);
        done.weekly = await sendWeekly(db);
    }
    return done;
}

function schedule(db) {
    const run = () => tick(db).catch((err) => console.error('[follow-up]', err.message));
    setTimeout(run, 90_000).unref();
    setInterval(run, 15 * 60_000).unref();
}

module.exports = { buildDigests, digestText, sendDaily, buildWeekly, weeklyText, sendWeekly, weeklyRecipients, tick, schedule, SEND_HOUR };
