/* =============================================================
   «المستخدمون والصلاحيات» (managers): staff accounts, the sections
   each one may open, and their customer follow-up scope.
   Uses api(), $id(), esc(), setStatus() and ME from admin.js.
   ============================================================= */

let usersData = { users: [], sections: {}, roles: {}, scopes: {}, names: [] };

async function loadUsers() {
    usersData = await api('GET', '/api/admin/users');
    $id('uPerms').innerHTML = Object.entries(usersData.sections).map(([k, label]) =>
        `<label class="perm"><input type="checkbox" value="${esc(k)}"> ${esc(label)}</label>`).join('');
    $id('staffInput').value = usersData.names.join('، ');
    renderUsers();
    if (!$id('uId').value) resetUserForm();
}

function renderUsers() {
    const rows = usersData.users;
    $id('usersEmpty').hidden = rows.length > 0;
    $id('usersBody').innerHTML = rows.map((u) => `
        <tr class="${u.active ? '' : 'muted-row'}">
            <td data-label="الموظف"><strong>${esc(u.display_name)}</strong></td>
            <td data-label="اسم المستخدم" dir="ltr">${esc(u.username)}${u.email ? `<br><small class="status-text">${esc(u.email)}</small>` : ''}</td>
            <td data-label="الدور">${u.role === 'manager' ? '<span class="badge on">مدير</span>' : u.role === 'technician' ? '<span class="badge lme">فني</span>' : '<span class="badge">موظف</span>'}</td>
            <td data-label="الأقسام" class="perm-badges">${u.role === 'manager' ? '<span class="pill">كل الأقسام</span>'
                : u.permissions.map((p) => `<span class="pill">${esc(usersData.sections[p] || p)}</span>`).join(' ')}</td>
            <td data-label="متابعة العملاء">${u.permissions.includes('leads') ? esc(u.leads_scope === 'mine' ? 'عملاؤه فقط' : 'كل العملاء') : '—'}</td>
            <td data-label="التحقق بخطوتين">${u.totp_enabled ? '<span class="badge on">مفعّل</span>' : u.role === 'manager' ? '<span class="badge lme">يُطلب عند الدخول</span>' : '<span class="badge">غير مفعّل</span>'}</td>
            <td data-label="الحالة">${u.active ? '<span class="badge on">مفعّل</span>' : '<span class="badge">موقوف</span>'}</td>
            <td data-label="آخر دخول"><small>${u.last_login_at ? esc(new Date(u.last_login_at.replace(' ', 'T') + 'Z').toLocaleString('ar-OM', { dateStyle: 'medium', timeStyle: 'short' })) : 'لم يدخل بعد'}</small></td>
            <td data-label="" style="white-space:nowrap">
                <button class="btn btn-outline btn-sm" onclick="editUser(${u.id})">تعديل</button>
                <button class="btn btn-outline btn-sm" onclick="deleteUser(${u.id})">حذف</button>
            </td>
        </tr>`).join('');
}

function resetUserForm() {
    $id('uId').value = '';
    $id('uDisplay').value = '';
    $id('uUsername').value = '';
    $id('uEmail').value = '';
    $id('uMaxDisc').value = '';
    $id('uPassword').value = '';
    $id('uRole').value = 'staff';
    $id('uActive').checked = true;
    $id('uReset2fa').checked = false;
    $id('uReset2faRow').hidden = true;
    document.querySelectorAll('#uPerms input').forEach((c) => { c.checked = c.value === 'leads'; });
    document.querySelector('input[name="uScope"][value="all"]').checked = true;
    $id('userFormTitle').textContent = 'إضافة موظف';
    $id('uSave').textContent = 'إضافة الموظف';
    $id('uPasswordLabel').textContent = 'كلمة المرور (8 أحرف على الأقل)';
    userRoleChanged();
    setStatus('userStatus', '');
}

function userRoleChanged() {
    $id('uPermsBox').hidden = $id('uRole').value !== 'staff';
    $id('uManagerNote').hidden = $id('uRole').value !== 'manager';
    $id('uTechNote').hidden = $id('uRole').value !== 'technician';
    $id('uMaxDiscBox').hidden = $id('uRole').value !== 'staff';
}

function editUser(id) {
    const u = usersData.users.find((x) => x.id === id);
    if (!u) return;
    $id('uId').value = u.id;
    $id('uDisplay').value = u.display_name;
    $id('uUsername').value = u.username;
    $id('uEmail').value = u.email || '';
    $id('uMaxDisc').value = u.max_discount_percent ?? '';
    $id('uPassword').value = '';
    $id('uRole').value = u.role;
    $id('uActive').checked = u.active;
    $id('uReset2fa').checked = false;
    $id('uReset2faRow').hidden = !u.totp_enabled;
    document.querySelectorAll('#uPerms input').forEach((c) => { c.checked = u.permissions.includes(c.value); });
    document.querySelector(`input[name="uScope"][value="${u.leads_scope}"]`).checked = true;
    $id('userFormTitle').textContent = 'تعديل: ' + u.display_name;
    $id('uSave').textContent = 'حفظ التعديلات';
    $id('uPasswordLabel').textContent = 'كلمة مرور جديدة (اتركها فارغة لعدم التغيير)';
    userRoleChanged();
    $id('userFormCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function saveUser() {
    const id = $id('uId').value;
    const body = {
        display_name: $id('uDisplay').value,
        username: $id('uUsername').value,
        email: $id('uEmail').value.trim(),
        max_discount_percent: $id('uMaxDisc').value === '' ? null : Number($id('uMaxDisc').value),
        role: $id('uRole').value,
        permissions: [...document.querySelectorAll('#uPerms input:checked')].map((c) => c.value),
        leads_scope: document.querySelector('input[name="uScope"]:checked').value,
        active: $id('uActive').checked
    };
    if ($id('uPassword').value) body.password = $id('uPassword').value;
    if (id && $id('uReset2fa').checked) {
        if (!confirm('إعادة ضبط التحقق بخطوتين لهذا الحساب؟ يخرج من كل الأجهزة، ويضبطه من جديد بجواله عند الدخول.')) return;
        body.reset_2fa = true;
    }
    try {
        await api(id ? 'PUT' : 'POST', id ? `/api/admin/users/${id}` : '/api/admin/users', body);
        const created = !id;
        await loadUsers();
        resetUserForm();
        setStatus('userStatus', created ? 'تمت إضافة الموظف ✓ — أعطه اسم المستخدم وكلمة المرور' : 'تم الحفظ ✓', 'ok');
    } catch (err) {
        setStatus('userStatus', err.message, 'err');
    }
}

async function deleteUser(id) {
    const u = usersData.users.find((x) => x.id === id);
    if (!u || !confirm(`حذف حساب «${u.display_name}»؟ تبقى تقاريره ورسائله السابقة باسمه.\nلإيقافه مؤقتاً استخدم «تعديل» وألغِ «الحساب مفعّل».`)) return;
    try {
        await api('DELETE', `/api/admin/users/${id}`);
        await loadUsers();
        if (String($id('uId').value) === String(id)) resetUserForm();
    } catch (err) {
        alert(err.message);
    }
}

/* Names without an account (shown in «الموظف المتابع») */
async function saveStaff() {
    const names = $id('staffInput').value.split(/[,،\n]/).map((n) => n.trim()).filter(Boolean);
    try {
        const s = await api('PUT', '/api/admin/settings', { staff_members: names });
        $id('staffInput').value = s.staff_members.join('، ');
        setStatus('staffStatus', 'تم الحفظ ✓', 'ok');
    } catch (err) {
        setStatus('staffStatus', err.message, 'err');
    }
}

const switchTabBeforeUsers = window.switchTab;
window.switchTab = function (tabId) {
    switchTabBeforeUsers(tabId);
    if (online && tabId === 'users' && ME && ME.role === 'manager') loadUsers().catch((err) => setStatus('userStatus', err.message, 'err'));
};
