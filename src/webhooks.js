/* =============================================================
   Outgoing webhooks — notify n8n / Make / Zapier / any HTTP endpoint
   ============================================================= */
const crypto = require('node:crypto');
const { assertPublicUrl } = require('./safe-url');

const EVENTS = [
    'quote.created',
    'quote.status_changed',
    'product.created',
    'product.updated',
    'product.deleted',
    'purchase.created',
    'settings.updated'
];

function sign(secret, body) {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function subscribed(hook, event) {
    const events = hook.events.split(',').map((e) => e.trim());
    return events.includes('*') || events.includes(event);
}

async function deliver(db, hook, event, body) {
    const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'aluminum-pricing-webhooks/1.0',
        'X-Aluminum-Event': event
    };
    if (hook.secret) headers['X-Aluminum-Signature'] = sign(hook.secret, body);

    let statusCode = null;
    let error = null;
    try {
        // Re-checked at every delivery (a domain can be re-pointed to an internal address after it was saved)
        await assertPublicUrl(hook.url);
        const res = await fetch(hook.url, {
            method: 'POST',
            headers,
            body,
            redirect: 'manual', // a redirect could lead to an internal address: never followed
            signal: AbortSignal.timeout(10_000)
        });
        statusCode = res.status;
        if (res.status >= 300 && res.status < 400) error = `HTTP ${res.status}: إعادة توجيه — لا تُتبع لأسباب أمنية، استخدم الرابط النهائي`;
        else if (!res.ok) error = `HTTP ${res.status}`;
    } catch (err) {
        error = err.message;
    }
    db.prepare(`INSERT INTO webhook_deliveries (webhook_id, event, status_code, ok, error)
                VALUES (?, ?, ?, ?, ?)`)
        .run(hook.id, event, statusCode, error ? 0 : 1, error);
    return { ok: !error, status_code: statusCode, error };
}

/* Fire-and-forget: never blocks or fails the API request that caused it */
function emit(db, event, data, onlyHook = null) {
    const payload = JSON.stringify({
        id: crypto.randomUUID(),
        event,
        created_at: new Date().toISOString(),
        data
    });
    const hooks = onlyHook
        ? [onlyHook]
        : db.prepare('SELECT * FROM webhooks WHERE active = 1').all().filter((h) => subscribed(h, event));
    return Promise.all(hooks.map((h) => deliver(db, h, event, payload)));
}

module.exports = { EVENTS, emit, sign };
