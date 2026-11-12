/* Panels (sheets) that are easy to close, above all on a phone and in the installed app:
   - the title and a large close button stay fixed at the top while the panel scrolls;
   - swipe the top bar down, tap the dark area outside, press the phone's back button / gesture, or Esc;
   - a panel with something typed in asks first, so nothing is lost by a slip of the finger.
   Works for every <div class="sheet"> on the page without touching how each one opens. */
(function () {
    const stack = [];          // open sheets, the top one last
    const dirty = new Set();   // sheets with something typed since they opened
    let backPending = false;   // a history.back() we started and whose popstate has not come yet
    const pushQueue = [];

    function enhance(sheet) {
        const card = sheet.querySelector('.sheet-card');
        if (!card || card.querySelector(':scope > .sheet-bar')) return;
        const bar = document.createElement('div');
        bar.className = 'sheet-bar';
        bar.innerHTML = '<span class="sheet-grab" aria-hidden="true"></span>';
        const title = card.querySelector(':scope > h3');
        const close = card.querySelector(':scope > .sheet-close');
        if (title) bar.appendChild(title); else bar.classList.add('no-title');
        if (close) bar.appendChild(close);
        card.prepend(bar);
        swipeToClose(sheet, card, bar);
    }

    function closeButton(sheet) { return sheet.querySelector('.sheet-bar .sheet-close, .sheet-close'); }

    // Close the way its own × does (some panels do more than hide themselves)
    function requestClose(sheet, { ask = true } = {}) {
        if (ask && dirty.has(sheet.id) && !confirm('إغلاق النافذة؟ ما كتبته ولم تحفظه سيُفقد.')) return false;
        const x = closeButton(sheet);
        if (x) x.click(); else sheet.hidden = true;
        return true;
    }

    function pushFor(id) {
        if (backPending) pushQueue.push(id);
        else history.pushState({ ...(history.state || {}), sheet: id }, '');
    }

    function opened(sheet) {
        if (stack.includes(sheet)) return;
        enhance(sheet);
        stack.push(sheet);
        dirty.delete(sheet.id);
        const card = sheet.querySelector('.sheet-card');
        if (card) { card.scrollTop = 0; card.style.transform = ''; }
        document.documentElement.classList.add('sheet-open');
        pushFor(sheet.id);
    }

    function closed(sheet, { fromHistory = false } = {}) {
        const i = stack.indexOf(sheet);
        if (i === -1) return;
        stack.splice(i, 1);
        dirty.delete(sheet.id);
        if (!stack.length) document.documentElement.classList.remove('sheet-open');
        // Closed by its × / a save: take its step out of the back history too
        if (!fromHistory && history.state && history.state.sheet === sheet.id && !backPending) {
            backPending = true;
            history.back();
        }
    }

    window.addEventListener('popstate', (e) => {
        if (backPending) {
            backPending = false;
            while (pushQueue.length) history.pushState({ ...(history.state || {}), sheet: pushQueue.shift() }, '');
            return;
        }
        const want = e.state && e.state.sheet;
        // The back button: close the top panel(s) the history has stepped past
        while (stack.length && stack[stack.length - 1].id !== want) {
            const top = stack[stack.length - 1];
            if (dirty.has(top.id) && !confirm('إغلاق النافذة؟ ما كتبته ولم تحفظه سيُفقد.')) {
                history.pushState({ ...(history.state || {}), sheet: top.id }, '');
                return;
            }
            closed(top, { fromHistory: true });
            requestClose(top, { ask: false });
        }
    });

    // Tap on the dark area around the panel
    // (only when the press also started there: selecting text inside and letting go outside is not a close)
    let downOn = null;
    document.addEventListener('pointerdown', (e) => { downOn = e.target; }, true);
    document.addEventListener('click', (e) => {
        const sheet = e.target.classList && e.target.classList.contains('sheet') ? e.target : null;
        if (sheet && downOn === sheet && stack[stack.length - 1] === sheet) requestClose(sheet);
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && stack.length) requestClose(stack[stack.length - 1]);
    });
    document.addEventListener('input', (e) => {
        const sheet = e.target.closest && e.target.closest('.sheet');
        if (sheet && !e.target.closest('.sheet-bar')) dirty.add(sheet.id);
    }, true);
    // A save inside the panel is not "typed and lost"
    document.addEventListener('submit', (e) => {
        const sheet = e.target.closest && e.target.closest('.sheet');
        if (sheet) dirty.delete(sheet.id);
    }, true);

    // Drag the top bar down to close
    function swipeToClose(sheet, card, bar) {
        let y0 = null; let dy = 0;
        bar.addEventListener('touchstart', (e) => {
            if (e.target.closest('.sheet-close')) return;
            y0 = e.touches[0].clientY; dy = 0;
            card.style.transition = 'none';
        }, { passive: true });
        bar.addEventListener('touchmove', (e) => {
            if (y0 === null) return;
            dy = Math.max(0, e.touches[0].clientY - y0);
            card.style.transform = dy ? `translateY(${dy}px)` : '';
        }, { passive: true });
        const end = () => {
            if (y0 === null) return;
            y0 = null;
            card.style.transition = 'transform 0.18s ease-out';
            const far = dy > Math.min(140, card.offsetHeight * 0.25);
            card.style.transform = '';
            if (far) requestClose(sheet);
        };
        bar.addEventListener('touchend', end);
        bar.addEventListener('touchcancel', end);
    }

    const sheets = document.querySelectorAll('.sheet');
    const watch = new MutationObserver((records) => {
        for (const r of records) {
            const s = r.target;
            if (s.hidden) closed(s); else opened(s);
        }
    });
    sheets.forEach((s) => {
        enhance(s);
        watch.observe(s, { attributes: true, attributeFilter: ['hidden'] });
        if (!s.hidden) opened(s);
    });
})();
