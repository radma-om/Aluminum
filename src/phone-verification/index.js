const crypto = require('node:crypto');
const { createInfocommProvider } = require('./provider-infocomm');

class VerificationError extends Error {
    constructor(code, status, message) {
        super(message); this.code = code; this.status = status; this.expose = true;
    }
}
const fail = (code, status, message) => { throw new VerificationError(code, status, message); };
const int = (env, name, fallback, min, max) => {
    const n = Number(env[name]);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};
const sqlTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const normalizeOmanMobile = (value) => {
    let phone = String(value || '').replace(/\D/g, '');
    if (phone.length === 8) phone = '968' + phone;
    return /^968[79]\d{7}$/.test(phone) ? phone : null;
};

function config(env) {
    const raw = String(env.PHONE_VERIFICATION_MODE || 'off').trim().toLowerCase();
    const mode = raw === 'off' || raw === 'required' ? raw : 'off';
    if (raw !== mode) console.warn('[phone-verification] unknown mode; using off');
    return {
        mode,
        codeTtl: int(env, 'PHONE_VERIFICATION_CODE_TTL_SECONDS', 300, 60, 1800),
        proofTtl: int(env, 'PHONE_VERIFICATION_PROOF_TTL_SECONDS', 900, 60, 3600),
        maxAttempts: int(env, 'PHONE_VERIFICATION_MAX_ATTEMPTS', 5, 1, 10),
        maxSends: int(env, 'PHONE_VERIFICATION_MAX_SENDS_PER_PHONE', 3, 1, 20),
        cooldown: int(env, 'PHONE_VERIFICATION_RESEND_COOLDOWN_SECONDS', 60, 10, 600)
    };
}

function create({ db, provider = null, env = process.env }) {
    const cfg = config(env);
    provider = provider || createInfocommProvider(env);
    const configured = () => Boolean(provider.isConfigured && provider.isConfigured());
    const required = () => cfg.mode === 'required' && configured();
    const misconfigured = () => cfg.mode === 'required' && !configured();
    const publicStatus = () => required()
        ? { enabled: true, required: true, resendCooldownSeconds: cfg.cooldown, codeLength: 6 }
        : { enabled: false, required: false };
    const metrics = () => Object.fromEntries(db.prepare(
        "SELECT status, COUNT(*) AS n FROM phone_verification_challenges WHERE created_at >= datetime('now','-1 day') GROUP BY status"
    ).all().map((r) => [r.status, Number(r.n)]));
    const adminStatus = () => {
        const p = provider.status ? provider.status() : { configured: configured(), mapping_ready: true, missing: [] };
        return {
            mode: cfg.mode, enabled: required(), required: required(), misconfigured: misconfigured(),
            provider: provider.name || 'infocomm', configured: configured(),
            mapping_ready: p.mapping_ready !== false, missing: p.missing || [], metrics_24h: metrics()
        };
    };
    const ensureEnabled = () => {
        if (!required()) fail('verification_disabled', 404, 'التحقق من الرقم غير مفعّل حالياً.');
    };
    const response = (row) => ({
        challengeId: row.public_id,
        expiresIn: Math.max(0, Math.ceil((Date.parse(row.expires_at.replace(' ', 'T') + 'Z') - Date.now()) / 1000)),
        resendAfter: cfg.cooldown
    });
    const requestCode = async ({ phone: rawPhone, purpose = 'quote', idempotencyKey }) => {
        ensureEnabled();
        if (purpose !== 'quote') fail('invalid_purpose', 400, 'طلب التحقق غير صالح.');
        const phone = normalizeOmanMobile(rawPhone);
        if (!phone) fail('invalid_phone', 400, 'اكتب رقم جوال عمانياً صحيحاً.');
        const key = /^[A-Za-z0-9._:-]{8,100}$/.test(String(idempotencyKey || '')) ? String(idempotencyKey) : null;
        if (key) {
            const same = db.prepare(`SELECT * FROM phone_verification_challenges
                WHERE phone=? AND purpose=? AND idempotency_key=? AND status IN ('pending','verified')
                AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1`).get(phone, purpose, key);
            if (same) return response(same);
        }
        const pending = db.prepare(`SELECT * FROM phone_verification_challenges
            WHERE phone=? AND purpose=? AND status='pending' AND expires_at > datetime('now')
            ORDER BY id DESC LIMIT 1`).get(phone, purpose);
        if (pending && pending.last_sent_at) {
            const sent = Date.parse(pending.last_sent_at.replace(' ', 'T') + 'Z');
            if (Date.now() - sent < cfg.cooldown * 1000) return response(pending);
        }
        const sent = Number(db.prepare(`SELECT COALESCE(SUM(send_count),0) AS n FROM phone_verification_challenges
            WHERE phone=? AND created_at >= datetime('now','-1 hour')`).get(phone).n);
        if (sent >= cfg.maxSends) fail('send_limit', 429, 'طلبات كثيرة لهذا الرقم، يرجى المحاولة لاحقاً.');
        const publicId = token(18);
        const info = db.prepare(`INSERT INTO phone_verification_challenges
            (public_id,phone,purpose,provider,status,idempotency_key,expires_at)
            VALUES (?,?,?,?,'pending',?,?)`).run(publicId, phone, purpose, provider.name || 'infocomm', key, sqlTime(Date.now() + cfg.codeTtl * 1000));
        try {
            const result = await provider.requestCode({ phone, locale: 'ar', purpose, idempotencyKey: key || publicId });
            db.prepare(`UPDATE phone_verification_challenges SET provider_reference=?,send_count=1,
                last_sent_at=datetime('now'),updated_at=datetime('now') WHERE id=?`)
                .run(result && (result.reference || result.providerReference) || null, Number(info.lastInsertRowid));
            return response(db.prepare('SELECT * FROM phone_verification_challenges WHERE id=?').get(Number(info.lastInsertRowid)));
        } catch (err) {
            db.prepare("UPDATE phone_verification_challenges SET status='failed',updated_at=datetime('now') WHERE id=?").run(Number(info.lastInsertRowid));
            if (err && err.status) throw err;
            fail('provider_error', 502, 'تعذر إرسال رمز التحقق حالياً، حاول لاحقاً.');
        }
    };
    const confirmCode = async ({ challengeId, phone: rawPhone, code }) => {
        ensureEnabled();
        const phone = normalizeOmanMobile(rawPhone);
        if (!phone) fail('invalid_phone', 400, 'اكتب رقم جوال عمانياً صحيحاً.');
        const row = db.prepare('SELECT * FROM phone_verification_challenges WHERE public_id=?').get(String(challengeId || ''));
        if (!row || row.phone !== phone || row.purpose !== 'quote' || row.status !== 'pending') {
            fail('invalid_verification', 400, 'تعذر التحقق من الرمز.');
        }
        if (Date.parse(row.expires_at.replace(' ', 'T') + 'Z') <= Date.now()) {
            db.prepare("UPDATE phone_verification_challenges SET status='expired' WHERE id=?").run(row.id);
            fail('verification_expired', 400, 'انتهت صلاحية الرمز، اطلب رمزاً جديداً.');
        }
        const entered = String(code || '').trim();
        if (!/^\d{4,10}$/.test(entered)) fail('invalid_verification', 400, 'تعذر التحقق من الرمز.');
        let result;
        try { result = await provider.verifyCode({ providerReference: row.provider_reference, phone, code: entered }); }
        catch (err) {
            if (err && err.status) throw err;
            fail('provider_error', 502, 'تعذر التحقق من الرمز حالياً، حاول لاحقاً.');
        }
        if (!(result === true || result && result.verified === true)) {
            db.prepare(`UPDATE phone_verification_challenges SET attempt_count=attempt_count+1,
                status=CASE WHEN attempt_count+1>=? THEN 'blocked' ELSE status END,updated_at=datetime('now') WHERE id=?`)
                .run(cfg.maxAttempts, row.id);
            const updated = db.prepare('SELECT status FROM phone_verification_challenges WHERE id=?').get(row.id);
            if (updated.status === 'blocked') fail('verification_blocked', 429, 'تم تجاوز عدد المحاولات، اطلب رمزاً جديداً لاحقاً.');
            fail('invalid_verification', 400, 'تعذر التحقق من الرمز.');
        }
        const proof = token();
        db.prepare(`UPDATE phone_verification_challenges SET status='verified',verified_at=datetime('now'),
            proof_hash=?,proof_expires_at=?,updated_at=datetime('now') WHERE id=? AND status='pending'`)
            .run(hash(proof), sqlTime(Date.now() + cfg.proofTtl * 1000), row.id);
        return { verified: true, verificationProof: proof, expiresIn: cfg.proofTtl };
    };
    const assertQuoteRequest = ({ phone, proof }) => {
        if (required() && (!normalizeOmanMobile(phone) || !/^[A-Za-z0-9_-]{40,100}$/.test(String(proof || '')))) {
            fail('verification_required', 428, 'تحقق من رقم الجوال قبل إرسال طلب عرض السعر.');
        }
    };
    const consumeForQuote = ({ phone: rawPhone, proof }, action) => {
        if (!required()) return action();
        const phone = normalizeOmanMobile(rawPhone);
        assertQuoteRequest({ phone, proof });
        db.exec('BEGIN IMMEDIATE');
        try {
            const used = db.prepare(`UPDATE phone_verification_challenges SET status='consumed',
                consumed_at=datetime('now'),updated_at=datetime('now')
                WHERE proof_hash=? AND phone=? AND purpose='quote' AND status='verified'
                AND proof_expires_at > datetime('now')`).run(hash(proof), phone);
            if (Number(used.changes) !== 1) fail('invalid_verification_proof', 409,
                'انتهى إثبات التحقق أو تم استخدامه؛ تحقق من الرقم مرة أخرى.');
            const result = action();
            db.exec('COMMIT');
            return result;
        } catch (err) {
            try { db.exec('ROLLBACK'); } catch {}
            throw err;
        }
    };
    const healthCheck = async () => provider.healthCheck();
    const handleWebhook = () => fail('provider_not_configured', 404, 'غير موجود');
    return { isRequired: required, isMisconfigured: misconfigured, publicStatus, adminStatus,
        requestCode, confirmCode, assertQuoteRequest, consumeForQuote, healthCheck, handleWebhook };
}
module.exports = { create, normalizeOmanMobile, VerificationError };
