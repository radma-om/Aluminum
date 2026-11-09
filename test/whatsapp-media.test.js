/* Photos and voice notes from WhatsApp (MazBot). No real network: MazBot, the files and OpenAI are local fakes. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase, saveSettings } = require('../src/db');
const { saveQuote } = require('../src/server');
const inbox = require('../src/mazbot-inbox');
const mazbot = require('../src/mazbot');
const media = require('../src/media');

/* The two real MazBot payloads (shortened) */
const IMAGE = {
    id: '15569f45-10ad-4db2-a9a6-7a12d3fb6be3', type: 'message.received', client_id: 1136,
    data: { contact: { id: 1376829, phone: '96899887897', name: 'محمد' },
        message: { id: 18434021, message_type: 'image', value: null, meta_type: 'image', header_image: 'https://mazbotapp.s3.eu-west-3.amazonaws.com/images/media/2019915885365799.jpg' } }
};
const AUDIO = {
    id: '5c34dbca-3d0a-4998-8342-c64cc95c13a6', type: 'message.received', client_id: 1136,
    data: { contact: { id: 1376829, phone: '96899887897', name: 'محمد' },
        message: { id: 18434059, message_type: 'audio', value: null, meta_type: 'audio', header_audio: 'https://mazbotapp.s3.eu-west-3.amazonaws.com/images/media/1451188720437751.ogg' } }
};
let n = 0;
const fresh = (e) => { const c = structuredClone(e); c.id += '-' + (++n); c.data.message.id += 1000 * n; return c; };

async function fakeMazbot(t) {
    const sent = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/login') return res.end(JSON.stringify({ data: { token: 'jwt' } }));
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

function setup() {
    const db = openDatabase(':memory:');
    saveSettings(db, { mazbot_agent_enabled: true });
    return db;
}
const store = (db, e) => Number(db.prepare("INSERT INTO inbound_events (source, method, body) VALUES ('mazbot', 'POST', ?)").run(JSON.stringify(e)).lastInsertRowid);
const statusOf = (db, id) => db.prepare('SELECT status FROM inbound_events WHERE id = ?').get(id).status;
const leadLog = (db) => db.prepare("SELECT text FROM lead_messages WHERE role = 'customer' ORDER BY id").all().map((r) => r.text);

/* Fake file store and speech-to-text, so no request leaves the test */
const fakeTools = ({ transcript = 'أبغى سعر بوابة عرض ٣ متر وارتفاع مترين ونص', fail = null } = {}) => ({
    calls: [],
    async download(url, kind) {
        this.calls.push(['download', url, kind]);
        if (fail === 'download') throw new Error('تعذر تنزيل الملف (HTTP 403)');
        return { buffer: Buffer.from(kind === 'image' ? 'JPEGDATA' : 'OGGDATA'), contentType: kind === 'image' ? 'image/jpeg' : 'audio/ogg' };
    },
    imagePart: media.imagePart,
    async transcribe(file, url) {
        this.calls.push(['transcribe', url]);
        if (fail === 'transcribe') throw new Error('تحويل الصوت فشل: insufficient_quota');
        return transcript;
    }
});

test('the two real MazBot payloads: photo and voice note links, and only MazBot storage is trusted', () => {
    assert.deepEqual(media.mediaOf(IMAGE), { kind: 'image', url: IMAGE.data.message.header_image, caption: null });
    assert.deepEqual(media.mediaOf(AUDIO), { kind: 'audio', url: AUDIO.data.message.header_audio, caption: null });
    assert.equal(media.mediaOf({ data: { message: { message_type: 'text', value: 'hi' } } }), null);
    assert.equal(media.isMazbotMedia(IMAGE.data.message.header_image), true);
    assert.equal(media.isMazbotMedia('https://mazbotapp.s3.amazonaws.com/x.jpg'), true);
    for (const bad of [
        'http://mazbotapp.s3.eu-west-3.amazonaws.com/x.jpg',          // not https
        'https://evil.example.com/mazbotapp.s3.eu-west-3.amazonaws.com/x.jpg',
        'https://mazbotapp.s3.eu-west-3.amazonaws.com.evil.com/x.jpg',
        'https://otherbucket.s3.eu-west-3.amazonaws.com/x.jpg',
        'https://user:pw@mazbotapp.s3.eu-west-3.amazonaws.com/x.jpg',
        'https://169.254.169.254/latest/meta-data', 'file:///etc/passwd', 'not a url'
    ]) assert.equal(media.isMazbotMedia(bad), false, bad);
});

test('download refuses any address outside MazBot storage, before sending a request', async () => {
    await assert.rejects(media.download('https://127.0.0.1/secret', 'image'), /ليس من خوادم MazBot/);
    await assert.rejects(media.download('https://evil.example.com/x.ogg', 'audio'), /ليس من خوادم MazBot/);
});

test('image limit accounts for base64 expansion before an Anthropic request', () => {
    const encodedSize = (bytes) => 4 * Math.ceil(bytes / 3);
    assert.equal(media.LIMITS.image, 7.5 * 1024 * 1024);
    assert.equal(encodedSize(media.LIMITS.image), media.ANTHROPIC_IMAGE_BASE64_LIMIT);
    assert.ok(encodedSize(media.LIMITS.image + 1) > media.ANTHROPIC_IMAGE_BASE64_LIMIT);
    assert.throws(
        () => media.imagePart({ buffer: Buffer.alloc(media.LIMITS.image + 1), contentType: 'image/jpeg' }, 'photo.jpg'),
        /أكبر من الحد المسموح بعد الترميز/
    );
});

test('a photo is shown to the AI with the conversation; the history and the follow-up keep a note and the link', async (t) => {
    const sent = await fakeMazbot(t);
    const db = setup();
    const seen = [];
    const client = { beta: { messages: { create: async (params) => { seen.push(structuredClone(params)); return { content: [{ type: 'text', text: 'هذه بوابة رول شتر — ما المقاس؟' }], stop_reason: 'end_turn' }; } } } };
    const tools = fakeTools();
    const e = fresh(IMAGE);
    const id = store(db, e);
    await inbox.handleEvent(db, id, e, { saveQuote: (q) => saveQuote(db, q), notifySales: async () => null, baseUrl: 'https://calc.example.com', client, mediaTools: tools });
    assert.equal(statusOf(db, id), 'replied');
    assert.equal(sent.at(-1).message, 'هذه بوابة رول شتر — ما المقاس؟');
    const user = seen[0].messages.at(-1);
    assert.equal(user.content[0].type, 'image');
    assert.equal(user.content[0].source.media_type, 'image/jpeg');
    assert.equal(user.content[0].source.data, Buffer.from('JPEGDATA').toString('base64'));
    // No image data kept in the stored conversation
    const stored = db.prepare('SELECT messages_json FROM agent_conversations').get().messages_json;
    assert.ok(!stored.includes(Buffer.from('JPEGDATA').toString('base64')));
    assert.match(stored, /أرسل العميل صورة/);
    assert.match(leadLog(db).at(-1), /^📷 صورة\nhttps:\/\/mazbotapp\.s3/);
});

test('a voice note is turned into text and answered like a typed message; the follow-up shows what was said', async (t) => {
    const sent = await fakeMazbot(t);
    const db = setup();
    const seen = [];
    const client = { beta: { messages: { create: async (params) => { seen.push(structuredClone(params)); return { content: [{ type: 'text', text: 'تمام، بوابة 300 × 250 سم' }], stop_reason: 'end_turn' }; } } } };
    const tools = fakeTools();
    const e = fresh(AUDIO);
    const id = store(db, e);
    await inbox.handleEvent(db, id, e, { saveQuote: (q) => saveQuote(db, q), notifySales: async () => null, baseUrl: 'https://calc.example.com', client, mediaTools: tools });
    assert.deepEqual(tools.calls.map((c) => c[0]), ['download', 'transcribe']);
    assert.equal(seen[0].messages.at(-1).content, 'أبغى سعر بوابة عرض ٣ متر وارتفاع مترين ونص');
    assert.equal(sent.at(-1).message, 'تمام، بوابة 300 × 250 سم');
    assert.match(leadLog(db).at(-1), /🎤 رسالة صوتية: «أبغى سعر بوابة عرض ٣ متر/);
});

test('when a file cannot be read the customer is asked to type, the follow-up keeps the link, and the fault is counted', async (t) => {
    const sent = await fakeMazbot(t);
    const db = setup();
    const client = { beta: { messages: { create: async () => { throw new Error('the AI must not be called'); } } } };
    for (const [event, fail, reply] of [[AUDIO, 'transcribe', /لم أتمكن من سماع/], [IMAGE, 'download', /لم أتمكن من فتح الصورة/]]) {
        const e = fresh(event);
        const id = store(db, e);
        await inbox.handleEvent(db, id, e, { saveQuote: (q) => saveQuote(db, q), notifySales: async () => null, client, mediaTools: fakeTools({ fail }) });
        assert.match(sent.at(-1).message, reply);
        assert.match(statusOf(db, id), /failed/);
    }
    assert.match(leadLog(db).join('\n'), /تعذر تحويلها إلى نص[\s\S]*mazbotapp/);
    assert.equal(db.prepare("SELECT fail_count FROM system_alerts WHERE key = 'media'").get().fail_count, 2);
});

test('with the agent off, a voice note still reaches the follow-up as a link (nothing is downloaded)', async (t) => {
    await fakeMazbot(t);
    const db = setup();
    saveSettings(db, { mazbot_agent_enabled: false });
    const e = fresh(AUDIO);
    const id = store(db, e);
    assert.equal(inbox.handleEvent(db, id, e, { mediaTools: { download: () => { throw new Error('no'); } } }), null);
    assert.equal(statusOf(db, id), 'agent_off');
    assert.match(leadLog(db).at(-1), /^🎤 رسالة صوتية\nhttps:/);
});

test('speech-to-text calls OpenAI with the file and the model; the OpenAI agent gets the photo as an image', async (t) => {
    const got = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: Buffer.concat(chunks) }).formData();
        got.push({ url: req.url, auth: req.headers.authorization, model: form.get('model'), file: form.get('file') });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ text: ' مرحبا أبغى سعر ' }));
    });
    await new Promise((r) => server.listen(0, r));
    const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, OPENAI_BASE_URL: process.env.OPENAI_BASE_URL };
    Object.assign(process.env, { OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` });
    t.after(() => { server.close(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
    const text = await media.transcribe({ buffer: Buffer.from('OGG'), contentType: 'audio/ogg' }, AUDIO.data.message.header_audio);
    assert.equal(text, 'مرحبا أبغى سعر');
    assert.equal(got[0].url, '/v1/audio/transcriptions');
    assert.equal(got[0].auth, 'Bearer sk-test');
    assert.equal(got[0].model, 'gpt-4o-mini-transcribe');
    assert.equal(got[0].file.name, '1451188720437751.ogg');

    // The OpenAI agent path: the image goes as an image_url data URL
    const agent = require('../src/agent');
    const db = setup();
    const seen = [];
    process.env.AI_PROVIDER = 'openai';
    t.after(() => { delete process.env.AI_PROVIDER; });
    const client = { chat: { completions: { create: async (p) => { seen.push(p); return { choices: [{ message: { content: 'رأيت الصورة' } }] }; } } } };
    const r = await agent.chat({ db, key: 'mz:1', channel: 'mazbot', phone: '1', text: '', images: [{ media_type: 'image/jpeg', data: 'QUJD' }], createQuote: () => {}, notifyHuman: async () => {}, client });
    assert.equal(r.reply, 'رأيت الصورة');
    const parts = seen[0].messages.at(-1).content;
    assert.equal(parts[1].type, 'image_url');
    assert.equal(parts[1].image_url.url, 'data:image/jpeg;base64,QUJD');
    assert.ok(!db.prepare('SELECT messages_json FROM agent_conversations').get().messages_json.includes('QUJD'));
});
