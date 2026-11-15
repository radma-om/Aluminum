/* =============================================================
   The panel's language: العربية (default) or English, per user.
   - Arabic is the source: the page and the scripts are written in it.
   - In English, every Arabic text on the page (text, placeholder, title,
     aria-label, the value of a button) that is in the dictionary
     (admin-i18n-en.js) is replaced — at start and whenever the scripts
     add something (a MutationObserver), so lists and windows follow too.
   - Texts with numbers or names inside use PATTERNS (regular expressions).
   - The page turns left-to-right; dates and numbers use APP_LOCALE.
   - Chosen with the button in the header; kept on the device and, for a
     staff account, on the server (it follows the user to another phone).
   ============================================================= */
(function () {
    let saved = 'ar';
    try { saved = localStorage.getItem('adminLang') === 'en' ? 'en' : 'ar'; } catch { /* private mode */ }
    window.APP_LANG = saved;
    window.APP_LOCALE = saved === 'en' ? 'en-GB' : 'ar-OM';
    const root = document.documentElement;
    if (saved === 'en') { root.lang = 'en'; root.dir = 'ltr'; root.classList.add('lang-en'); }

    const ARABIC = /[؀-ۿ]/;
    const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
    const dict = () => window.I18N_EN || {};
    const patterns = () => window.I18N_EN_PATTERNS || [];

    /* One Arabic text → English (null when unknown: it stays as written) */
    function en(text) {
        const key = norm(text);
        if (!key || !ARABIC.test(key)) return null;
        const d = dict();
        if (Object.prototype.hasOwnProperty.call(d, key)) return d[key];
        for (const [re, to] of patterns()) {
            const m = key.match(re);
            if (m) return typeof to === 'function' ? to(...m) : key.replace(re, to);
        }
        const whole = look(d, key);
        if (whole !== null) return whole;
        return byParts(d, key);
    }
    const has = (d, k) => Object.prototype.hasOwnProperty.call(d, k);
    /* A text as it is, or a label followed by a colon / «*» / «…» */
    function look(d, s) {
        if (has(d, s)) return d[s];
        const tail = s.match(/^(.*?)\s*([:：*…]+)$/);
        if (tail && has(d, tail[1])) return d[tail[1]] + tail[2];
        return null;
    }
    /* A text the scripts built from parts and values («متبقٍ 15 يوماً», «عميل: سالم»): each part between
       the numbers and Latin words is looked up, then each run of Arabic words; names and the rest stay */
    const LETTERS = '\\u0620-\\u065F\\u066E-\\u06D3\\u0670';
    const RUN = new RegExp(`[${LETTERS}]+(?:\\s+[${LETTERS}]+)*`, 'g');
    function byParts(d, key) {
        let hit = false;
        let unknown = 0;
        let known = 0;
        const out = key.replace(/[^0-9A-Za-z\u0660-\u0669]+/g, (seg) => {
            if (!ARABIC.test(seg)) return seg;
            const lead = seg.match(/^\s*/)[0];
            const trail = seg.match(/\s*$/)[0];
            const found = look(d, seg.trim());
            if (found !== null) { hit = true; known += seg.trim().split(/\s+/).length; return lead + found + trail; }
            return seg.replace(RUN, (r) => {
                const v = look(d, r);
                if (v !== null) { hit = true; known += r.split(/\s+/).length; return v; }
                unknown += r.split(/\s+/).length;
                return r;
            });
        });
        // A name or two left in Arabic is fine; a half-translated sentence is not — then it stays as written
        return hit && unknown <= 3 && unknown < known ? out : null;
    }
    window.t = (s) => (window.APP_LANG === 'en' ? en(s) ?? s : s);

    const ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-label'];
    // What customers and staff wrote: chat messages, follow-up notes, technicians' reports
    const KEEP = ['no-i18n', 'msg', 'msg-text', 'n-text', 'wo-ev', 'wo-feed-text'];
    function translateNode(node) {
        if (node.nodeType === 3) {
            const v = node.nodeValue;
            if (!ARABIC.test(v)) return;
            const out = en(v);
            if (out !== null) {
                const lead = v.match(/^\s*/)[0];
                const trail = v.match(/\s*$/)[0];
                node.nodeValue = lead + out + trail;
            }
            return;
        }
        if (node.nodeType !== 1) return;
        const tag = node.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA' || node.isContentEditable || node.hasAttribute('data-no-i18n')) return;
        for (const a of ATTRS) {
            const v = node.getAttribute(a);
            if (v && ARABIC.test(v)) { const out = en(v); if (out !== null) node.setAttribute(a, out); }
        }
        if (tag === 'INPUT' && (node.type === 'button' || node.type === 'submit') && ARABIC.test(node.value)) {
            const out = en(node.value); if (out !== null) node.value = out;
        }
        // Data the user typed or the customers wrote is not translated
        if (node.classList && KEEP.some((c) => node.classList.contains(c))) return;
        for (let c = node.firstChild; c; c = c.nextSibling) translateNode(c);
    }
    window.translatePage = (el = document.body) => { if (window.APP_LANG === 'en' && el) translateNode(el); };

    /* The switch buttons name the other language */
    const nameButtons = () => document.querySelectorAll('.lang-name').forEach((el) => {
        el.textContent = saved === 'en' ? (el.classList.contains('lang-short') ? 'ع' : 'العربية') : (el.classList.contains('lang-short') ? 'EN' : 'English');
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', nameButtons); else nameButtons();

    if (saved === 'en') {
        const start = () => {
            translateNode(document.body);
            document.title = window.t(document.title);
            new MutationObserver((records) => {
                for (const r of records) {
                    if (r.type === 'characterData') translateNode(r.target);
                    else if (r.type === 'attributes') translateNode(r.target);
                    else r.addedNodes.forEach(translateNode);
                }
            }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
    }

    /* The switch in the header: saved on the device and the account, then the page reloads in the other language */
    window.setLanguage = async (lang) => {
        lang = lang === 'en' ? 'en' : 'ar';
        try { localStorage.setItem('adminLang', lang); } catch { /* private mode */ }
        try { if (typeof api === 'function') await api('PUT', '/api/admin/me/lang', { lang }); } catch { /* signed out: the device keeps it */ }
        location.reload();
    };
    /* After sign-in: the account's language wins (chosen on another phone) */
    window.applyAccountLanguage = (user) => {
        if (!user || user.owner || !user.lang || user.lang === window.APP_LANG) return;
        try { localStorage.setItem('adminLang', user.lang); } catch { return; }
        location.reload();
    };
})();
