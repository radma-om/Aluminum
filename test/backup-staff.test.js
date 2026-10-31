const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { openDatabase } = require('../src/db');
const { createApp, saveQuote } = require('../src/server');
const { exportWorkbook, restoreWorkbook } = require('../src/backup');
const leads = require('../src/leads');
const staff = require('../src/staff');

process.env.ADMIN_TOKEN = 'test-token';
process.env.BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'radma-backup-staff-'));

async function start(db = openDatabase(':memory:')) {
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, body, token = 'test-token', headers = {}) => {
        const res = await fetch(base + url, {
            method, body: Buffer.isBuffer(body) ? body : body ? JSON.stringify(body) : undefined,
            headers: { 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }
        });
        const ct = res.headers.get('content-type') || '';
        return { status: res.status, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
    };
    const login = async (username, password) => {
        const r = await call('POST', '/api/auth/login', { username, password }, null);
        assert.strictEqual(r.status, 200, JSON.stringify(r.body));
        return r.body.token;
    };
    return { db, server, call, login };
}

const priced = (total) => ({ items: [{ name: 'بند', quantity: 1, unit_price: total, line_total: total }], subtotal: total, vat_percent: 5, vat: 0, total });
const count = (db, t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;

/* A database with staff, customers, their messages, notes and quotes, a webhook with deliveries, and sessions */
function populate(db) {
    staff.create(db, { username: 'salem', display_name: 'سالم', password: 'salem-secret-1', permissions: ['leads', 'quotes'], leads_scope: 'mine' });
    staff.create(db, { username: 'boss', display_name: 'أحمد', password: 'boss-secret-12', role: 'manager' });
    saveQuote(db, { customer_name: 'محمد', customer_phone: '99887897', source: 'web', priced: priced(120) });
    const lead = leads.customerMessage(db, { key: 'tel:96899887897', channel: 'whatsapp', name: 'محمد', phone: '96899887897', text: 'أريد مكينة بوابة' });
    leads.assistantMessage(db, 'tel:96899887897', 'كم وزن البوابة؟');
    leads.update(db, lead.id, { assigned_to: 'سالم', status: 'following', next_follow_up: '2026-11-10' }, 'المدير العام');
    leads.addNote(db, lead.id, { kind: 'report', text: 'اتصلت بالعميل' }, 'سالم');
    leads.addNote(db, lead.id, { kind: 'recommendation', text: 'مكينة 600 كجم' }, 'سالم');
    const hook = Number(db.prepare("INSERT INTO webhooks (name, url, events) VALUES ('CRM', 'https://example.com/h', '*')").run().lastInsertRowid);
    db.prepare("INSERT INTO webhook_deliveries (webhook_id, event, status_code, ok) VALUES (?, 'quote.created', 200, 1)").run(hook);
    staff.login(db, 'salem', 'salem-secret-1');
    return lead;
}

test('export → restore into an empty database keeps staff, permissions, customers, messages, notes and quotes', async (t) => {
    const src = openDatabase(':memory:');
    populate(src);
    const file = await exportWorkbook(src);

    // The file holds password hashes only, never a password or a session
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file);
    const allText = [];
    wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => allText.push(String(c.value ?? '')))));
    assert.ok(!allText.some((v) => v.includes('salem-secret-1') || v.includes('boss-secret-12')), 'plain password in backup');
    assert.ok(allText.some((v) => /^scrypt\$/.test(v)), 'password hash saved');
    assert.ok(wb.getWorksheet('حسابات الموظفين') && wb.getWorksheet('متابعة العملاء') && wb.getWorksheet('رسائل العملاء') && wb.getWorksheet('تقارير المتابعة'));
    assert.ok(!wb.getWorksheet('staff_sessions'));

    const dst = openDatabase(':memory:');
    assert.strictEqual(count(dst, 'staff_users'), 0);
    const counts = await restoreWorkbook(dst, file);
    assert.deepStrictEqual([counts.staff_users, counts.leads, counts.lead_messages, counts.lead_notes, counts.quotes],
        [2, 1, count(src, 'lead_messages'), count(src, 'lead_notes'), 1]);

    const { server, call, login } = await start(dst);
    t.after(() => server.close());
    // Accounts work with their original passwords, with the same sections and scope
    const token = await login('salem', 'salem-secret-1');
    const me = (await call('GET', '/api/admin/me', null, token)).body.user;
    assert.deepStrictEqual([me.display_name, me.permissions, me.leads_scope], ['سالم', ['leads', 'quotes'], 'mine']);
    assert.strictEqual((await call('GET', '/api/admin/dashboard', null, token)).status, 403);
    assert.ok(await login('boss', 'boss-secret-12'));
    // The follow-up is complete
    const list = (await call('GET', '/api/admin/leads', null, token)).body.leads;
    assert.strictEqual(list.length, 1);
    const detail = (await call('GET', `/api/admin/leads/${list[0].id}`, null, token)).body;
    assert.strictEqual(detail.lead.assigned_to, 'سالم');
    assert.deepStrictEqual(detail.notes.map((n) => n.kind), ['recommendation', 'report', 'handover']);
    assert.ok(detail.messages.some((m) => m.role === 'assistant' && m.text === 'كم وزن البوابة؟'));
    assert.strictEqual(detail.quotes.length, 1);
    // No sessions or delivery logs came along; nothing points at a missing row
    assert.strictEqual(count(dst, 'webhook_deliveries'), 0);
    assert.strictEqual(count(dst, 'webhooks'), 1);
    assert.deepStrictEqual(dst.prepare('PRAGMA foreign_key_check').all(), []);
});

test('a successful restore signs everyone out; backups are for managers only', async (t) => {
    const { db, server, call, login } = await start();
    t.after(() => server.close());
    populate(db);
    const salem = await login('salem', 'salem-secret-1');
    const boss = await login('boss', 'boss-secret-12');
    staff.create(db, { username: 'allsections', display_name: 'خالد', password: 'khalid-secret', permissions: Object.keys(staff.SECTIONS) });
    const khalid = await login('allsections', 'khalid-secret');

    // Every section is not enough: backup and restore need a manager
    assert.strictEqual((await call('GET', '/api/admin/backup.xlsx', null, khalid)).status, 403);
    assert.strictEqual((await call('POST', '/api/admin/restore', Buffer.from('x'), khalid, { 'X-Confirm-Restore': 'yes' })).status, 403);
    assert.strictEqual((await call('GET', '/api/admin/backups', null, khalid)).status, 403);
    assert.strictEqual((await call('GET', '/api/admin/backup.xlsx', null, null)).status, 401);

    const file = (await call('GET', '/api/admin/backup.xlsx', null, boss)).body;
    const r = await call('POST', '/api/admin/restore', file, boss, { 'X-Confirm-Restore': 'yes' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.signed_out, true);
    assert.ok(r.body.saved_before_restore);
    for (const token of [salem, boss]) assert.strictEqual((await call('GET', '/api/admin/me', null, token)).status, 401);
    assert.strictEqual(count(db, 'staff_sessions'), 0);
    // The general manager's ADMIN_TOKEN is not a session and keeps working
    assert.strictEqual((await call('GET', '/api/admin/me')).status, 200);
    assert.ok(await login('salem', 'salem-secret-1'));
});

/* An older backup: remove the sheets added in 3.5.0 / 3.3.0 */
async function withoutSheets(file, names) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file);
    for (const n of names) wb.removeWorksheet(wb.getWorksheet(n).id);
    return Buffer.from(await wb.xlsx.writeBuffer());
}

test('an old backup without staff and follow-up sheets keeps the current accounts and customers', async () => {
    const db = openDatabase(':memory:');
    const old = await withoutSheets(await exportWorkbook(db), ['حسابات الموظفين', 'متابعة العملاء', 'رسائل العملاء', 'تقارير المتابعة']);
    populate(db);
    const before = ['staff_users', 'leads', 'lead_messages', 'lead_notes'].map((t) => count(db, t));
    const counts = await restoreWorkbook(db, old);
    assert.ok(!('staff_users' in counts) && !('leads' in counts));
    assert.deepStrictEqual(['staff_users', 'leads', 'lead_messages', 'lead_notes'].map((t) => count(db, t)), before);
    assert.strictEqual(count(db, 'staff_sessions'), 0); // sessions still end
    assert.strictEqual(count(db, 'quotes'), 0); // the old file's quotes (none) replaced the current ones
    assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('an inconsistent file is refused and the current data stays exactly as it was', async () => {
    const db = openDatabase(':memory:');
    populate(db);
    const snapshot = () => ['staff_users', 'staff_sessions', 'leads', 'lead_messages', 'lead_notes', 'quotes', 'webhooks', 'webhook_deliveries', 'shutter_types']
        .map((t) => count(db, t));
    const before = snapshot();
    const good = await exportWorkbook(db);

    // Messages pointing at a customer that is not in the file
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(good);
    const ws = wb.getWorksheet('رسائل العملاء');
    const leadCol = ws.getRow(1).values.indexOf('lead_id');
    ws.getRow(2).getCell(leadCol).value = 9999;
    const broken = Buffer.from(await wb.xlsx.writeBuffer());
    await assert.rejects(restoreWorkbook(db, broken), (e) => e.status === 400 && /غير مترابطة/.test(e.message));
    assert.deepStrictEqual(snapshot(), before);

    // Customers without their messages / notes sheets
    const partial = await withoutSheets(good, ['تقارير المتابعة']);
    await assert.rejects(restoreWorkbook(db, partial), (e) => e.status === 400 && /تقارير المتابعة/.test(e.message));
    assert.deepStrictEqual(snapshot(), before);

    // An account whose password is not a hash
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(good);
    const us = wb2.getWorksheet('حسابات الموظفين');
    us.getRow(2).getCell(us.getRow(1).values.indexOf('password_hash')).value = 'plain-password';
    await assert.rejects(restoreWorkbook(db, Buffer.from(await wb2.xlsx.writeBuffer())), (e) => e.status === 400 && /تجزئة/.test(e.message));
    assert.deepStrictEqual(snapshot(), before);
});
