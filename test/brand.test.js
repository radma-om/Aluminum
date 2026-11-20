/* The company's name «ردما للبوابات الإلكترونية»: the default, and the old names renamed once on start
   (a name the manager typed is kept as it is). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase, getSettings, saveSettings } = require('../src/db');

const BRAND = 'ردما للبوابات الإلكترونية';

test('the default name, and the old ones renamed on start; a name typed by the manager is kept', () => {
    assert.equal(getSettings(openDatabase(':memory:')).company_name, BRAND);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-'));
    const file = path.join(dir, 'a.db');
    for (const old of ['رادما', 'ردما', 'مصنع شرائح الألمنيوم']) {
        saveSettings(openDatabase(file), { company_name: old });
        assert.equal(getSettings(openDatabase(file)).company_name, BRAND, old);
    }
    saveSettings(openDatabase(file), { company_name: 'شركة أخرى' });
    assert.equal(getSettings(openDatabase(file)).company_name, 'شركة أخرى');
    fs.rmSync(dir, { recursive: true, force: true });
});
