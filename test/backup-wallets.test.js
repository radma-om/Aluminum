/* The Excel backup carries the petty cash books, requests and receipt photos (split into
   pieces that fit an Excel cell), and restores them; a copy without photos keeps the current ones. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { openDatabase, getSettings } = require('../src/db');
const { exportWorkbook, restoreWorkbook } = require('../src/backup');
const wallets = require('../src/wallets');
const staff = require('../src/staff');

const boss = { manager: true, name: 'المدير' };
function populate(db) {
    wallets.ensureTables(db);
    const tech = staff.create(db, { username: 'tech1', display_name: 'فني', password: 'tech-pass-12', role: 'technician' });
    const settings = getSettings(db);
    wallets.add(db, tech.id, { kind: 'receive', amount: 50, details: 'عهدة' }, boss, settings);
    const spend = wallets.add(db, tech.id, { kind: 'expense', amount: 4, category: 'بترول', details: 'بترول' }, { id: tech.id, name: 'فني' }, settings);
    // A photo bigger than one Excel cell after Base64 (≈ 3 pieces)
    const photo = crypto.randomBytes(70_000);
    wallets.saveReceipt(db, spend.entry.id, 'image/jpeg', photo);
    wallets.request(db, tech.id, { amount: 30, reason: 'قطع' });
    db.prepare('UPDATE staff_users SET wallet_min = 20 WHERE id = ?').run(tech.id);
    return { tech, spend, photo };
}
const rows = (db, t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all();

test('export → restore keeps wallet entries, requests, limits and the exact receipt photo', async () => {
    const src = openDatabase(':memory:');
    const { tech, spend, photo } = populate(src);
    const file = await exportWorkbook(src);

    const dst = openDatabase(':memory:');
    const counts = await restoreWorkbook(dst, file);
    assert.equal(counts.wallet_entries, 2);
    assert.equal(counts.wallet_requests, 1);
    assert.equal(counts.wallet_receipts, 1);
    assert.deepEqual(rows(dst, 'wallet_entries'), rows(src, 'wallet_entries'));
    assert.deepEqual(rows(dst, 'wallet_requests'), rows(src, 'wallet_requests'));
    assert.equal(wallets.balanceOf(dst, tech.id), 46);
    assert.equal(dst.prepare('SELECT wallet_min FROM staff_users WHERE id = ?').get(tech.id).wallet_min, 20);
    const back = wallets.receipt(dst, spend.entry.id);
    assert.equal(back.mime, 'image/jpeg');
    assert.ok(Buffer.from(back.data).equals(photo), 'the photo is restored byte for byte');
});

test('a copy without photos (too big for email) keeps the current photos on restore', async () => {
    const db = openDatabase(':memory:');
    const { spend, photo } = populate(db);
    const light = await exportWorkbook(db, { receipts: false });
    const full = await exportWorkbook(db);
    assert.ok(light.length < full.length);
    const counts = await restoreWorkbook(db, light);
    assert.equal(counts.wallet_receipts, undefined);
    assert.ok(Buffer.from(wallets.receipt(db, spend.entry.id).data).equals(photo));
    assert.equal(db.prepare('SELECT has_receipt FROM wallet_entries WHERE id = ?').get(spend.entry.id).has_receipt, 1);

    // Restored into another database, the entry no longer claims a photo it does not have
    const other = openDatabase(':memory:');
    await restoreWorkbook(other, light);
    assert.equal(other.prepare('SELECT has_receipt FROM wallet_entries WHERE id = ?').get(spend.entry.id).has_receipt, 0);
    assert.equal(wallets.receipt(other, spend.entry.id), null);
});

test('an older backup without wallet sheets keeps the current books', async () => {
    const old = openDatabase(':memory:');
    const file = await exportWorkbook(old);
    // Drop the wallet sheets to imitate a file made before 3.42.0
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(file);
    for (const name of ['طلبات العهدة', 'دفاتر العهدة', 'صور الإيصالات']) wb.removeWorksheet(wb.getWorksheet(name).id);
    const oldFile = Buffer.from(await wb.xlsx.writeBuffer());

    const db = openDatabase(':memory:');
    populate(db);
    const before = rows(db, 'wallet_entries').length;
    await restoreWorkbook(db, oldFile);
    assert.equal(rows(db, 'wallet_entries').length, before);
});
