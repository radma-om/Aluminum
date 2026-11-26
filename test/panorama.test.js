/* Panorama's tools in Radma's agent: off (0) changes nothing; the signature Panorama checks; the router; which tools
   each route sees; the circuit breaker; what Panorama is told about the customer; shadow (Radma's reply only, the
   suggestion kept aside); on (1): lead.message / handoff.requested; request_human without a team as before; no key
   in the panel and no phone in the call log. No real network: Panorama and the AI are fakes. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase, getSettings } = require('../src/db');
const agent = require('../src/agent');
const panorama = require('../src/panorama-client');
const { classify } = require('../src/router');
const webhooks = require('../src/webhooks');
const leads = require('../src/leads');

const BEFORE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'agent-before-panorama.json'), 'utf8'));
const KEY = 'k'.repeat(64);
const SECRET = 's'.repeat(64);
const ENV = { PANORAMA_BASE_URL: 'https://commerce.example.test', PANORAMA_API_KEY: KEY, PANORAMA_HMAC_SECRET: SECRET };
const dateless = (s) => String(s).replace(/(الأحد|الاثنين|الثلاثاء|الأربعاء|الخميس|الجمعة|السبت) \d{4}-\d{2}-\d{2}/g, 'TODAY');

process.env.AI_PROVIDER = 'anthropic';
process.env.ANTHROPIC_API_KEY = 'test-not-a-real-key';
panorama.setSleepForTests(async () => {});

/* Panorama as it checks requests: Bearer, ±300 s, HMAC of "<ts>.<rid>.<body>" */
const REMOTE_TOOLS = [
    { name: 'panorama_search_products', type: 'read', description: 'بحث', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'panorama_check_stock', type: 'read', description: 'المخزون', input_schema: { type: 'object', properties: { sku: { type: 'string' } } } },
    { name: 'panorama_create_order', type: 'write', description: 'لا', input_schema: { type: 'object' } },
    { name: 'other_tool', type: 'read', description: 'لا', input_schema: { type: 'object' } }
];
function fakePanorama({ fail = null } = {}) {
    const seen = [];
    const fn = async (url, opts = {}) => {
        const u = new URL(url);
        const body = opts.body || '';
        const h = opts.headers || {};
        seen.push({ path: u.pathname, method: opts.method || 'GET', body, headers: h });
        if (u.pathname === '/healthz') return new Response('ok', { status: 200 });
        const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${h['X-Timestamp']}.${h['X-Request-Id']}.${body}`).digest('hex');
        const fresh = Math.abs(Date.now() / 1000 - Number(h['X-Timestamp'])) <= 300;
        if (h.Authorization !== `Bearer ${KEY}` || h['X-Signature'] !== expected || !fresh) return Response.json({ status: 'forbidden' }, { status: 401 });
        if (fail) return fail(u.pathname);
        if (u.pathname === '/api/internal/v1/tools') return Response.json({ tools: REMOTE_TOOLS, instructions_for_agent: 'تعليمات بانوراما' });
        if (u.pathname === '/api/internal/v1/tools/execute') {
            const b = JSON.parse(body);
            return Response.json({ status: 'ok', as_of: '2026-11-26T12:00:00Z', data: { echo: b.tool, items: [{ sku: 'DS-2CD1043G0-I', price: 25 }] }, message_for_agent: null });
        }
        return Response.json({ status: 'not_found' }, { status: 404 });
    };
    fn.seen = seen;
    return fn;
}
function withEnv(t, env) {
    Object.assign(process.env, env);
    t.after(() => { for (const k of Object.keys(env)) delete process.env[k]; panorama._reset(); panorama.setFetchForTests((...a) => fetch(...a)); panorama.setClockForTests(() => Date.now()); });
}

/* The AI: a scripted conversation; every request kept (tools, system) */
function fakeClaude(script) {
    const calls = [];
    let i = 0;
    return {
        calls,
        beta: { messages: { create: async (params) => {
            calls.push(structuredClone({ tools: params.tools, system: params.system, messages: params.messages }));
            const step = typeof script === 'function' ? script(params, i) : script[Math.min(i, script.length - 1)];
            i += 1;
            return step;
        } } }
    };
}
const textReply = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const toolCall = (name, input, id = 'tu1') => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });

test('mode 0: the tools and prompt are those before the task; no router, no Panorama, the same model calls', async (t) => {
    withEnv(t, { PANORAMA_TOOLS_ENABLED: '0', ...ENV });
    assert.deepEqual(JSON.parse(JSON.stringify(agent.TOOLS)), BEFORE.tools);
    assert.deepEqual(JSON.parse(JSON.stringify(agent.OPENAI_TOOLS)), BEFORE.openai_tools);
    const db = openDatabase(':memory:');
    assert.equal(dateless(agent.systemPrompt(getSettings(db), db)), dateless(BEFORE.prompt));
    const net = fakePanorama();
    panorama.setFetchForTests(net);
    const client = fakeClaude([textReply('أهلاً')]);
    const r = await agent.chat({ db, key: 'mz:96891111111', channel: 'mazbot', phone: '96891111111', text: 'كم سعر كاميرا 4 ميجا', client, createQuote: () => {}, notifyHuman: async () => {} });
    assert.equal(r.reply, 'أهلاً');
    assert.equal(client.calls.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(client.calls[0].tools)), BEFORE.tools);
    assert.equal(dateless(client.calls[0].system), dateless(BEFORE.prompt));
    assert.equal(net.seen.length, 0, 'Panorama never called');
    panorama.ensureTables(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM panorama_routes').get().n, 0, 'no router');
    // shadow / 1 with a setting missing acts as 0
    process.env.PANORAMA_TOOLS_ENABLED = '1';
    delete process.env.PANORAMA_HMAC_SECRET;
    assert.equal(panorama.mode(db), '0');
    assert.match(db.prepare("SELECT last_error FROM system_alerts WHERE key = 'panorama'").get().last_error, /PANORAMA_HMAC_SECRET/);
});

test('the signature Panorama checks; GET signs "<ts>.<rid>."; only read panorama_ tools; cached 10 minutes', async (t) => {
    withEnv(t, { PANORAMA_TOOLS_ENABLED: '1', ...ENV });
    const net = fakePanorama();
    panorama.setFetchForTests(net);
    let clock = Date.now();
    panorama.setClockForTests(() => clock);
    const l = await panorama.listTools();
    assert.deepEqual(l.tools.map((x) => x.name), ['panorama_search_products', 'panorama_check_stock'], 'write tools and other names left out');
    assert.equal(l.instructions, 'تعليمات بانوراما');
    const get = net.seen[0];
    assert.equal(get.method, 'GET');
    assert.equal(get.body, '');
    assert.match(get.headers['X-Request-Id'], /^[0-9a-f-]{36}$/);
    await panorama.listTools();
    assert.equal(net.seen.length, 1, 'cached');
    clock += 11 * 60_000;
    await panorama.listTools();
    assert.equal(net.seen.length, 2, 'refreshed after 10 minutes');
    // Down: the last good list
    panorama.setFetchForTests(async () => { throw new TypeError('fetch failed'); });
    clock += 11 * 60_000;
    assert.equal((await panorama.listTools()).tools.length, 2);
    // A POST: signed over its body; Panorama's answer as is (a clock 22 minutes ahead is refused by Panorama: ±300 s)
    assert.equal((await panorama.execute('panorama_check_stock', {}, {})).status, 'unavailable');
    panorama._reset();
    panorama.setClockForTests(() => Date.now());
    panorama.setFetchForTests(net);
    const out = await panorama.execute('panorama_check_stock', { sku: 'X' }, { channel: 'website' });
    assert.deepEqual([out.status, out.data.echo, out.message_for_agent], ['ok', 'panorama_check_stock', null]);
    assert.deepEqual(JSON.parse(net.seen.at(-1).body), { tool: 'panorama_check_stock', arguments: { sku: 'X' }, context: { channel: 'website' } });
    // Wrong keys: 401, no retry
    process.env.PANORAMA_API_KEY = 'wrong';
    const before = net.seen.length;
    assert.equal((await panorama.execute('panorama_check_stock', {}, {})).status, 'unavailable');
    assert.equal(net.seen.length - before, 1, '401 is not retried');
});

test('the router', () => {
    assert.equal(classify('كم سعر كاميرا 4 ميجا').route, 'PANORAMA');
    assert.equal(classify('بوابة شتر 3×2.5').route, 'RADMA');
    assert.equal(classify('أبي كاميرا وبوابة').route, 'MIXED');
    assert.equal(classify('السلام عليكم', { current_business: 'PANORAMA' }).route, 'PANORAMA', 'the current business');
    assert.equal(classify('السلام عليكم').route, 'MIXED', 'no current business: both');
    assert.equal(classify('كم السعر؟').kind, 'NONE');
    assert.equal(classify('ابغى اشتري باب').kind, 'NONE', '«اشتري» is not «شتر»');
    assert.equal(classify('DS-2CD1043G0-I متوفر؟').route, 'PANORAMA');
    assert.equal(classify('ارتفاع ٢٥٠ عرض ٤٠٠').route, 'RADMA');
    assert.equal(classify('عندكم نظام حضور وانصراف؟').route, 'PANORAMA');
    assert.equal(classify('مَكِينَة للبوّابة').route, 'RADMA', 'without diacritics');
});

test('mode 1: RADMA sees Radma only (as before); PANORAMA sees Panorama + request_human; events fired', async (t) => {
    withEnv(t, { PANORAMA_TOOLS_ENABLED: '1', ...ENV });
    const net = fakePanorama();
    panorama.setFetchForTests(net);
    const emitted = [];
    const realEmit = webhooks.emit;
    webhooks.emit = (db, event, data) => { emitted.push({ event, data }); return Promise.resolve([]); };
    t.after(() => { webhooks.emit = realEmit; });
    const db = openDatabase(':memory:');
    const phone = '96891111111';
    leads.customerMessage(db, { key: leads.phoneKey(phone), channel: 'whatsapp', name: 'سالم', phone, text: 'مرحبا' });
    const notified = [];
    const base = { db, key: 'mz:' + phone, channel: 'mazbot', phone, createQuote: () => {}, notifyHuman: async (s, team) => { notified.push({ s, team }); } };

    // RADMA: exactly Radma's tools and prompt; no event
    let client = fakeClaude([textReply('سعر الشتر …')]);
    await agent.chat({ ...base, text: 'بوابة شتر 3×2.5', client });
    assert.deepEqual(JSON.parse(JSON.stringify(client.calls[0].tools)), BEFORE.tools);
    assert.equal(dateless(client.calls[0].system), dateless(BEFORE.prompt));
    assert.equal(emitted.length, 0);

    // PANORAMA: Panorama's tools + request_human (with team); the tool runs with the customer's verified number
    client = fakeClaude([toolCall('panorama_search_products', { query: 'كاميرا 4 ميجا' }), textReply('كاميرا DS-2CD1043G0-I بسعر 25 ر.ع')]);
    const r = await agent.chat({ ...base, text: 'كم سعر كاميرا 4 ميجا', client });
    assert.equal(r.reply, 'كاميرا DS-2CD1043G0-I بسعر 25 ر.ع');
    assert.deepEqual(client.calls[0].tools.map((x) => x.name), ['request_human', 'panorama_search_products', 'panorama_check_stock']);
    assert.deepEqual(client.calls[0].tools[0].input_schema.required, ['summary', 'team']);
    assert.ok(!('strict' in client.calls[0].tools[1]), 'Panorama tools are not strict');
    assert.match(client.calls[0].system, /تعليمات بانوراما/);
    assert.ok(client.calls[0].system.startsWith(dateless(BEFORE.prompt).split('TODAY')[0]), 'Radma prompt kept, the section added after');
    const exec = JSON.parse(net.seen.find((x) => x.path.endsWith('/tools/execute')).body);
    assert.deepEqual(exec.context, { channel: 'mazbot', conversation_key: 'mz:' + phone, customer_phone: phone, customer_verified: true, customer_consent: false });
    assert.deepEqual(emitted.map((e) => e.event), ['lead.message']);
    assert.deepEqual({ ...emitted[0].data, lead_id: typeof emitted[0].data.lead_id }, { lead_id: 'number', channel: 'mazbot', customer_phone: phone, customer_name: 'سالم',
        business: 'panorama', text: 'كم سعر كاميرا 4 ميجا', agent_reply: 'كاميرا DS-2CD1043G0-I بسعر 25 ر.ع' });
    // «السلام عليكم» after cameras: still Panorama
    client = fakeClaude([textReply('وعليكم السلام')]);
    await agent.chat({ ...base, text: 'السلام عليكم', client });
    assert.ok(client.calls[0].tools.some((x) => x.name === 'panorama_search_products'));
    assert.equal(emitted.length, 2);

    // request_human with team=panorama_sales: the alert's team, handoff.requested
    client = fakeClaude([toolCall('request_human', { summary: 'يريد عرض 8 كاميرات', team: 'panorama_sales' }), textReply('سيتواصل معك فريق بانوراما')]);
    await agent.chat({ ...base, text: 'أبي أحد يكلمني عن الكاميرات', client });
    assert.deepEqual(notified.at(-1), { s: 'يريد عرض 8 كاميرات', team: 'panorama_sales' });
    const handoff = emitted.find((e) => e.event === 'handoff.requested');
    assert.deepEqual({ ...handoff.data, lead_id: typeof handoff.data.lead_id }, { lead_id: 'number', team: 'panorama_sales', customer_phone: phone, summary: 'يريد عرض 8 كاميرات' });

    // MIXED: both sets
    client = fakeClaude([textReply('تقصد أي منهما؟')]);
    await agent.chat({ ...base, key: 'mz:96892222222', phone: '96892222222', text: 'أبي كاميرا وبوابة', client });
    const names = client.calls[0].tools.map((x) => x.name);
    assert.ok(names.includes('calculate_final_price') && names.includes('panorama_check_stock') && names.filter((n) => n === 'request_human').length === 1);

    // The admin test chat fires nothing
    const n = emitted.length;
    client = fakeClaude([textReply('…')]);
    await agent.chat({ ...base, key: 'test:x', channel: 'agent-test', text: 'كاميرا', client });
    assert.equal(emitted.length, n);
});

test('request_human without a team works as today; the website tells Panorama no number', async () => {
    const calls = [];
    const ctx = { db: null, phone: '96891111111', channel: 'mazbot', events: [], notifyHuman: async (...a) => { calls.push(a); } };
    assert.deepEqual(await agent.executeTool('request_human', { summary: 'ملخص' }, ctx), { ok: true, message: 'تم إبلاغ فريق المبيعات' });
    assert.deepEqual(calls[0], ['ملخص', null]);
    assert.deepEqual(ctx.events, [{ type: 'human_requested', summary: 'ملخص' }], 'the event as before');
    assert.deepEqual(agent.panoramaContext({ channel: 'website', phone: null, key: 'web:abc' }),
        { channel: 'website', conversation_key: 'web:abc', customer_phone: null, customer_verified: false, customer_consent: false });
    assert.deepEqual(agent.panoramaContext({ channel: 'agent-test', phone: '96800000000', key: 'test:x' }).customer_verified, false);
});

test('circuit breaker: 3 failures → «unavailable» for 60 s without a request', async (t) => {
    withEnv(t, { PANORAMA_TOOLS_ENABLED: '1', ...ENV });
    const db = openDatabase(':memory:');
    let clock = Date.now();
    panorama.setClockForTests(() => clock);
    const net = fakePanorama({ fail: () => Response.json({ status: 'error' }, { status: 503 }) });
    panorama.setFetchForTests(net);
    for (let i = 0; i < 3; i++) assert.equal((await panorama.execute('panorama_check_stock', {}, { channel: 'mazbot' }, { db })).status, 'unavailable');
    assert.equal(net.seen.length, 9, 'each with two retries');
    const r = await panorama.execute('panorama_check_stock', {}, { channel: 'mazbot' }, { db });
    assert.deepEqual(r, panorama.UNAVAILABLE);
    assert.equal(net.seen.length, 9, 'no request while open');
    clock += panorama.BREAKER_MS + 1;
    panorama.setFetchForTests(fakePanorama());
    assert.equal((await panorama.execute('panorama_check_stock', {}, { channel: 'mazbot' }, { db })).status, 'ok', 'closed again after 60 s');
    // The log: tool, status, time, channel — no arguments, no phone
    const cols = db.prepare('PRAGMA table_info(remote_tool_calls)').all().map((c) => c.name);
    assert.deepEqual(cols, ['id', 'request_id', 'tool', 'status', 'duration_ms', 'channel', 'created_at']);
    assert.ok(db.prepare("SELECT 1 FROM remote_tool_calls WHERE status = 'circuit_open'").get());
});

test('shadow: the customer gets Radma\'s reply; the suggestion is kept; nothing else saved or sent', async (t) => {
    withEnv(t, { PANORAMA_TOOLS_ENABLED: 'shadow', ...ENV });
    panorama.setFetchForTests(fakePanorama());
    const emitted = [];
    const realEmit = webhooks.emit;
    webhooks.emit = (db, event) => { emitted.push(event); return Promise.resolve([]); };
    t.after(() => { webhooks.emit = realEmit; });
    const db = openDatabase(':memory:');
    const notified = [];
    // Radma's run first (its tools), then the shadow run (Panorama's tools): it asks for a person — a dry run
    const client = fakeClaude((params) => (params.tools.some((x) => x.name.startsWith('panorama_'))
        ? (params.messages.at(-1).role === 'user' && Array.isArray(params.messages.at(-1).content) ? textReply('الرد المقترح: كاميرا بـ 25 ر.ع')
            : toolCall('request_human', { summary: 'x', team: 'panorama_sales' }))
        : textReply('رد ردما: سنحولك لفريقنا')));
    const r = await agent.chat({ db, key: 'mz:96893333333', channel: 'mazbot', phone: '96893333333', text: 'كم سعر كاميرا 4 ميجا', client,
        createQuote: () => {}, notifyHuman: async (...a) => { notified.push(a); } });
    assert.equal(r.reply, 'رد ردما: سنحولك لفريقنا');
    assert.deepEqual(JSON.parse(JSON.stringify(client.calls[0].tools)), BEFORE.tools, 'the reply the customer gets: Radma as today');
    for (let i = 0; i < 50 && !db.prepare('SELECT COUNT(*) AS n FROM panorama_shadow_replies').get().n; i++) await new Promise((res) => setTimeout(res, 10));
    const row = db.prepare('SELECT * FROM panorama_shadow_replies').get();
    assert.deepEqual([row.business, row.customer_text, row.actual_reply, row.shadow_reply], ['panorama', 'كم سعر كاميرا 4 ميجا', 'رد ردما: سنحولك لفريقنا', 'الرد المقترح: كاميرا بـ 25 ر.ع']);
    assert.deepEqual(JSON.parse(row.tools_used), ['request_human']);
    assert.equal(notified.length, 0, 'request_human was a dry run');
    assert.equal(emitted.length, 0, 'no webhook in shadow');
    const stored = JSON.parse(db.prepare("SELECT messages_json FROM agent_conversations WHERE conversation_key = 'mz:96893333333'").get().messages_json);
    assert.equal(stored.length, 2, 'only Radma\'s exchange is kept');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_conversations').get().n, 1, 'no second conversation');
});

test('the panel: managers only; settings shown as set or not, never their values', async (t) => {
    withEnv(t, { PANORAMA_TOOLS_ENABLED: '1', ...ENV });
    panorama.setFetchForTests(fakePanorama());
    process.env.ADMIN_TOKEN = 'test-token-long-enough-1234';
    const http = require('node:http');
    const { createApp } = require('../src/server');
    const staff = require('../src/staff');
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, token = process.env.ADMIN_TOKEN) => {
        const res = await fetch(base + url, { method, headers: { Authorization: 'Bearer ' + token } });
        return { status: res.status, text: await res.text() };
    };
    const test1 = await call('POST', '/api/admin/panorama/test');
    assert.deepEqual(JSON.parse(test1.text).names, ['panorama_search_products', 'panorama_check_stock']);
    const s = await call('GET', '/api/admin/panorama');
    assert.equal(s.status, 200);
    assert.ok(!s.text.includes(KEY) && !s.text.includes(SECRET), 'no key in the panel');
    assert.deepEqual(JSON.parse(s.text).settings, { PANORAMA_BASE_URL: true, PANORAMA_API_KEY: true, PANORAMA_HMAC_SECRET: true, PANORAMA_TOOL_TIMEOUT_MS: 8000 });
    staff.create(db, { username: 'nour', display_name: 'نور', password: 'pass-12345', role: 'staff', permissions: ['integrations', 'leads', 'quotes'] });
    const tok = JSON.parse(await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'nour', password: 'pass-12345' }) })).text()).token;
    assert.equal((await call('GET', '/api/admin/panorama', tok)).status, 403);
});
