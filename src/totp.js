/* =============================================================
   Two-step sign-in codes (TOTP, RFC 6238): the 6-digit code that
   changes every 30 seconds in Google Authenticator, Microsoft
   Authenticator, 1Password, etc.
   - The secret is 20 random bytes, shown once as base32 and as a QR code.
   - A code is accepted for the current 30-second step and one step either
     side (phone clocks drift), and each step only once (no replay).
   ============================================================= */
const crypto = require('node:crypto');
const qrcode = require('qrcode-generator');

const STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += B32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
}

function base32Decode(text) {
    const clean = String(text || '').toUpperCase().replace(/[\s=-]/g, '');
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of clean) {
        const idx = B32.indexOf(ch);
        if (idx < 0) throw new Error('invalid base32');
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));
const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

function codeAt(secret, step) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const h = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
    const offset = h[h.length - 1] & 15;
    const n = ((h[offset] & 127) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
    return String(n % 10 ** DIGITS).padStart(DIGITS, '0');
}

/* The step the code belongs to (within ±1 step and after lastStep), or null */
function verify(secret, code, { lastStep = 0, now = Date.now() } = {}) {
    const given = String(code || '').replace(/\s/g, '');
    if (!secret || !/^\d{6}$/.test(given)) return null;
    const step = currentStep(now);
    for (const s of [step - 1, step, step + 1]) {
        if (s <= Number(lastStep || 0)) continue; // already used: a code works once
        const a = Buffer.from(codeAt(secret, s));
        if (crypto.timingSafeEqual(a, Buffer.from(given))) return s;
    }
    return null;
}

function otpauthUri({ issuer, account, secret }) {
    const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
    return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

/* The link as an SVG QR code (generated here: nothing is sent to another site) */
function qrSvg(text) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 5, margin: 4, scalable: true });
}

module.exports = { generateSecret, codeAt, currentStep, verify, otpauthUri, qrSvg, base32Encode, base32Decode, STEP_SECONDS };
