/* «طلب عرض سعر – بوابات ردما» (WhatsApp form, MazBot whatsapp_form.submitted): only signed events, each event id
   once (MazBot retries), the answers read from several shapes of «data», the customer in «متابعة العملاء», the
   inspection request when asked, the other templates events as before, and who may see the submissions.
   No real WhatsApp: no sales numbers are set and the sender is a mock. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { openDatabase, saveSettings } = require('../src/db');
const { createApp } = require('../src/server');
const staff = require('../src/staff');
const forms = require('../src/whatsapp-forms');
const notify = require('../src/order-notify');

const OWNER = 'test-token-long-enough-1234';
process.env.ADMIN_TOKEN = OWNER;
notify.setSenderForTests(async () => ({ ok: true }));
const ENV = { MAZBOT_TEMPLATES_WEBHOOK_SECRET: 'tpl-hook-secret-0123456789', MAZBOT_TEMPLATES_SIGNING_SECRET: 'tpl-signing-secret' };
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));

/* Three shapes MazBot might send — the reading must not depend on one */
const FLAT = { id: 'evt-flat-1', type: 'whatsapp_form.submitted', data: { form_id: 12, contact: { id: 5, phone: '96890000001', name: 'Salem' },
    responses: { 'الاسم': 'سالم الحارثي', 'رقم الجوال': '٩١١١١١١١', 'الولاية / المنطقة': 'السيب', 'نوع البوابة': 'رول شتر',
        'عرض الفتحة (سم)': '٣٥٠', 'ملاحظات': 'بوابة كراج', 'هل تريد زيارة معاينة؟': 'نعم' } } };
const LIST = { id: 'evt-list-2', type: 'whatsapp_form.submitted', data: { form: { id: '12', name: 'طلب عرض سعر – بوابات ردما' }, contact: { phone: '96892222222' },
    answers: [{ question: 'Full name', answer: 'Khalid' }, { question: 'Wilayat / area', answer: 'بوشر' },
        { question: 'Gate type', answer: { id: 'overhead', title: 'أوفرهيد' } }, { question: 'Opening width (cm)', answer: '300 cm' },
        { question: 'Site visit?', answer: 'No' }] } };
const KEYS = { id: 'evt-keys-3', type: 'whatsapp_form.submitted', data: { submission: { fields: [
    { label: 'Name', value: 'منى' }, { label: 'Phone', value: '+968 9333 3333' }, { label: 'Area', value: 'مكان غير معروف' },
    { label: 'Product', value: 'Roller shutter' }, { label: 'Favourite colour', value: 'أبيض' }] } } };

test('reading the answers from three shapes of data', () => {
    const a = forms.extract(FLAT);
    assert.deepEqual(a.unmatched, [], 'the WhatsApp contact is not read as an answer');
    assert.deepEqual({ ...a, unmatched: undefined }, { name: 'سالم الحارثي', phone: '96891111111', region_text: 'السيب', gate_type: 'rolling_shutter',
        width_cm: 350, notes: 'بوابة كراج', inspection: 1, unmatched: undefined });
    const b = forms.extract(LIST);
    assert.equal(b.name, 'Khalid');
    assert.equal(b.phone, '96892222222', 'from the WhatsApp contact');
    assert.equal(b.gate_type, 'overhead');
    assert.equal(b.width_cm, 300);
    assert.equal(b.inspection, 0);
    assert.equal(b.region_text, 'بوشر');
    const c = forms.extract(KEYS);
    assert.equal(c.phone, '96893333333');
    assert.equal(c.gate_type, 'rolling_shutter');
    assert.deepEqual(c.unmatched, [{ label: 'Favourite colour', value: 'أبيض' }], 'kept for the office to see');
    assert.ok(forms.isFormEvent(null, 'whatsapp_form.submitted'), 'by the header too');
    assert.ok(!forms.isFormEvent({ type: 'message.received' }, ''));
});

test('the shape MazBot really sends: {label, value} under each field id, a wilayah in English', () => {
    const real = { id: 'evt-real', type: 'whatsapp_form.submitted', data: { form_id: 12, contact: { id: 7, phone: '96890000002' }, submitted_at: '2026-11-26T11:56:20+02:00',
        responses: { screen_0_TextInput_0: { label: 'الاسم', value: 'Mohammad' }, screen_0_PhoneNumber_1: { label: 'رقم الجوال', value: '76979066' },
            screen_0_TextInput_2: { label: 'الولاية أو المنطقة', value: 'Nizwa' }, screen_1_Dropdown_0: { label: 'نوع البوابة', value: { id: '0_رول_شتر', title: 'رول شتر' } },
            screen_1_Number_1: { label: 'عرض الفتحة بالسم', value: '400' }, screen_1_TextArea_2: { label: 'ملاحظات إضافية', value: '' },
            screen_1_Radio_3: { label: 'هل تريد زيارة معاينة؟', value: '0_نعم' } } } };
    const f = forms.extract(real);
    assert.deepEqual({ ...f }, { name: 'Mohammad', phone: '96876979066', region_text: 'Nizwa', gate_type: 'rolling_shutter', width_cm: 400, notes: null, inspection: 1, unmatched: [] });
    assert.equal(forms.arabicWilayah('Nizwa'), 'نزوى');
    assert.equal(forms.arabicWilayah('Al Seeb'), 'السيب');
    assert.equal(forms.arabicWilayah('wilayat bahla'), 'بهلاء');
    // The value as plain text too («أوفرهيد», «لا»)
    const plain = forms.extract({ data: { fields: { a: { label: 'نوع البوابة', value: 'أوفرهيد' }, b: { label: 'هل تريد زيارة معاينة؟', value: 'لا' }, c: { label: 'رقم الجوال', value: '92222222' } } } });
    assert.deepEqual([plain.gate_type, plain.inspection, plain.phone], ['overhead', 0, '96892222222']);
});

test('the webhook: signed only, once per id, the customer followed up, the inspection request, the routes', async (t) => {
    Object.assign(process.env, ENV);
    t.after(() => { for (const k of Object.keys(ENV)) delete process.env[k]; });
    const db = openDatabase(':memory:');
    saveSettings(db, { mazbot_recipients: '' });
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const hook = `${base}/webhooks/mazbot-templates/${ENV.MAZBOT_TEMPLATES_WEBHOOK_SECRET}`;
    const post = (event, { sign = true, headers = {} } = {}) => {
        const raw = JSON.stringify(event);
        const sig = 'sha256=' + crypto.createHmac('sha256', sign === 'wrong' ? 'not-the-secret' : ENV.MAZBOT_TEMPLATES_SIGNING_SECRET).update(raw).digest('hex');
        return fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(sign ? { 'X-Mazbot-Signature': sig } : {}), ...headers }, body: raw });
    };
    const call = async (method, url, body, token = OWNER) => {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const count = () => db.prepare('SELECT COUNT(*) AS n FROM whatsapp_form_submissions').get().n;

    // A wrong or missing signature: refused, nothing kept
    assert.equal((await post(FLAT, { sign: 'wrong' })).status, 401);
    assert.equal((await post(FLAT, { sign: false })).status, 401);
    forms.ensureTable(db);
    assert.equal(count(), 0);

    // Signed: 200; MazBot's retries of the same id: 200 and still one row
    for (let i = 0; i < 3; i++) assert.equal((await post(FLAT, { headers: { 'X-Mazbot-Event-Type': 'whatsapp_form.submitted', 'X-Mazbot-Delivery-Id': 'd-1' } })).status, 200);
    await wait();
    assert.equal(count(), 1);
    const s = db.prepare('SELECT * FROM whatsapp_form_submissions').get();
    assert.equal(JSON.parse(s.raw_json).id, 'evt-flat-1', 'the raw event, whole');
    assert.equal(s.status, 'new');
    assert.equal(s.form_id, '12');
    assert.equal(s.gate_type, 'rolling_shutter');
    assert.equal(db.prepare('SELECT name FROM regions WHERE id = ?').get(s.region_id).name, 'السيب');
    // The customer in «متابعة العملاء», waiting for a person, with the answers in the log
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(s.lead_id);
    assert.equal(lead.status, 'needs_staff');
    assert.match(db.prepare("SELECT text FROM lead_messages WHERE lead_id = ? AND role = 'customer'").get(lead.id).text, /نوع البوابة: رول شتر[\s\S]*عرض الفتحة: 350 سم/);
    // «نعم» to the visit: an inspection request for the office to approve
    const sr = db.prepare('SELECT * FROM service_requests WHERE id = ?').get(s.service_request_id);
    assert.deepEqual([sr.kind, sr.source, sr.customer_phone], ['inspection', 'whatsapp_form', '96891111111']);
    const events = db.prepare("SELECT status FROM inbound_events WHERE source = 'mazbot_templates' ORDER BY id").all().map((e) => e.status);
    assert.deepEqual(events, ['bad_signature', 'bad_signature', 'whatsapp_form', 'duplicate', 'duplicate']);

    // No visit asked: no inspection request; another shape of data
    assert.equal((await post(LIST)).status, 200);
    await wait();
    const k = db.prepare("SELECT * FROM whatsapp_form_submissions WHERE event_id = 'evt-list-2'").get();
    assert.deepEqual([k.gate_type, k.width_cm, k.inspection, k.service_request_id], ['overhead', 300, 0, null]);

    // Without a phone: kept with the reason; the office can reprocess after a fix
    assert.equal((await post({ id: 'evt-nophone', type: 'whatsapp_form.submitted', data: { answers: { 'نوع البوابة': 'رول شتر' } } })).status, 200);
    await wait();
    const bad = db.prepare("SELECT * FROM whatsapp_form_submissions WHERE event_id = 'evt-nophone'").get();
    assert.equal(bad.status, 'error');
    assert.match(bad.error, /رقم الجوال/);

    // Reprocessing does not tell the customer twice nor make a second inspection request
    const again = await call('POST', `/api/admin/whatsapp-forms/${s.id}/reprocess`);
    assert.equal(again.status, 200);
    assert.equal(again.body.service_request.ref, sr.ref);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM service_requests').get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lead_messages WHERE lead_id = ? AND role = 'customer'").get(lead.id).n, 1);

    // Other templates events behave as before
    const press = { type: 'message.received', data: { contact: { id: 9, phone: '96899999999' }, message: { id: 'm1', message_type: 'button', value: 'إيقاف الإشعارات 48 ساعة' } } };
    assert.equal((await post(press)).status, 200);
    await wait();
    assert.ok(notify.isMuted(db, '96899999999'));
    assert.equal(count(), 3);

    // The routes: the list, the raw event, the status; quotes or follow-up staff only
    const l = await call('GET', '/api/admin/whatsapp-forms');
    assert.equal(l.body.submissions.length, 3);
    assert.equal(l.body.statuses.new, 'جديد – من نموذج واتساب');
    const one = await call('GET', `/api/admin/whatsapp-forms/${s.id}`);
    assert.equal(one.body.raw.data.responses['نوع البوابة'], 'رول شتر');
    assert.equal((await call('PATCH', `/api/admin/whatsapp-forms/${s.id}`, { status: 'contacted' })).body.status, 'contacted');
    assert.equal((await call('PATCH', `/api/admin/whatsapp-forms/${s.id}`, { status: 'nonsense' })).status, 400);
    assert.equal((await call('GET', '/api/admin/whatsapp-forms?status=contacted')).body.submissions.length, 1);
    staff.create(db, { username: 'ali', display_name: 'علي', password: 'pass-12345', role: 'staff', permissions: ['leads'] });
    staff.create(db, { username: 'omar', display_name: 'عمر', password: 'pass-12345', role: 'staff', permissions: ['products'] });
    const login = async (u) => (await call('POST', '/api/auth/login', { username: u, password: 'pass-12345' }, '')).body.token;
    assert.equal((await call('GET', '/api/admin/whatsapp-forms', null, await login('ali'))).status, 200);
    assert.equal((await call('GET', '/api/admin/whatsapp-forms', null, await login('omar'))).status, 403);
});

test('the main account webhook takes the form too', async (t) => {
    const env = { MAZBOT_WEBHOOK_SECRET: 'main-hook-secret-0123456789', MAZBOT_SIGNING_SECRET: 'main-signing-secret' };
    Object.assign(process.env, env);
    t.after(() => { for (const k of Object.keys(env)) delete process.env[k]; });
    const db = openDatabase(':memory:');
    saveSettings(db, { mazbot_recipients: '' });
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    t.after(() => server.close());
    const raw = JSON.stringify(KEYS);
    const sig = 'sha256=' + crypto.createHmac('sha256', env.MAZBOT_SIGNING_SECRET).update(raw).digest('hex');
    const res = await fetch(`http://127.0.0.1:${server.address().port}/webhooks/mazbot/${env.MAZBOT_WEBHOOK_SECRET}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Mazbot-Signature': sig }, body: raw });
    assert.equal(res.status, 200);
    await wait();
    const s = db.prepare('SELECT * FROM whatsapp_form_submissions').get();
    assert.deepEqual([s.account, s.phone, s.status], ['main', '96893333333', 'new']);
});

test('«Nizwa» in the form is the wilayah of نزوى', async () => {
    const db = openDatabase(':memory:');
    saveSettings(db, { mazbot_recipients: '' });
    const r = forms.receive(db, { id: 'evt-nizwa', type: 'whatsapp_form.submitted', data: { responses: { a: { label: 'رقم الجوال', value: '76979066' }, b: { label: 'الولاية أو المنطقة', value: 'Nizwa' } } } });
    const s = await forms.processSubmission(db, r.id, { notifyStaff: false });
    assert.equal(s.region, 'نزوى، الداخلية');
});
