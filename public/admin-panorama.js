/* «بانوراما — أدوات الوكيل» (the «الربط» tab, managers only): the mode, which settings are set (never their values),
   the circuit breaker, the health check, «اختبار الاتصال», the last calls, the routing of 7 days and the shadow replies. */
const PANORAMA_MODES = { 0: 'معطّل', shadow: 'تجريبي (shadow)', 1: 'مفعّل' };

async function loadPanorama() {
    let s;
    try { s = await api('GET', '/api/admin/panorama'); } catch (err) { setStatus('panoramaTestStatus', err.message, 'err'); return; }
    const off = s.requested !== '0' && s.mode === '0';
    $id('panoramaMode').textContent = `— ${PANORAMA_MODES[s.mode] || s.mode}${off ? ` (المطلوب ${s.requested} لكن الإعدادات ناقصة)` : ''}`;
    const set = Object.entries(s.settings).map(([k, v]) => `${k}: ${typeof v === 'boolean' ? (v ? '✓ مضبوط' : '✗ فارغ') : v}`).join('\n');
    const h = s.health;
    $id('panoramaStatus').textContent = [
        set,
        `قاطع الدائرة: ${s.breaker.open ? `⛔ موقوف حتى ${muscatTime(String(s.breaker.open_until).replace('T', ' ').slice(0, 19))}` : '✓ يعمل'}`,
        `آخر فحص صحة: ${h ? `${h.ok ? '✓' : '✗'} ${muscatTime(String(h.at).replace('T', ' ').slice(0, 19))}${h.error ? ` — ${h.error}` : ''}` : 'لم يُفحص بعد'}`,
        `الأدوات المحفوظة: ${s.tools_cached ? `${s.tools_cached.count} (قراءة ${s.tools_cached.read} · كتابة ${s.tools_cached.write}) — ${s.tools_cached.names.join('، ')}` : '—'}`,
        `التوجيه (آخر 7 أيام): ردما ${s.routes_7d.RADMA} · بانوراما ${s.routes_7d.PANORAMA} · مختلط ${s.routes_7d.MIXED}`
    ].join('\n');
    $id('panoramaRecipients').value = s.recipients || '';
    $id('panoramaCalls').innerHTML = s.calls.length ? s.calls.map((c) => `<tr>
        <td data-label="الوقت"><small dir="ltr">${esc(muscatTime(c.created_at))}</small></td><td data-label="الأداة" dir="ltr">${esc(c.tool)}${c.kind === 'write' ? ' ✍️' : ''}</td>
        <td data-label="النتيجة">${esc(c.status)}</td><td data-label="المدة">${c.duration_ms == null ? '' : `${Number(c.duration_ms)} ms`}</td><td data-label="القناة">${esc(c.channel || '')}</td></tr>`).join('')
        : '<tr><td colspan="5" class="empty">لا توجد استدعاءات بعد</td></tr>';
    $id('panoramaShadow').innerHTML = s.shadow.length ? s.shadow.map((r) => {
        let tools = [];
        try { tools = JSON.parse(r.tools_used || '[]'); } catch { tools = []; }
        return `<tr><td data-label="الوقت"><small dir="ltr">${esc(muscatTime(r.created_at))}</small></td>
            <td data-label="رسالة العميل" style="white-space:pre-wrap">${esc(r.customer_text)}</td>
            <td data-label="الرد الفعلي" style="white-space:pre-wrap">${esc(r.actual_reply)}</td>
            <td data-label="الرد المقترح" style="white-space:pre-wrap">${esc(r.shadow_reply)}</td>
            <td data-label="الأدوات" dir="ltr"><small>${esc(tools.join(', '))}</small></td></tr>`;
    }).join('') : '<tr><td colspan="5" class="empty">لا توجد ردود تجريبية</td></tr>';
}

async function testPanorama() {
    setStatus('panoramaTestStatus', 'جاري الاختبار...');
    try {
        const r = await api('POST', '/api/admin/panorama/test');
        setStatus('panoramaTestStatus', r.ok ? `✓ متصل — ${r.count} أداة (قراءة ${r.read} · كتابة ${r.write}): ${r.names.join('، ')}` : `✗ ${r.error}`, r.ok ? 'ok' : 'err');
        loadPanorama();
    } catch (err) { setStatus('panoramaTestStatus', err.message, 'err'); }
}

async function savePanoramaRecipients() {
    try {
        await api('PUT', '/api/admin/settings', { panorama_recipients: $id('panoramaRecipients').value.trim() });
        setStatus('panoramaTestStatus', 'تم الحفظ', 'ok');
    } catch (err) { setStatus('panoramaTestStatus', err.message, 'err'); }
}
