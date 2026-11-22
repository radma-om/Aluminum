/* The greeting on the customer calculators: off by default; on with its wording until its last day; a new
   wording is a new greeting (its id changes); the preview shows it even when off; managers only set it. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase, saveSettings } = require('../src/db');
const { createApp } = require('../src/server');

process.env.ADMIN_TOKEN = 'test-token-long-enough-1234';

test('the greeting: off, on, ended, a new wording, the preview, and the limits', async (t) => {
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (q = '') => (await (await fetch(`${base}/api/public/greeting${q}`)).json()).greeting;

    assert.equal(await get(), null, 'off by default');
    const preview = await get('?preview=1');
    assert.equal(preview.title, 'كل عام وعُمان بخير', 'the preview shows the saved wording even when off');

    saveSettings(db, { greeting_enabled: true });
    const on = await get();
    assert.deepEqual([on.title, on.text], ['كل عام وعُمان بخير', 'ردما للبوابات الإلكترونية تهنئكم باليوم الوطني المجيد']);
    assert.match(on.id, /^[0-9a-f]{12}$/);
    saveSettings(db, { greeting_text: 'نص آخر' });
    assert.notEqual((await get()).id, on.id, 'a new wording: shown again');

    saveSettings(db, { greeting_until: '2020-01-01' });
    assert.equal(await get(), null, 'its last day has passed');
    saveSettings(db, { greeting_until: '2099-12-31' });
    assert.ok(await get());

    assert.throws(() => saveSettings(db, { greeting_title: 'ع'.repeat(61) }), /60/);
    assert.throws(() => saveSettings(db, { greeting_until: '30-11-2026' }), /تاريخ/);
    // The calculators load it (and the fireworks) from calc-common.js
    const js = await (await fetch(`${base}/calc-common.js`)).text();
    assert.match(js, /\/api\/public\/greeting/);
    assert.match(js, /prefers-reduced-motion/);
});
