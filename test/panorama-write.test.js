/* Panorama's write tools (a request for installation, a quote) with the customer's consent: without
   PANORAMA_WRITE_API_KEY nothing changes; with it, a write tool goes with the write key and an Idempotency-Key that its
   one retry (network / timeout only) keeps; a read tool as before; consent only with customer_confirmed: true; only on
   WhatsApp with the customer's number; never sent in shadow. No real network: Panorama and the AI are fakes. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { openDatabase } = require('../src/db');
const agent = require('../src/agent');
const panorama = require('../src/panorama-client');

const READ_KEY = 'r'.repeat(64);
const WRITE_KEY = 'w'.repeat(64);
const SECRET = 's'.repeat(64);
const ENV = { PANORAMA_TOOLS_ENABLED: '1', PANORAMA_BASE_URL: 'https://commerce.example.test', PANORAMA_API_KEY: READ_KEY, PANORAMA_HMAC_SECRET: SECRET };
process.env.AI_PROVIDER = 'anthropic';
process.env.ANTHROPIC_API_KEY = 'test-not-a-real-key';
panorama.setSleepForTests(async () => {});

const TOOLS = [
    { name: 'panorama_search_products', type: 'read', description: 'بحث', input_schema: { type: 'object', properties: { query: { type: 'string' } } } },
    { name: 'panorama_create_quote', type: 'write', description: 'عرض سعر', input_schema: { type: 'object', properties: { items: { type: 'array' }, customer_confirmed: { type: 'boolean' } } } },
    { name: 'panorama_request_installation', type: 'write', description: 'طلب تركيب', input_schema: { type: 'object', properties: { customer_confirmed: { type: 'boolean' } } } }
];
/* Panorama: write tools listed only to the write key; a write tool executed only with it */
function fakePanorama({ onExecute = null } = {}) {
    const seen = [];
    const fn = async (url, opts = {}) => {
        const u = new URL(url);
        const h = opts.headers || {};
        const body = opts.body || '';
        seen.push({ path: u.pathname, headers: h, body });
        const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${h['X-Timestamp']}.${h['X-Request-Id']}.${body}`).digest('hex');
        const key = String(h.Authorization || '').replace(/^Bearer /, '');
        if (h['X-Signature'] !== expected || ![READ_KEY, WRITE_KEY].includes(key)) return Response.json({ status: 'forbidden' }, { status: 401 });
        if (u.pathname.endsWith('/tools')) return Response.json({ tools: key === WRITE_KEY ? TOOLS : TOOLS.filter((x) => x.type === 'read') });
        const b = JSON.parse(body);
        if (onExecute) { const r = await onExecute(b, h, seen.length); if (r) return r; }
        if (TOOLS.find((x) => x.name === b.tool).type === 'write' && key !== WRITE_KEY) return Response.json({ status: 'forbidden', data: null }, { status: 200 });
        return Response.json({ status: 'ok', data: { number: 'PQ-2026-0001', tool: b.tool }, message_for_agent: 'أرسل رابط العرض للعميل' });
    };
    fn.seen = seen;
    return fn;
}
function withEnv(t, env) {
    Object.assign(process.env, env);
    t.after(() => { for (const k of [...Object.keys(env), 'PANORAMA_WRITE_API_KEY']) delete process.env[k]; panorama._reset(); panorama.setFetchForTests((...a) => fetch(...a)); });
}
function fakeClaude(script) {
    const calls = [];
    let i = 0;
    return { calls, beta: { messages: { create: async (params) => {
        calls.push(structuredClone({ tools: params.tools, system: params.system, messages: params.messages }));
        const step = typeof script === 'function' ? script(params, i) : script[Math.min(i, script.length - 1)];
        i += 1;
        return step;
    } } } };
}
const textReply = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const toolCall = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu1', name, input }] });
const names = (set) => set.tools.map((x) => x.name);

test('without PANORAMA_WRITE_API_KEY: as before — read key, no write tools, no Idempotency-Key', async (t) => {
    withEnv(t, ENV);
    const net = fakePanorama();
    panorama.setFetchForTests(net);
    const set = await agent.toolsetFor('PANORAMA', null, { channel: 'mazbot', phone: '96891111111' });
    assert.deepEqual(names(set), ['request_human', 'panorama_search_products']);
    assert.doesNotMatch(set.system({}, null), /أدوات التسجيل/);
    assert.equal(net.seen[0].headers.Authorization, `Bearer ${READ_KEY}`);
    await panorama.execute('panorama_search_products', { query: 'كاميرا' }, { channel: 'mazbot' });
    const exec = net.seen.at(-1);
    assert.equal(exec.headers.Authorization, `Bearer ${READ_KEY}`);
    assert.ok(!('Idempotency-Key' in exec.headers));
    assert.equal(panorama.status(openDatabase(':memory:')).settings.PANORAMA_WRITE_API_KEY, false);
});

test('with the write key: /tools and write tools with it and an Idempotency-Key; read tools with the read key', async (t) => {
    withEnv(t, { ...ENV, PANORAMA_WRITE_API_KEY: WRITE_KEY });
    const net = fakePanorama();
    panorama.setFetchForTests(net);
    const set = await agent.toolsetFor('PANORAMA', null, { channel: 'mazbot', phone: '96891111111' });
    assert.deepEqual(names(set), ['request_human', 'panorama_search_products', 'panorama_create_quote', 'panorama_request_installation']);
    assert.match(set.system({}, null), /أدوات التسجيل \(طلب تركيب، عرض سعر\)/);
    assert.equal(net.seen[0].headers.Authorization, `Bearer ${WRITE_KEY}`, '/tools asked with the write key');

    const w = await panorama.execute('panorama_create_quote', { items: [{ sku: 'DS-2CD1043G2-LIU', qty: 8 }], customer_confirmed: true }, { channel: 'mazbot', customer_phone: '96891111111' });
    assert.deepEqual([w.status, w.data.number], ['ok', 'PQ-2026-0001']);
    const wr = net.seen.at(-1);
    assert.equal(wr.headers.Authorization, `Bearer ${WRITE_KEY}`);
    assert.match(wr.headers['Idempotency-Key'], /^[0-9a-f-]{36}$/);
    await panorama.execute('panorama_search_products', { query: 'x' }, { channel: 'mazbot' });
    const rd = net.seen.at(-1);
    assert.equal(rd.headers.Authorization, `Bearer ${READ_KEY}`);
    assert.ok(!('Idempotency-Key' in rd.headers));
    // The log: kind, no arguments
    const db = openDatabase(':memory:');
    await panorama.execute('panorama_request_installation', { customer_confirmed: true }, { channel: 'mazbot' }, { db });
    assert.deepEqual({ ...db.prepare('SELECT tool, kind, status FROM remote_tool_calls').get() }, { tool: 'panorama_request_installation', kind: 'write', status: 'ok' });
    const s = panorama.status(db);
    assert.equal(s.settings.PANORAMA_WRITE_API_KEY, true);
    assert.deepEqual([s.tools_cached.read, s.tools_cached.write], [1, 2]);
});

test('a write retried after a timeout keeps its Idempotency-Key with a new X-Request-Id; never after an HTTP answer', async (t) => {
    withEnv(t, { ...ENV, PANORAMA_WRITE_API_KEY: WRITE_KEY });
    let calls = 0;
    const net = fakePanorama();
    panorama.setFetchForTests(async (url, opts) => {
        if (String(url).endsWith('/tools/execute') && ++calls === 1) {
            net.seen.push({ path: 'timeout', headers: opts.headers, body: opts.body });
            throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
        }
        return net(url, opts);
    });
    await panorama.listTools();
    const out = await panorama.execute('panorama_create_quote', { customer_confirmed: true }, { channel: 'mazbot' });
    assert.equal(out.status, 'ok');
    const [first, second] = net.seen.filter((x) => x.path === 'timeout' || x.path.endsWith('/tools/execute'));
    assert.equal(first.headers['Idempotency-Key'], second.headers['Idempotency-Key'], 'same Idempotency-Key');
    assert.notEqual(first.headers['X-Request-Id'], second.headers['X-Request-Id'], 'a new request id');

    // An HTTP answer (500): sent once, never again
    panorama._reset();
    const failing = fakePanorama({ onExecute: () => Response.json({ status: 'error' }, { status: 500 }) });
    panorama.setFetchForTests(failing);
    await panorama.listTools();
    assert.equal((await panorama.execute('panorama_create_quote', { customer_confirmed: true }, { channel: 'mazbot' })).status, 'unavailable');
    assert.equal(failing.seen.filter((x) => x.path.endsWith('/tools/execute')).length, 1, 'a write is not retried after an HTTP answer');
    // A read tool keeps its retries
    await panorama.execute('panorama_search_products', {}, { channel: 'mazbot' });
    assert.equal(failing.seen.filter((x) => x.path.endsWith('/tools/execute')).length, 4);
});

test('consent: customer_confirmed absent or false → customer_consent false; true → true', async (t) => {
    withEnv(t, { ...ENV, PANORAMA_WRITE_API_KEY: WRITE_KEY });
    const net = fakePanorama();
    panorama.setFetchForTests(net);
    await panorama.listTools();
    const consentOf = async (args) => {
        await panorama.execute('panorama_create_quote', args, { channel: 'mazbot', customer_consent: true });
        return JSON.parse(net.seen.at(-1).body).context.customer_consent;
    };
    assert.equal(await consentOf({}), false);
    assert.equal(await consentOf({ customer_confirmed: false }), false);
    assert.equal(await consentOf({ customer_confirmed: 'true' }), false, 'only the boolean true');
    assert.equal(await consentOf({ customer_confirmed: true }), true);
});

test('the website and the admin test never see a write tool (nor can call one)', async (t) => {
    withEnv(t, { ...ENV, PANORAMA_WRITE_API_KEY: WRITE_KEY });
    const net = fakePanorama();
    panorama.setFetchForTests(net);
    for (const [channel, phone] of [['website', null], ['agent-test', '96800000000'], ['mazbot', null]]) {
        const set = await agent.toolsetFor('PANORAMA', null, { channel, phone });
        assert.deepEqual(names(set), ['request_human', 'panorama_search_products'], channel);
        assert.doesNotMatch(set.system({}, null), /أدوات التسجيل/);
    }
    const before = net.seen.length;
    const r = await agent.executeTool('panorama_create_quote', { customer_confirmed: true }, { db: null, channel: 'website', phone: null, key: 'web:x', events: [] });
    assert.equal(r.status, 'forbidden');
    assert.equal(net.seen.length, before, 'not sent');
    // WhatsApp through the agent: offered and sent with the customer's number
    const db = openDatabase(':memory:');
    const client = fakeClaude([toolCall('panorama_create_quote', { items: [{ sku: 'DS-2CD1043G2-LIU', qty: 8 }], customer_confirmed: true }), textReply('عرضك جاهز: PQ-2026-0001')]);
    const out = await agent.chat({ db, key: 'mz:96891111111', channel: 'mazbot', phone: '96891111111', text: 'نعم أوافق، جهز لي عرض سعر 8 كاميرات', client, createQuote: () => {}, notifyHuman: async () => {} });
    assert.equal(out.reply, 'عرضك جاهز: PQ-2026-0001');
    assert.ok(names(client.calls[0]).includes('panorama_create_quote'));
    const sent = JSON.parse(net.seen.at(-1).body);
    assert.deepEqual(sent.context, { channel: 'mazbot', conversation_key: 'mz:96891111111', customer_phone: '96891111111', customer_verified: true, customer_consent: true });
});

test('shadow: a write tool is never sent; the model gets {status: ok, dry_run: true}', async (t) => {
    withEnv(t, { ...ENV, PANORAMA_TOOLS_ENABLED: 'shadow', PANORAMA_WRITE_API_KEY: WRITE_KEY });
    const net = fakePanorama();
    panorama.setFetchForTests(net);
    const db = openDatabase(':memory:');
    let shadowResult = null;
    const client = fakeClaude((params) => {
        if (!params.tools.some((x) => x.name.startsWith('panorama_'))) return textReply('رد ردما');
        const last = params.messages.at(-1);
        if (last.role === 'user' && Array.isArray(last.content)) { shadowResult = JSON.parse(last.content[0].content); return textReply('الرد المقترح'); }
        return toolCall('panorama_create_quote', { items: [], customer_confirmed: true });
    });
    const r = await agent.chat({ db, key: 'mz:96892222222', channel: 'mazbot', phone: '96892222222', text: 'أبي عرض سعر 8 كاميرات', client, createQuote: () => {}, notifyHuman: async () => {} });
    assert.equal(r.reply, 'رد ردما');
    panorama.ensureTables(db);
    for (let i = 0; i < 50 && !db.prepare('SELECT COUNT(*) AS n FROM panorama_shadow_replies').get().n; i++) await new Promise((res) => setTimeout(res, 10));
    assert.deepEqual(shadowResult, { status: 'ok', dry_run: true });
    assert.equal(net.seen.filter((x) => x.path.endsWith('/tools/execute')).length, 0, 'no network request for the write tool');
});
