/* =============================================================
   Database backup as an Excel file, and restore from it.
   - One sheet per table (Arabic sheet names; row 1 = column names).
   - Restore replaces all the data in one transaction; a copy of the
     current data is saved first, so a restore can always be undone.
   - Automatic daily backups are kept next to the database file.
   - Staff accounts are saved with their password HASHES only (never a
     password, never an environment secret, never a two-step sign-in
     secret); login sessions are not saved, and every session ends after a
     successful restore. Accounts and outgoing Webhooks keep their current
     live secrets when a backup is restored.
   Petty cash books and requests are saved, and the receipt photos in their
   own sheet (Base64 in pieces); a file without that sheet keeps the current photos.
   Logs (webhook deliveries, incoming webhook requests, AI conversation
   history, temporary agent pauses) are not included; the webhook delivery
   log is emptied when the webhooks are replaced, so it never points at a
   webhook of another backup.
   ============================================================= */
const fs = require('node:fs');
const path = require('node:path');
// Loaded when a backup is made or read, not at start (it is the heaviest library)
let excel = null;
const xl = () => (excel = excel || require('exceljs'));
const { resolveDbPath } = require('./db');

/* Parents before children (insert order); delete runs in reverse */
const TABLES = [
    ['settings', 'الإعدادات'],
    ['products', 'المنتجات'],
    ['purchases', 'المشتريات'],
    ['price_history', 'سجل الأسعار'],
    ['quotes', 'عروض الأسعار'],
    ['invoices', 'الفواتير'],
    ['payments', 'الدفعات'],
    ['invoice_revisions', 'تعديلات الفواتير'],
    ['work_orders', 'أوامر العمل'],
    ['work_order_events', 'سجل أوامر العمل'],
    ['service_requests', 'طلبات المواعيد'],
    ['webhooks', 'Webhooks'],
    ['shutter_types', 'أنواع البوابات'],
    ['shutter_variants', 'السماكات'],
    ['shutter_colors', 'الألوان'],
    ['accessory_groups', 'مجموعات الإكسسوارات'],
    ['accessory_options', 'فئات الإكسسوارات'],
    ['governorates', 'المحافظات'],
    ['regions', 'الولايات'],
    ['overhead_sizes', 'مقاسات الأوفرهيد'],
    ['overhead_motors', 'محركات الأوفرهيد'],
    ['overhead_types', 'أوصاف أنواع الأوفرهيد'],
    ['bonus_months', 'المكافآت المعتمدة'],
    ['knowledge_items', 'قاعدة المعرفة'],
    ['motor_sections', 'أقسام المكائن'],
    ['motor_items', 'مكائن البوابات'],
    ['motor_extra_fees', 'رسوم المكائن الإضافية'],
    ['staff_users', 'حسابات الموظفين'],
    ['wallet_requests', 'طلبات العهدة'],
    ['wallet_entries', 'دفاتر العهدة'],
    ['customers', 'العملاء'],
    ['leads', 'متابعة العملاء'],
    ['lead_assignments', 'سجل إسناد المتابعة'],
    ['lead_messages', 'رسائل العملاء'],
    ['lead_notes', 'تقارير المتابعة'],
    ['customer_external_refs', 'أرقام العملاء في الأنظمة الأخرى']
];
/* Sheets added after the first backups: an older file without them keeps the current data */
const OPTIONAL = new Set(['invoice_revisions', 'overhead_sizes', 'overhead_motors', 'overhead_types', 'bonus_months', 'knowledge_items', 'motor_sections', 'motor_items', 'motor_extra_fees',
    'staff_users', 'leads', 'lead_assignments', 'lead_messages', 'lead_notes', 'invoices', 'payments', 'work_orders', 'work_order_events', 'customers', 'service_requests',
    'wallet_requests', 'wallet_entries', 'customer_external_refs']);
/* Restored together or not at all (a customer without its messages, or messages of another
   backup's customers, would be inconsistent) */
const GROUPS = [['leads', 'lead_messages', 'lead_notes'], ['invoices', 'payments'], ['work_orders', 'work_order_events'], ['wallet_requests', 'wallet_entries']];
const INFO_SHEET = 'معلومات';
/* Receipt photos (wallet_receipts) are images: each one is written as Base64 text in pieces of
   at most 30,000 characters (an Excel cell holds 32,767), one piece per row, joined on restore. */
const RECEIPTS_SHEET = 'صور الإيصالات';
const PIECE = 30000;
const err400 = (message) => Object.assign(new Error(message), { status: 400 });

/* Never written to the file: two-step sign-in and outgoing Webhook secrets (a copy sent by email
   must not carry them). A restore keeps the current live secret when the same record is present. */
const NOT_EXPORTED = {
    staff_users: new Set(['totp_secret', 'totp_pending', 'totp_last_step']),
    // A backup may be emailed or copied outside the server. Webhook HMAC
    // secrets must never leave the live database in that file.
    webhooks: new Set(['secret'])
};
const columnsOf = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
const exportedColumns = (db, table) => columnsOf(db, table).filter((c) => !(NOT_EXPORTED[table] && NOT_EXPORTED[table].has(c)));

async function exportWorkbook(db, { receipts = true } = {}) {
    require('./wallets').ensureTables(db);
    const wb = new (xl().Workbook)();
    wb.creator = 'Radma pricing';
    wb.created = new Date();
    const info = wb.addWorksheet(INFO_SHEET, { views: [{ rightToLeft: true }] });
    info.columns = [{ header: 'البيان', width: 28 }, { header: 'القيمة', width: 40 }];
    info.addRow(['نسخة احتياطية من قاعدة البيانات', new Date().toISOString().replace('T', ' ').slice(0, 19)]);
    info.addRow(['إصدار النظام', require('../package.json').version]);
    info.addRow(['تنبيه', 'لا تغيّر أسماء الأوراق ولا الصف الأول (أسماء الأعمدة) إذا أردت الاستعادة من هذا الملف']);
    info.getRow(1).font = { bold: true };

    for (const [table, label] of TABLES) {
        const cols = exportedColumns(db, table);
        const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
        info.addRow([label, `${rows.length} سجل`]);
        const ws = wb.addWorksheet(label, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
        ws.columns = cols.map((c) => ({ header: c, key: c, width: Math.min(40, Math.max(12, c.length + 4)) }));
        ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };
        for (const row of rows) ws.addRow(cols.map((c) => row[c]));
    }
    if (receipts) {
        const photos = db.prepare('SELECT entry_id, mime, data FROM wallet_receipts ORDER BY entry_id').all();
        info.addRow([RECEIPTS_SHEET, `${photos.length} صورة`]);
        const ws = wb.addWorksheet(RECEIPTS_SHEET, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
        ws.columns = [{ header: 'entry_id', key: 'entry_id', width: 12 }, { header: 'mime', key: 'mime', width: 14 },
            { header: 'part', key: 'part', width: 8 }, { header: 'data', key: 'data', width: 60 }];
        ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E40AF' } };
        for (const p of photos) {
            const b64 = Buffer.from(p.data).toString('base64');
            for (let i = 0, part = 1; i < b64.length; i += PIECE, part++) ws.addRow([p.entry_id, p.mime, part, b64.slice(i, i + PIECE)]);
        }
    } else {
        info.addRow([RECEIPTS_SHEET, 'غير مضمّنة في هذه النسخة (الحجم) — تبقى الصور الحالية عند الاستعادة']);
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
}

/* Excel cell → SQLite value (empty → NULL; dates, links, rich text → text) */
function cellValue(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19);
    if (typeof v === 'object') {
        if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
        if ('result' in v) return cellValue(v.result);
        if ('text' in v) return cellValue(v.text);
        return JSON.stringify(v);
    }
    return v;
}

async function readWorkbook(buffer) {
    const wb = new (xl().Workbook)();
    try { await wb.xlsx.load(buffer); } catch { throw err400('الملف ليس ملف Excel صالحاً'); }
    const missing = TABLES.filter(([table, label]) => !OPTIONAL.has(table) && !wb.getWorksheet(label) && !wb.getWorksheet(table))
        .map(([, label]) => label);
    if (missing.length) throw err400('الملف ليس نسخة احتياطية من النظام — أوراق ناقصة: ' + missing.join('، '));
    const data = {};
    for (const [table, label] of TABLES) {
        const ws = wb.getWorksheet(label) || wb.getWorksheet(table);
        if (!ws) continue; // optional sheet missing
        const header = [];
        ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => { header[col] = String(cellValue(cell.value) ?? '').trim(); });
        const rows = [];
        ws.eachRow({ includeEmpty: false }, (row, n) => {
            if (n === 1) return;
            const obj = {};
            header.forEach((name, col) => { if (name) obj[name] = cellValue(row.getCell(col).value); });
            if (Object.values(obj).some((v) => v != null)) rows.push(obj);
        });
        data[table] = { header: header.filter(Boolean), rows };
    }
    const photos = wb.getWorksheet(RECEIPTS_SHEET);
    if (photos) {
        const byEntry = new Map();
        photos.eachRow({ includeEmpty: false }, (row, n) => {
            if (n === 1) return;
            const id = Number(cellValue(row.getCell(1).value));
            const mime = String(cellValue(row.getCell(2).value) || '');
            const part = Number(cellValue(row.getCell(3).value));
            const text = String(cellValue(row.getCell(4).value) || '');
            if (!Number.isInteger(id) || id <= 0 || !/^image\/(jpeg|png|webp)$/.test(mime) || !text) return;
            if (!byEntry.has(id)) byEntry.set(id, { mime, parts: [] });
            byEntry.get(id).parts.push([part, text]);
        });
        data.wallet_receipts = [...byEntry].map(([entry_id, p]) => ({
            entry_id, mime: p.mime,
            data: Buffer.from(p.parts.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(''), 'base64')
        }));
    }
    return data;
}

/* Replace all the data with the workbook's; all-or-nothing */
async function restoreWorkbook(db, buffer) {
    require('./wallets').ensureTables(db);
    const data = await readWorkbook(buffer);
    if (!data.settings.rows.length) throw err400('ورقة الإعدادات فارغة — الملف غير صالح للاستعادة');
    for (const group of GROUPS) {
        const have = group.filter((t) => data[t]);
        if (have.length && have.length !== group.length) {
            const label = (t) => TABLES.find(([x]) => x === t)[1];
            throw err400('الملف غير متسق: أوراق متابعة العملاء يجب أن تكون معاً — ناقص: ' + group.filter((t) => !data[t]).map(label).join('، '));
        }
    }
    const counts = {};
    db.exec('PRAGMA foreign_keys = OFF');
    try {
        db.exec('BEGIN');
        try {
            const present = TABLES.filter(([table]) => data[table]);
            // Logs and sessions that point at rows being replaced
            if (data.webhooks) db.prepare('DELETE FROM webhook_deliveries').run();
            db.prepare('DELETE FROM staff_sessions').run(); // everyone signs in again after a restore
            const twoStep = data.staff_users
                ? db.prepare('SELECT username, totp_secret, totp_last_step FROM staff_users WHERE totp_secret IS NOT NULL').all() : [];
            const webhookSecrets = data.webhooks
                ? db.prepare('SELECT id, name, url, secret FROM webhooks WHERE secret IS NOT NULL').all() : [];
            for (const [table] of [...present].reverse()) db.prepare(`DELETE FROM ${table}`).run();
            // Assignment history was added after the first follow-up backups. If an older
            // file contains leads but no assignment sheet, remove the current history too;
            // otherwise it would refer to the newly restored (different) lead IDs.
            if (data.leads && !data.lead_assignments) db.prepare('DELETE FROM lead_assignments').run();
            for (const [table, label] of present) {
                const cols = exportedColumns(db, table).filter((c) => data[table].header.includes(c));
                if (!cols.length) throw err400(`ورقة «${label}» لا تحتوي أسماء الأعمدة في الصف الأول`);
                const insert = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
                for (const row of data[table].rows) insert.run(...cols.map((c) => row[c] ?? null));
                counts[table] = data[table].rows.length;
            }
            // Give assigned leads from an old backup one baseline event so the dashboard can
            // still show who currently owns them. Newer backups restore the complete history.
            if (data.leads && !data.lead_assignments) {
                const insert = db.prepare(`INSERT INTO lead_assignments (lead_id, from_employee, to_employee, assigned_by, created_at)
                                           VALUES (?, NULL, ?, ?, COALESCE(?, datetime('now')))`);
                const assigned = db.prepare('SELECT id, assigned_to, assigned_by, assigned_at, last_staff_at, created_at FROM leads WHERE assigned_to IS NOT NULL').all();
                for (const lead of assigned) {
                    insert.run(lead.id, lead.assigned_to, lead.assigned_by || null,
                        lead.assigned_at || lead.last_staff_at || lead.created_at);
                }
            }
            // Receipt photos: replaced by the file's when it carries them; otherwise the current
            // photos stay, only for entries that still exist. «has_receipt» follows what is kept.
            if (data.wallet_receipts) {
                db.prepare('DELETE FROM wallet_receipts').run();
                const put = db.prepare('INSERT INTO wallet_receipts (entry_id, mime, data) VALUES (?, ?, ?)');
                for (const r of data.wallet_receipts) put.run(r.entry_id, r.mime, r.data);
                counts.wallet_receipts = data.wallet_receipts.length;
            }
            db.prepare('DELETE FROM wallet_receipts WHERE entry_id NOT IN (SELECT id FROM wallet_entries)').run();
            db.prepare('UPDATE wallet_entries SET has_receipt = EXISTS (SELECT 1 FROM wallet_receipts r WHERE r.entry_id = wallet_entries.id)').run();
            const keep2fa = db.prepare('UPDATE staff_users SET totp_secret = ?, totp_last_step = ? WHERE username = ?');
            for (const u of twoStep) keep2fa.run(u.totp_secret, u.totp_last_step, u.username);
            const keepWebhookSecret = db.prepare('UPDATE webhooks SET secret = ? WHERE id = ? AND name = ? AND url = ?');
            for (const hook of webhookSecrets) keepWebhookSecret.run(hook.secret, hook.id, hook.name, hook.url);
            // Motors items from a backup of version 3.0.0 (no sections yet) join the current sections
            require('./motors').linkItems(db);
            const broken = db.prepare('PRAGMA foreign_key_check').all();
            if (broken.length) throw err400(`بيانات غير مترابطة في الملف (مثلاً ${broken[0].table} يشير إلى سجل غير موجود في ${broken[0].parent})`);
            const badRole = data.staff_users && db.prepare("SELECT username FROM staff_users WHERE role NOT IN ('staff', 'manager', 'technician', 'marketer') OR password_hash NOT LIKE 'scrypt$%'").get();
            if (badRole) throw err400(`حساب «${badRole.username}» في الملف غير صالح (الدور أو تجزئة كلمة المرور)`);
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            if (!err.status) throw err400('تعذرت الاستعادة: ' + err.message);
            throw err;
        }
    } finally {
        db.exec('PRAGMA foreign_keys = ON');
    }
    return counts;
}

/* ------------------------- Saved backups on the server ------------------------- */

const DEFAULT_DB = path.join(__dirname, '..', 'data', 'aluminum.db');

function backupDir() {
    if (process.env.BACKUP_DIR) return resolveDbPath(process.env.BACKUP_DIR);
    const file = resolveDbPath(process.env.DB_FILE || DEFAULT_DB);
    return file === ':memory:' ? null : path.join(path.dirname(file), 'backups');
}

const NAME_RE = /^(auto|before-restore|manual)-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.xlsx$/;
const KEEP = { auto: 14, 'before-restore': 10, manual: 10 };

function listBackups() {
    const dir = backupDir();
    if (!dir || !fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((n) => NAME_RE.test(n)).map((name) => {
        const st = fs.statSync(path.join(dir, name));
        return { name, kind: name.split('-2')[0], size: st.size, created_at: st.mtime.toISOString() };
    }).sort((a, b) => b.name.localeCompare(a.name));
}

function backupPath(name) {
    const dir = backupDir();
    if (!dir || !NAME_RE.test(String(name))) return null;
    const file = path.join(dir, name);
    return fs.existsSync(file) ? file : null;
}

async function saveBackup(db, kind) {
    const dir = backupDir();
    if (!dir) return null;
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
    const name = `${kind}-${stamp}.xlsx`;
    fs.writeFileSync(path.join(dir, name), await exportWorkbook(db));
    // Keep only the newest files of this kind
    for (const old of listBackups().filter((b) => b.kind === kind).slice(KEEP[kind])) {
        fs.rmSync(path.join(dir, old.name), { force: true });
    }
    return name;
}

/* One automatic backup a day (checked at start and every hour) */
function scheduleDailyBackups(db) {
    const run = () => {
        const last = listBackups().find((b) => b.kind === 'auto');
        if (last && Date.now() - Date.parse(last.created_at) < 23 * 3600_000) return;
        saveBackup(db, 'auto')
            .then(() => require('./alerts').ok(db, 'backup_local'))
            .catch((err) => { console.error('[backup]', err.message); require('./alerts').fail(db, 'backup_local', err); });
    };
    run();
    setInterval(run, 3600_000).unref();
}

module.exports = { exportWorkbook, restoreWorkbook, listBackups, backupPath, saveBackup, scheduleDailyBackups, TABLES };
