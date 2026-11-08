/* Switching the WhatsApp auto-reply off for chosen numbers */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase, saveSettings } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const autoreply = require('../src/autoreply');
const inbox = require('../src/mazbot-inbox');
const mazbot = require('../src/mazbot');
const staff = require('../src/staff');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;

async function fakeMazbot(t) {
    const sent = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/login') return res.end(JSON.stringify({ data: { token: 'jwt' } }));
        if (req.url === '/api/contact/resolve-by-phone') return res.end(JSON.stringify({ data: { receiver_id: 77 } }));
        const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: Buffer.concat(chunks) }).formData();
        sent.push(Object.fromEntries(form.entries()));
        res.end(JSON.stringify({ success: true }));
    });
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    Object.assign(process.env, { MAZBOT_BASE_URL: `http://127.0.0.1:${server.address().port}/api`, MAZBOT_API_KEY: 'k', MAZBOT_STAFF_EMAIL: 's@example.com', MAZBOT_STAFF_PASSWORD: 'p', ANTHROPIC_API_KEY: 'test' });
    mazbot._reset();
    return sent;
}

async function start(t) {
    const db = openDatabase(':memory:');
    saveSettings(db, { mazbot_agent_enabled: true });
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = OWNER) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    return { db, call };
}

let n = 0;
const message = (text, phone = '96899887897') => ({
    id: 'evt-' + (++n), type: 'message.received',
    data: { contact: { id: 1376829, phone, name: 'محمد' }, message: { id: 900000 + n, message_type: 'text', value: text, meta_type: 'text' } }
});
const mediaMessage = (kind, phone = '96899887897') => {
    const fields = { image: 'header_image', audio: 'header_audio', video: 'header_video', document: 'header_document' };
    const seq = ++n;
    return {
        id: 'evt-' + seq, type: 'message.received',
        data: {
            contact: { id: 1376829, phone, name: 'محمد' },
            message: {
                id: 900000 + seq, message_type: kind,
                [fields[kind]]: `https://mazbotapp.s3.me-central-1.amazonaws.com/tests/${seq}.${kind === 'image' ? 'jpg' : kind === 'audio' ? 'ogg' : kind === 'video' ? 'mp4' : 'pdf'}`,
                value: kind === 'image' ? 'صورة البوابة' : null
            }
        }
    };
};
const store = (db, e) => Number(db.prepare("INSERT INTO inbound_events (source, method, body) VALUES ('mazbot', 'POST', ?)").run(JSON.stringify(e)).lastInsertRowid);
const statusOf = (db, id) => db.prepare('SELECT status FROM inbound_events WHERE id = ?').get(id).status;
const answering = () => ({ beta: { messages: { create: async () => ({ content: [{ type: 'text', text: 'رد المساعد' }], stop_reason: 'end_turn' }) } } });

test('a number switched off gets no AI reply (even «جديد»); its messages still reach the follow-up', async (t) => {
    const sent = await fakeMazbot(t);
    const { db } = await start(t);
    autoreply.stop(db, '96899887897', { reason: 'عميل كبير يتابعه المدير', by: 'أحمد' });
    for (const text of ['كم سعر البوابة؟', 'جديد']) {
        const e = message(text);
        const id = store(db, e);
        await inbox.handleEvent(db, id, e, { saveQuote: (q) => saveQuote(db, q), notifySales: async () => null, client: answering() });
        assert.match(statusOf(db, id), /auto-reply off for this number/);
    }
    assert.equal(sent.length, 0, 'nothing sent to the customer');
    const texts = db.prepare("SELECT text FROM lead_messages WHERE role = 'customer'").all().map((r) => r.text);
    assert.deepEqual(texts, ['كم سعر البوابة؟', 'جديد']);
    // Another number is answered as usual
    const other = message('مرحبا', '96891111111');
    const id = store(db, other);
    await inbox.handleEvent(db, id, other, { saveQuote: (q) => saveQuote(db, q), notifySales: async () => null, client: answering() });
    assert.equal(statusOf(db, id), 'replied');
});

test('paused media is recorded without download, transcription, AI or an automatic reply', async (t) => {
    const sent = await fakeMazbot(t);
    const { db } = await start(t);
    const manualPhone = '96899887897';
    const autoPhone = '96891111111';
    autoreply.stop(db, manualPhone, { reason: 'يتابعه موظف', by: 'أحمد' });
    autoreply.pauseAuto(db, autoPhone);

    const calls = { download: 0, transcribe: 0, imagePart: 0, ai: 0 };
    const mediaTools = {
        download: async () => { calls.download++; throw new Error('must not download while paused'); },
        transcribe: async () => { calls.transcribe++; return 'نص'; },
        imagePart: () => { calls.imagePart++; return { media_type: 'image/jpeg', data: 'x' }; }
    };
    const client = { beta: { messages: { create: async () => {
        calls.ai++;
        return { content: [{ type: 'text', text: 'رد المساعد' }], stop_reason: 'end_turn' };
    } } } };
    const ctx = { saveQuote: (q) => saveQuote(db, q), notifySales: async () => null, client, mediaTools };

    for (const [phone, expected] of [[manualPhone, /auto-reply off for this number/], [autoPhone, /paused: with sales team/]]) {
        for (const kind of ['image', 'audio', 'video', 'document']) {
            const e = mediaMessage(kind, phone);
            const id = store(db, e);
            await inbox.handleEvent(db, id, e, ctx);
            assert.match(statusOf(db, id), expected);
        }
    }

    assert.deepEqual(calls, { download: 0, transcribe: 0, imagePart: 0, ai: 0 });
    assert.equal(sent.length, 0, 'paused media must not trigger any WhatsApp reply');
    const logged = db.prepare("SELECT text FROM lead_messages WHERE role = 'customer' ORDER BY id").all().map((r) => r.text);
    assert.equal(logged.length, 8);
    assert.ok(logged.every((text) => text.includes('https://mazbotapp.s3.me-central-1.amazonaws.com/tests/')));

    // Preserve the existing rule: only a typed reset command clears an automatic pause.
    const reset = message('جديد', autoPhone);
    const resetId = store(db, reset);
    await inbox.handleEvent(db, resetId, reset, ctx);
    assert.equal(statusOf(db, resetId), 'replied');
    assert.equal(autoreply.isStopped(db, autoPhone), false);
    assert.equal(calls.ai, 1);
    assert.equal(sent.length, 1);
});

test('until a date: the stop ends by itself after that day (Muscat time)', async (t) => {
    const { db } = await start(t);
    assert.throws(() => autoreply.stop(db, '96899887897', { until: '2020-01-01' }), /تاريخاً قادماً/);
    const p = autoreply.stop(db, '96899887897', { until: '2099-12-31' });
    assert.equal(p.until, '2099-12-31 19:59:59');
    assert.equal(p.forever, false);
    db.prepare("UPDATE agent_pauses SET until = datetime('now', '-1 minute')").run();
    assert.equal(autoreply.isStopped(db, '96899887897'), false);
});

test('automatic pauses never shorten a stop, and «resume all» leaves stops alone', async (t) => {
    const { db, call } = await start(t);
    autoreply.stop(db, '96899887897', {});
    autoreply.pauseAuto(db, '96899887897'); // an employee replied: would be 12 hours
    assert.equal(autoreply.stateOf(db, '96899887897').forever, true);
    autoreply.pauseAuto(db, '96891111111');
    assert.equal(autoreply.stateOf(db, '96891111111').kind, 'auto');
    const r = await call('DELETE', '/api/admin/mazbot/pauses');
    assert.equal(r.body.resumed, 1);
    assert.equal(autoreply.isStopped(db, '96891111111'), false);
    assert.equal(autoreply.isStopped(db, '96899887897'), true);
    // A stop replaces an automatic pause
    autoreply.pauseAuto(db, '96892222222');
    autoreply.stop(db, '96892222222', { until: '2099-01-01' });
    assert.equal(autoreply.stateOf(db, '96892222222').kind, 'manual');
});

test('from the customer page and for any number; listed with who and why; the audit log records it', async (t) => {
    const { db, call } = await start(t);
    const lead = Number(db.prepare("INSERT INTO leads (contact_key, channel, name, phone) VALUES ('tel:96899887897', 'whatsapp', 'محمد', '96899887897')").run().lastInsertRowid);
    let d = (await call('PUT', `/api/admin/leads/${lead}/pause`, { forever: true, reason: 'يتابعه المدير' })).body;
    assert.equal(d.agent_stop.kind, 'manual');
    assert.equal(d.agent_stop.forever, true);
    assert.equal(d.agent_stop.reason, 'يتابعه المدير');
    assert.match(d.notes[0].text, /أُوقف الرد الآلي لهذا العميل دائماً/);
    assert.equal((await call('GET', '/api/admin/leads?open=1')).body.leads[0].agent_stop, 'manual');
    // A supplier who is not a customer: an 8-digit Omani number gets the country code
    assert.equal((await call('POST', '/api/admin/mazbot/pauses', { phone: '9123 4567', forever: true, reason: 'مورّد' })).status, 201);
    assert.equal((await call('POST', '/api/admin/mazbot/pauses', { phone: '12', forever: true })).status, 400);
    const list = (await call('GET', '/api/admin/mazbot/pauses')).body.pauses;
    assert.deepEqual(list.map((p) => [p.phone, p.name, p.reason]).sort(), [['96891234567', null, 'مورّد'], ['96899887897', 'محمد', 'يتابعه المدير']]);
    d = (await call('DELETE', `/api/admin/leads/${lead}/pause`)).body;
    assert.equal(d.agent_stop, null);
    const actions = (await call('GET', '/api/admin/audit')).body.entries.map((e) => e.action);
    assert.ok(actions.includes('إيقاف الرد الآلي لعميل'));
    assert.ok(actions.includes('إيقاف الرد الآلي لرقم'));
});

test('permissions: the customer page needs «متابعة العملاء», any number needs «الربط»', async (t) => {
    const { db, call } = await start(t);
    staff.create(db, { username: 'sales', display_name: 'سالم', password: 'pass-12345', permissions: ['leads'] });
    const tok = (await call('POST', '/api/auth/login', { username: 'sales', password: 'pass-12345' }, null)).body.token;
    const lead = Number(db.prepare("INSERT INTO leads (contact_key, channel, name, phone) VALUES ('tel:96899887897', 'whatsapp', 'محمد', '96899887897')").run().lastInsertRowid);
    assert.equal((await call('PUT', `/api/admin/leads/${lead}/pause`, { forever: true }, tok)).status, 200);
    assert.equal((await call('POST', '/api/admin/mazbot/pauses', { phone: '96891234567', forever: true }, tok)).status, 403);
});
