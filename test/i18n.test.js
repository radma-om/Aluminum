/* English for the admin panel: every Arabic text written in admin.html has an English entry,
   the language is chosen per account, and the page loads the dictionary before anything is drawn. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/server');
const { codeFor } = require('./two-step-helper');

process.env.ADMIN_TOKEN = 'test-token';
const pub = path.join(__dirname, '..', 'public');
const ARABIC = /[؀-ۿ]/;
const norm = (s) => s.replace(/\s+/g, ' ').trim();
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

function dictionary() {
    const ctx = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(pub, 'admin-i18n-en.js'), 'utf8'), ctx);
    return ctx.window;
}

test('every Arabic text in admin.html has an English translation', () => {
    const { I18N_EN } = dictionary();
    const html = fs.readFileSync(path.join(pub, 'admin.html'), 'utf8')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(script|style|textarea)\b[\s\S]*?<\/\1>/g, '');
    const texts = new Set();
    for (const m of html.matchAll(/>([^<>]+)</g)) {
        const v = norm(decode(m[1]));
        if (ARABIC.test(v)) texts.add(v);
    }
    for (const m of html.matchAll(/\s(?:placeholder|title|aria-label|alt)="([^"]*)"/g)) {
        const v = norm(decode(m[1]));
        if (ARABIC.test(v)) texts.add(v);
    }
    const missing = [...texts].filter((v) => !Object.hasOwn(I18N_EN, v) && !Object.hasOwn(I18N_EN, v.replace(/\s*[:：*…]+$/, '')));
    assert.deepEqual(missing, [], 'add these to public/admin-i18n-en.js');
    assert.ok(texts.size > 500);
    for (const [ar, en] of Object.entries(I18N_EN)) assert.ok(en && !ARABIC.test(en) || ar === 'رادما', `${ar} → ${en}`);
});

test('the language scripts load in <head>, before the page is drawn', () => {
    const html = fs.readFileSync(path.join(pub, 'admin.html'), 'utf8');
    const head = html.slice(0, html.indexOf('</head>'));
    assert.ok(head.indexOf('admin-i18n-en.js') > 0 && head.indexOf('admin-i18n-en.js') < head.indexOf('admin-i18n.js'));
    for (const f of fs.readdirSync(pub).filter((n) => /^admin.*\.js$/.test(n) && n !== 'admin-i18n.js')) {
        assert.ok(!fs.readFileSync(path.join(pub, f), 'utf8').includes("'ar-OM'"), `${f}: use APP_LOCALE`);
    }
});

test('patterns translate texts with numbers inside', () => {
    const { I18N_EN_PATTERNS } = dictionary();
    const tr = (s) => { for (const [re, to] of I18N_EN_PATTERNS) { const m = s.match(re); if (m) return typeof to === 'function' ? to(...m) : s.replace(re, to); } return null; };
    assert.equal(tr('30 يوماً'), '30 days');
    assert.equal(tr('3 فاتورة — لا شيء أمس أيضاً'), '3 invoices — nothing yesterday either');
    assert.equal(tr('12.500 ر.ع'), '12.500 OMR');
});

test('each staff account keeps its own language', async (t) => {
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = 'test-token') => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json() };
    };
    assert.equal((await call('POST', '/api/admin/users', { username: 'salem', display_name: 'سالم', password: 'salem-pass-1', permissions: ['leads'] })).status, 201);
    const signIn = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'salem', password: 'salem-pass-1', code: codeFor(db, 'salem') }) });
    const token = (await signIn.json()).token;

    assert.equal((await call('GET', '/api/admin/me', null, token)).body.user.lang, 'ar');
    assert.deepEqual((await call('PUT', '/api/admin/me/lang', { lang: 'en' }, token)).body, { lang: 'en' });
    assert.equal((await call('GET', '/api/admin/me', null, token)).body.user.lang, 'en');
    // Anything else falls back to Arabic
    await call('PUT', '/api/admin/me/lang', { lang: 'fr' }, token);
    assert.equal((await call('GET', '/api/admin/me', null, token)).body.user.lang, 'ar');
    // The general manager (no account row) is answered without error
    assert.equal((await call('PUT', '/api/admin/me/lang', { lang: 'en' })).status, 200);
});
