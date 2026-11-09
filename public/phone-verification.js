(function () {
    'use strict';
    let required = false, phone = '', challengeId = '', proof = '', root = null;
    const input = () => document.getElementById('clientPhone') || document.getElementById('custPhone');
    const normalize = (value) => {
        let p = String(value || '').replace(/\D/g, '');
        if (p.length === 8) p = '968' + p;
        return /^968[79]\d{7}$/.test(p) ? p : '';
    };
    const say = (text, ok) => {
        if (!root) return;
        const el = root.querySelector('[data-pv-message]');
        el.textContent = text || ''; el.style.color = ok ? '#167c45' : '#9a3412';
    };
    const reset = () => {
        phone = ''; challengeId = ''; proof = '';
        if (root) { root.querySelector('[data-pv-code]').value = ''; root.querySelector('[data-pv-row]').hidden = true; say(''); }
    };
    const post = async (url, body, headers = {}) => {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'تعذر إكمال التحقق');
        return data;
    };
    function mount() {
        const field = input();
        if (!field || root) return;
        root = document.createElement('div');
        root.className = 'phone-verification';
        root.innerHTML = '<button type="button" data-pv-send>إرسال رمز التحقق عبر واتساب</button>' +
            '<div data-pv-row hidden><input data-pv-code inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="رمز التحقق">' +
            '<button type="button" data-pv-confirm>تحقق</button></div><div data-pv-message role="status" aria-live="polite"></div>';
        const style = document.createElement('style');
        style.textContent = '.phone-verification{grid-column:1/-1;padding:12px;border:1px solid #d6e2dc;border-radius:10px;background:#f7fbf9;display:grid;gap:8px}.phone-verification button{padding:9px 14px;border:0;border-radius:8px;background:#176b4d;color:#fff;font:inherit;cursor:pointer}.phone-verification button:disabled{opacity:.55}.phone-verification [data-pv-row]{display:flex;gap:8px;flex-wrap:wrap}.phone-verification [data-pv-row][hidden]{display:none}.phone-verification input{min-width:160px;flex:1;padding:9px;border:1px solid #bbb;border-radius:8px;font:inherit}';
        document.head.appendChild(style);
        field.parentElement.insertAdjacentElement('afterend', root);
        field.addEventListener('input', reset);
        root.querySelector('[data-pv-send]').onclick = async () => {
            const p = normalize(field.value);
            if (!p) return say('اكتب رقم جوال عمانياً صحيحاً.');
            const button = root.querySelector('[data-pv-send]'); button.disabled = true; say('جارٍ إرسال الرمز...');
            try {
                const key = globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-verification';
                const data = await post('/api/public/phone-verification/request', { phone: p, purpose: 'quote' }, { 'Idempotency-Key': key });
                phone = p; challengeId = data.challengeId; root.querySelector('[data-pv-row]').hidden = false;
                say('أُرسل الرمز. أدخله لإثبات ملكية الرقم.', true);
            } catch (err) { say(err.message); } finally { button.disabled = false; }
        };
        root.querySelector('[data-pv-confirm]').onclick = async () => {
            const p = normalize(field.value), code = root.querySelector('[data-pv-code]').value;
            if (!challengeId || p !== phone) return say('أرسل رمزاً جديداً لهذا الرقم.');
            const button = root.querySelector('[data-pv-confirm]'); button.disabled = true; say('جارٍ التحقق...');
            try {
                const data = await post('/api/public/phone-verification/confirm', { challengeId, phone: p, code });
                proof = data.verificationProof; say('تم التحقق من الرقم ✅', true);
            } catch (err) { proof = ''; say(err.message); } finally { button.disabled = false; }
        };
    }
    async function init() {
        try {
            const res = await fetch('/api/public/phone-verification/status', { cache: 'no-store' });
            required = Boolean((await res.json()).required);
            if (required) mount();
        } catch { required = false; }
    }
    window.RadmaPhoneVerification = {
        ready: init(),
        async proofFor(value) {
            await this.ready;
            if (!required) return undefined;
            if (!proof || normalize(value) !== phone) throw new Error('تحقق من رقم الجوال أولاً.');
            return proof;
        },
        reset
    };
})();
