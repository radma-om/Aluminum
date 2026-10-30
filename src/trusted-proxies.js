const { isIP } = require('node:net');

// Trust addresses, never all forwarded headers or a client-controlled hop count.
function trustedProxies(value = '') {
    if (!value.trim()) return false;
    const entries = value.split(',').map((v) => v.trim());
    for (const entry of entries) {
        const [address, prefix, ...extra] = entry.split('/');
        const family = isIP(address);
        const max = family === 4 ? 32 : 128;
        if (!family || extra.length || (prefix !== undefined &&
            (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > max))) {
            throw new Error('TRUSTED_PROXIES must contain explicit IP addresses or non-zero CIDR ranges');
        }
    }
    return entries;
}

module.exports = { trustedProxies };
