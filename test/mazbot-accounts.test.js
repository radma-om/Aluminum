/* Two MazBot accounts: with MAZBOT_TEMPLATES_* set, every approved template (the calculators' to the sales
   numbers, the customers') goes through the templates account — its own key and sign-in; the main account
   keeps the plain messages. Checked against a local stand-in of MazBot. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

test('templates through the templates account, plain messages through the main one', async (t) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; }).on('end', () => {
            seen.push({ path: req.url, key: req.headers.apikey, auth: req.headers.authorization || null });
            res.setHeader('Content-Type', 'application/json');
            if (req.url === '/login') return res.end(JSON.stringify({ data: { token: 'jwt-' + req.headers.apikey } }));
            if (req.url === '/contact/resolve-by-phone') return res.end(JSON.stringify({ data: { receiver_id: 7 } }));
            res.end(JSON.stringify({ success: true }));
        });
    });
    await new Promise((r) => srv.listen(0, r));
    const keys = { MAZBOT_BASE_URL: `http://127.0.0.1:${srv.address().port}`, MAZBOT_API_KEY: 'OLD', MAZBOT_STAFF_EMAIL: 'o@x', MAZBOT_STAFF_PASSWORD: 'p',
        MAZBOT_TEMPLATE_ID: '1', MAZBOT_TEMPLATES_API_KEY: 'NEW', MAZBOT_TEMPLATES_STAFF_EMAIL: 'n@x', MAZBOT_TEMPLATES_STAFF_PASSWORD: 'p' };
    const before = Object.fromEntries(Object.keys(keys).map((k) => [k, process.env[k]]));
    Object.assign(process.env, keys);
    t.after(() => { srv.close(); for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
    const mazbot = require('../src/mazbot');
    mazbot._reset();

    assert.equal(mazbot.isConfigured(), true);
    const calc = await mazbot.sendToAll(['96876979066'], ['a'], 'rolling_shutter');
    assert.equal(calc.sent, 1);
    assert.equal((await mazbot.sendTemplateTo('96891234567', ['x'], '9')).ok, true);
    assert.equal((await mazbot.sendTextToPhone('96891234567', 'مرحبا')).ok, true);

    const sends = seen.filter((s) => s.path === '/whatsapp/send-template');
    assert.deepEqual(sends.map((s) => [s.key, s.auth]), [['NEW', 'Bearer jwt-NEW'], ['NEW', 'Bearer jwt-NEW']], 'both templates: the templates account');
    const text = seen.find((s) => s.path === '/send-message');
    assert.deepEqual([text.key, text.auth], ['OLD', 'Bearer jwt-OLD'], 'the plain message: the main account');
});

test('a pasted value with spaces or quotes still signs in; a refused sign-in says which account and why', async (t) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; }).on('end', () => {
            seen.push({ path: req.url, key: req.headers.apikey });
            res.setHeader('Content-Type', 'application/json');
            if (req.url === '/login' && req.headers.apikey === 'GOOD') return res.end(JSON.stringify({ data: { token: 'jwt' } }));
            if (req.url === '/login') { res.statusCode = 401; return res.end(JSON.stringify({ success: false, message: 'Invalid API key' })); }
            res.end(JSON.stringify({ success: true }));
        });
    });
    await new Promise((r) => srv.listen(0, r));
    const keys = { MAZBOT_BASE_URL: `http://127.0.0.1:${srv.address().port}`, MAZBOT_API_KEY: ' "GOOD"\n', MAZBOT_STAFF_EMAIL: ' o@x ', MAZBOT_STAFF_PASSWORD: 'p',
        MAZBOT_TEMPLATES_API_KEY: 'WRONG', MAZBOT_TEMPLATES_STAFF_EMAIL: 'n@x', MAZBOT_TEMPLATES_STAFF_PASSWORD: '' };
    const before = Object.fromEntries(Object.keys(keys).map((k) => [k, process.env[k]]));
    Object.assign(process.env, keys);
    t.after(() => { srv.close(); for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
    const mazbot = require('../src/mazbot');
    mazbot._reset();

    // Spaces, a new line and quotes around the key are not part of it
    assert.deepEqual(await mazbot.checkLogin(), { ok: true });
    assert.equal(seen.at(-1).key, 'GOOD');
    const tpl = mazbot.templatesAccount().client;
    // A missing value is named
    assert.deepEqual(await tpl.checkLogin(), { ok: false, error: 'missing', missing: ['MAZBOT_TEMPLATES_STAFF_PASSWORD'] });
    // Refused: the account and MazBot's words
    process.env.MAZBOT_TEMPLATES_STAFF_PASSWORD = 'p';
    const r = await tpl.checkLogin();
    assert.equal(r.ok, false);
    assert.equal(r.error, 'login_failed_http_401 (حساب القوالب): Invalid API key');
});
