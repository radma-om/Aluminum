/* =============================================================
   Outgoing email (SMTP), shared by the daily backup copy and the
   password-reset links.
     SMTP_HOST, SMTP_PORT (465 = SSL, 587 = STARTTLS), SMTP_USER, SMTP_PASS,
     SMTP_FROM (optional, defaults to SMTP_USER)
   The connection is always encrypted (TLS 1.2+) and the certificate checked.
   ============================================================= */
const nodemailer = require('nodemailer');

function config() {
    const env = process.env;
    const port = Number(env.SMTP_PORT) || 465;
    return {
        host: String(env.SMTP_HOST || '').trim(),
        port,
        secure: port === 465,
        user: String(env.SMTP_USER || '').trim(),
        pass: env.SMTP_PASS || '',
        from: String(env.SMTP_FROM || env.SMTP_USER || '').trim()
    };
}

const isConfigured = (c = config()) => Boolean(c.host && c.user && c.pass);

/* Replaced in tests (no real email is ever sent from a test) */
let makeTransport = (c) => nodemailer.createTransport({
    host: c.host, port: c.port, secure: c.secure, requireTLS: !c.secure,
    auth: { user: c.user, pass: c.pass },
    tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 60_000
});
const setTransportForTests = (fn) => { makeTransport = fn; };

/* Sends one message ({ to, subject, text, attachments? }); throws on failure */
async function send(mail) {
    const c = config();
    if (!isConfigured(c)) throw new Error('البريد غير مضبوط — أضف SMTP_HOST وSMTP_USER وSMTP_PASS في متغيرات البيئة');
    return makeTransport(c).sendMail({ from: c.from, ...mail });
}

module.exports = { config, isConfigured, send, setTransportForTests };
