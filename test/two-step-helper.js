/* Test managers are enrolled in two-step sign-in (required for managers):
   returns the current code for the account, or undefined when it has none. */
const totp = require('../src/totp');

function codeFor(db, username) {
    const name = String(username).trim().toLowerCase();
    const row = db.prepare('SELECT role, totp_secret FROM staff_users WHERE username = ?').get(name);
    if (!row) return undefined;
    let secret = row.totp_secret;
    if (!secret && row.role !== 'manager') return undefined;
    if (!secret) {
        secret = totp.generateSecret();
        db.prepare('UPDATE staff_users SET totp_secret = ? WHERE username = ?').run(secret, name);
    }
    // Tests sign in several times within one 30-second step: allow the same step again here only
    db.prepare('UPDATE staff_users SET totp_last_step = 0 WHERE username = ?').run(name);
    return totp.codeAt(secret, totp.currentStep());
}

module.exports = { codeFor };
