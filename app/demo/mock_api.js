'use strict';
// نسخة العرض التجريبية: محاكٍ لواجهة /api داخل المتصفح، منقول من server.py.
// البيانات وهمية وتُحفظ في متصفح الزائر فقط. الثوابت والبيانات الأولية يحقنها build_demo.py من الخادم نفسه.
(() => {
  const C = window.PTMS_CONST, KEY = 'ptms-demo-v1', PASSWORD = 'Demo@1234';
  const TABLES = ['schools', 'users', 'teachers', 'request_types', 'document_types', 'requests', 'request_details',
    'documents', 'comments', 'workflow', 'approvals', 'notifications', 'audit_logs'];
  const files = new Map();   // الملفات المرفوعة في الذاكرة فقط (id → blob URL)
  let db, session = null;

  const fresh = () => JSON.parse(JSON.stringify(window.PTMS_SEED));
  const load = () => { try { const s = JSON.parse(localStorage.getItem(KEY)); if (s?.users) return s; } catch { /* تخزين غير متاح */ } return fresh(); };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* تخزين غير متاح */ } };
  // الجلسة لكل تبويب (sessionStorage) حتى يعمل كل تبويب كمستخدم مختلف، والبيانات مشتركة بين التبويبات
  const getSession = () => { try { return +sessionStorage.getItem(KEY) || null; } catch { return session; } };
  const setSession = id => { session = id; try { id ? sessionStorage.setItem(KEY, id) : sessionStorage.removeItem(KEY); } catch { /* غير متاح */ } };
  db = load();
  session = getSession();
  const nextId = t => Math.max(0, ...db[t].map(r => r.id || 0)) + 1;
  const insert = (t, row) => { row = { id: nextId(t), ...row }; db[t].push(row); return row; };

  const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
  const days = (a, b) => (new Date((b || now()).replace(' ', 'T') + 'Z') - new Date(a.replace(' ', 'T') + 'Z')) / 864e5;
  const clean = (v, n = 2000) => String(v ?? '').trim().slice(0, n);
  const fail = (status, msg, fields) => { throw { status, msg, fields }; };
  const byId = (t, id) => db[t].find(r => r.id === +id);

  // ───── أدوات المجال ─────
  const school = id => byId('schools', id) || {};
  const teacherRow = uid => db.teachers.find(t => t.user_id === uid);
  const details = rid => Object.fromEntries(db.request_details.filter(d => d.request_id === rid).map(d => [d.field, d.value]));
  const saveDetails = (rid, d) => {
    db.request_details = db.request_details.filter(x => !(x.request_id === rid && x.field in d));
    Object.entries(d).forEach(([field, value]) => db.request_details.push({ request_id: rid, field, value }));
  };
  const typeOf = r => byId('request_types', r.request_type_id);
  const fieldsOf = r => JSON.parse(typeOf(r).fields_json);
  const docTypes = tid => db.document_types.filter(d => d.request_type_id === tid && d.active).sort((a, b) => a.sort - b.sort || a.id - b.id);
  const visible = (f, d) => Object.entries(f.show_if || {}).every(([k, v]) => d[k] === v);
  const parseDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !isNaN(new Date(v)) ? new Date(v + 'T00:00:00Z') : null;

  function profile(uid) {
    const u = byId('users', uid), t = teacherRow(uid);
    if (!t) fail(400, 'لا يوجد سجل وظيفي لهذا المستخدم. تواصل مع مدير النظام.');
    const s = school(t.school_id);
    return { t_name: u.full_name, t_employee_no: t.employee_no, t_civil_id: t.civil_id, t_school: s.name || '', t_wilayat: s.wilayat || '',
      t_directorate: s.directorate || '', t_job_title: t.job_title || '', t_subject: t.subject || '', t_grade: t.grade || '',
      t_phone: u.phone || '', t_email: u.email || '' };
  }

  function validate(fields, d, strict) {
    const errs = {};
    for (const f of fields) {
      if (f.kind === 'computed' || !visible(f, d)) continue;
      const v = (d[f.name] || '').trim();
      if (!v) { if (strict && f.required) errs[f.name] = `${f.label}: حقل مطلوب`; continue; }
      if (f.kind === 'date' && !parseDate(v)) errs[f.name] = `${f.label}: تاريخ غير صالح`;
      else if (f.kind === 'number' && (!/^\d+$/.test(v) || +v < (f.min ?? 0) || +v > (f.max ?? 1e9))) errs[f.name] = `${f.label}: رقم بين ${f.min ?? 0} و${f.max ?? ''}`;
      else if (f.kind === 'select' && !f.options.includes(v)) errs[f.name] = `${f.label}: قيمة غير مسموحة`;
      else if (f.kind === 'checkbox' && v !== '1') errs[f.name] = `${f.label}: قيمة غير صالحة`;
    }
    const s = parseDate(d.start_date), e = parseDate(d.end_date);
    if (s && e && e < s) errs.end_date = 'تاريخ نهاية التفرغ يجب أن يكون بعد تاريخ البداية';
    if (d.t_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.t_email)) errs.t_email = 'البريد الإلكتروني غير صالح';
    if (d.t_phone && !/^\+?\d{8,15}$/.test(d.t_phone)) errs.t_phone = 'رقم الهاتف غير صالح (8–15 رقمًا)';
    if (strict) C.TEACHER_FIELDS.forEach(([n, l]) => { if (!(d[n] || '').trim()) errs[n] = `${l}: حقل مطلوب`; });
    return errs;
  }
  const computeDays = d => { const s = parseDate(d.start_date), e = parseDate(d.end_date); d.days = s && e && e >= s ? String(Math.round((e - s) / 864e5) + 1) : ''; };
  const missingDocs = r => { const have = new Set(db.documents.filter(x => x.request_id === r.id).map(x => x.doc_type_id)); return docTypes(r.request_type_id).filter(t => t.required && !have.has(t.id)).map(t => t.name); };
  const nextNo = (prefix, col) => {
    const head = `${prefix}-${new Date().getUTCFullYear()}-`;
    const last = Math.max(0, ...db.requests.filter(r => (r[col] || '').startsWith(head)).map(r => +r[col].slice(head.length)));
    return head + String(last + 1).padStart(6, '0');
  };
  const audit = (rid, action, label, note, vis = true, uid) => insert('audit_logs', { request_id: rid, user_id: uid ?? session, action, label, note: note || null, visible_to_teacher: vis ? 1 : 0, ip: 'متصفح العرض', created_at: now() });
  const notify = (uids, rid, title, body) => uids.forEach(u => insert('notifications', { user_id: u, request_id: rid, title, body: body || null, is_read: 0, created_at: now() }));
  const staffIds = (role, gov) => db.users.filter(u => u.role === role && u.active && (!u.governorate || u.governorate === gov)).map(u => u.id);
  const publicUser = u => ({ id: u.id, username: u.username, full_name: u.full_name, role: u.role, role_label: C.ROLE_AR[u.role], governorate: u.governorate });

  function reqRow(r) {
    const u = byId('users', r.teacher_id), t = teacherRow(r.teacher_id) || {}, s = school(r.school_id), rt = typeOf(r);
    return { ...r, teacher_name: u.full_name, employee_no: t.employee_no, school_name: s.name, governorate: s.governorate, wilayat: s.wilayat,
      directorate: s.directorate, type_name: rt.name, type_code: rt.code, leave_type: details(r.id).leave_type ?? null,
      wait_days: r.submitted_at ? Math.floor(days(r.submitted_at, r.decided_at)) : null,
      process_days: r.decided_at && r.submitted_at ? Math.round(days(r.submitted_at, r.decided_at) * 10) / 10 : null,
      status_label: C.STATUS_AR[r.status] };
  }
  const canSee = (u, r) => u.role === 'teacher' ? r.teacher_id === u.id : u.role === 'admin' || (r.status !== 'draft' && (!u.governorate || u.governorate === r.governorate));
  const loadReq = (ctx, id) => { const r = byId('requests', id); const row = r && reqRow(r); if (!row || !canSee(ctx.user, row)) fail(404, 'الطلب غير موجود'); return row; };

  function listRows(ctx) {
    const u = ctx.user, g = k => clean(ctx.q[k], 100);
    let rows = db.requests.map(reqRow).filter(r => u.role === 'teacher' ? r.teacher_id === u.id
      : r.status !== 'draft' && (u.role === 'admin' || !u.governorate || r.governorate === u.governorate));
    const q = g('q');
    if (q) rows = rows.filter(r => [r.request_no, r.teacher_name, r.employee_no, r.school_name].some(x => (x || '').includes(q)));
    if (g('status') === 'in_progress') rows = rows.filter(r => C.IN_PROGRESS.includes(r.status));
    else if (g('status')) rows = rows.filter(r => r.status === g('status'));
    if (g('stage')) rows = rows.filter(r => r.stage === g('stage'));
    if (g('wilayat')) rows = rows.filter(r => r.wilayat === g('wilayat'));
    if (g('school_id')) rows = rows.filter(r => String(r.school_id) === g('school_id'));
    if (g('leave_type')) rows = rows.filter(r => r.leave_type === g('leave_type'));
    if (g('from')) rows = rows.filter(r => (r.submitted_at || '').slice(0, 10) >= g('from'));
    if (g('to')) rows = rows.filter(r => r.submitted_at && r.submitted_at.slice(0, 10) <= g('to'));
    return rows.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id);
  }
  function counts(rows) {
    const st = s => rows.filter(r => r.status === s).length;
    return { total: rows.length, new: st('submitted') + st('resubmitted'), under_review: st('under_review'),
      in_review: st('submitted') + st('under_review') + st('resubmitted'), needs_completion: st('needs_completion'), drafts: st('draft'),
      approved: rows.filter(r => r.outcome === 'approved').length, rejected: rows.filter(r => r.outcome === 'rejected').length };
  }
  const countBy = (rows, f) => Object.entries(rows.reduce((m, r) => { const k = f(r) || 'غير محدد'; m[k] = (m[k] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);

  // ───── المسارات ─────
  const ANY = [], STAFF = ['employee', 'approver', 'admin'], ADMIN = ['admin'];
  const routes = [];
  const route = (method, pattern, roles, fn) => routes.push([method, new RegExp('^' + pattern + '$'), roles, fn]);

  route('GET', '/api/config', null, () => ({ org: C.ORG, demo: true }));
  route('POST', '/api/login', null, ctx => {
    const u = db.users.find(x => x.username === clean(ctx.body.username, 64).toLowerCase() && x.active);
    if (!u || (u.password || PASSWORD) !== String(ctx.body.password || '')) fail(401, 'اسم المستخدم أو كلمة المرور غير صحيحة');
    setSession(u.id);
    audit(null, 'login', 'تسجيل الدخول', null, false, u.id);
    return { user: publicUser(u) };
  });
  route('POST', '/api/logout', null, () => { setSession(null); return { ok: true }; });
  route('POST', '/api/forgot', null, ctx => {
    const name = clean(ctx.body.username, 64).toLowerCase(), u = db.users.find(x => x.username === name && x.active);
    if (u) notify(db.users.filter(x => x.role === 'admin' && x.active).map(x => x.id), null, 'طلب إعادة تعيين كلمة مرور', `اسم المستخدم: ${name}`);
    return { message: 'إذا كان اسم المستخدم صحيحًا فقد أُبلغ مدير النظام، وسيتواصل معك لإعادة تعيين كلمة المرور.' };
  });
  route('GET', '/api/me', ANY, ctx => ({ user: publicUser(ctx.user), unread: db.notifications.filter(n => n.user_id === ctx.user.id && !n.is_read).length }));
  route('GET', '/api/lookups', ANY, () => {
    const types = db.request_types.filter(t => t.active).map(t => ({ ...t, fields: JSON.parse(t.fields_json), documents: docTypes(t.id) }));
    const schools = db.schools.filter(s => s.active).sort((a, b) => a.governorate.localeCompare(b.governorate) || a.name.localeCompare(b.name));
    return { schools, types, statuses: C.STATUS_AR, roles: C.ROLE_AR, teacher_fields: C.TEACHER_FIELDS, completion_reasons: C.COMPLETION_REASONS,
      checklist: C.CHECKLIST, wilayats: [...new Set(db.schools.map(s => s.wilayat))].sort(), governorates: [...new Set(db.schools.map(s => s.governorate))].sort(),
      leave_types: types.flatMap(t => t.fields).find(f => f.name === 'leave_type')?.options || [] };
  });
  route('GET', '/api/dashboard', ANY, ctx => {
    const rows = listRows(ctx), role = ctx.user.role;
    const inbox = role === 'teacher' ? rows.slice(0, 8) : role === 'employee' ? rows.filter(r => r.stage === 'employee' || ['approved', 'rejected'].includes(r.status)).slice(0, 15)
      : role === 'approver' ? rows.filter(r => r.stage === 'approver').slice(0, 15) : rows.slice(0, 15);
    return { counts: counts(rows), requests: inbox };
  });
  route('GET', '/api/stats', STAFF, ctx => {
    const rows = listRows(ctx), k = counts(rows), done = rows.map(r => r.process_days).filter(x => x != null);
    k.avg_days = done.length ? Math.round(done.reduce((a, b) => a + b, 0) / done.length * 10) / 10 : null;
    return { kpis: k, by_month: countBy(rows.filter(r => r.submitted_at), r => r.submitted_at.slice(0, 7)).sort((a, b) => a[0].localeCompare(b[0])),
      by_wilayat: countBy(rows, r => r.wilayat), by_school: countBy(rows, r => r.school_name), by_leave_type: countBy(rows, r => r.leave_type),
      by_status: countBy(rows, r => r.status).map(([s, n]) => [s, C.STATUS_AR[s], n]) };
  });
  route('GET', '/api/requests', ANY, ctx => ({ requests: listRows(ctx).slice(0, 500) }));
  route('POST', '/api/requests', ['teacher'], ctx => {
    const t = db.request_types.find(x => x.id === +(ctx.body.request_type_id || 1) && x.active);
    if (!t) fail(400, 'نوع الطلب غير متاح');
    const snap = profile(ctx.user.id);
    const r = insert('requests', { request_no: null, request_type_id: t.id, teacher_id: ctx.user.id, school_id: teacherRow(ctx.user.id).school_id, status: 'draft',
      stage: 'teacher', prelim_approved: 0, outcome: null, checklist_json: null, decision_no: null, created_at: now(), submitted_at: null, decided_at: null, closed_at: null, updated_at: now() });
    saveDetails(r.id, snap);
    audit(r.id, 'create', 'إنشاء الطلب (مسودة)');
    notify([ctx.user.id], r.id, `تم إنشاء مسودة ${t.name}`, 'يمكنك استكمالها وإرسالها في أي وقت.');
    return { id: r.id };
  });
  route('GET', '/api/requests/(\\d+)', ANY, (ctx, id) => {
    const r = loadReq(ctx, id), u = ctx.user, teacher = u.role === 'teacher';
    const withUser = x => { const us = byId('users', x.user_id) || {}; return { ...x, user_name: us.full_name, user_role: us.role }; };
    const actions = db.workflow.filter(w => w.active && w.from_status === r.status && w.from_stage === r.stage && w.role === u.role).map(w => ({ action: w.action, label: w.label }));
    if (['employee', 'approver'].includes(u.role) && r.status !== 'draft') actions.push({ action: 'add_note', label: 'إضافة ملاحظة' });
    return { request: r, details: details(r.id), fields: fieldsOf(r), doc_types: docTypes(r.request_type_id),
      documents: db.documents.filter(x => x.request_id === r.id),
      comments: db.comments.filter(x => x.request_id === r.id && (!teacher || !x.internal)).map(withUser),
      events: db.audit_logs.filter(x => x.request_id === r.id && (!teacher || x.visible_to_teacher)).map(withUser),
      approvals: db.approvals.filter(x => x.request_id === r.id).map(withUser),
      actions, can_edit: teacher && ['draft', 'needs_completion'].includes(r.status) };
  });
  const editable = (ctx, id) => { const r = loadReq(ctx, id); if (ctx.user.role !== 'teacher' || !['draft', 'needs_completion'].includes(r.status)) fail(409, 'لا يمكن تعديل الطلب في حالته الحالية'); return r; };
  const touch = id => { byId('requests', id).updated_at = now(); };
  route('PUT', '/api/requests/(\\d+)', ['teacher'], (ctx, id) => {
    const r = editable(ctx, id), fields = fieldsOf(r);
    const allowed = new Set([...fields.filter(f => f.kind !== 'computed').map(f => f.name), ...C.TEACHER_FIELDS.filter(t => t[2]).map(t => t[0])]);
    const d = details(r.id);
    Object.entries(ctx.body.details || {}).forEach(([k, v]) => { if (allowed.has(k)) d[k] = clean(v); });
    computeDays(d);
    const errs = validate(fields, d, false);
    if (Object.keys(errs).length) fail(400, 'تحقق من الحقول المظللة', errs);
    saveDetails(r.id, d);
    touch(r.id);
    return { ok: true, details: d };
  });
  route('POST', '/api/requests/(\\d+)/documents', ['teacher'], (ctx, id) => {
    const r = editable(ctx, id), dt = db.document_types.find(x => x.id === +ctx.body.doc_type_id && x.request_type_id === r.request_type_id && x.active);
    if (!dt) fail(400, 'نوع المستند غير صحيح');
    const name = clean(ctx.body.filename, 120).replace(/[\x00-\x1f/\\]/g, '') || 'file';
    let bytes;
    try { bytes = Uint8Array.from(atob(ctx.body.data || ''), ch => ch.charCodeAt(0)); } catch { fail(400, 'تعذر قراءة الملف'); }
    if (!bytes.length || bytes.length > 5 * 1024 * 1024) fail(400, 'حجم الملف يجب ألا يتجاوز 5 ميغابايت');
    const head = [...bytes.slice(0, 8)], starts = sig => sig.every((b, i) => head[i] === b);
    const [mime, exts] = starts([0x25, 0x50, 0x44, 0x46, 0x2d]) ? ['application/pdf', ['pdf']] : starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ? ['image/png', ['png']]
      : starts([0xff, 0xd8, 0xff]) ? ['image/jpeg', ['jpg', 'jpeg']] : [null, []];
    if (!mime || !exts.includes(name.split('.').pop().toLowerCase())) fail(400, 'نوع الملف غير مسموح. المسموح: PDF أو JPG أو PNG');
    const old = db.documents.filter(x => x.request_id === r.id && x.doc_type_id === dt.id);
    db.documents = db.documents.filter(x => !old.includes(x));
    const doc = insert('documents', { request_id: r.id, doc_type_id: dt.id, original_name: name, mime, size: bytes.length, uploaded_at: now() });
    files.set(doc.id, URL.createObjectURL(new Blob([bytes], { type: mime })));
    audit(r.id, 'upload', old.length ? 'إعادة رفع مستند' : 'رفع مستند', `${dt.name}: ${name}`);
    touch(r.id);
    return doc;
  });
  route('DELETE', '/api/documents/(\\d+)', ['teacher'], (ctx, id) => {
    const d = byId('documents', id);
    if (!d) fail(404, 'المستند غير موجود');
    editable(ctx, d.request_id);
    db.documents = db.documents.filter(x => x !== d);
    audit(d.request_id, 'delete_document', 'حذف مستند', d.original_name);
    return { ok: true };
  });

  route('POST', '/api/requests/(\\d+)/actions/(\\w+)', ['teacher', 'employee', 'approver'], (ctx, id, action) => {
    const u = ctx.user, r = loadReq(ctx, id), req = byId('requests', r.id);
    let note = clean(ctx.body.note);
    if (action === 'add_note') {
      if (u.role === 'teacher' || r.status === 'draft') fail(403, 'ليست لديك صلاحية');
      if (!note) fail(400, 'اكتب الملاحظة');
      insert('comments', { request_id: r.id, user_id: u.id, kind: 'note', reasons_json: null, body: note, internal: 1, created_at: now() });
      audit(r.id, 'add_note', 'إضافة ملاحظة داخلية', note, false);
      return { ok: true };
    }
    const wf = db.workflow.find(w => w.active && w.from_status === r.status && w.from_stage === r.stage && w.action === action && w.role === u.role);
    if (!wf) fail(409, 'هذا الإجراء غير متاح للطلب في حالته الحالية');
    const ts = now(), sets = { status: wf.to_status, stage: wf.to_stage, updated_at: ts };
    const approval = (level, decision, reason) => insert('approvals', { request_id: r.id, user_id: u.id, level, decision, reason: reason || null, created_at: ts });
    const comment = (kind, body, reasons) => insert('comments', { request_id: r.id, user_id: u.id, kind, reasons_json: reasons ? JSON.stringify(reasons) : null, body, internal: 0, created_at: ts });
    if (action === 'submit' || action === 'resubmit') {
      const d = details(r.id), editableF = C.TEACHER_FIELDS.filter(t => t[2]).map(t => t[0]);
      Object.assign(d, profile(r.teacher_id), Object.fromEntries(editableF.map(k => [k, d[k] || ''])));
      computeDays(d);
      saveDetails(r.id, d);
      const errs = validate(fieldsOf(r), d, true);
      missingDocs(r).forEach(n => { errs['doc:' + n] = `مستند إلزامي غير مرفوع: ${n}`; });
      if (ctx.body.declaration !== true) errs.declaration = 'يجب الإقرار بصحة البيانات المدخلة';
      if (Object.keys(errs).length) fail(400, 'الطلب غير مكتمل', errs);
      if (!r.request_no) sets.request_no = nextNo(r.type_code, 'request_no');
      if (!r.submitted_at) sets.submitted_at = ts;
      sets.prelim_approved = 0;
    } else if (action === 'request_completion' || action === 'return_completion') {
      const reasons = (ctx.body.reasons || []).filter(x => C.COMPLETION_REASONS.includes(x));
      if (!reasons.length || !note) fail(400, 'حدد سبب الاستكمال واكتب ملاحظة توضح المطلوب من المعلم');
      comment('completion', note, reasons);
      sets.prelim_approved = 0;
      if (action === 'return_completion') approval('final', 'returned', note);
      note = reasons.join('، ') + ' — ' + note;
    } else if (action === 'prelim_approve') {
      const cl = ctx.body.checklist || {};
      if (!C.CHECKLIST.every(([k]) => cl[k] === true)) fail(400, 'أكمل جميع بنود قائمة التحقق قبل الاعتماد المبدئي');
      sets.prelim_approved = 1;
      sets.checklist_json = JSON.stringify(Object.fromEntries(C.CHECKLIST.map(([k]) => [k, true])));
      approval('preliminary', 'approved', note);
    } else if (action === 'refer' && !r.prelim_approved) {
      fail(409, 'يجب الاعتماد المبدئي قبل إحالة الطلب');
    } else if (action === 'approve') {
      Object.assign(sets, { decision_no: nextNo('DEC', 'decision_no'), decided_at: ts, outcome: 'approved' });
      approval('final', 'approved', note);
      comment('decision', note || 'تمت الموافقة على الطلب');
    } else if (action === 'reject') {
      if (!note) fail(400, 'يجب إدخال سبب الرفض');
      Object.assign(sets, { decided_at: ts, outcome: 'rejected' });
      approval('final', 'rejected', note);
      comment('rejection', note);
    } else if (action === 'close') {
      sets.closed_at = ts;
    }
    Object.assign(req, sets);
    audit(r.id, action, wf.label, note);
    if (action === 'approve') audit(r.id, 'issue_decision', 'إصدار القرار', `رقم القرار: ${sets.decision_no}`);
    const no = sets.request_no || r.request_no, dec = sets.decision_no || '';
    const [tTitle, staffRole, sTitle] = C.NOTIFY[action];
    if (u.id !== r.teacher_id || ['submit', 'resubmit'].includes(action)) notify([r.teacher_id], r.id, tTitle.replace('{no}', no).replace('{dec}', dec), note);
    if (staffRole) notify(staffIds(staffRole, r.governorate), r.id, sTitle.replace('{no}', no));
    return { ok: true, status: sets.status, status_label: C.STATUS_AR[sets.status], request_no: no, decision_no: dec || null };
  });

  route('GET', '/api/requests/(\\d+)/assistant', ['employee', 'approver'], (ctx, id) => {
    const r = loadReq(ctx, id), d = details(r.id), fields = fieldsOf(r);
    const missingTeacher = C.TEACHER_FIELDS.filter(([n]) => !(d[n] || '').trim()).map(t => t[1]);
    const missingFields = fields.filter(f => f.required && visible(f, d) && !(d[f.name] || '').trim()).map(f => f.label);
    const missDocs = missingDocs(r);
    const uploaded = db.documents.filter(x => x.request_id === r.id).map(x => byId('document_types', x.doc_type_id)?.name || '');
    const checks = [], s = parseDate(d.start_date), e = parseDate(d.end_date);
    if (s && e) {
      checks.push(e >= s ? ['ok', `مدة التفرغ ${Math.round((e - s) / 864e5) + 1} يومًا`] : ['warn', 'تاريخ النهاية قبل البداية']);
      if (s < new Date() && r.status !== 'closed') checks.push(['warn', 'تاريخ بداية التفرغ قد مضى']);
      if ((e - s) / 864e5 > 366) checks.push(['warn', 'مدة التفرغ تتجاوز سنة']);
      db.requests.filter(x => x.teacher_id === r.teacher_id && x.id !== r.id && x.outcome === 'approved').forEach(x => {
        const o = details(x.id);
        if (o.start_date <= d.end_date && o.end_date >= d.start_date) checks.push(['warn', `تتداخل الفترة مع طلب معتمد سابق: ${x.request_no}`]);
      });
    }
    if (/^\d+$/.test(d.hours || '') && +d.hours > 20) checks.push(['warn', `عدد الساعات الأسبوعية مرتفع (${d.hours} ساعة)`]);
    const p = profile(r.teacher_id);
    C.TEACHER_FIELDS.forEach(([n, l, ed]) => { if (!ed && d[n] && d[n] !== p[n]) checks.push(['warn', `${l} في الطلب يختلف عن السجل الوظيفي`]); });
    const principal = uploaded.some(n => n.includes('مدير المدرسة'));
    checks.push([principal ? 'ok' : 'warn', 'موافقة مدير المدرسة ' + (principal ? 'مرفوعة' : 'غير مرفوعة')]);
    if (d.leave_type === C.STUDY) checks.push([d.contract_ack === '1' ? 'ok' : 'warn', 'الإقرار ببنود عقد الالتحاق ' + (d.contract_ack === '1' ? 'موجود' : 'غير موجود')]);
    const v = k => d[k] || '—';
    let summary = `${r.type_name} مقدَّم من ${d.t_name || ''} (${d.t_job_title || ''} – ${d.t_subject || ''}) في ${d.t_school || ''}، ولاية ${d.t_wilayat || ''}. نوع التفرغ: ${v('leave_type')}، `
      + `للفترة من ${v('start_date')} إلى ${v('end_date')} (${v('days')} يومًا) بواقع ${v('hours')} ساعة أسبوعيًا – ${v('period')}. الجهة/النشاط: ${v('entity')}. السبب: ${v('reason')}.`;
    if (d.leave_type === C.STUDY) summary += ` الدراسة: ${v('qualification')} في تخصص ${v('specialization')} بـ${v('university')} (${v('country')}).`;
    const warns = checks.filter(c => c[0] === 'warn');
    return { summary, missing_teacher: missingTeacher, missing_fields: missingFields, missing_docs: missDocs, checks: checks.map(([level, text]) => ({ level, text })),
      suggested_checklist: { teacher_complete: !missingTeacher.length, request_complete: !missingFields.length, principal_approval: principal,
        docs_complete: !missDocs.length, conditions_met: !warns.length && !missingFields.length && !missDocs.length },
      disclaimer: 'اقتراحات آلية للمساعدة فقط، والقرار النهائي للموظف المخوّل. لا يرسل المساعد أي بيانات شخصية إلى خدمات خارجية.' };
  });

  route('GET', '/api/notifications', ANY, ctx => ({ notifications: db.notifications.filter(n => n.user_id === ctx.user.id).sort((a, b) => b.id - a.id).slice(0, 100) }));
  route('POST', '/api/notifications/read', ANY, ctx => {
    db.notifications.forEach(n => { if (n.user_id === ctx.user.id && (!ctx.body.id || n.id === ctx.body.id)) n.is_read = 1; });
    return { ok: true };
  });

  route('GET', '/api/reports', STAFF, ctx => {
    const kind = ctx.q.kind || 'all';
    if (!C.REPORTS[kind]) fail(400, 'نوع التقرير غير معروف');
    const rows = listRows(ctx);
    let columns, out;
    if (['all', 'approved', 'rejected', 'in_progress'].includes(kind)) {
      const keep = { approved: r => r.outcome === 'approved', rejected: r => r.outcome === 'rejected', in_progress: r => C.IN_PROGRESS.includes(r.status) }[kind] || (() => true);
      columns = C.ROW_COLS.map(c => c[1]);
      out = rows.filter(keep).map(r => C.ROW_COLS.map(([k]) => k === 'submitted_at' ? (r[k] || '').slice(0, 10) : r[k]));
    } else {
      const key = { by_school: r => r.school_name, by_wilayat: r => r.wilayat, by_month: r => (r.submitted_at || '').slice(0, 7) }[kind];
      const groups = {};
      rows.forEach(r => (groups[key(r) || 'غير محدد'] ||= []).push(r));
      columns = [{ by_school: 'المدرسة', by_wilayat: 'الولاية', by_month: 'الشهر' }[kind], 'الإجمالي', 'قيد المعالجة', 'المعتمدة', 'المرفوضة', 'متوسط زمن المعالجة (يوم)'];
      out = Object.entries(groups).sort((a, b) => kind === 'by_month' ? a[0].localeCompare(b[0]) : b[1].length - a[1].length).map(([g, rs]) => {
        const done = rs.map(r => r.process_days).filter(x => x != null);
        return [g, rs.length, rs.filter(r => C.IN_PROGRESS.includes(r.status)).length, rs.filter(r => r.outcome === 'approved').length,
          rs.filter(r => r.outcome === 'rejected').length, done.length ? Math.round(done.reduce((a, b) => a + b, 0) / done.length * 10) / 10 : ''];
      });
    }
    return { title: C.REPORTS[kind], columns, rows: out, generated_at: now() };
  });

  // ─── الإدارة ───
  const adminAudit = (action, label, note) => audit(null, action, label, note, false);
  route('GET', '/api/admin/users', ADMIN, () => ({ users: db.users.map(u => { const t = teacherRow(u.id) || {}; return { ...u, password: undefined, ...t, id: u.id, school_name: school(t.school_id).name }; }) }));
  const userPayload = (b, creating) => {
    const out = Object.fromEntries(['full_name', 'email', 'phone', 'governorate'].map(k => [k, clean(b[k], 200) || null]));
    if (!out.full_name) fail(400, 'الاسم مطلوب', { full_name: 'مطلوب' });
    const pw = String(b.password || '');
    if (pw || creating) {
      if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) fail(400, 'كلمة المرور 8 أحرف على الأقل وتحتوي حروفًا وأرقامًا', { password: 'ضعيفة' });
      out.password = pw;
    }
    return out;
  };
  const saveTeacher = (uid, t) => {
    t = Object.fromEntries(['employee_no', 'civil_id', 'school_id', 'job_title', 'subject', 'grade', 'appointment_date'].map(k => [k, clean(t[k], 120) || null]));
    if (!t.employee_no || !t.civil_id || !t.school_id) fail(400, 'للمعلم: الرقم الوظيفي والرقم المدني والمدرسة مطلوبة');
    if (db.teachers.some(x => x.user_id !== uid && (x.employee_no === t.employee_no || x.civil_id === t.civil_id))) fail(400, 'الرقم الوظيفي أو المدني مستخدم مسبقًا');
    t.school_id = +t.school_id;
    const cur = teacherRow(uid);
    if (cur) Object.assign(cur, t); else db.teachers.push({ user_id: uid, ...t });
  };
  route('POST', '/api/admin/users', ADMIN, ctx => {
    const b = ctx.body, username = clean(b.username, 32).toLowerCase();
    if (!/^[a-z0-9_.]{3,32}$/.test(username)) fail(400, 'اسم المستخدم: 3–32 حرفًا إنجليزيًا صغيرًا أو أرقامًا', { username: 'غير صالح' });
    if (!C.ROLE_AR[b.role]) fail(400, 'الدور غير صحيح');
    if (db.users.some(u => u.username === username)) fail(400, 'اسم المستخدم مستخدم مسبقًا');
    const p = userPayload(b, true);
    if (b.role === 'teacher') saveTeacher(nextId('users'), b.teacher || {});
    const u = insert('users', { username, role: b.role, active: 1, created_at: now(), ...p });
    adminAudit('admin_create_user', 'إضافة مستخدم', `${username} (${C.ROLE_AR[b.role]})`);
    return { id: u.id };
  });
  route('PUT', '/api/admin/users/(\\d+)', ADMIN, (ctx, id) => {
    const b = ctx.body, u = byId('users', id);
    if (!u) fail(404, 'المستخدم غير موجود');
    const p = userPayload(b, false), active = b.active === false ? 0 : 1, role = b.role || u.role;
    if (u.id === ctx.user.id && !active) fail(400, 'لا يمكنك تعطيل حسابك');
    if (role !== u.role && (role === 'teacher' || u.role === 'teacher' || !C.ROLE_AR[role])) fail(400, 'لا يمكن تحويل حساب معلم إلى دور آخر أو العكس؛ أنشئ حسابًا جديدًا');
    if (role === 'teacher' && b.teacher) saveTeacher(u.id, b.teacher);
    Object.assign(u, p, { active, role });
    adminAudit('admin_update_user', 'تعديل مستخدم', u.username + (p.password ? ' — إعادة تعيين كلمة المرور' : ''));
    return { ok: true };
  });
  const schoolPayload = b => {
    const s = Object.fromEntries(['name', 'governorate', 'wilayat', 'directorate'].map(k => [k, clean(b[k], 150)]));
    if (!Object.values(s).every(Boolean)) fail(400, 'جميع حقول المدرسة مطلوبة');
    return { ...s, active: b.active === false ? 0 : 1 };
  };
  route('GET', '/api/admin/schools', ADMIN, () => ({ schools: [...db.schools].sort((a, b) => a.governorate.localeCompare(b.governorate) || a.name.localeCompare(b.name)) }));
  route('POST', '/api/admin/schools', ADMIN, ctx => { const s = insert('schools', schoolPayload(ctx.body)); adminAudit('admin_school', 'إضافة مدرسة', s.name); return { id: s.id }; });
  route('PUT', '/api/admin/schools/(\\d+)', ADMIN, (ctx, id) => { const s = schoolPayload(ctx.body); Object.assign(byId('schools', id), s); adminAudit('admin_school', 'تعديل مدرسة', s.name); return { ok: true }; });
  const fieldsPayload = raw => {
    let f;
    try { f = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { f = null; }
    if (!Array.isArray(f) || !f.every(x => x && x.name && x.label && x.kind)) fail(400, 'تعريف الحقول يجب أن يكون قائمة JSON لكل عنصر فيها name وlabel وkind');
    return JSON.stringify(f);
  };
  route('GET', '/api/admin/types', ADMIN, () => ({ types: db.request_types.map(t => ({ ...t, documents: db.document_types.filter(d => d.request_type_id === t.id).sort((a, b) => a.sort - b.sort || a.id - b.id) })) }));
  route('POST', '/api/admin/types', ADMIN, ctx => {
    const code = clean(ctx.body.code, 6).toUpperCase(), name = clean(ctx.body.name, 100);
    if (!/^[A-Z]{2,6}$/.test(code) || !name) fail(400, 'الرمز 2–6 أحرف إنجليزية كبيرة، والاسم مطلوب');
    if (db.request_types.some(t => t.code === code)) fail(400, 'الرمز مستخدم مسبقًا');
    const t = insert('request_types', { code, name, fields_json: fieldsPayload(ctx.body.fields_json || db.request_types[0].fields_json), active: 1 });
    adminAudit('admin_type', 'إضافة نوع طلب', `${code} — ${name}`);
    return { id: t.id };
  });
  route('PUT', '/api/admin/types/(\\d+)', ADMIN, (ctx, id) => {
    const name = clean(ctx.body.name, 100);
    if (!name) fail(400, 'الاسم مطلوب');
    const t = byId('request_types', id);
    Object.assign(t, { name, active: ctx.body.active === false ? 0 : 1 }, 'fields_json' in ctx.body ? { fields_json: fieldsPayload(ctx.body.fields_json) } : {});
    adminAudit('admin_type', 'تعديل نوع طلب', name);
    return { ok: true };
  });
  route('POST', '/api/admin/document-types', ADMIN, ctx => {
    const b = ctx.body, name = clean(b.name, 150);
    if (!name || !byId('request_types', b.request_type_id)) fail(400, 'اسم المستند ونوع الطلب مطلوبان');
    const d = insert('document_types', { request_type_id: +b.request_type_id, name, hint: clean(b.hint, 300), required: b.required ? 1 : 0, sort: +b.sort || 99, active: 1 });
    adminAudit('admin_doc_type', 'إضافة مستند مطلوب', name);
    return { id: d.id };
  });
  route('PUT', '/api/admin/document-types/(\\d+)', ADMIN, (ctx, id) => {
    const b = ctx.body, name = clean(b.name, 150);
    if (!name) fail(400, 'اسم المستند مطلوب');
    Object.assign(byId('document_types', id), { name, hint: clean(b.hint, 300), required: b.required ? 1 : 0, active: b.active === false ? 0 : 1, sort: +b.sort || 0 });
    adminAudit('admin_doc_type', 'تعديل مستند مطلوب', name);
    return { ok: true };
  });
  route('GET', '/api/admin/workflow', ADMIN, () => ({ workflow: db.workflow, statuses: C.STATUS_AR, roles: C.ROLE_AR }));
  route('PUT', '/api/admin/workflow/(\\d+)', ADMIN, (ctx, id) => {
    const label = clean(ctx.body.label, 100);
    if (!label) fail(400, 'اسم المرحلة مطلوب');
    Object.assign(byId('workflow', id), { label, active: ctx.body.active === false ? 0 : 1 });
    adminAudit('admin_workflow', 'تعديل مرحلة سير العمل', label);
    return { ok: true };
  });
  route('GET', '/api/admin/audit', ADMIN, ctx => {
    const f = k => clean(ctx.q[k], 60);
    const logs = db.audit_logs.map(a => { const u = byId('users', a.user_id) || {}; return { ...a, username: u.username, user_name: u.full_name, request_no: byId('requests', a.request_id)?.request_no }; })
      .filter(a => (!f('request_no') || (a.request_no || '').includes(f('request_no'))) && (!f('username') || (a.username || '').includes(f('username'))) && (!f('action') || a.action.includes(f('action'))));
    return { logs: logs.reverse().slice(0, 500) };
  });

  // ───── اعتراض fetch ─────
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, opts = {}) => {
    const url = new URL(String(input), location.href);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, opts);
    const method = (opts.method || 'GET').toUpperCase();
    const reply = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
    db = load();                           // أحدث بيانات من التبويبات الأخرى
    session = getSession();
    const snapshot = JSON.stringify(db);   // يُستعاد عند الخطأ، مثل rollback في الخادم
    try {
      for (const [m, rx, roles, fn] of routes) {
        const match = m === method && url.pathname.match(rx);
        if (!match) continue;
        const user = db.users.find(u => u.id === session && u.active) || null;
        if (roles && !user) fail(401, 'انتهت الجلسة، يرجى تسجيل الدخول');
        if (roles?.length && !roles.includes(user.role)) fail(403, 'ليست لديك صلاحية لهذا الإجراء');
        const result = fn({ user, q: Object.fromEntries(url.searchParams), body: opts.body ? JSON.parse(opts.body) : {} }, ...match.slice(1));
        if (method !== 'GET' || url.pathname === '/api/login') save();
        return reply(200, result);
      }
      fail(404, 'غير موجود');
    } catch (e) {
      db = JSON.parse(snapshot);
      if (e && e.status) return reply(e.status, { error: e.msg, fields: e.fields || null });
      console.error(e);
      return reply(500, { error: 'حدث خطأ غير متوقع' });
    }
  };

  // المسارات داخل إطار العرض: replaceState قد يُمنع، فنرجع لتغيير الـ hash
  const rs = history.replaceState.bind(history);
  history.replaceState = (s, t, u) => { try { rs(s, t, u); } catch { if (u && location.hash !== u) location.hash = u; } };

  window.PTMS_DEMO = {
    docUrl: id => files.get(id) || 'about:blank',
    reset() { db = fresh(); setSession(null); files.clear(); save(); location.hash = '#/login'; location.reload(); },
  };
})();
