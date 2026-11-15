/* =============================================================
   In-app dialogs instead of the browser's prompt() / confirm() / alert().
   A browser lets the user tick «منع هذه الصفحة من إنشاء نوافذ حوار إضافية»;
   after that every prompt() returns nothing and every confirm() «no» — an
   assignment, a payment, a cancellation would silently stop. These cannot
   be blocked, look like the app, and work the same on a phone.
     await askText(message, defaultValue, { multiline, placeholder, okLabel })  → string, or null (cancelled)
     await askYes(message, { okLabel, danger })                                → true / false
     tell(message)  (also replaces window.alert)                               → Promise, resolved when closed
   ============================================================= */
(function () {
    const queue = [];
    let busy = false;

    function build() {
        let el = document.getElementById('uiDialog');
        if (el) return el;
        el = document.createElement('div');
        el.id = 'uiDialog';
        el.className = 'ui-dialog';
        el.hidden = true;
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.innerHTML = `<form class="ui-dialog-card" novalidate>
            <div class="ui-dialog-msg"></div>
            <div class="ui-dialog-field"></div>
            <div class="ui-dialog-buttons">
                <button type="submit" class="btn btn-primary ui-ok">موافق</button>
                <button type="button" class="btn btn-outline ui-cancel">إلغاء</button>
            </div></form>`;
        document.body.appendChild(el);
        return el;
    }

    function next() {
        if (busy || !queue.length) return;
        busy = true;
        const { kind, message, value, opts, resolve } = queue.shift();
        const el = build();
        const form = el.querySelector('form');
        el.querySelector('.ui-dialog-msg').textContent = String(message ?? '');
        const field = el.querySelector('.ui-dialog-field');
        field.innerHTML = '';
        let input = null;
        if (kind === 'text') {
            input = document.createElement(opts.multiline ? 'textarea' : 'input');
            if (!opts.multiline) input.type = opts.type || 'text';
            if (opts.multiline) input.rows = 3;
            input.value = value ?? '';
            input.placeholder = opts.placeholder || '';
            input.className = 'ui-dialog-input';
            input.setAttribute('autocomplete', opts.type === 'password' ? 'current-password' : 'off');
            field.appendChild(input);
        }
        const ok = el.querySelector('.ui-ok');
        const cancel = el.querySelector('.ui-cancel');
        ok.textContent = opts.okLabel || (kind === 'tell' ? 'حسناً' : 'موافق');
        ok.classList.toggle('danger', Boolean(opts.danger));
        cancel.hidden = kind === 'tell';
        cancel.textContent = opts.cancelLabel || 'إلغاء';
        const done = (result) => {
            el.hidden = true;
            form.onsubmit = null; cancel.onclick = null; el.onclick = null; document.removeEventListener('keydown', onKey, true);
            busy = false;
            resolve(result);
            setTimeout(next, 0);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(kind === 'text' ? null : kind === 'yes' ? false : undefined); }
        };
        form.onsubmit = (e) => { e.preventDefault(); done(kind === 'text' ? input.value : kind === 'yes' ? true : undefined); };
        cancel.onclick = () => done(kind === 'text' ? null : false);
        el.onclick = (e) => { if (e.target === el && kind === 'tell') done(undefined); };
        document.addEventListener('keydown', onKey, true);
        el.hidden = false;
        setTimeout(() => (input || ok).focus(), 30);
        if (input && input.select && value) input.select();
    }

    const ask = (kind, message, value, opts = {}) => new Promise((resolve) => { queue.push({ kind, message, value, opts, resolve }); next(); });
    window.askText = (message, value = '', opts = {}) => ask('text', message, value, opts);
    window.askYes = (message, opts = {}) => ask('yes', message, null, opts);
    window.tell = (message, opts = {}) => ask('tell', message, null, opts);
    // Every message the app shows goes through the in-app dialog (never blocked by the browser)
    window.alert = (message) => { window.tell(message); };
})();
