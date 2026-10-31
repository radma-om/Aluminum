/* =============================================================
   Which proxies may tell us the customer's address (X-Forwarded-For).
   TRUSTED_PROXIES = explicit IP addresses or CIDR networks, comma
   separated, e.g. "10.0.0.5, 192.168.10.0/24". Default: trust nobody,
   so a forged X-Forwarded-For can never reset the login / form limits.
   Rejected (and reported, the app keeps running untrusted): anything
   that means "everyone" or is not an address — 1 / true / * / hop
   counts / names like "loopback" / 0.0.0.0/0 / very wide networks.
   Hostinger's proxy addresses are never assumed: the addresses that
   actually send X-Forwarded-For are recorded and shown in the system
   status, so the manager can set them knowingly.
   ============================================================= */
const { isIP } = require('node:net');

const MIN_PREFIX = { 4: 8, 6: 32 }; // narrower than this is "everyone" for practical purposes

/* → { list: string[] | false, error: string | null } */
function parse(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return { list: false, error: null };
    const entries = raw.split(',').map((v) => v.trim());
    for (const entry of entries) {
        const [address, prefix, ...extra] = entry.split('/');
        const family = isIP(address);
        if (!family || extra.length) return { list: false, error: `«${entry}» ليس عنوان IP أو شبكة CIDR صريحة` };
        if (prefix !== undefined) {
            const n = Number(prefix);
            if (!/^\d+$/.test(prefix) || n > (family === 4 ? 32 : 128)) return { list: false, error: `«${entry}»: طول الشبكة غير صالح` };
            if (n < MIN_PREFIX[family]) return { list: false, error: `«${entry}» واسعة جداً (تعني الثقة بالجميع تقريباً) — الحد الأدنى /${MIN_PREFIX[family]}` };
        }
        if (/^(0\.0\.0\.0|::)$/.test(address)) return { list: false, error: `«${entry}» تعني كل العناوين` };
    }
    return { list: entries, error: null };
}

/* For the system status: peers that sent X-Forwarded-For lately, and whether we trust them */
const seen = new Map();
function notePeer(req, trusted) {
    if (!req.headers['x-forwarded-for']) return;
    const addr = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (!addr) return;
    seen.delete(addr);
    seen.set(addr, { address: addr, trusted, last_seen: new Date().toISOString() });
    while (seen.size > 10) seen.delete(seen.keys().next().value);
}
const peers = () => [...seen.values()].reverse();
const resetPeers = () => seen.clear();

module.exports = { parse, notePeer, peers, resetPeers, MIN_PREFIX };
