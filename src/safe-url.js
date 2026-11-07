/* =============================================================
   Outgoing webhooks may only reach the public internet.
   Without this, an admin URL like http://127.0.0.1:3000/… or an
   internal network address makes the server send requests to itself or
   to machines behind the hosting firewall (SSRF).
   - The host is resolved and EVERY address it resolves to must be public
     (not loopback, private, link-local / cloud metadata, carrier NAT,
     multicast, unspecified, documentation or IPv4-mapped forms of these).
   - Checked when the webhook is saved and again before each delivery
     (a name can be re-pointed later); redirects are never followed.
   - WEBHOOK_ALLOW_PRIVATE_TARGETS=1 lifts the check — for tests and local
     development only; the system status warns while it is set.
   ============================================================= */
const dns = require('node:dns').promises;
const net = require('node:net');

const blocked = new net.BlockList();
for (const [addr, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
    ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) blocked.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
    // (IPv4-mapped ::ffff:a.b.c.d is unwrapped in isPublicAddress: BlockList would match plain IPv4 against it)
    ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
    ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
]) blocked.addSubnet(addr, prefix, 'ipv6');

const allowPrivate = () => process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS === '1';
const err = (message) => Object.assign(new Error(message), { status: 400 });

function isPublicAddress(address) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(String(address));
    if (mapped) return isPublicAddress(mapped[1]);
    if (/^::ffff:/i.test(String(address))) return false; // hex-written mapped forms
    const family = net.isIP(address);
    if (!family) return false;
    return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/* Throws (status 400) unless the URL is http(s) and its host resolves only to public addresses */
async function assertPublicUrl(value) {
    let url;
    try { url = new URL(String(value)); } catch { throw err('الرابط غير صالح'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw err('يجب أن يبدأ الرابط بـ http أو https');
    if (url.username || url.password) throw err('لا تضع اسم مستخدم أو كلمة مرور داخل الرابط');
    if (allowPrivate()) return url;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw err('لا يُسمح بالعناوين الداخلية أو المحلية في الـ Webhook');
    let addresses;
    if (net.isIP(host)) addresses = [host];
    else {
        try { addresses = (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address); } catch { throw err(`تعذر العثور على النطاق «${host}»`); }
    }
    if (!addresses.length || !addresses.every(isPublicAddress)) {
        throw err('لا يُسمح بالعناوين الداخلية أو المحلية في الـ Webhook — استخدم رابطاً عاماً على الإنترنت');
    }
    return url;
}

module.exports = { assertPublicUrl, isPublicAddress, allowPrivate };
