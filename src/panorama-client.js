/* =============================================================
   Panorama's tools for the agent (panorama-commerce, Tool API v1):
   the agent answers questions about cameras, networks and intercoms
   with Panorama's real products and prices.
   - PANORAMA_TOOLS_ENABLED: 0 (default: off, the agent as before),
     shadow (Panorama's reply is written for review only, never sent),
     1 (on). shadow / 1 without its settings act as 0, with an alert.
   - PANORAMA_BASE_URL (no path; /api/internal/v1 is added),
     PANORAMA_API_KEY, PANORAMA_HMAC_SECRET (Panorama's INTERNAL_API_KEY /
     INTERNAL_API_HMAC_SECRET), PANORAMA_TOOL_TIMEOUT_MS (default 8000).
   - Every request signed: Bearer key, X-Timestamp (Unix seconds),
     X-Request-Id (a new UUID), X-Signature: sha256=HMAC("<ts>.<rid>.<body>")
     (a GET signs an empty body).
   - GET /tools: kept 10 minutes; on failure the last good list, else none.
     Only read tools named panorama_* are offered.
   - POST /tools/execute: two retries (0.5 s, 1 s) on a network error, a
     timeout or a status other than 200 — never on 401 (wrong keys: an
     alert). 3 failures in a row stop it for 60 s (an «unavailable» answer
     the agent understands, without a request).
   - Each call is logged in remote_tool_calls (tool, status, time, channel)
     — never its arguments or a phone number. 30 days.
   - Health: GET /healthz every 15 minutes (not in mode 0); two failures in
     a row → an alert, a success → back to normal.
   Secrets only from the environment; never logged or shown.
   ============================================================= */
const crypto = require('node:crypto');
const alerts = require('./alerts');

const LIST_TTL_MS = 10 * 60_000;
const LIST_TIMEOUT_MS = 5_000;
const RETRY_DELAYS_MS = [500, 1000];
const BREAKER_FAILURES = 3;
const BREAKER_MS = 60_000;
const HEALTH_EVERY_MS = 15 * 60_000;
const UNAVAILABLE = { status: 'unavailable', data: null, message_for_agent: 'أسعار بانوراما غير متاحة الآن؛ لا تذكر أي سعر، واعرض تحويل العميل لموظف' };

/* Tests replace the network and the clock */
let fetchImpl = (...a) => fetch(...a);
let now = () => Date.now();
let sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const setFetchForTests = (fn) => { fetchImpl = fn; };
const setClockForTests = (fn) => { now = fn; };
const setSleepForTests = (fn) => { sleep = fn; };

const cleanEnv = (v) => String(v || '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
const config = () => ({
    requested: String(process.env.PANORAMA_TOOLS_ENABLED || '0').trim().toLowerCase(),
    baseUrl: cleanEnv(process.env.PANORAMA_BASE_URL).replace(/\/+$/, ''),
    apiKey: cleanEnv(process.env.PANORAMA_API_KEY),
    secret: cleanEnv(process.env.PANORAMA_HMAC_SECRET),
    timeoutMs: Number(process.env.PANORAMA_TOOL_TIMEOUT_MS) > 0 ? Number(process.env.PANORAMA_TOOL_TIMEOUT_MS) : 8000
});
const missing = (c = config()) => [['PANORAMA_BASE_URL', c.baseUrl], ['PANORAMA_API_KEY', c.apiKey], ['PANORAMA_HMAC_SECRET', c.secret]].filter(([, v]) => !v).map(([k]) => k);

/**
 * The mode in effect: '0' | 'shadow' | '1'. shadow / 1 with a setting missing → '0' (and an alert when a db is given).
 */
function mode(db = null) {
    const c = config();
    const want = c.requested === 'shadow' ? 'shadow' : c.requested === '1' ? '1' : '0';
    if (want === '0') return '0';
    const miss = missing(c);
    if (miss.length) {
        if (db) alerts.fail(db, 'panorama', `PANORAMA_TOOLS_ENABLED=${want} لكن ينقص: ${miss.join('، ')} — الربط معطّل`);
        return '0';
    }
    return want;
}

/* ---------------- Signed requests ---------------- */

function signedHeaders(body, c = config()) {
    const ts = String(Math.floor(now() / 1000));
    const rid = crypto.randomUUID();
    const signature = 'sha256=' + crypto.createHmac('sha256', c.secret).update(`${ts}.${rid}.${body}`).digest('hex');
    return { rid, headers: { Authorization: `Bearer ${c.apiKey}`, 'X-Timestamp': ts, 'X-Request-Id': rid, 'X-Signature': signature } };
}

async function request(method, path, payload, timeoutMs) {
    const c = config();
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const { rid, headers } = signedHeaders(body, c);
    const res = await fetchImpl(`${c.baseUrl}/api/internal/v1${path}`, {
        method,
        headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(timeoutMs)
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data, rid };
}

/* ---------------- The tools Panorama offers ---------------- */

let listCache = { at: 0, tools: null, instructions: '', fetchedAt: null };
const accepted = (t) => t && typeof t.name === 'string' && /^panorama_[a-z0-9_]+$/.test(t.name) && (t.type || t.kind || 'read') === 'read';

/** { tools: [{name, description, input_schema}], instructions } — cached 10 minutes; the last good list on failure */
async function listTools({ fresh = false, db = null } = {}) {
    if (!fresh && listCache.tools && now() - listCache.at < LIST_TTL_MS) return { tools: listCache.tools, instructions: listCache.instructions };
    try {
        const r = await request('GET', '/tools', undefined, LIST_TIMEOUT_MS);
        if (r.status === 401) { if (db) alerts.fail(db, 'panorama', 'مفاتيح بانوراما غير صحيحة (401)'); throw new Error('http_401'); }
        if (r.status !== 200 || !r.data) throw new Error(`http_${r.status}`);
        const raw = Array.isArray(r.data.tools) ? r.data.tools : Array.isArray(r.data.data && r.data.data.tools) ? r.data.data.tools : [];
        const tools = raw.filter(accepted).map((t) => ({
            name: t.name,
            description: String(t.description || '').slice(0, 1000),
            input_schema: t.input_schema || t.parameters || t.schema || { type: 'object', properties: {} }
        }));
        const instructions = String(r.data.instructions_for_agent || (r.data.data && r.data.data.instructions_for_agent) || '').slice(0, 4000);
        listCache = { at: now(), tools, instructions, fetchedAt: new Date(now()).toISOString() };
        return { tools, instructions };
    } catch (err) {
        if (fresh) throw err;
        return listCache.tools ? { tools: listCache.tools, instructions: listCache.instructions } : { tools: [], instructions: '' };
    }
}

/* ---------------- Calling a tool ---------------- */

let breaker = { failures: 0, openUntil: 0 };
const breakerState = () => ({ failures: breaker.failures, open: now() < breaker.openUntil, open_until: breaker.openUntil > now() ? new Date(breaker.openUntil).toISOString() : null });
function failed() {
    breaker.failures += 1;
    if (breaker.failures >= BREAKER_FAILURES) { breaker.openUntil = now() + BREAKER_MS; breaker.failures = 0; }
}

const ready = new WeakSet();
function ensureTables(db) {
    if (ready.has(db)) return;
    ready.add(db);
    db.exec(`CREATE TABLE IF NOT EXISTS remote_tool_calls (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id   TEXT,
        tool         TEXT NOT NULL,
        status       TEXT NOT NULL,
        duration_ms  INTEGER,
        channel      TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS panorama_shadow_replies (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        channel        TEXT,
        business       TEXT,
        customer_text  TEXT,
        actual_reply   TEXT,
        shadow_reply   TEXT,
        tools_used     TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS panorama_routes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        route       TEXT NOT NULL,
        channel     TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
}
const logCall = (db, row) => {
    if (!db) return;
    ensureTables(db);
    db.prepare('INSERT INTO remote_tool_calls (request_id, tool, status, duration_ms, channel) VALUES (?, ?, ?, ?, ?)')
        .run(row.request_id || null, String(row.tool).slice(0, 80), String(row.status).slice(0, 40), row.duration_ms ?? null, row.channel || null);
};

/**
 * Run one of Panorama's tools. context: {channel, conversation_key, customer_phone, customer_verified, customer_consent}.
 * Returns Panorama's answer {status, data, message_for_agent} (as is), or «unavailable».
 */
async function execute(tool, args, context = {}, { db = null } = {}) {
    const started = now();
    if (now() < breaker.openUntil) {
        logCall(db, { tool, status: 'circuit_open', duration_ms: 0, channel: context.channel });
        return UNAVAILABLE;
    }
    const c = config();
    let last = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        if (attempt) await sleep(RETRY_DELAYS_MS[attempt - 1]);
        try {
            const r = await request('POST', '/tools/execute', { tool, arguments: args || {}, context }, c.timeoutMs);
            last = r;
            if (r.status === 401) {
                if (db) alerts.fail(db, 'panorama', 'مفاتيح بانوراما غير صحيحة (401)');
                failed();
                logCall(db, { request_id: r.rid, tool, status: 'http_401', duration_ms: now() - started, channel: context.channel });
                return UNAVAILABLE;
            }
            if (r.status === 200 && r.data && typeof r.data === 'object') {
                breaker.failures = 0;
                if (db) alerts.ok(db, 'panorama');
                logCall(db, { request_id: r.rid, tool, status: String(r.data.status || 'ok'), duration_ms: now() - started, channel: context.channel });
                return { status: r.data.status ?? 'ok', ...(r.data.as_of ? { as_of: r.data.as_of } : {}), data: r.data.data ?? null, message_for_agent: r.data.message_for_agent ?? null };
            }
        } catch (err) {
            last = { status: 0, error: err.name === 'TimeoutError' ? 'timeout' : 'network' };
        }
    }
    failed();
    logCall(db, { request_id: last && last.rid, tool, status: last && last.status ? `http_${last.status}` : (last && last.error) || 'error', duration_ms: now() - started, channel: context.channel });
    return UNAVAILABLE;
}

/* ---------------- Health ---------------- */

let health = { at: null, ok: null, error: null, failures: 0 };
async function checkHealth(db) {
    const c = config();
    try {
        const res = await fetchImpl(`${c.baseUrl}/healthz`, { signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`http_${res.status}`);
        health = { at: new Date(now()).toISOString(), ok: true, error: null, failures: 0 };
        if (db) alerts.ok(db, 'panorama');
    } catch (err) {
        health = { at: new Date(now()).toISOString(), ok: false, error: err.name === 'TimeoutError' ? 'timeout' : err.message, failures: health.failures + 1 };
        if (db && health.failures >= 2) alerts.fail(db, 'panorama', `فحص صحة بانوراما فشل مرتين متتاليتين: ${health.error}`);
    }
    if (db) db.prepare(`INSERT INTO scheduled_runs (name, last_key, at) VALUES ('panorama_health', ?, datetime('now'))
                        ON CONFLICT(name) DO UPDATE SET last_key = excluded.last_key, at = excluded.at`).run(health.ok ? 'ok' : `fail: ${health.error}`);
    return health;
}
function scheduleHealth(db) {
    const run = () => { if (mode(db) !== '0') checkHealth(db).catch(() => {}); };
    setTimeout(run, 60_000).unref();
    setInterval(run, HEALTH_EVERY_MS).unref();
}

/* ---------------- The office's view (owner only) ---------------- */

function status(db) {
    ensureTables(db);
    const c = config();
    const last = db.prepare("SELECT last_key, at FROM scheduled_runs WHERE name = 'panorama_health'").get();
    const routes = Object.fromEntries(db.prepare("SELECT route, COUNT(*) AS n FROM panorama_routes WHERE created_at >= datetime('now', '-7 days') GROUP BY route").all().map((r) => [r.route, r.n]));
    return {
        requested: c.requested, mode: mode(), base_url: c.baseUrl || null,
        settings: { PANORAMA_BASE_URL: Boolean(c.baseUrl), PANORAMA_API_KEY: Boolean(c.apiKey), PANORAMA_HMAC_SECRET: Boolean(c.secret), PANORAMA_TOOL_TIMEOUT_MS: c.timeoutMs },
        breaker: breakerState(),
        health: health.at ? health : last ? { at: last.at, ok: last.last_key === 'ok', error: last.last_key === 'ok' ? null : last.last_key } : null,
        tools_cached: listCache.tools ? { count: listCache.tools.length, names: listCache.tools.map((t) => t.name), at: listCache.fetchedAt } : null,
        routes_7d: { RADMA: routes.RADMA || 0, PANORAMA: routes.PANORAMA || 0, MIXED: routes.MIXED || 0, NONE: routes.NONE || 0 },
        calls: db.prepare('SELECT request_id, tool, status, duration_ms, channel, created_at FROM remote_tool_calls ORDER BY id DESC LIMIT 50').all(),
        shadow: db.prepare('SELECT * FROM panorama_shadow_replies ORDER BY id DESC LIMIT 100').all()
    };
}

const logRoute = (db, route, channel) => { ensureTables(db); db.prepare('INSERT INTO panorama_routes (route, channel) VALUES (?, ?)').run(route, channel || null); };
const saveShadow = (db, row) => {
    ensureTables(db);
    db.prepare('INSERT INTO panorama_shadow_replies (channel, business, customer_text, actual_reply, shadow_reply, tools_used) VALUES (?, ?, ?, ?, ?, ?)')
        .run(row.channel || null, row.business || null, String(row.customer_text || '').slice(0, 2000), String(row.actual_reply || '').slice(0, 4000),
            String(row.shadow_reply || '').slice(0, 4000), JSON.stringify(row.tools_used || []));
};

function prune(db) {
    ensureTables(db);
    return ['remote_tool_calls', 'panorama_shadow_replies', 'panorama_routes']
        .reduce((n, t) => n + Number(db.prepare(`DELETE FROM ${t} WHERE created_at < datetime('now', '-30 days')`).run().changes), 0);
}

const _reset = () => { listCache = { at: 0, tools: null, instructions: '', fetchedAt: null }; breaker = { failures: 0, openUntil: 0 }; health = { at: null, ok: null, error: null, failures: 0 }; };

module.exports = {
    mode, config, missing, listTools, execute, checkHealth, scheduleHealth, status, ensureTables, logRoute, saveShadow, prune, signedHeaders,
    UNAVAILABLE, BREAKER_MS, setFetchForTests, setClockForTests, setSleepForTests, _reset
};
