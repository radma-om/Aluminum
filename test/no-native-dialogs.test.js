/* The panel never uses the browser's prompt() / confirm(): once the user ticks «منع هذه الصفحة من إنشاء نوافذ
   حوار إضافية», they return nothing and the action (assigning a customer, a payment, a cancellation) silently stops.
   The in-app dialogs (admin-dialog.js: askText / askYes / tell) are used instead. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('no browser prompt() / confirm() in the admin panel; the in-app dialog is loaded first', () => {
    const dir = path.join(__dirname, '..', 'public');
    const files = fs.readdirSync(dir).filter((f) => /^admin.*\.js$/.test(f) && f !== 'admin-dialog.js').concat(['admin.html']);
    for (const f of files) {
        const code = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        const found = code.match(/(?<![\w.])(prompt|confirm)\(/g);
        assert.equal(found, null, `${f}: ${found}`);
    }
    const html = fs.readFileSync(path.join(dir, 'admin.html'), 'utf8');
    assert.ok(html.indexOf('admin-dialog.js') < html.indexOf('src="admin.js"'), 'loaded before the other scripts');
});
