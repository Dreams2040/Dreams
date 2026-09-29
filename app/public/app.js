'use strict';
// نظام إدارة طلبات التفرغ الجزئي للمعلمين — الواجهة (JavaScript بدون مكتبات أو بناء)

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { user: null, cfg: null, lk: null, unread: 0 };
let H = {};   // معالجات الصفحة الحالية: data-act="name" و $change/$input/$submit

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method, credentials: 'same-origin',
    headers: { 'X-Requested-With': 'fetch', ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (res.headers.get('Content-Type') || '').includes('json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && state.user) { state.user = null; location.hash = '#/login'; }
    throw Object.assign(new Error(data?.error || 'تعذر الاتصال بالخادم'), { fields: data?.fields, status: res.status });
  }
  return data;
}

// ───── تنسيق ─────
const LOC = 'ar-OM-u-nu-latn', TZ = 'Asia/Muscat';
const toDate = s => new Date(s.replace(' ', 'T') + 'Z');
const fmtDate = s => s ? toDate(s).toLocaleDateString(LOC, { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }) : '—';
const fmtTime = s => s ? toDate(s).toLocaleTimeString(LOC, { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) : '';
const fmtDT = s => s ? `${fmtDate(s)} ${fmtTime(s)}` : '—';
const fmtDay = s => s ? s.split('-').reverse().join('/') : '—';
const fmtMonth = ym => new Date(ym + '-01T00:00:00Z').toLocaleDateString(LOC, { timeZone: 'UTC', month: 'short' }) + ' ' + ym.slice(0, 4);
const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' م.ب' : Math.ceil(n / 1024) + ' ك.ب';
const badge = (status, label) => `<span class="badge st-${esc(status)}"><i></i>${esc(label || state.lk?.statuses[status] || status)}</span>`;
const visibleF = (f, d) => Object.entries(f.show_if || {}).every(([k, v]) => d[k] === v);
const DEMO = window.PTMS_DEMO;   // نسخة العرض التجريبية (app/demo) تستبدل الخادم بمحاكٍ داخل المتصفح
const docUrl = id => DEMO ? DEMO.docUrl(id) : `/api/documents/${id}`;
const home = () => state.user?.role === 'admin' ? '#/stats' : '#/dashboard';

const ICONS = {
  home: 'M3 11l9-8 9 8M5 10v10h14V10', plus: 'M12 5v14M5 12h14',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01', bell: 'M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4',
  chart: 'M4 20V10M10 20V4M16 20v-8M22 20H2', report: 'M6 2h9l5 5v15H6zM14 2v6h6M9 13h6M9 17h6',
  users: 'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8M22 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8',
  school: 'M2 10l10-6 10 6-10 6zM6 12v5c3 2 9 2 12 0v-5', doc: 'M14 2H6v20h12V6zM14 2v4h4',
  flow: 'M5 3v6M5 15v6M5 9a3 3 0 100 6 3 3 0 000-6M19 9a3 3 0 100 6 3 3 0 000-6M8 12h8',
  audit: 'M12 8v4l3 2M3 12a9 9 0 1018 0 9 9 0 00-18 0', inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.5 5h13L22 12v7H2v-7z',
};
const icon = n => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[n]}"/></svg>`;

// ───── إشعارات منبثقة ونوافذ ─────
function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 5000);
}

function modal(title, html, buttons = [{ label: 'إغلاق' }], { wide, onOpen } = {}) {
  return new Promise(resolve => {
    const root = $('#modal-root'), prev = document.activeElement;
    // <dialog> + showModal(): خلفية خاملة، حصر التنقل بـ Tab، وEsc تلقائيًا
    root.innerHTML = `<dialog class="modal ${wide ? 'wide' : ''}" aria-labelledby="m-title">
      <header><h3 id="m-title">${esc(title)}</h3><button class="icon-btn" data-m="x" aria-label="إغلاق">✕</button></header>
      <div class="m-body">${html}</div><p class="m-err" role="alert"></p>
      <footer>${buttons.map((b, i) => `<button class="btn ${b.cls || 'ghost'}" data-m="${i}">${esc(b.label)}</button>`).join('')}</footer>
    </dialog>`;
    const box = $('dialog', root);
    let busy = false, result = null;
    const close = v => { result = v; box.close(); };
    box.addEventListener('cancel', e => busy && e.preventDefault());   // لا إغلاق أثناء تنفيذ الإجراء
    box.addEventListener('close', () => { root.innerHTML = ''; prev?.focus?.(); resolve(result); });
    box.onclick = async e => {
      if (e.target === box && !busy) return close(null);   // نقرة على الخلفية
      const m = e.target.closest('[data-m]')?.dataset.m;
      if (m === undefined || busy) return;
      if (m === 'x') return close(null);
      const b = buttons[+m];
      if (!b.run) return close(b.value ?? null);
      const btn = e.target.closest('button');
      btn.disabled = busy = true;
      try { const v = await b.run(box); busy = false; if (v !== false) close(v ?? true); }
      catch (err) { $('.m-err', box).textContent = err.message; }
      finally { busy = false; btn.disabled = false; }
    };
    box.showModal();
    onOpen?.(box);
    ($('input:not([type=hidden]),textarea,select', box) || $('footer .btn', box))?.focus();
  });
}
const confirmBox = (msg, label = 'تأكيد', cls = 'primary') =>
  modal('تأكيد الإجراء', `<p>${esc(msg)}</p>`, [{ label, cls, value: true }, { label: 'إلغاء' }]);
const formData = box => Object.fromEntries($$('[name]', box).map(el => [el.name, el.type === 'checkbox' ? el.checked : el.value.trim()]));

// ───── الإطار العام ─────
const NAV = {
  teacher: [['#/dashboard', 'الرئيسية', 'home'], ['#/requests/new', 'طلب جديد', 'plus'], ['#/requests', 'طلباتي', 'list'], ['#/notifications', 'الإشعارات', 'bell']],
  employee: [['#/dashboard', 'الرئيسية', 'home'], ['#/requests', 'الطلبات', 'list'], ['#/stats', 'لوحة المؤشرات', 'chart'], ['#/reports', 'التقارير', 'report'], ['#/notifications', 'الإشعارات', 'bell']],
  approver: [['#/dashboard', 'الرئيسية', 'home'], ['#/requests?stage=approver', 'الطلبات المحالة', 'inbox'], ['#/requests', 'جميع الطلبات', 'list'], ['#/stats', 'لوحة المؤشرات', 'chart'], ['#/reports', 'التقارير', 'report'], ['#/notifications', 'الإشعارات', 'bell']],
  admin: [['#/stats', 'لوحة المؤشرات', 'chart'], ['#/requests', 'الطلبات', 'list'], ['#/reports', 'التقارير', 'report'], ['#/admin/users', 'المستخدمون', 'users'], ['#/admin/schools', 'المدارس', 'school'], ['#/admin/types', 'أنواع الطلبات والمستندات', 'doc'], ['#/admin/workflow', 'مراحل سير العمل', 'flow'], ['#/admin/audit', 'سجل العمليات', 'audit'], ['#/notifications', 'الإشعارات', 'bell']],
};

function shell(content) {
  const u = state.user, h = location.hash;
  const items = NAV[u.role];
  const active = items.find(([x]) => x === h)?.[0] || items.filter(([x]) => h.startsWith(x.split('?')[0])).sort((a, b) => b[0].length - a[0].length)[0]?.[0];
  $('#app').innerHTML = `
  <header class="topbar no-print">
    <a class="brand" href="${home()}"><img src="/logo.svg" alt="" width="38" height="38"><span><b>نظام إدارة طلبات التفرغ الجزئي</b><small>${esc(state.cfg.org)}</small></span></a>
    <div class="top-actions">
      <a class="icon-btn bell" href="#/notifications" aria-label="${state.unread ? `الإشعارات (${state.unread} غير مقروءة)` : 'الإشعارات'}">${icon('bell')}<span class="count" ${state.unread ? '' : 'hidden'}>${state.unread}</span></a>
      <div class="who"><b>${esc(u.full_name)}</b><small>${esc(u.role_label)}</small></div>
      <button class="btn ghost sm" data-act="logout">خروج</button>
    </div>
  </header>
  <div class="layout">
    <nav class="side no-print" aria-label="القائمة الرئيسية">${items.map(([x, l, i]) => `<a href="${x}" class="${x === active ? 'on' : ''}">${icon(i)}<span>${l}</span></a>`).join('')}</nav>
    <main id="view" tabindex="-1">${content}</main>
  </div>`;
}

const stat = (label, value, cls) => `<div class="stat s-${cls}"><span>${esc(label)}</span><b>${value ?? '—'}</b></div>`;
const empty = msg => `<div class="empty">${esc(msg)}</div>`;

function teacherTable(rows) {
  if (!rows.length) return empty('لا توجد طلبات بعد. ابدأ بتقديم طلب تفرغ جزئي.');
  return `<div class="table-wrap"><table class="table"><thead><tr><th>رقم الطلب</th><th>تاريخ الطلب</th><th>نوع الطلب</th><th>الحالة</th><th>آخر تحديث</th><th>الإجراء</th></tr></thead><tbody>
  ${rows.map(r => `<tr>
    <td data-label="رقم الطلب"><b>${esc(r.request_no || 'مسودة')}</b></td>
    <td data-label="تاريخ الطلب">${fmtDate(r.submitted_at || r.created_at)}</td>
    <td data-label="نوع الطلب">${esc(r.leave_type || r.type_name)}</td>
    <td data-label="الحالة">${badge(r.status, r.status_label)}</td>
    <td data-label="آخر تحديث">${fmtDT(r.updated_at)}</td>
    <td data-label="الإجراء">${['draft', 'needs_completion'].includes(r.status)
      ? `<a class="btn sm ${r.status === 'needs_completion' ? 'warn' : 'primary'}" href="#/requests/${r.id}/edit">${r.status === 'draft' ? 'متابعة التعبئة' : 'استكمال الطلب'}</a>`
      : r.decision_no ? `<a class="btn sm primary" href="#/decision/${r.id}">عرض القرار</a> <a class="link" href="#/requests/${r.id}">متابعة</a>`
      : `<a class="btn sm ghost" href="#/requests/${r.id}">متابعة الطلب</a>`}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function staffTable(rows) {
  if (!rows.length) return empty('لا توجد طلبات مطابقة.');
  return `<div class="table-wrap"><table class="table"><thead><tr><th>رقم الطلب</th><th>اسم المعلم</th><th>المدرسة</th><th>الولاية</th><th>تاريخ التقديم</th><th>الحالة</th><th>مدة الانتظار</th><th>الإجراء</th></tr></thead><tbody>
  ${rows.map(r => {
    const mine = (state.user.role === 'employee' && r.stage === 'employee') || (state.user.role === 'approver' && r.stage === 'approver');
    return `<tr>
    <td data-label="رقم الطلب"><b>${esc(r.request_no)}</b></td>
    <td data-label="اسم المعلم">${esc(r.teacher_name)}<small class="muted d-block">${esc(r.employee_no)}</small></td>
    <td data-label="المدرسة">${esc(r.school_name)}</td>
    <td data-label="الولاية">${esc(r.wilayat)}</td>
    <td data-label="تاريخ التقديم">${fmtDate(r.submitted_at)}</td>
    <td data-label="الحالة">${badge(r.status, r.status_label)}${r.stage === 'approver' && r.status === 'under_review' ? '<small class="muted d-block">لدى المعتمد</small>' : ''}</td>
    <td data-label="مدة الانتظار"><span class="${r.wait_days > 7 && !r.decided_at ? 'late' : ''}">${r.wait_days ?? 0} يوم</span></td>
    <td data-label="الإجراء"><a class="btn sm ${mine ? 'primary' : 'ghost'}" href="#/requests/${r.id}">${mine ? 'مراجعة' : 'عرض'}</a></td></tr>`;
  }).join('')}
  </tbody></table></div>`;
}

// ───── تسجيل الدخول ─────
function viewLogin() {
  if (state.user) return void (location.hash = home());
  const demo = state.cfg.demo ? `<div class="card demo"><h3>حسابات العرض التجريبي</h3><p class="muted">كلمة المرور لجميع الحسابات: <code>Demo@1234</code></p>
    <div class="demo-list">${[['teacher1', 'معلم'], ['employee1', 'الموظف المختص'], ['approver1', 'المسؤول المعتمد'], ['admin', 'مدير النظام']]
      .map(([u, l]) => `<button type="button" class="btn ghost sm" data-act="demo" data-u="${u}">${l}</button>`).join('')}</div></div>` : '';
  $('#app').innerHTML = `<div class="login-page">
    <section class="login-brand">
      <img src="/logo.svg" alt="شعار الجهة" width="92" height="92">
      <h1>نظام إدارة طلبات التفرغ الجزئي للمعلمين</h1>
      <p>${esc(state.cfg.org)}</p>
      <ul><li>تقديم الطلب ورفع المستندات إلكترونيًا</li><li>متابعة حالة الطلب في كل مرحلة</li><li>اعتماد الطلب وإصدار القرار دون أوراق</li></ul>
    </section>
    <section class="login-side">
      <form id="login" class="card login-card" novalidate>
        <h2>تسجيل الدخول</h2>
        <label>اسم المستخدم<input name="username" autocomplete="username" required></label>
        <label>كلمة المرور<input name="password" type="password" autocomplete="current-password" required></label>
        <p class="form-err" role="alert"></p>
        <button class="btn primary block lg">تسجيل الدخول</button>
        <button type="button" class="link center" data-act="forgot">نسيت كلمة المرور؟</button>
      </form>${demo}
    </section></div>`;
  H.demo = el => { $('[name=username]').value = el.dataset.u; $('[name=password]').value = 'Demo@1234'; $('#login').requestSubmit(); };
  H.forgot = () => modal('نسيت كلمة المرور', `<p class="muted">أدخل اسم المستخدم وسيتم إبلاغ مدير النظام لإعادة تعيين كلمة المرور.</p>
    <label>اسم المستخدم<input name="username"></label>`, [{
    label: 'إرسال', cls: 'primary', run: async box => {
      const { username } = formData(box);
      if (!username) throw new Error('أدخل اسم المستخدم');
      toast((await api('/forgot', { method: 'POST', body: { username } })).message);
    },
  }, { label: 'إلغاء' }]);
  H.$submit = async e => {
    const f = formData(e.target), err = $('.form-err');
    if (!f.username || !f.password) return void (err.textContent = 'أدخل اسم المستخدم وكلمة المرور');
    try {
      state.user = (await api('/login', { method: 'POST', body: f })).user;
      state.unread = (await api('/me')).unread;
      state.lk = null;
      location.hash = home();
    } catch (x) { err.textContent = x.message; }
  };
  $('[name=username]').focus();
}

// ───── لوحة المعلم / الموظف / المعتمد ─────
async function viewDashboard() {
  const u = state.user;
  if (u.role === 'admin') return void (location.hash = '#/stats');
  const d = await api('/dashboard'), k = d.counts;
  if (u.role === 'teacher') {
    const need = d.requests.filter(r => r.status === 'needs_completion');
    shell(`<div class="page-head"><div><h1>مرحبًا، ${esc(u.full_name)}</h1><p class="muted">تابع طلباتك وقدّم طلبًا جديدًا بسهولة.</p></div>
      <button class="btn primary lg" data-act="new">+ تقديم طلب تفرغ جزئي</button></div>
      ${need.length ? `<div class="alert warn"><b>تنبيه:</b> لديك ${need.length} طلب يحتاج إلى استكمال. <a href="#/requests/${need[0].id}">عرض الطلب</a></div>` : ''}
      <div class="stats">${stat('إجمالي الطلبات', k.total, 'total')}${stat('قيد المراجعة', k.in_review, 'under_review')}${stat('تحتاج استكمال', k.needs_completion, 'needs_completion')}${stat('المعتمدة', k.approved, 'approved')}${stat('المرفوضة', k.rejected, 'rejected')}</div>
      <section class="card"><header class="card-head"><h2>آخر الطلبات</h2><a href="#/requests">عرض الكل</a></header>${teacherTable(d.requests)}</section>`);
    H.new = newRequest;
    return;
  }
  shell(`<div class="page-head"><div><h1>مرحبًا، ${esc(u.full_name)}</h1><p class="muted">${esc(u.role_label)}${u.governorate ? ' — محافظة ' + esc(u.governorate) : ''}</p></div></div>
    <div class="stats">${stat('الطلبات الجديدة', k.new, 'submitted')}${stat('قيد المراجعة', k.under_review, 'under_review')}${stat('تحتاج استكمال', k.needs_completion, 'needs_completion')}${stat('المعتمدة', k.approved, 'approved')}${stat('المرفوضة', k.rejected, 'rejected')}${stat('إجمالي الطلبات', k.total, 'total')}</div>
    <section class="card"><header class="card-head"><h2>${u.role === 'approver' ? 'طلبات بانتظار اعتمادك' : 'طلبات تحتاج إجراءً منك'}</h2><a href="#/requests">جميع الطلبات</a></header>${staffTable(d.requests)}</section>`);
}

async function newRequest() {
  const drafts = (await api('/requests?status=draft')).requests;
  if (drafts.length) {
    const v = await modal('لديك مسودة غير مرسلة', `<p>لديك ${drafts.length} مسودة لم تُرسل بعد. هل تريد متابعة آخر مسودة بدلًا من إنشاء طلب جديد؟</p>`,
      [{ label: 'متابعة المسودة', cls: 'primary', value: 'draft' }, { label: 'إنشاء طلب جديد', value: 'new' }]);
    if (v === 'draft') return void (location.hash = `#/requests/${drafts[0].id}/edit`);
    if (v !== 'new') return void (location.hash === '#/requests/new' && history.back());
  }
  const types = state.lk.types;
  let typeId = types[0]?.id;
  if (types.length > 1) {
    typeId = await modal('نوع الطلب', `<label>اختر نوع الطلب<select name="t">${types.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></label>`,
      [{ label: 'متابعة', cls: 'primary', run: box => +$('[name=t]', box).value }, { label: 'إلغاء' }]);
    if (!typeId) return;
  }
  const { id } = await api('/requests', { method: 'POST', body: { request_type_id: typeId } });
  location.hash = `#/requests/${id}/edit`;
}

// ───── معالج تقديم الطلب (Wizard) ─────
const STEPS = ['بيانات المعلم', 'بيانات التفرغ', 'المستندات', 'المراجعة والإرسال'];
const CONTRACT = [
  'الالتزام باللوائح والأنظمة المعمول بها في المؤسسات التعليمية داخل السلطنة وخارجها.',
  'موافاة الوزارة بالتقارير الدراسية نهاية كل فصل دراسي عن طريق جهة العمل، وتفويضها بالحصول عليها مباشرة من المؤسسة التعليمية.',
  'عدم إجراء أي تعديل في الوضع الدراسي (تمديد، تأجيل، قطع، استئناف، تغيير مقر الدراسة أو المؤهل أو التخصص) إلا بعد الحصول على الموافقة الرسمية.',
  'الالتزام بالمدة المحددة في قرار الإيفاد، وتقديم طلب التمديد – عند الحاجة – قبل نهاية الفترة بثلاثة أشهر على الأقل مع التقارير الدراسية ورسالة المؤسسة التعليمية.',
  'مباشرة العمل خلال مدة لا تتجاوز شهرًا من الحصول على المؤهل حتى لو لم تنتهِ الفترة المحددة في القرار.',
  'استمرار التواصل مع الوزارة وتحديث البيانات (العنوان، الهاتف، البريد الإلكتروني) طوال فترة الدراسة.',
  'تسليم نسخة من المؤهل بعد الحصول عليه (ومعادلته إذا كان من خارج السلطنة)، ونسخة إلكترونية وورقية من الأطروحة لطلبة الماجستير والدكتوراه.',
  'يحق للوزارة تطبيق الجزاءات القانونية والإدارية والمالية عند الإخلال بأي بند، وإلغاء القرار في الحالات المنصوص عليها (مثل الرسوب سنتين متتاليتين أو تغيير الجامعة أو التخصص دون موافقة).',
];

async function viewWizard(params, id, step = '1') {
  const d = await api(`/requests/${id}`);
  if (!d.can_edit) return void (location.hash = `#/requests/${id}`);
  const W = { id, d, details: { ...d.details }, step: Math.min(4, Math.max(1, +step)), errors: {} };
  drawWizard(W);

  const collect = () => $$('[data-field]').forEach(el => { W.details[el.dataset.field] = el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value.trim(); });
  const save = async (quiet) => {
    collect();
    const editable = new Set([...d.fields.map(f => f.name), ...state.lk.teacher_fields.filter(t => t[2]).map(t => t[0])]);
    try {
      const res = await api(`/requests/${id}`, { method: 'PUT', body: { details: Object.fromEntries(Object.entries(W.details).filter(([k]) => editable.has(k))) } });
      W.details = res.details;
      W.errors = {};
      if (!quiet) toast('تم حفظ المسودة');
      return true;
    } catch (e) {
      W.errors = e.fields || {};
      drawWizard(W);
      toast(e.message, 'err');
      return false;
    }
  };
  const go = async n => { if (await save(true)) { W.step = n; history.replaceState(null, '', `#/requests/${id}/edit/${n}`); drawWizard(W); } };
  H.next = () => go(W.step + 1);
  H.prev = () => go(W.step - 1);
  H.goto = el => go(+el.dataset.step);
  H.save = () => save(false);
  H.contract = () => modal('بنود عقد الالتحاق بالبرامج التأهيلية (ملخص)',
    `<ol class="contract">${CONTRACT.map(c => `<li>${esc(c)}</li>`).join('')}</ol><p class="muted">النص الكامل في النموذج الرئيسي رقم (2) «عقد الالتحاق بالبرامج التأهيلية».</p>`, [{ label: 'إغلاق' }], { wide: true });
  H.$change = e => {
    if (e.target.matches('input[type=file][data-doc]')) return upload(e.target);
    if (e.target.dataset.field === 'leave_type') { collect(); drawWizard(W); }
  };
  H.$input = e => {
    if (!['start_date', 'end_date'].includes(e.target.dataset.field)) return;
    collect();
    const s = W.details.start_date, en = W.details.end_date, out = $('[data-computed=days]');
    const n = s && en ? Math.round((new Date(en) - new Date(s)) / 864e5) + 1 : 0;
    if (out) out.value = n > 0 ? n : '';
  };
  async function upload(input) {
    const file = input.files[0];
    if (!file) return;
    if (!/\.(pdf|jpe?g|png)$/i.test(file.name)) return toast('نوع الملف غير مسموح. المسموح: PDF أو JPG أو PNG', 'err');
    if (file.size > 5 * 1024 * 1024) return toast('حجم الملف يجب ألا يتجاوز 5 ميغابايت', 'err');
    const row = input.closest('tr');
    row.classList.add('busy');
    try {
      const data = await new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(r.result.split(',')[1]); r.onerror = fail; r.readAsDataURL(file); });
      const doc = await api(`/requests/${id}/documents`, { method: 'POST', body: { doc_type_id: +input.dataset.doc, filename: file.name, data } });
      d.documents = d.documents.filter(x => x.doc_type_id !== doc.doc_type_id).concat(doc);
      toast('تم رفع الملف');
    } catch (e) { toast(e.message, 'err'); }
    drawWizard(W);
  }
  H.deldoc = async el => {
    if (!await confirmBox('حذف هذا الملف؟', 'حذف', 'danger')) return;
    try {
      await api(`/documents/${el.dataset.id}`, { method: 'DELETE' });
      d.documents = d.documents.filter(x => x.id !== +el.dataset.id);
      drawWizard(W);
    } catch (e) { toast(e.message, 'err'); }
  };
  H.submit = async () => {
    if (!await save(true)) return;
    const declaration = $('#declaration')?.checked === true;
    const action = d.request.status === 'needs_completion' ? 'resubmit' : 'submit';
    try {
      const res = await api(`/requests/${id}/actions/${action}`, { method: 'POST', body: { declaration } });
      state.unread++;
      await modal('تم إرسال طلبك بنجاح', `<div class="success"><div class="check-big">✓</div><p>رقم الطلب</p><b class="req-no">${esc(res.request_no)}</b>
        <p class="muted">احتفظ برقم الطلب لمتابعته. سيصلك إشعار عند كل تحديث.</p></div>`, [{ label: 'متابعة الطلب', cls: 'primary' }]);
      location.hash = `#/requests/${id}`;
    } catch (e) {
      W.errors = e.fields || {};
      drawWizard(W);
      toast(e.message, 'err');
    }
  };
}

function drawWizard(W) {
  const { d, details: v, step, errors } = W, r = d.request;
  const completion = r.status === 'needs_completion' ? d.comments.filter(c => c.kind === 'completion').pop() : null;
  const progress = `<ol class="steps">${STEPS.map((s, i) => `<li class="${i + 1 === step ? 'on' : i + 1 < step ? 'done' : ''}"${i + 1 === step ? ' aria-current="step"' : ''}><button type="button" data-act="goto" data-step="${i + 1}"><span>${i + 1 < step ? '✓' : i + 1}</span>${s}</button></li>`).join('')}</ol>
    <div class="progress" role="progressbar" aria-label="تقدم الطلب" aria-valuetext="الخطوة ${step} من 4: ${STEPS[step - 1]}" aria-valuemin="1" aria-valuemax="4" aria-valuenow="${step}"><i style="width:${step * 25}%"></i></div>`;
  const tf = state.lk.teacher_fields;
  let body = '';
  if (step === 1) {
    body = `<h2>بيانات المعلم</h2><p class="muted">عُبئت البيانات تلقائيًا من سجلك الوظيفي. الحقول المقفلة 🔒 تُعدَّل من مدير النظام فقط.</p>
      <div class="grid">${tf.map(([n, l, ed]) => `<div class="field ${errors[n] ? 'has-err' : ''}"><label for="f_${n}">${esc(l)} ${ed ? '<i class="req">*</i>' : '🔒'}</label>
      <input id="f_${n}"${errors[n] ? ` aria-invalid="true" aria-describedby="f_${n}-err"` : ''} ${ed ? `data-field="${n}"` : 'readonly class="locked"'} type="${n === 't_email' ? 'email' : n === 't_phone' ? 'tel' : 'text'}" value="${esc(v[n])}">
      ${errors[n] ? `<small class="err" id="f_${n}-err">${esc(errors[n])}</small>` : ''}</div>`).join('')}</div>`;
  } else if (step === 2) {
    body = `<h2>بيانات طلب التفرغ</h2><div class="grid">${d.fields.filter(f => visibleF(f, v)).map(f => fieldInput(f, v[f.name], errors[f.name])).join('')}</div>`;
  } else if (step === 3) {
    body = `<h2>المستندات</h2><p class="muted">الصيغ المسموحة: PDF أو JPG أو PNG بحجم أقصى 5 ميغابايت للملف. لا يمكن إرسال الطلب قبل رفع جميع المستندات الإلزامية.</p>${docsTable(d, errors)}`;
  } else {
    body = reviewStep(W);
  }
  shell(`<div class="page-head"><div><h1>${r.request_no ? 'استكمال الطلب ' + esc(r.request_no) : 'طلب تفرغ جزئي جديد'}</h1><p class="muted">${esc(r.type_name)} — ${badge(r.status, r.status_label)}</p></div>
    <a class="link" href="${r.request_no ? '#/requests/' + r.id : '#/dashboard'}">إلغاء والعودة</a></div>
    ${completion ? completionAlert(completion) : ''}
    <section class="card wizard">${progress}<div class="step-body">${body}</div>
    <footer class="wizard-nav">
      ${step > 1 ? '<button class="btn ghost" data-act="prev">→ السابق</button>' : '<span></span>'}
      <div class="row">
        <button class="btn ghost" data-act="save">حفظ كمسودة</button>
        ${step < 4 ? '<button class="btn primary" data-act="next">التالي ←</button>'
          : `<button class="btn primary" data-act="submit">${r.status === 'needs_completion' ? 'إعادة إرسال الطلب' : 'إرسال الطلب'}</button>`}
      </div>
    </footer></section>`);
  // بعد كل إعادة رسم: التركيز على ملخص الأخطاء أو أول حقل خاطئ أو عنوان الخطوة
  const h2 = $('.step-body h2');
  h2?.setAttribute('tabindex', '-1');
  ($('.step-body .alert.err') || $('.has-err input, .has-err select, .has-err textarea') || h2)?.focus();
}

function completionAlert(c) {
  const reasons = c.reasons_json ? JSON.parse(c.reasons_json) : [];
  return `<div class="alert warn"><b>هذا الطلب يحتاج إلى استكمال البيانات التالية:</b>
    ${reasons.length ? `<div class="chips">${reasons.map(x => `<span class="chip">${esc(x)}</span>`).join('')}</div>` : ''}
    <p class="note">${esc(c.body)}</p><small class="muted">${esc(c.user_name)} — ${fmtDT(c.created_at)}</small></div>`;
}

function fieldInput(f, v, err) {
  const id = 'f_' + f.name, req = f.required ? ' <i class="req">*</i>' : '';
  const e = err ? `<small class="err" id="${id}-err">${esc(err)}</small>` : '', a = err ? ` aria-invalid="true" aria-describedby="${id}-err"` : '';
  if (f.kind === 'checkbox') {
    return `<div class="field full ${err ? 'has-err' : ''}"><label class="check"><input type="checkbox" id="${id}"${a} data-field="${f.name}" value="1" ${v === '1' ? 'checked' : ''}><span>${esc(f.label)}${req}</span></label>
      ${f.name === 'contract_ack' ? '<button type="button" class="link" data-act="contract">عرض بنود العقد</button>' : ''}${e}</div>`;
  }
  let input;
  if (f.kind === 'select') input = `<select id="${id}"${a} data-field="${f.name}"><option value="">اختر…</option>${f.options.map(o => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  else if (f.kind === 'textarea') input = `<textarea id="${id}"${a} data-field="${f.name}" rows="3">${esc(v)}</textarea>`;
  else if (f.kind === 'computed') input = `<input id="${id}" readonly class="locked" data-computed="${f.name}" value="${esc(v)}" placeholder="يُحسب تلقائيًا">`;
  else input = `<input id="${id}"${a} data-field="${f.name}" type="${{ date: 'date', number: 'number', email: 'email', tel: 'tel' }[f.kind] || 'text'}" value="${esc(v)}"${f.min != null ? ` min="${f.min}"` : ''}${f.max != null ? ` max="${f.max}"` : ''}>`;
  return `<div class="field ${f.kind === 'textarea' ? 'full' : ''} ${err ? 'has-err' : ''}"><label for="${id}">${esc(f.label)}${req}</label>${input}${e}</div>`;
}

function docsTable(d, errors = {}, readonly = false) {
  const byType = Object.fromEntries(d.documents.map(x => [x.doc_type_id, x]));
  return `<div class="table-wrap"><table class="table docs"><thead><tr><th>اسم المستند</th><th>إلزامي/اختياري</th>${readonly ? '' : '<th>رفع الملف</th>'}<th>حالة الملف</th></tr></thead><tbody>
  ${d.doc_types.map(t => {
    const f = byType[t.id], err = errors['doc:' + t.name];
    return `<tr class="${err ? 'has-err' : ''}">
      <td data-label="اسم المستند"><b>${esc(t.name)}</b>${t.hint ? `<small class="muted d-block">${esc(t.hint)}</small>` : ''}</td>
      <td data-label="إلزامي/اختياري"><span class="tag ${t.required ? 'req' : ''}">${t.required ? 'إلزامي' : 'اختياري'}</span></td>
      ${readonly ? '' : `<td data-label="رفع الملف"><label class="btn sm ${f ? 'ghost' : 'primary'} file-btn">${f ? 'إعادة رفع' : 'اختيار ملف'}<input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" data-doc="${t.id}"></label></td>`}
      <td data-label="حالة الملف">${f ? `<span class="ok-text">✓ تم رفع الملف</span><small class="muted d-block">${esc(f.original_name)} — ${fmtSize(f.size)}</small>
        <span class="row"><a class="link" href="${docUrl(f.id)}" data-id="${f.id}" target="_blank" rel="noopener">معاينة</a>${readonly ? '' : `<button type="button" class="link danger" data-act="deldoc" data-id="${f.id}">حذف</button>`}</span>`
        : `<span class="${t.required ? 'err' : 'muted'}">${t.required ? '✗ لم يُرفع' : 'لم يُرفع'}</span>`}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function dl(pairs) {
  return `<dl class="dl">${pairs.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v) || '—'}</dd></div>`).join('')}</dl>`;
}
const fieldValue = (f, v) => f.kind === 'date' ? fmtDay(v) : f.kind === 'checkbox' ? (v === '1' ? 'نعم' : 'لا') : f.name === 'hours' && v ? v + ' ساعة أسبوعيًا' : f.name === 'days' && v ? v + ' يومًا' : v;
const teacherPairs = v => state.lk.teacher_fields.map(([n, l]) => [l, v[n]]);
const leavePairs = (fields, v) => fields.filter(f => visibleF(f, v) && f.kind !== 'checkbox').map(f => [f.label, fieldValue(f, v[f.name])]);

function reviewStep(W) {
  const { d, details: v, errors } = W;
  const stepOf = k => k.startsWith('t_') ? 1 : k.startsWith('doc:') ? 3 : k === 'declaration' ? 4 : 2;
  const errList = Object.entries(errors).filter(([k]) => k !== 'declaration');
  const byType = new Set(d.documents.map(x => x.doc_type_id));
  return `<h2>مراجعة الطلب قبل الإرسال</h2>
    ${errList.length ? `<div class="alert err" role="alert" tabindex="-1"><b>لا يمكن إرسال الطلب قبل استكمال ما يلي:</b><ul>${errList.map(([k, m]) => `<li>${esc(m)} — <button class="link" data-act="goto" data-step="${stepOf(k)}">انتقل للخطوة ${stepOf(k)}</button></li>`).join('')}</ul></div>` : ''}
    <section class="review"><header><h3>بيانات المعلم</h3><button class="link" data-act="goto" data-step="1">تعديل</button></header>${dl(teacherPairs(v))}</section>
    <section class="review"><header><h3>بيانات التفرغ</h3><button class="link" data-act="goto" data-step="2">تعديل</button></header>${dl(leavePairs(d.fields, v))}</section>
    <section class="review"><header><h3>المستندات</h3><button class="link" data-act="goto" data-step="3">تعديل</button></header>
      <ul class="doc-check">${d.doc_types.map(t => `<li class="${byType.has(t.id) ? 'ok-text' : t.required ? 'err' : 'muted'}">${byType.has(t.id) ? '✓' : '✗'} ${esc(t.name)}${t.required ? '' : ' (اختياري)'}</li>`).join('')}</ul></section>
    <label class="check declaration ${errors.declaration ? 'has-err' : ''}"><input type="checkbox" id="declaration"${errors.declaration ? ' aria-invalid="true" aria-describedby="declaration-err"' : ''}><span>أقر بأن جميع البيانات المدخلة صحيحة، وأتحمل كامل المسؤولية في حالة ثبوت خلاف ذلك.</span></label>
    ${errors.declaration ? `<small class="err" id="declaration-err">${esc(errors.declaration)}</small>` : ''}`;
}

// ───── عرض الطلب ومتابعته ومراجعته ─────
const STAGES = [
  ['تقديم الطلب', ['submit']],
  ['استلام الطلب', ['start_review']],
  ['مراجعة الموظف المختص', ['prelim_approve', 'request_completion']],
  ['استكمال البيانات – إذا لزم', ['request_completion', 'return_completion', 'resubmit'], true],
  ['المراجعة النهائية', ['refer']],
  ['الاعتماد', ['approve', 'reject']],
  ['إصدار القرار', ['issue_decision', 'reject']],
  ['إغلاق الطلب', ['close']],
];

function timeline(events, status) {
  const hits = STAGES.map(([, acts]) => events.filter(e => acts.includes(e.action)).pop());
  const lastDone = hits.reduce((m, h, i) => h ? i : m, -1);
  let current = status === 'needs_completion' || status === 'draft' && !hits[0];
  return `<ol class="timeline">${STAGES.map(([label, , optional], i) => {
    const e = hits[i];
    let cls = e ? 'done' : optional && i < lastDone ? 'skipped' : 'pending';
    if (cls === 'pending' && !current && !optional) { cls = 'current'; current = true; }
    if (optional && status === 'needs_completion') cls = 'current';
    if (e?.action === 'reject') cls = 'rejected';
    return `<li class="${cls}"><span class="dot" aria-hidden="true"></span><div>
      <b>${esc(label)}</b>
      ${e ? `<small>${fmtDate(e.created_at)} — ${fmtTime(e.created_at)}</small><small>${esc(e.label)} — ${esc(e.user_name || '')}${e.user_role ? ' (' + esc(state.lk.roles[e.user_role]) + ')' : ''}</small>${e.note ? `<p class="note">${esc(e.note)}</p>` : ''}`
        : `<small class="muted">${cls === 'skipped' ? 'لم يلزم' : cls === 'current' ? 'المرحلة الحالية' : 'لم تبدأ بعد'}</small>`}
    </div></li>`;
  }).join('')}</ol>`;
}

function eventsTable(events) {
  if (!events.length) return empty('لا توجد إجراءات بعد.');
  return `<div class="table-wrap"><table class="table compact"><thead><tr><th>التاريخ</th><th>المستخدم</th><th>الإجراء</th><th>الملاحظة</th></tr></thead><tbody>
    ${events.map(e => `<tr><td data-label="التاريخ">${fmtDT(e.created_at)}</td><td data-label="المستخدم">${esc(e.user_name || '—')}</td><td data-label="الإجراء">${esc(e.label)}</td><td data-label="الملاحظة">${esc(e.note || '')}</td></tr>`).join('')}
  </tbody></table></div>`;
}

const ACTION_CLS = { start_review: 'primary', prelim_approve: 'success', refer: 'primary', approve: 'success', reject: 'danger', request_completion: 'warn', return_completion: 'warn', close: 'ghost', add_note: 'ghost' };

async function viewRequest(params, id) {
  const d = await api(`/requests/${id}`), r = d.request, v = d.details, u = state.user, staff = u.role !== 'teacher';
  const checklist = r.checklist_json ? JSON.parse(r.checklist_json) : {};
  const lastRejection = d.comments.filter(c => c.kind === 'rejection').pop();
  const completion = r.status === 'needs_completion' ? d.comments.filter(c => c.kind === 'completion').pop() : null;
  const staffActions = staff ? d.actions : [];
  const reviewing = u.role === 'employee' && r.stage === 'employee' && r.status === 'under_review';
  const visibleComments = d.comments.filter(c => c.kind !== 'completion' || !completion || c.id !== completion.id);

  shell(`<div class="page-head"><div>
      <h1>${r.request_no ? 'الطلب ' + esc(r.request_no) : 'مسودة طلب'} ${badge(r.status, r.status_label)}</h1>
      <p class="muted">${esc(r.type_name)}${r.leave_type ? ' — ' + esc(r.leave_type) : ''} · ${staff ? esc(r.teacher_name) + ' · ' : ''}تاريخ التقديم: ${fmtDate(r.submitted_at)}${r.submitted_at ? ` · مدة الانتظار: ${r.wait_days} يوم` : ''}</p></div>
      <div class="row">${d.can_edit ? `<a class="btn ${r.status === 'needs_completion' ? 'warn' : 'primary'}" href="#/requests/${r.id}/edit">${r.status === 'draft' ? 'متابعة التعبئة' : 'استكمال الطلب'}</a>` : ''}
      ${r.decision_no ? `<a class="btn success" href="#/decision/${r.id}">عرض القرار وتحميله</a>` : ''}</div></div>
    ${completion ? completionAlert(completion) : ''}
    ${r.decision_no ? `<div class="alert ok"><b>صدر القرار رقم ${esc(r.decision_no)}</b> بالموافقة على الطلب بتاريخ ${fmtDate(r.decided_at)}.</div>` : ''}
    ${lastRejection && r.outcome === 'rejected' ? `<div class="alert err"><b>تم رفض الطلب.</b> السبب: ${esc(lastRejection.body)}</div>` : ''}
    ${r.stage === 'approver' && r.status === 'under_review' ? '<div class="alert info">الطلب محال إلى المسؤول المعتمد للمراجعة النهائية.</div>' : ''}
    <div class="split">
      <div class="col-main">
        ${staffActions.length ? `<section class="card actions-card"><h2>الإجراءات المتاحة</h2><div class="row wrap">${staffActions.map(a => `<button class="btn ${ACTION_CLS[a.action] || 'ghost'}" data-act="do" data-a="${a.action}">${esc(a.label)}</button>`).join('')}</div>
          ${r.status === 'submitted' || r.status === 'resubmitted' ? '<p class="muted">ابدأ باستلام الطلب لتتمكن من مراجعته واتخاذ الإجراء.</p>' : ''}</section>` : ''}
        ${reviewing ? `<section class="card"><h2>قائمة التحقق</h2><div class="checklist">${state.lk.checklist.map(([k, l]) => `<label class="check"><input type="checkbox" data-check="${k}" ${checklist[k] ? 'checked' : ''}><span>${esc(l)}</span></label>`).join('')}</div>
          ${r.prelim_approved ? '<p class="ok-text">✓ تم الاعتماد المبدئي، ويمكن الآن إحالة الطلب.</p>' : '<p class="muted">يجب تأشير جميع البنود قبل الاعتماد المبدئي.</p>'}</section>` : ''}
        ${staff && r.status !== 'draft' ? `<section class="card ai"><header class="card-head"><h2>✦ المساعد الذكي</h2><button class="btn sm ghost" data-act="assist">تحليل الطلب</button></header><div id="assist" aria-live="polite"><p class="muted">يلخّص الطلب ويكتشف البيانات والمستندات الناقصة ويقترح قائمة التحقق. لا يتخذ أي قرار.</p></div></section>` : ''}
        <section class="card"><h2>بيانات المعلم</h2>${dl(teacherPairs(v))}</section>
        <section class="card"><h2>بيانات طلب التفرغ</h2>${dl(leavePairs(d.fields, v))}</section>
        <section class="card"><h2>المستندات</h2>${docsTable(d, {}, true)}</section>
        ${visibleComments.length ? `<section class="card"><h2>الملاحظات</h2><ul class="comments">${visibleComments.map(c => `<li class="c-${c.kind}"><b>${esc(c.user_name)}</b> <small class="muted">${esc(state.lk.roles[c.user_role])} — ${fmtDT(c.created_at)}${c.internal ? ' — <span class="tag">داخلية</span>' : ''}</small>
          ${c.reasons_json ? `<div class="chips">${JSON.parse(c.reasons_json).map(x => `<span class="chip">${esc(x)}</span>`).join('')}</div>` : ''}<p>${esc(c.body)}</p></li>`).join('')}</ul></section>` : ''}
        <section class="card"><h2>سجل الإجراءات</h2>${eventsTable(d.events)}</section>
      </div>
      <aside class="col-side">
        <section class="card"><h2>مراحل الطلب</h2>${timeline(d.events, r.status)}</section>
      </aside>
    </div>`);

  // معاينة المستندات داخل نافذة للموظفين
  $$('.docs a[target=_blank]').forEach(a => a.setAttribute('data-act', 'preview'));
  H.preview = el => {
    const doc = d.documents.find(x => x.id === +el.dataset.id);
    const src = el.getAttribute('href');
    modal(doc.original_name, doc.mime === 'application/pdf' ? `<iframe class="preview" src="${src}" title="${esc(doc.original_name)}"></iframe>` : `<img class="preview" src="${src}" alt="${esc(doc.original_name)}">`,
      [...(DEMO ? [] : [{ label: 'تحميل', cls: 'primary', run: () => { location.href = src + '?download=1'; } }]), { label: 'إغلاق' }], { wide: true });
  };
  H.assist = async () => {
    const box = $('#assist');
    box.innerHTML = '<p class="muted">جارٍ التحليل…</p>';
    try {
      const a = await api(`/requests/${id}/assistant`);
      const list = (title, items) => items.length ? `<p><b>${title}:</b></p><ul>${items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
      box.innerHTML = `<p class="summary">${esc(a.summary)}</p>
        ${list('بيانات معلم ناقصة', a.missing_teacher)}${list('بيانات طلب ناقصة', a.missing_fields)}${list('مستندات إلزامية ناقصة', a.missing_docs)}
        <ul class="checks">${a.checks.map(c => `<li class="${c.level}">${c.level === 'ok' ? '✓' : '⚠'} ${esc(c.text)}</li>`).join('')}</ul>
        ${reviewing ? '<button class="btn sm ghost" data-act="applyChecklist">تطبيق قائمة التحقق المقترحة</button>' : ''}
        <p class="disclaimer">${esc(a.disclaimer)}</p>`;
      H.applyChecklist = () => { Object.entries(a.suggested_checklist).forEach(([k, val]) => { const c = $(`[data-check=${k}]`); if (c) c.checked = val; }); toast('طُبّقت الاقتراحات — راجعها قبل الاعتماد'); };
    } catch (e) { box.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  };
  H.do = el => runAction(r, el.dataset.a);
}

async function runAction(r, action) {
  const post = body => api(`/requests/${r.id}/actions/${action}`, { method: 'POST', body });
  const done = res => { toast(res?.status_label ? `تم: ${res.status_label}` : 'تم تنفيذ الإجراء'); render(); };
  const noteField = (label, ph, required) => `<label>${label}${required ? ' <i class="req">*</i>' : ''}<textarea name="note" rows="4" placeholder="${esc(ph)}"></textarea></label>`;
  try {
    if (action === 'request_completion' || action === 'return_completion') {
      const ok = await modal('طلب استكمال', `<fieldset><legend>سبب الاستكمال</legend><div class="checklist">${state.lk.completion_reasons.map(x => `<label class="check"><input type="checkbox" name="r_${esc(x)}" data-reason="${esc(x)}"><span>${esc(x)}</span></label>`).join('')}</div></fieldset>
        ${noteField('ملاحظة الموظف', 'مثال: يرجى إرفاق موافقة مدير المدرسة.', true)}`, [{
        label: 'إرسال طلب الاستكمال', cls: 'warn', run: async box => {
          const reasons = $$('[data-reason]', box).filter(x => x.checked).map(x => x.dataset.reason), note = $('[name=note]', box).value.trim();
          if (!reasons.length) throw new Error('حدد سببًا واحدًا على الأقل');
          if (!note) throw new Error('اكتب ملاحظة توضح المطلوب من المعلم');
          return post({ reasons, note });
        },
      }, { label: 'إلغاء' }]);
      if (ok) done(ok);
    } else if (action === 'reject') {
      const ok = await modal('رفض الطلب', noteField('سبب الرفض', 'اذكر سبب الرفض بوضوح؛ سيظهر للمعلم.', true), [{
        label: 'تأكيد الرفض', cls: 'danger', run: box => {
          const note = $('[name=note]', box).value.trim();
          if (!note) throw new Error('لا يمكن رفض الطلب بدون ذكر السبب');
          return post({ note });
        },
      }, { label: 'إلغاء' }]);
      if (ok) done(ok);
    } else if (action === 'approve') {
      const ok = await modal('اعتماد الطلب', `<p><b>هل أنت متأكد من اعتماد هذا الطلب؟</b></p><p class="muted">سيُسجَّل اسمك وتاريخ ووقت القرار، ويصدر رقم قرار يظهر للمعلم.</p>${noteField('ملاحظة (اختيارية)', '')}`,
        [{ label: 'نعم، اعتماد الطلب', cls: 'success', run: box => post({ note: $('[name=note]', box).value.trim() }) }, { label: 'إلغاء' }]);
      if (ok) done(ok);
    } else if (action === 'add_note') {
      const ok = await modal('إضافة ملاحظة داخلية', `<p class="muted">الملاحظة الداخلية تظهر للموظفين والمعتمدين فقط.</p>${noteField('الملاحظة', '', true)}`,
        [{ label: 'حفظ', cls: 'primary', run: box => post({ note: $('[name=note]', box).value.trim() }) }, { label: 'إلغاء' }]);
      if (ok) done(ok);
    } else if (action === 'prelim_approve') {
      const checklist = Object.fromEntries($$('[data-check]').map(c => [c.dataset.check, c.checked]));
      if (!Object.values(checklist).every(Boolean)) return toast('أكمل جميع بنود قائمة التحقق قبل الاعتماد المبدئي', 'err');
      if (await confirmBox('اعتماد الطلب مبدئيًا؟ يمكنك بعدها إحالته للمسؤول المعتمد.', 'اعتماد مبدئي', 'success')) done(await post({ checklist }));
    } else {
      const msg = { start_review: 'استلام الطلب وبدء مراجعته؟', refer: 'إحالة الطلب إلى المسؤول المعتمد للمراجعة النهائية؟', close: 'إغلاق الطلب نهائيًا؟' }[action] || 'تنفيذ الإجراء؟';
      if (await confirmBox(msg)) done(await post({}));
    }
  } catch (e) { toast(e.message, 'err'); }
}

// ───── القرار (قابل للطباعة) ─────
async function viewDecision(params, id) {
  const d = await api(`/requests/${id}`), r = d.request, v = d.details;
  if (!r.decision_no) throw new Error('لم يصدر قرار لهذا الطلب بعد');
  const ap = d.approvals.filter(a => a.level === 'final' && a.decision === 'approved').pop();
  shell(`<div class="page-head no-print"><a class="link" href="#/requests/${r.id}">→ العودة إلى الطلب</a><button class="btn primary" data-act="print">طباعة / حفظ PDF</button></div>
    <article class="card decision">
      <header><img src="/logo.svg" alt="" width="72" height="72"><div><b>${esc(state.cfg.org)}</b><span>${esc(r.directorate || '')}</span></div></header>
      <h1>قرار الموافقة على طلب تفرغ جزئي</h1>
      <div class="meta"><span>رقم القرار: <b>${esc(r.decision_no)}</b></span><span>التاريخ: <b>${fmtDate(r.decided_at)}</b></span><span>رقم الطلب: <b>${esc(r.request_no)}</b></span></div>
      <p>بناءً على الطلب المقدَّم من الفاضل/ة <b>${esc(v.t_name)}</b>، الرقم الوظيفي <b>${esc(v.t_employee_no)}</b>، ${esc(v.t_job_title)} بـ${esc(v.t_school)} – ولاية ${esc(v.t_wilayat)}،
      وبعد مراجعة الطلب والمستندات المؤيدة له واستيفائه للشروط، تقرر <b>الموافقة</b> على منحه/ها <b>${esc(v.leave_type)}</b>
      للفترة من <b>${fmtDay(v.start_date)}</b> إلى <b>${fmtDay(v.end_date)}</b> (${esc(v.days)} يومًا)، بواقع <b>${esc(v.hours)}</b> ساعة أسبوعيًا – ${esc(v.period)}،
      وذلك لـ${esc(v.entity)}.</p>
      ${ap?.reason ? `<p><b>ملاحظات:</b> ${esc(ap.reason)}</p>` : ''}
      <p>على المعني/ة الالتزام بالأنظمة واللوائح المعمول بها، ومباشرة العمل وفق ما يحدده القرار.</p>
      <footer><div><span>المعتمد</span><b>${esc(ap?.user_name || '')}</b><small>${fmtDT(ap?.created_at)}</small></div></footer>
      <p class="fine">صدر هذا القرار إلكترونيًا من نظام إدارة طلبات التفرغ الجزئي للمعلمين، ويمكن التحقق منه برقم القرار.</p>
    </article>`);
  H.print = () => window.print();
}

// ───── قائمة الطلبات والبحث والتصفية ─────
async function viewRequests(params) {
  const u = state.user;
  if (u.role === 'teacher') {
    const { requests } = await api('/requests');
    shell(`<div class="page-head"><h1>طلباتي</h1><button class="btn primary" data-act="new">+ تقديم طلب تفرغ جزئي</button></div><section class="card">${teacherTable(requests)}</section>`);
    H.new = newRequest;
    return;
  }
  const lk = state.lk, f = Object.fromEntries(params);
  const opt = (list, cur, all) => `<option value="">${all}</option>` + list.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(cur ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('');
  shell(`<div class="page-head"><h1>${f.stage === 'approver' ? 'الطلبات المحالة للاعتماد' : 'الطلبات'}</h1></div>
    <form class="card filters" id="filters">
      <label class="grow">بحث<input name="q" value="${esc(f.q)}" placeholder="رقم الطلب أو اسم المعلم أو الرقم الوظيفي أو المدرسة"></label>
      <label>الحالة<select name="status">${opt([['in_progress', 'قيد المعالجة (الكل)'], ...Object.entries(lk.statuses).filter(([s]) => s !== 'draft')], f.status, 'جميع الحالات')}</select></label>
      <label>الولاية<select name="wilayat">${opt(lk.wilayats.map(w => [w, w]), f.wilayat, 'جميع الولايات')}</select></label>
      <label>المدرسة<select name="school_id">${opt(lk.schools.map(s => [s.id, s.name]), f.school_id, 'جميع المدارس')}</select></label>
      <label>نوع التفرغ<select name="leave_type">${opt(lk.leave_types.map(x => [x, x]), f.leave_type, 'جميع الأنواع')}</select></label>
      <label>من تاريخ<input type="date" name="from" value="${esc(f.from)}"></label>
      <label>إلى تاريخ<input type="date" name="to" value="${esc(f.to)}"></label>
      ${f.stage ? `<input type="hidden" name="stage" value="${esc(f.stage)}">` : ''}
      <button type="button" class="btn ghost" data-act="reset">إعادة تعيين الفلاتر</button>
    </form>
    <section class="card"><div id="results"><p class="muted">جارٍ التحميل…</p></div></section>`);
  const load = async () => {
    const q = new URLSearchParams(Object.entries(formData($('#filters'))).filter(([, x]) => x));
    history.replaceState(null, '', '#/requests' + (q.toString() ? '?' + q : ''));
    const { requests } = await api('/requests?' + q);
    $('#results').innerHTML = `<p class="muted count-line">${requests.length} طلب</p>${staffTable(requests)}`;
  };
  let t;
  H.$input = e => { if (e.target.name === 'q') { clearTimeout(t); t = setTimeout(load, 300); } };
  H.$change = e => { if (e.target.name !== 'q') load(); };
  H.$submit = load;
  H.reset = () => { $$('#filters [name]').forEach(x => { if (x.type !== 'hidden') x.value = ''; }); load(); };
  await load();
}

// ───── الإشعارات ─────
async function viewNotifications() {
  const { notifications: list } = await api('/notifications');
  shell(`<div class="page-head"><h1>الإشعارات</h1>${list.some(n => !n.is_read) ? '<button class="btn ghost" data-act="readAll">تحديد الكل كمقروء</button>' : ''}</div>
    <section class="card">${list.length ? `<ul class="notes">${list.map(n => `<li class="${n.is_read ? '' : 'unread'}"><button data-act="open" data-id="${n.id}" data-r="${n.request_id || ''}">
      <b>${esc(n.title)}</b>${n.body ? `<span>${esc(n.body)}</span>` : ''}<small>${fmtDT(n.created_at)}</small></button></li>`).join('')}</ul>` : empty('لا توجد إشعارات.')}</section>`);
  H.readAll = async () => { await api('/notifications/read', { method: 'POST', body: {} }); state.unread = 0; render(); };
  H.open = async el => {
    await api('/notifications/read', { method: 'POST', body: { id: +el.dataset.id } });
    state.unread = Math.max(0, state.unread - (el.closest('li').classList.contains('unread') ? 1 : 0));
    if (el.dataset.r) location.hash = `#/requests/${el.dataset.r}`; else render();
  };
}

// ───── لوحة المؤشرات ─────
const STATUS_COLOR = { draft: '#a77f00', submitted: '#2458c6', under_review: '#6d3fc0', needs_completion: '#c25e00', resubmitted: '#0a7a94', approved: '#1f7a3f', rejected: '#c02626', closed: '#4b5563' };

function barChart(title, data, colorOf) {
  const max = Math.max(1, ...data.map(x => x[1]));
  return `<section class="card chart"><h3>${esc(title)}</h3>
    ${data.length ? `<div class="bars">${data.map(([label, value, key]) => `<div class="bar-row" title="${esc(label)}: ${value}">
      <span class="bar-label">${esc(label)}</span><span class="bar-track"><span class="bar" style="width:${Math.max(2, value / max * 100)}%${colorOf ? ';background:' + colorOf(key) : ''}"></span></span><b>${value}</b></div>`).join('')}</div>` : empty('لا توجد بيانات')}
    ${dataTable(data)}</section>`;
}

function columnChart(title, data) {
  const max = Math.max(1, ...data.map(x => x[1]));
  return `<section class="card chart"><h3>${esc(title)}</h3>
    ${data.length ? `<div class="cols">${data.map(([label, value]) => `<div class="col" title="${esc(label)}: ${value}"><b>${value}</b><span class="col-bar" style="height:${Math.max(2, value / max * 100)}%"></span><small>${esc(label).replace(' ', '<br>')}</small></div>`).join('')}</div>` : empty('لا توجد بيانات')}
    ${dataTable(data)}</section>`;
}
const dataTable = data => data.length ? `<details><summary>عرض البيانات كجدول</summary><table class="table compact"><thead><tr><th scope="col">البند</th><th scope="col">العدد</th></tr></thead><tbody>${data.map(([l, v]) => `<tr><th scope="row">${esc(l)}</th><td>${v}</td></tr>`).join('')}</tbody></table></details>` : '';

async function viewStats(params) {
  const f = Object.fromEntries(params), q = new URLSearchParams(f);
  const s = await api('/stats?' + q), k = s.kpis;
  shell(`<div class="page-head"><div><h1>لوحة المؤشرات</h1><p class="muted">نظرة شاملة على طلبات التفرغ الجزئي${state.user.governorate ? ' — محافظة ' + esc(state.user.governorate) : ''}</p></div></div>
    <form class="card filters" id="sfilters">
      <label>من تاريخ<input type="date" name="from" value="${esc(f.from)}"></label>
      <label>إلى تاريخ<input type="date" name="to" value="${esc(f.to)}"></label>
      <label>الولاية<select name="wilayat"><option value="">جميع الولايات</option>${state.lk.wilayats.map(w => `<option ${w === f.wilayat ? 'selected' : ''}>${esc(w)}</option>`).join('')}</select></label>
      <button type="button" class="btn ghost" data-act="reset">إعادة تعيين الفلاتر</button>
    </form>
    <div class="stats kpis">${stat('إجمالي الطلبات', k.total, 'total')}${stat('الطلبات الجديدة', k.new, 'submitted')}${stat('قيد المعالجة', k.under_review, 'under_review')}${stat('تحتاج استكمال', k.needs_completion, 'needs_completion')}${stat('المعتمدة', k.approved, 'approved')}${stat('المرفوضة', k.rejected, 'rejected')}${stat('متوسط زمن المعالجة', k.avg_days != null ? k.avg_days + ' يوم' : '—', 'avg')}</div>
    <div class="charts">
      ${columnChart('الطلبات حسب الشهر', s.by_month.map(([m, n]) => [fmtMonth(m), n]))}
      ${barChart('الطلبات حسب الحالة', s.by_status.map(([key, label, n]) => [label, n, key]), key => STATUS_COLOR[key])}
      ${barChart('الطلبات حسب الولاية', s.by_wilayat)}
      ${barChart('الطلبات حسب نوع التفرغ', s.by_leave_type)}
      ${barChart('الطلبات حسب المدرسة', s.by_school)}
    </div>`);
  const apply = () => { const p = new URLSearchParams(Object.entries(formData($('#sfilters'))).filter(([, x]) => x)); location.hash = '#/stats' + (p.toString() ? '?' + p : ''); };
  H.$change = apply;
  H.reset = () => { location.hash = '#/stats'; };
}

// ───── التقارير ─────
const REPORT_KINDS = [['all', 'تقرير الطلبات'], ['approved', 'المعتمدة'], ['rejected', 'المرفوضة'], ['in_progress', 'قيد المعالجة'], ['by_school', 'حسب المدرسة'], ['by_wilayat', 'حسب الولاية'], ['by_month', 'تقرير زمني']];

async function viewReports(params) {
  const f = Object.fromEntries(params);
  f.kind ||= 'all';
  const q = new URLSearchParams(f), rep = await api('/reports?' + q);
  shell(`<div class="page-head no-print"><h1>التقارير</h1><div class="row">
      ${DEMO ? '<span class="muted">التصدير والطباعة متاحان في النسخة المثبتة على الخادم</span>' : `<a class="btn success" href="/api/reports?${q}&format=csv" download>تصدير Excel</a>
      <button class="btn ghost" data-act="print" title="اختر «حفظ بصيغة PDF» من نافذة الطباعة">تصدير PDF</button>
      <button class="btn ghost" data-act="print">طباعة</button>`}</div></div>
    <nav class="tabs no-print">${REPORT_KINDS.map(([k, l]) => `<button class="${k === f.kind ? 'on' : ''}" data-act="kind" data-k="${k}">${l}</button>`).join('')}</nav>
    <form class="card filters no-print" id="rfilters">
      <label>من تاريخ<input type="date" name="from" value="${esc(f.from)}"></label>
      <label>إلى تاريخ<input type="date" name="to" value="${esc(f.to)}"></label>
      <label>الولاية<select name="wilayat"><option value="">جميع الولايات</option>${state.lk.wilayats.map(w => `<option ${w === f.wilayat ? 'selected' : ''}>${esc(w)}</option>`).join('')}</select></label>
      <label>نوع التفرغ<select name="leave_type"><option value="">جميع الأنواع</option>${state.lk.leave_types.map(w => `<option ${w === f.leave_type ? 'selected' : ''}>${esc(w)}</option>`).join('')}</select></label>
    </form>
    <section class="card report">
      <header class="print-head"><img src="/logo.svg" alt="" width="48" height="48"><div><b>${esc(state.cfg.org)}</b><h2>${esc(rep.title)}</h2>
        <small class="muted">تاريخ الإصدار: ${fmtDT(rep.generated_at)}${f.from || f.to ? ` — الفترة: ${fmtDay(f.from) || '…'} إلى ${fmtDay(f.to) || '…'}` : ''} — عدد السجلات: ${rep.rows.length}</small></div></header>
      ${rep.rows.length ? `<div class="table-wrap"><table class="table compact"><thead><tr>${rep.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${rep.rows.map(row => `<tr>${row.map((c, i) => `<td data-label="${esc(rep.columns[i])}">${esc(c ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : empty('لا توجد بيانات لهذا التقرير.')}
    </section>`);
  const go = extra => { const p = new URLSearchParams({ ...Object.fromEntries(Object.entries(formData($('#rfilters'))).filter(([, x]) => x)), kind: f.kind, ...extra }); location.hash = '#/reports?' + p; };
  H.kind = el => go({ kind: el.dataset.k });
  H.$change = () => go({});
  H.print = () => window.print();
}

// ───── الإدارة ─────
async function viewAdmin(params, section) {
  return ({ users: adminUsers, schools: adminSchools, types: adminTypes, workflow: adminWorkflow, audit: adminAudit })[section](params);
}

const input = (name, label, value = '', type = 'text', extra = '') => `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const select = (name, label, options, value) => `<label>${label}<select name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
const yesNo = v => v ? '<span class="tag ok">فعّال</span>' : '<span class="tag">معطّل</span>';

async function adminUsers() {
  const { users } = await api('/admin/users'), lk = state.lk;
  shell(`<div class="page-head"><h1>المستخدمون والصلاحيات</h1><button class="btn primary" data-act="add">+ إضافة مستخدم</button></div>
    <section class="card"><div class="table-wrap"><table class="table"><thead><tr><th>اسم المستخدم</th><th>الاسم</th><th>الدور</th><th>النطاق/المدرسة</th><th>الحالة</th><th></th></tr></thead><tbody>
    ${users.map(x => `<tr><td data-label="اسم المستخدم"><code>${esc(x.username)}</code></td><td data-label="الاسم">${esc(x.full_name)}</td><td data-label="الدور">${esc(lk.roles[x.role])}</td>
      <td data-label="النطاق/المدرسة">${esc(x.role === 'teacher' ? x.school_name : x.governorate || 'جميع المحافظات')}</td><td data-label="الحالة">${yesNo(x.active)}</td>
      <td><button class="btn sm ghost" data-act="edit" data-id="${x.id}">تعديل</button></td></tr>`).join('')}</tbody></table></div></section>
    <p class="muted">صلاحيات الأدوار: المعلم يرى طلباته فقط · الموظف المختص يراجع ويطلب الاستكمال ويحيل · المسؤول المعتمد يعتمد أو يرفض · مدير النظام يدير الإعدادات والتقارير. تحديد محافظة للموظف/المعتمد يقصر وصوله على طلبات مدارسها.</p>`);
  const form = (x = {}) => `<div class="grid">
    ${x.id ? '' : input('username', 'اسم المستخدم (إنجليزي)', '', 'text', 'autocomplete="off"')}
    ${input('full_name', 'الاسم', x.full_name)}
    ${select('role', 'الدور', Object.entries(lk.roles).filter(([r]) => !x.id || (x.role === 'teacher') === (r === 'teacher')), x.role || 'teacher')}
    ${input('password', x.id ? 'كلمة مرور جديدة (اتركها فارغة لعدم التغيير)' : 'كلمة المرور', '', 'password', 'autocomplete="new-password"')}
    ${input('email', 'البريد الإلكتروني', x.email, 'email')}${input('phone', 'الهاتف', x.phone, 'tel')}
    <div class="staff-only">${select('governorate', 'نطاق المحافظة', [['', 'جميع المحافظات'], ...lk.governorates.map(g => [g, g])], x.governorate)}</div>
    ${x.id ? `<label class="check"><input type="checkbox" name="active" ${x.active ? 'checked' : ''}><span>الحساب فعّال</span></label>` : ''}
    </div><fieldset class="teacher-only"><legend>السجل الوظيفي للمعلم</legend><div class="grid">
    ${input('employee_no', 'الرقم الوظيفي', x.employee_no)}${input('civil_id', 'الرقم المدني', x.civil_id)}
    ${select('school_id', 'المدرسة', [['', 'اختر…'], ...lk.schools.map(s => [s.id, `${s.name} — ${s.wilayat}`])], x.school_id)}
    ${input('job_title', 'المسمى الوظيفي', x.job_title)}${input('subject', 'المادة', x.subject)}${input('grade', 'الصف', x.grade)}
    ${input('appointment_date', 'تاريخ التعيين', x.appointment_date, 'date')}</div></fieldset>`;
  const toggle = box => { const t = $('[name=role]', box).value === 'teacher'; $('.teacher-only', box).hidden = !t; $('.staff-only', box).hidden = t; };
  const payload = box => {
    const f = formData(box);
    const teacher = { employee_no: f.employee_no, civil_id: f.civil_id, school_id: f.school_id, job_title: f.job_title, subject: f.subject, grade: f.grade, appointment_date: f.appointment_date };
    return { ...f, governorate: f.role === 'teacher' ? '' : f.governorate, teacher: f.role === 'teacher' ? teacher : undefined };
  };
  const open = (title, x, send) => modal(title, form(x), [{ label: 'حفظ', cls: 'primary', run: async box => { await send(payload(box)); toast('تم الحفظ'); render(); } }, { label: 'إلغاء' }],
    { wide: true, onOpen: box => { toggle(box); $('[name=role]', box).addEventListener('change', () => toggle(box)); } });
  H.add = () => open('إضافة مستخدم', {}, body => api('/admin/users', { method: 'POST', body }));
  H.edit = el => { const x = users.find(u => u.id === +el.dataset.id); open('تعديل مستخدم: ' + x.username, x, body => api(`/admin/users/${x.id}`, { method: 'PUT', body })); };
}

async function adminSchools() {
  const { schools } = await api('/admin/schools');
  shell(`<div class="page-head"><h1>المدارس</h1><button class="btn primary" data-act="add">+ إضافة مدرسة</button></div>
    <section class="card"><div class="table-wrap"><table class="table"><thead><tr><th>المدرسة</th><th>المحافظة</th><th>الولاية</th><th>المديرية</th><th>الحالة</th><th></th></tr></thead><tbody>
    ${schools.map(s => `<tr><td data-label="المدرسة">${esc(s.name)}</td><td data-label="المحافظة">${esc(s.governorate)}</td><td data-label="الولاية">${esc(s.wilayat)}</td><td data-label="المديرية">${esc(s.directorate)}</td><td data-label="الحالة">${yesNo(s.active)}</td>
    <td><button class="btn sm ghost" data-act="edit" data-id="${s.id}">تعديل</button></td></tr>`).join('')}</tbody></table></div></section>`);
  const form = (s = { active: 1 }) => `<div class="grid">${input('name', 'اسم المدرسة', s.name)}${input('governorate', 'المحافظة', s.governorate)}${input('wilayat', 'الولاية', s.wilayat)}${input('directorate', 'المديرية التعليمية', s.directorate)}
    <label class="check"><input type="checkbox" name="active" ${s.active ? 'checked' : ''}><span>فعّالة</span></label></div>`;
  const open = (title, s, send) => modal(title, form(s), [{ label: 'حفظ', cls: 'primary', run: async box => { await send(formData(box)); state.lk = null; toast('تم الحفظ'); render(); } }, { label: 'إلغاء' }]);
  H.add = () => open('إضافة مدرسة', undefined, body => api('/admin/schools', { method: 'POST', body }));
  H.edit = el => { const s = schools.find(x => x.id === +el.dataset.id); open('تعديل مدرسة', s, body => api(`/admin/schools/${s.id}`, { method: 'PUT', body })); };
}

async function adminTypes() {
  const { types } = await api('/admin/types');
  shell(`<div class="page-head"><div><h1>أنواع الطلبات والمستندات المطلوبة</h1><p class="muted">يمكن إضافة خدمات جديدة للمعلمين (النقل، الندب، التكليف، التدريب، الإجازات…) كنوع طلب جديد يستخدم نفس سير العمل.</p></div>
    <button class="btn primary" data-act="addType">+ إضافة نوع طلب</button></div>
    ${types.map(t => `<section class="card"><header class="card-head"><h2>${esc(t.name)} <code>${esc(t.code)}</code> ${yesNo(t.active)}</h2>
      <div class="row"><button class="btn sm ghost" data-act="editType" data-id="${t.id}">تعديل النوع والحقول</button><button class="btn sm primary" data-act="addDoc" data-id="${t.id}">+ مستند مطلوب</button></div></header>
      <div class="table-wrap"><table class="table compact"><thead><tr><th>المستند</th><th>إلزامي</th><th>الحالة</th><th>الترتيب</th><th></th></tr></thead><tbody>
      ${t.documents.map(x => `<tr><td data-label="المستند">${esc(x.name)}${x.hint ? `<small class="muted d-block">${esc(x.hint)}</small>` : ''}</td><td data-label="إلزامي">${x.required ? 'إلزامي' : 'اختياري'}</td><td data-label="الحالة">${yesNo(x.active)}</td><td data-label="الترتيب">${x.sort}</td>
        <td><button class="btn sm ghost" data-act="editDoc" data-t="${t.id}" data-id="${x.id}">تعديل</button></td></tr>`).join('')}</tbody></table></div></section>`).join('')}`);
  const docForm = (x = { required: 1, active: 1, sort: 99 }) => `<div class="grid">${input('name', 'اسم المستند', x.name)}${input('hint', 'توضيح', x.hint)}${input('sort', 'الترتيب', x.sort, 'number')}
    <label class="check"><input type="checkbox" name="required" ${x.required ? 'checked' : ''}><span>إلزامي</span></label>
    <label class="check"><input type="checkbox" name="active" ${x.active ? 'checked' : ''}><span>فعّال</span></label></div>`;
  const reload = () => { state.lk = null; toast('تم الحفظ'); render(); };
  H.addDoc = el => modal('إضافة مستند مطلوب', docForm(), [{ label: 'حفظ', cls: 'primary', run: async box => { await api('/admin/document-types', { method: 'POST', body: { ...formData(box), request_type_id: +el.dataset.id } }); reload(); } }, { label: 'إلغاء' }]);
  H.editDoc = el => {
    const x = types.find(t => t.id === +el.dataset.t).documents.find(d => d.id === +el.dataset.id);
    modal('تعديل مستند', docForm(x), [{ label: 'حفظ', cls: 'primary', run: async box => { await api(`/admin/document-types/${x.id}`, { method: 'PUT', body: formData(box) }); reload(); } }, { label: 'إلغاء' }]);
  };
  H.editType = el => {
    const t = types.find(x => x.id === +el.dataset.id);
    modal('تعديل نوع الطلب', `<div class="grid">${input('name', 'اسم نوع الطلب', t.name)}<label class="check"><input type="checkbox" name="active" ${t.active ? 'checked' : ''}><span>فعّال</span></label></div>
      <label>تعريف حقول "بيانات الطلب" (JSON — للمختصين)<textarea name="fields_json" rows="12" dir="ltr" class="mono">${esc(JSON.stringify(JSON.parse(t.fields_json), null, 2))}</textarea></label>
      <p class="muted">كل حقل: name وlabel وkind (text, textarea, select, date, number, checkbox, computed) واختياريًا required وoptions وshow_if وmin وmax.</p>`,
    [{ label: 'حفظ', cls: 'primary', run: async box => { await api(`/admin/types/${t.id}`, { method: 'PUT', body: formData(box) }); reload(); } }, { label: 'إلغاء' }], { wide: true });
  };
  H.addType = () => modal('إضافة نوع طلب جديد', `<div class="grid">${input('code', 'الرمز (بادئة رقم الطلب، مثل TR)', '', 'text', 'dir="ltr" maxlength="6"')}${input('name', 'اسم نوع الطلب (مثل: طلب نقل)')}</div>
    <p class="muted">تُنسخ حقول طلب التفرغ الجزئي كبداية، ويمكنك تعديلها بعد الإنشاء، ثم إضافة المستندات المطلوبة.</p>`,
  [{ label: 'إنشاء', cls: 'primary', run: async box => { await api('/admin/types', { method: 'POST', body: formData(box) }); reload(); } }, { label: 'إلغاء' }]);
}

async function adminWorkflow() {
  const { workflow, statuses, roles } = await api('/admin/workflow');
  shell(`<div class="page-head"><div><h1>مراحل سير العمل (Workflow)</h1><p class="muted">كل صف انتقال مسموح بين حالتين. تعطيل الانتقال يمنعه فورًا في النظام.</p></div></div>
    <section class="card flow">${['مسودة', 'تم الإرسال', 'قيد المراجعة (الموظف)', 'مطلوب استكمال ↺', 'إحالة (المعتمد)', 'تمت الموافقة / مرفوض', 'مغلق'].map(s => `<span>${s}</span>`).join('<i>←</i>')}</section>
    <section class="card"><div class="table-wrap"><table class="table compact"><thead><tr><th>من الحالة</th><th>لدى</th><th>الإجراء</th><th>يُنفّذه</th><th>إلى الحالة</th><th>ينتقل إلى</th><th>الحالة</th><th></th></tr></thead><tbody>
    ${workflow.map(w => `<tr><td data-label="من الحالة">${badge(w.from_status, statuses[w.from_status])}</td><td data-label="لدى">${esc(roles[w.from_stage] || '—')}</td><td data-label="الإجراء"><b>${esc(w.label)}</b></td>
      <td data-label="يُنفّذه">${esc(roles[w.role])}</td><td data-label="إلى الحالة">${badge(w.to_status, statuses[w.to_status])}</td><td data-label="ينتقل إلى">${esc(roles[w.to_stage] || '—')}</td><td data-label="الحالة">${yesNo(w.active)}</td>
      <td><button class="btn sm ghost" data-act="edit" data-id="${w.id}">تعديل</button></td></tr>`).join('')}</tbody></table></div></section>`);
  H.edit = el => {
    const w = workflow.find(x => x.id === +el.dataset.id);
    modal('تعديل مرحلة', `${input('label', 'اسم الإجراء كما يظهر للمستخدمين', w.label)}<label class="check"><input type="checkbox" name="active" ${w.active ? 'checked' : ''}><span>فعّال</span></label>`,
      [{ label: 'حفظ', cls: 'primary', run: async box => { await api(`/admin/workflow/${w.id}`, { method: 'PUT', body: formData(box) }); toast('تم الحفظ'); render(); } }, { label: 'إلغاء' }]);
  };
}

async function adminAudit(params) {
  const f = Object.fromEntries(params), { logs } = await api('/admin/audit?' + new URLSearchParams(f));
  shell(`<div class="page-head"><div><h1>سجل العمليات (Audit Log)</h1><p class="muted">سجل غير قابل للتعديل أو الحذف لكل إجراء في النظام.</p></div></div>
    <form class="card filters" id="afilters">${input('request_no', 'رقم الطلب', f.request_no)}${input('username', 'اسم المستخدم', f.username)}${input('action', 'رمز الإجراء', f.action)}
      <button class="btn primary">بحث</button></form>
    <section class="card"><div class="table-wrap"><table class="table compact"><thead><tr><th>التاريخ</th><th>المستخدم</th><th>رقم الطلب</th><th>الإجراء</th><th>الملاحظة</th><th>IP</th></tr></thead><tbody>
    ${logs.map(l => `<tr><td data-label="التاريخ">${fmtDT(l.created_at)}</td><td data-label="المستخدم">${esc(l.user_name || '—')}</td><td data-label="رقم الطلب">${esc(l.request_no || '')}</td>
      <td data-label="الإجراء">${esc(l.label)}</td><td data-label="الملاحظة">${esc(l.note || '')}</td><td data-label="IP"><code>${esc(l.ip || '')}</code></td></tr>`).join('')}</tbody></table></div></section>`);
  H.$submit = e => { location.hash = '#/admin/audit?' + new URLSearchParams(Object.entries(formData(e.target)).filter(([, x]) => x)); };
}

// ───── الموجّه ─────
const ROUTES = [
  [/^#\/dashboard$/, viewDashboard],
  [/^#\/requests\/new$/, newRequest],
  [/^#\/requests\/(\d+)\/edit(?:\/(\d))?$/, viewWizard],
  [/^#\/requests\/(\d+)$/, viewRequest],
  [/^#\/requests$/, viewRequests],
  [/^#\/decision\/(\d+)$/, viewDecision],
  [/^#\/notifications$/, viewNotifications],
  [/^#\/stats$/, viewStats, ['employee', 'approver', 'admin']],
  [/^#\/reports$/, viewReports, ['employee', 'approver', 'admin']],
  [/^#\/admin\/(users|schools|types|workflow|audit)$/, viewAdmin, ['admin']],
];

async function render() {
  H = {};
  const [path, qs] = (location.hash || home()).split('?');
  try {
    state.cfg ||= await api('/config');
    if (path === '#/login') return viewLogin();
    if (!state.user) {
      try { const me = await api('/me'); state.user = me.user; state.unread = me.unread; }
      catch { location.hash = '#/login'; return; }
    }
    state.lk ||= await api('/lookups');
    const view = $('#view');
    if (view) view.innerHTML = '<div class="loading">جارٍ التحميل…</div>';
    for (const [rx, fn, roles] of ROUTES) {
      const m = path.match(rx);
      if (!m) continue;
      if (roles && !roles.includes(state.user.role)) break;
      await fn(new URLSearchParams(qs || ''), ...m.slice(1).filter(x => x !== undefined));
      $('#view')?.focus({ preventScroll: true });
      document.title = `${$('#view h1')?.textContent.trim() || 'الرئيسية'} — نظام التفرغ الجزئي`;
      return;
    }
    location.hash = home();
  } catch (e) {
    if (state.user) shell(`<div class="card empty"><p>${esc(e.message)}</p><a class="btn ghost" href="${home()}">العودة للرئيسية</a></div>`);
    else $('#app').innerHTML = `<div class="card empty">${esc(e.message)}</div>`;
  }
}

const G = {
  logout: async () => { try { await api('/logout', { method: 'POST', body: {} }); } catch { /* الجلسة منتهية أصلًا */ } state.user = state.lk = null; location.hash = '#/login'; },
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  const fn = el && (H[el.dataset.act] || G[el.dataset.act]);
  if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener('change', e => H.$change?.(e));
document.addEventListener('input', e => H.$input?.(e));
document.addEventListener('submit', e => { e.preventDefault(); H.$submit?.(e); });
window.addEventListener('hashchange', render);
setInterval(async () => {
  if (!state.user) return;
  try {
    const { unread } = await api('/me');
    state.unread = unread;
    const c = $('.bell .count');
    $('.bell')?.setAttribute('aria-label', unread ? `الإشعارات (${unread} غير مقروءة)` : 'الإشعارات');
    if (c) { c.textContent = unread; c.hidden = !unread; }
  } catch { /* تجاهل أخطاء الشبكة المؤقتة */ }
}, 60000);
render();
