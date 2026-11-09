const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/server');

const OWNER = 'phone-verification-owner-token-1234';

async function start(t, { mode = 'off', provider } = {}) {
    const oldMode = process.env.PHONE_VERIFICATION_MODE;
    const oldToken = process.env.ADMIN_TOKEN;
    process.env.PHONE_VERIFICATION_MODE = mode;
    process.env.ADMIN_TOKEN = OWNER;
    t.after(() => {
        if (oldMode === undefined) delete process.env.PHONE_VERIFICATION_MODE;
        else process.env.PHONE_VERIFICATION_MODE = oldMode;
        if (oldToken === undefined) delete process.env.ADMIN_TOKEN;
        else process.env.ADMIN_TOKEN = oldToken;
    });
    const db = openDatabase(':memory:');
    const server = http.createServer(createApp(db, { phoneVerificationProvider: provider }));
    await new Promise((resolve) => server.listen(0, resolve));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, body, headers = {}) => {
        const res = await fetch(base + path, {
            method, headers: { 'Content-Type': 'application/json', ...headers },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: res.status, body: await res.json() };
    };
    return { db, call };
}

function fakeProvider() {
    const calls = { request: 0, verify: 0 };
    return {
        name: 'fake', calls,
        isConfigured: () => true,
        status: () => ({ configured: true, mapping_ready: true, missing: [] }),
        requestCode: async () => ({ reference: 'fake-' + (++calls.request) }),
        verifyCode: async ({ code }) => { calls.verify++; return { verified: code === '123456' }; },
        healthCheck: async () => ({ ok: true })
    };
}

test('off is safe: status is disabled and request never calls the provider', async (t) => {
    const provider = fakeProvider();
    const { call } = await start(t, { provider });
    assert.deepEqual((await call('GET', '/api/public/phone-verification/status')).body, { enabled: false, required: false });
    const r = await call('POST', '/api/public/phone-verification/request', { phone: '91234567', purpose: 'quote' });
    assert.equal(r.status, 404);
    assert.equal(r.body.code, 'verification_disabled');
    assert.equal(provider.calls.request, 0);
});

test('unfinished Infocomm mapping fails open for sales and reports provider_not_configured', async (t) => {
    const { call } = await start(t, { mode: 'required' });
    assert.deepEqual((await call('GET', '/api/public/phone-verification/status')).body, { enabled: false, required: false });
    const auth = { Authorization: 'Bearer ' + OWNER };
    const admin = await call('GET', '/api/admin/phone-verification/status', undefined, auth);
    assert.equal(admin.status, 200);
    assert.equal(admin.body.misconfigured, true);
    assert.equal(admin.body.mapping_ready, false);
    const check = await call('POST', '/api/admin/phone-verification/test-connection', {}, auth);
    assert.equal(check.status, 503);
    assert.equal(check.body.code, 'provider_not_configured');
});

test('required mode protects all public quotes with a hashed, one-use proof and atomic rollback', async (t) => {
    const provider = fakeProvider();
    const { db, call } = await start(t, { mode: 'required', provider });
    assert.equal((await call('GET', '/api/public/phone-verification/status')).body.required, true);

    const header = { 'Idempotency-Key': 'quote-click-0001' };
    const first = await call('POST', '/api/public/phone-verification/request', { phone: '91234567', purpose: 'quote' }, header);
    const again = await call('POST', '/api/public/phone-verification/request', { phone: '91234567', purpose: 'quote' }, header);
    assert.equal(first.status, 200);
    assert.equal(again.body.challengeId, first.body.challengeId);
    assert.equal(provider.calls.request, 1);

    const wrong = await call('POST', '/api/public/phone-verification/confirm', {
        challengeId: first.body.challengeId, phone: '91234567', code: '000000'
    });
    assert.equal(wrong.status, 400);
    const confirmed = await call('POST', '/api/public/phone-verification/confirm', {
        challengeId: first.body.challengeId, phone: '91234567', code: '123456'
    });
    assert.equal(confirmed.status, 200);
    const proof = confirmed.body.verificationProof;
    const challenge = db.prepare('SELECT * FROM phone_verification_challenges WHERE public_id=?').get(first.body.challengeId);
    assert.ok(proof.length >= 40);
    assert.notEqual(challenge.proof_hash, proof);
    assert.equal(challenge.code_hash, null);
    assert.equal(challenge.attempt_count, 1);

    const region = db.prepare('SELECT id FROM regions WHERE active=1 LIMIT 1').get();
    const product = db.prepare('SELECT id FROM products WHERE active=1 AND is_public=1 LIMIT 1').get();
    const customer = { customer_name: 'عميل التحقق', customer_phone: '91234567', region_id: region.id };
    for (const [path, body] of [
        ['/api/public/quotes', { ...customer, items: [] }],
        ['/api/public/door-quotes', customer],
        ['/api/public/overhead-quotes', customer],
        ['/api/public/motor-quotes', customer]
    ]) {
        const denied = await call('POST', path, body);
        assert.equal(denied.status, 428, path);
        assert.equal(denied.body.code, 'verification_required');
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quotes').get().n, 0);

    const valid = { ...customer, verification_proof: proof, items: [{ product_id: product.id, quantity: 1 }] };
    const quote = await call('POST', '/api/public/quotes', valid);
    assert.equal(quote.status, 201, JSON.stringify(quote.body));
    assert.equal(db.prepare('SELECT status FROM phone_verification_challenges WHERE public_id=?').get(first.body.challengeId).status, 'consumed');
    const reuse = await call('POST', '/api/public/quotes', valid);
    assert.equal(reuse.status, 409);
    assert.equal(reuse.body.code, 'invalid_verification_proof');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quotes').get().n, 1);

    const second = await call('POST', '/api/public/phone-verification/request',
        { phone: '92345678', purpose: 'quote' }, { 'Idempotency-Key': 'quote-click-0002' });
    const secondProof = (await call('POST', '/api/public/phone-verification/confirm', {
        challengeId: second.body.challengeId, phone: '92345678', code: '123456'
    })).body.verificationProof;
    const customer2 = { ...customer, customer_phone: '92345678', verification_proof: secondProof };
    assert.equal((await call('POST', '/api/public/quotes', { ...customer2, items: [] })).status, 400);
    assert.equal(db.prepare('SELECT status FROM phone_verification_challenges WHERE public_id=?').get(second.body.challengeId).status, 'verified');
    assert.equal((await call('POST', '/api/public/quotes', {
        ...customer2, items: [{ product_id: product.id, quantity: 1 }]
    })).status, 201);
    assert.equal(db.prepare('SELECT status FROM phone_verification_challenges WHERE public_id=?').get(second.body.challengeId).status, 'consumed');
});
