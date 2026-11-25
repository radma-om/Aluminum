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
    'invoice.updated',
    'payment.created',
    'work_order.created',
    'work_order.status_changed',
    'product.created',
    'product.updated',
    'product.deleted',
    'purchase.created',
    'settings.updated',
    // For another system (panorama-commerce): registered now, sent by a later change (the agent's link)
    'lead.message',
    'handoff.requested'
];

/* Events sent again after a failed delivery (after 1, then 5, then 15 minutes, the same payload with the same id);
   every other event is tried once, as before */
const RETRY_EVENTS = ['lead.message', 'handoff.requested'];
const RETRY_DELAYS_MIN = [1, 5, 15];
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

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
    return Promise.all(hooks.map(async (h) => {
        const r = await deliver(db, h, event, payload);
        // A failed delivery of an event that matters to another system waits for its next try (kept in the database,
        // so a restart does not lose it)
        if (!r.ok && RETRY_EVENTS.includes(event)) {
            db.prepare('INSERT INTO webhook_retries (webhook_id, event, payload, attempt, next_at, last_error) VALUES (?, ?, ?, 0, ?, ?)')
                .run(h.id, event, payload, sqlTime(Date.now() + RETRY_DELAYS_MIN[0] * 60_000), String(r.error || '').slice(0, 300));
        }
        return r;
    }));
}

/**
 * The retries that are due: each sent again with its saved payload. Delivered → removed; failed → the next
 * delay, or (after the third retry) given up: next_at NULL and an alert. Returns { sent, failed, gave_up }.
 */
let retrying = false;
async function processRetries(db, nowMs = Date.now()) {
    if (retrying) return { sent: 0, failed: 0, gave_up: 0 };
    retrying = true;
    const out = { sent: 0, failed: 0, gave_up: 0 };
    try {
        const due = db.prepare('SELECT * FROM webhook_retries WHERE next_at IS NOT NULL AND next_at <= ? ORDER BY id LIMIT 50').all(sqlTime(nowMs));
        for (const row of due) {
            const hook = db.prepare('SELECT * FROM webhooks WHERE id = ? AND active = 1').get(row.webhook_id);
            if (!hook) { db.prepare('DELETE FROM webhook_retries WHERE id = ?').run(row.id); continue; } // removed or switched off
            const r = await deliver(db, hook, row.event, row.payload);
            const attempt = row.attempt + 1;
            if (r.ok) {
                db.prepare('DELETE FROM webhook_retries WHERE id = ?').run(row.id);
                out.sent++;
            } else if (attempt < RETRY_DELAYS_MIN.length) {
                db.prepare('UPDATE webhook_retries SET attempt = ?, next_at = ?, last_error = ? WHERE id = ?')
                    .run(attempt, sqlTime(nowMs + RETRY_DELAYS_MIN[attempt] * 60_000), String(r.error || '').slice(0, 300), row.id);
                out.failed++;
            } else {
                db.prepare('UPDATE webhook_retries SET attempt = ?, next_at = NULL, last_error = ? WHERE id = ?')
                    .run(attempt, String(r.error || '').slice(0, 300), row.id);
                alerts.fail(db, `webhook:${hook.id}`, `${row.event}: لم يصل بعد ${attempt} محاولات إعادة — ${r.error}`, { label: hook.name || hook.url });
                out.gave_up++;
            }
        }
    } finally {
        retrying = false;
    }
    return out;
}

/* Every minute, in the running app (the state is in the table: a restart carries on) */
function scheduleRetries(db) {
    const run = () => processRetries(db).catch((err) => console.error('[webhooks] retry', err.message));
    setTimeout(run, 30_000).unref();
    setInterval(run, 60_000).unref();
}

module.exports = { EVENTS, RETRY_EVENTS, RETRY_DELAYS_MIN, emit, sign, processRetries, scheduleRetries };
