/* =============================================================
   Outgoing webhooks — notify n8n / Make / Zapier / any HTTP endpoint
   ============================================================= */
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { resolvePublicUrl } = require('./safe-url');
const alerts = require('./alerts');

const EVENTS = [
    'quote.created',
    'quote.status_changed',
    'invoice.created',
    'invoice.cancelled',
    'payment.created',
    'work_order.created',
    'work_order.status_changed',
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

/* POST over a pinned address. Native fetch resolves the hostname again after
   safe-url.js checked it, leaving a DNS-rebinding window. The custom lookup
   callback below always returns the address that passed the public-address
   check, while HTTPS still uses the original hostname for SNI/certificates. */
function postPinned({ url, host, addresses }, headers, body) {
    const address = addresses[0];
    if (!address) throw new Error('الرابط لا يملك عنواناً صالحاً');
    const transport = url.protocol === 'https:' ? https : http;
    const requestHeaders = { ...headers, 'Content-Length': Buffer.byteLength(body) };
    return new Promise((resolve, reject) => {
        const req = transport.request({
            protocol: url.protocol,
            hostname: host,
            port: url.port || undefined,
            path: url.pathname + url.search,
            method: 'POST',
            headers: requestHeaders,
            lookup: (_hostname, _options, callback) => callback(null, address, net.isIP(address)),
            ...(url.protocol === 'https:' && !net.isIP(host) ? { servername: host } : {})
        }, (res) => {
            res.resume();
            res.once('end', () => {
                const status = res.statusCode || 0;
                resolve({ status, ok: status >= 200 && status < 300 });
            });
        });
        req.setTimeout(10_000, () => req.destroy(new Error('انتهت مهلة Webhook')));
        req.once('error', reject);
        req.end(body);
    });
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
        const checked = await resolvePublicUrl(hook.url);
        const res = await postPinned(checked, headers, body);
        statusCode = res.status;
        if (res.status >= 300 && res.status < 400) error = `HTTP ${res.status}: إعادة توجيه — لا تُتبع لأسباب أمنية، استخدم الرابط النهائي`;
        else if (!res.ok) error = `HTTP ${res.status}`;
    } catch (err) {
        error = err.message;
    }
    db.prepare(`INSERT INTO webhook_deliveries (webhook_id, event, status_code, ok, error)
                VALUES (?, ?, ?, ?, ?)`)
        .run(hook.id, event, statusCode, error ? 0 : 1, error);
    if (error) alerts.fail(db, `webhook:${hook.id}`, error, { label: hook.name || hook.url });
    else alerts.ok(db, `webhook:${hook.id}`);
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
