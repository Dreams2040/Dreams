#!/usr/bin/env python3
"""نظام إدارة طلبات التفرغ الجزئي للمعلمين — الخادم.

Python 3.10+ (المكتبة القياسية فقط) + SQLite. تشغيل:  python3 server.py
إنشاء مدير نظام:                                    python3 server.py create-admin <username>
"""
import base64
import csv
import getpass
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
import traceback
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

BASE = Path(__file__).resolve().parent
PUBLIC = BASE / 'public'
DB_PATH = Path(os.environ.get('PTMS_DB', BASE / 'data' / 'ptms.db'))
UPLOADS = Path(os.environ.get('PTMS_UPLOADS', BASE / 'data' / 'uploads'))
DEMO = os.environ.get('PTMS_DEMO', '1') == '1'
SECURE_COOKIE = os.environ.get('PTMS_SECURE_COOKIE') == '1'   # فعّله خلف HTTPS
TRUST_PROXY = os.environ.get('PTMS_TRUST_PROXY') == '1'
ORG_NAME = os.environ.get('PTMS_ORG', 'وزارة التعليم')
SESSION_HOURS = 8
MAX_FILE = 5 * 1024 * 1024
MAX_BODY = 8 * 1024 * 1024

STATUS_AR = {
    'draft': 'مسودة', 'submitted': 'تم الإرسال', 'under_review': 'قيد المراجعة',
    'needs_completion': 'مطلوب استكمال', 'resubmitted': 'تمت إعادة الإرسال',
    'approved': 'تمت الموافقة', 'rejected': 'مرفوض', 'closed': 'مغلق',
}
ROLE_AR = {'teacher': 'معلم', 'employee': 'الموظف المختص', 'approver': 'المسؤول المعتمد', 'admin': 'مدير النظام'}
IN_PROGRESS = ('submitted', 'under_review', 'needs_completion', 'resubmitted')
COMPLETION_REASONS = ['بيانات ناقصة', 'مستند ناقص', 'مستند غير واضح', 'تعديل بيانات', 'أخرى']
CHECKLIST = [
    ('teacher_complete', 'بيانات المعلم مكتملة'), ('request_complete', 'بيانات الطلب مكتملة'),
    ('principal_approval', 'موافقة مدير المدرسة موجودة'), ('docs_complete', 'المستندات مكتملة'),
    ('conditions_met', 'الشروط مستوفاة'),
]
# (الحقل، التسمية، قابل للتعديل من المعلم). غير القابل للتعديل يُؤخذ من السجل الوظيفي.
TEACHER_FIELDS = [
    ('t_name', 'الاسم', False), ('t_employee_no', 'الرقم الوظيفي', False),
    ('t_civil_id', 'الرقم المدني', False), ('t_school', 'المدرسة', False),
    ('t_wilayat', 'الولاية', False), ('t_directorate', 'المديرية/الإدارة التعليمية', False),
    ('t_job_title', 'المسمى الوظيفي', True), ('t_subject', 'المادة', True),
    ('t_grade', 'الصف', True), ('t_phone', 'رقم الهاتف', True), ('t_email', 'البريد الإلكتروني', True),
]
STUDY = 'تفرغ جزئي للدراسة (جامعية/عليا)'
PT_FIELDS = [
    {'name': 'leave_type', 'label': 'نوع التفرغ', 'kind': 'select', 'required': True,
     'options': [STUDY, 'تفرغ جزئي للتدريب المهني', 'تفرغ جزئي لمهمة أو نشاط رسمي', 'أخرى']},
    {'name': 'qualification', 'label': 'المؤهل المطلوب دراسته', 'kind': 'select', 'required': True,
     'options': ['الدبلوم العالي', 'البكالوريوس', 'الماجستير', 'الدكتوراه'], 'show_if': {'leave_type': STUDY}},
    {'name': 'specialization', 'label': 'التخصص', 'kind': 'text', 'required': True, 'show_if': {'leave_type': STUDY}},
    {'name': 'university', 'label': 'الجامعة/الكلية', 'kind': 'text', 'required': True, 'show_if': {'leave_type': STUDY}},
    {'name': 'country', 'label': 'الدولة', 'kind': 'text', 'required': True, 'show_if': {'leave_type': STUDY}},
    {'name': 'funding', 'label': 'الجهة الممولة', 'kind': 'text', 'show_if': {'leave_type': STUDY}},
    {'name': 'reason', 'label': 'سبب طلب التفرغ', 'kind': 'select', 'required': True,
     'options': ['استكمال الدراسة', 'التدريب والتطوير المهني', 'تكليف أو مهمة رسمية', 'ظروف أخرى']},
    {'name': 'start_date', 'label': 'تاريخ بداية التفرغ', 'kind': 'date', 'required': True},
    {'name': 'end_date', 'label': 'تاريخ نهاية التفرغ', 'kind': 'date', 'required': True},
    {'name': 'days', 'label': 'عدد الأيام', 'kind': 'computed'},
    {'name': 'hours', 'label': 'عدد الساعات الأسبوعية', 'kind': 'number', 'required': True, 'min': 1, 'max': 40},
    {'name': 'period', 'label': 'الفترة المطلوبة', 'kind': 'select', 'required': True,
     'options': ['الفترة الصباحية', 'الفترة المسائية', 'أيام محددة من الأسبوع', 'طوال الدوام الجزئي']},
    {'name': 'entity', 'label': 'الجهة/النشاط الذي سيتم التفرغ له', 'kind': 'text', 'required': True},
    {'name': 'description', 'label': 'وصف الطلب', 'kind': 'textarea', 'required': True},
    {'name': 'notes', 'label': 'ملاحظات إضافية', 'kind': 'textarea'},
    {'name': 'contract_ack', 'label': 'أقر باطلاعي على بنود عقد الالتحاق بالبرامج التأهيلية وموافقتي عليها',
     'kind': 'checkbox', 'required': True, 'show_if': {'leave_type': STUDY}},
]
PT_DOCS = [  # (الاسم، التوضيح، إلزامي) — مأخوذة من استمارات عملية التأهيل
    ('خطاب طلب التفرغ', 'خطاب موجه من المعلم يوضح الطلب ومبرراته', 1),
    ('موافقة مدير المدرسة', 'موافقة مدير المدرسة موقعة ومختومة', 1),
    ('المستند المؤيد للطلب', 'مثل: قبول الجامعة غير المشروط محددًا به تاريخ بداية ونهاية الدراسة', 1),
    ('نسخة من البطاقة الشخصية أو جواز السفر', '', 1),
    ('آخر مؤهل دراسي وكشف الدرجات', '', 0),
    ('استمارة تفويض دارس', 'موقعة من المعلم', 0),
    ('مستندات أخرى', 'أي مستند إضافي يدعم الطلب (يمكن دمجها في ملف PDF واحد)', 0),
]
WORKFLOW = [  # from_status, from_stage, action, role, to_status, to_stage, label
    ('draft', 'teacher', 'submit', 'teacher', 'submitted', 'employee', 'تقديم الطلب'),
    ('needs_completion', 'teacher', 'resubmit', 'teacher', 'resubmitted', 'employee', 'إعادة إرسال الطلب'),
    ('submitted', 'employee', 'start_review', 'employee', 'under_review', 'employee', 'استلام الطلب وبدء المراجعة'),
    ('resubmitted', 'employee', 'start_review', 'employee', 'under_review', 'employee', 'استلام الطلب وبدء المراجعة'),
    ('under_review', 'employee', 'request_completion', 'employee', 'needs_completion', 'teacher', 'طلب استكمال'),
    ('under_review', 'employee', 'prelim_approve', 'employee', 'under_review', 'employee', 'اعتماد مبدئي'),
    ('under_review', 'employee', 'refer', 'employee', 'under_review', 'approver', 'إحالة للمسؤول المعتمد'),
    ('under_review', 'approver', 'approve', 'approver', 'approved', 'none', 'اعتماد الطلب'),
    ('under_review', 'approver', 'reject', 'approver', 'rejected', 'none', 'رفض الطلب'),
    ('under_review', 'approver', 'return_completion', 'approver', 'needs_completion', 'teacher', 'إعادة الطلب للاستكمال'),
    ('approved', 'none', 'close', 'employee', 'closed', 'none', 'إغلاق الطلب'),
    ('rejected', 'none', 'close', 'employee', 'closed', 'none', 'إغلاق الطلب'),
    ('approved', 'none', 'close', 'approver', 'closed', 'none', 'إغلاق الطلب'),
    ('rejected', 'none', 'close', 'approver', 'closed', 'none', 'إغلاق الطلب'),
]
# إشعارات كل إجراء: (عنوان للمعلم، دور الموظفين المُشعَرين، عنوان لهم)
NOTIFY = {
    'submit': ('تم إرسال طلبك {no} بنجاح', 'employee', 'طلب جديد {no} بانتظار المراجعة'),
    'resubmit': ('تمت إعادة إرسال طلبك {no}', 'employee', 'أُعيد إرسال الطلب {no} بعد الاستكمال'),
    'start_review': ('تم استلام طلبك {no} وبدأت مراجعته', None, None),
    'request_completion': ('طلبك {no} يحتاج إلى استكمال', None, None),
    'return_completion': ('طلبك {no} يحتاج إلى استكمال', None, None),
    'prelim_approve': ('تم الاعتماد المبدئي لطلبك {no}', None, None),
    'refer': ('أُحيل طلبك {no} للاعتماد النهائي', 'approver', 'طلب {no} محال إليك للاعتماد'),
    'approve': ('تمت الموافقة على طلبك {no} وصدر القرار {dec}', None, None),
    'reject': ('تم رفض طلبك {no}', None, None),
    'close': ('تم إغلاق طلبك {no}', None, None),
}


class ApiError(Exception):
    def __init__(self, status, msg, fields=None):
        super().__init__(msg)
        self.status, self.msg, self.fields = status, msg, fields


class Raw:
    def __init__(self, body, ctype, filename=None, inline=True):
        self.body, self.ctype, self.filename, self.inline = body, ctype, filename, inline


def now():
    return datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')


def sha(s):
    return hashlib.sha256(s.encode()).hexdigest()


def hash_pw(pw, salt=None):
    salt = salt or secrets.token_bytes(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1)
    return f'scrypt${salt.hex()}${h.hex()}'


def check_pw(pw, stored):
    try:
        _, salt, h = stored.split('$')
        return hmac.compare_digest(hash_pw(pw, bytes.fromhex(salt)).split('$')[2], h)
    except ValueError:
        return False


DUMMY_HASH = hash_pw(secrets.token_hex(8))
FAILS, FAILS_LOCK = {}, threading.Lock()   # قفل مؤقت بعد 5 محاولات دخول خاطئة


def strong_password(pw):
    return len(pw) >= 8 and re.search(r'[A-Za-z]', pw) and re.search(r'\d', pw)


def clean(v, limit=2000):
    return str(v if v is not None else '').strip()[:limit]


# ───────────────────────── قاعدة البيانات ─────────────────────────

def connect():
    c = sqlite3.connect(DB_PATH, timeout=10, isolation_level=None)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA foreign_keys = ON')
    return c


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    UPLOADS.mkdir(parents=True, exist_ok=True)
    c = connect()
    c.execute('PRAGMA journal_mode = WAL')
    c.executescript((BASE / 'schema.sql').read_text(encoding='utf-8'))
    if not c.execute('SELECT 1 FROM workflow').fetchone():
        c.executemany('INSERT INTO workflow (from_status,from_stage,action,role,to_status,to_stage,label) '
                      'VALUES (?,?,?,?,?,?,?)', WORKFLOW)
    if not c.execute('SELECT 1 FROM request_types').fetchone():
        c.execute("INSERT INTO request_types (code,name,fields_json) VALUES ('PT','طلب تفرغ جزئي',?)",
                  (json.dumps(PT_FIELDS, ensure_ascii=False),))
        c.executemany('INSERT INTO document_types (request_type_id,name,hint,required,sort) VALUES (1,?,?,?,?)',
                      [(n, h, r, i) for i, (n, h, r) in enumerate(PT_DOCS)])
    if DEMO and not c.execute('SELECT 1 FROM users').fetchone():
        seed_demo(c)
    c.close()


def seed_demo(c):
    """بيانات تجريبية وهمية بالكامل (لا بيانات حقيقية)."""
    schools = [
        ('مدرسة النور للتعليم الأساسي', 'مسقط', 'السيب', 'المديرية العامة للتعليم بمحافظة مسقط'),
        ('مدرسة الفجر للتعليم ما بعد الأساسي', 'مسقط', 'بوشر', 'المديرية العامة للتعليم بمحافظة مسقط'),
        ('مدرسة الأمل للتعليم الأساسي', 'شمال الباطنة', 'صحار', 'المديرية العامة للتعليم بمحافظة شمال الباطنة'),
        ('مدرسة الرواد للتعليم الأساسي', 'الداخلية', 'نزوى', 'المديرية العامة للتعليم بمحافظة الداخلية'),
        ('مدرسة الإشراق للتعليم الأساسي', 'ظفار', 'صلالة', 'المديرية العامة للتعليم بمحافظة ظفار'),
    ]
    c.executemany('INSERT INTO schools (name,governorate,wilayat,directorate) VALUES (?,?,?,?)', schools)
    pw = hash_pw('Demo@1234')
    users = [
        ('teacher1', 'معلم تجريبي أول', 'teacher', 'teacher1@example.com', '90000001'),
        ('teacher2', 'معلمة تجريبية ثانية', 'teacher', 'teacher2@example.com', '90000002'),
        ('teacher3', 'معلم تجريبي ثالث', 'teacher', 'teacher3@example.com', '90000003'),
        ('employee1', 'موظف مختص تجريبي', 'employee', 'employee1@example.com', '90000011'),
        ('approver1', 'مسؤول معتمد تجريبي', 'approver', 'approver1@example.com', '90000021'),
        ('admin', 'مدير النظام', 'admin', 'admin@example.com', '90000031'),
    ]
    for u in users:
        c.execute('INSERT INTO users (username,password_hash,full_name,role,email,phone) VALUES (?,?,?,?,?,?)',
                  (u[0], pw, *u[1:]))
    teachers = [
        (1, 'EMP-10001', '00000001', 1, 'معلم أول', 'الرياضيات', 'الصف الثامن', '2015-09-01'),
        (2, 'EMP-10002', '00000002', 3, 'معلمة', 'اللغة العربية', 'الصف الخامس', '2018-09-01'),
        (3, 'EMP-10003', '00000003', 4, 'معلم', 'العلوم', 'الصف العاشر', '2012-09-01'),
    ]
    c.executemany('INSERT INTO teachers (user_id,employee_no,civil_id,school_id,job_title,subject,grade,'
                  'appointment_date) VALUES (?,?,?,?,?,?,?,?)', teachers)
    # طلبات تاريخية وهمية حتى لا تظهر لوحة المؤشرات فارغة
    samples = [  # teacher, months_ago, status, stage, outcome, leave_type
        (2, 5, 'closed', 'none', 'approved', STUDY), (3, 4, 'approved', 'none', 'approved', STUDY),
        (2, 3, 'rejected', 'none', 'rejected', 'تفرغ جزئي للتدريب المهني'),
        (3, 2, 'under_review', 'approver', None, 'تفرغ جزئي لمهمة أو نشاط رسمي'),
        (2, 1, 'needs_completion', 'teacher', None, STUDY), (3, 0, 'submitted', 'employee', None, STUDY),
    ]
    today = datetime.now(timezone.utc)
    for i, (tid, ago, status, stage, outcome, lt) in enumerate(samples, 1):
        sub = (today - timedelta(days=30 * ago + 3)).strftime('%Y-%m-%d %H:%M:%S')
        dec = (today - timedelta(days=30 * ago - 4)).strftime('%Y-%m-%d %H:%M:%S') if outcome else None
        school = c.execute('SELECT school_id FROM teachers WHERE user_id=?', (tid,)).fetchone()[0]
        cur = c.execute(
            'INSERT INTO requests (request_no,request_type_id,teacher_id,school_id,status,stage,outcome,'
            'decision_no,created_at,submitted_at,decided_at,updated_at) VALUES (?,1,?,?,?,?,?,?,?,?,?,?)',
            (f'PT-{sub[:4]}-{i:06d}', tid, school, status, stage, outcome,
             f'DEC-{sub[:4]}-{i:06d}' if outcome == 'approved' else None, sub, sub, dec, dec or sub))
        rid = cur.lastrowid
        d = profile_snapshot(c, tid)
        d.update(leave_type=lt, reason='استكمال الدراسة' if lt == STUDY else 'التدريب والتطوير المهني',
                 start_date='2026-09-01', end_date='2027-01-31', days='153', hours='12',
                 period='الفترة المسائية', entity='جهة تجريبية', description='طلب تجريبي لأغراض العرض')
        if lt == STUDY:
            d.update(qualification='الماجستير', specialization='مناهج وطرق تدريس', university='جامعة تجريبية',
                     country='سلطنة عمان', contract_ack='1')
        save_details(c, rid, d)
        c.execute("INSERT INTO audit_logs (request_id,user_id,action,label,created_at) VALUES (?,?,'submit',"
                  "'تقديم الطلب',?)", (rid, tid, sub))


# ───────────────────────── أدوات المجال ─────────────────────────

def profile_snapshot(c, teacher_id):
    p = c.execute('SELECT u.full_name, u.email, u.phone, t.*, s.name school, s.wilayat, s.directorate '
                  'FROM users u JOIN teachers t ON t.user_id=u.id LEFT JOIN schools s ON s.id=t.school_id '
                  'WHERE u.id=?', (teacher_id,)).fetchone()
    if not p:
        raise ApiError(400, 'لا يوجد سجل وظيفي لهذا المستخدم. تواصل مع مدير النظام.')
    return {'t_name': p['full_name'], 't_employee_no': p['employee_no'], 't_civil_id': p['civil_id'],
            't_school': p['school'] or '', 't_wilayat': p['wilayat'] or '', 't_directorate': p['directorate'] or '',
            't_job_title': p['job_title'] or '', 't_subject': p['subject'] or '', 't_grade': p['grade'] or '',
            't_phone': p['phone'] or '', 't_email': p['email'] or ''}


def get_details(c, rid):
    return {r['field']: r['value'] for r in c.execute('SELECT field,value FROM request_details WHERE request_id=?', (rid,))}


def save_details(c, rid, d):
    c.executemany('INSERT INTO request_details (request_id,field,value) VALUES (?,?,?) '
                  'ON CONFLICT(request_id,field) DO UPDATE SET value=excluded.value',
                  [(rid, k, v) for k, v in d.items()])


def type_fields(c, type_id):
    return json.loads(c.execute('SELECT fields_json FROM request_types WHERE id=?', (type_id,)).fetchone()[0])


def visible(f, d):
    return all(d.get(k) == v for k, v in (f.get('show_if') or {}).items())


def parse_date(v):
    try:
        return date.fromisoformat(v)
    except (TypeError, ValueError):
        return None


def validate_details(fields, d, strict):
    errs = {}
    for f in fields:
        if f['kind'] == 'computed' or not visible(f, d):
            continue
        v = (d.get(f['name']) or '').strip()
        if not v:
            if strict and f.get('required'):
                errs[f['name']] = f'{f["label"]}: حقل مطلوب'
            continue
        k = f['kind']
        if k == 'date' and not parse_date(v):
            errs[f['name']] = f'{f["label"]}: تاريخ غير صالح'
        elif k == 'number':
            if not v.isdigit() or not f.get('min', 0) <= int(v) <= f.get('max', 10 ** 9):
                errs[f['name']] = f'{f["label"]}: رقم بين {f.get("min", 0)} و{f.get("max", "")}'
        elif k == 'select' and v not in f['options']:
            errs[f['name']] = f'{f["label"]}: قيمة غير مسموحة'
        elif k == 'checkbox' and v != '1':
            errs[f['name']] = f'{f["label"]}: قيمة غير صالحة'
    s, e = parse_date(d.get('start_date')), parse_date(d.get('end_date'))
    if s and e and e < s:
        errs['end_date'] = 'تاريخ نهاية التفرغ يجب أن يكون بعد تاريخ البداية'
    if d.get('t_email') and not re.fullmatch(r'[^@\s]+@[^@\s]+\.[^@\s]+', d['t_email']):
        errs['t_email'] = 'البريد الإلكتروني غير صالح'
    if d.get('t_phone') and not re.fullmatch(r'\+?\d{8,15}', d['t_phone']):
        errs['t_phone'] = 'رقم الهاتف غير صالح (8–15 رقمًا)'
    if strict:
        for name, label, _ in TEACHER_FIELDS:
            if not (d.get(name) or '').strip():
                errs[name] = f'{label}: حقل مطلوب'
    return errs


def compute_days(d):
    s, e = parse_date(d.get('start_date')), parse_date(d.get('end_date'))
    d['days'] = str((e - s).days + 1) if s and e and e >= s else ''


def doc_types(c, type_id):
    return [dict(r) for r in c.execute('SELECT * FROM document_types WHERE request_type_id=? AND active=1 '
                                       'ORDER BY sort, id', (type_id,))]


def missing_docs(c, r):
    have = {x['doc_type_id'] for x in c.execute('SELECT doc_type_id FROM documents WHERE request_id=?', (r['id'],))}
    return [t['name'] for t in doc_types(c, r['request_type_id']) if t['required'] and t['id'] not in have]


def next_no(c, prefix, col):
    assert col in ('request_no', 'decision_no')
    head = f'{prefix}-{datetime.now(timezone.utc).year}-'
    last = c.execute(f'SELECT MAX(CAST(substr({col}, ?) AS INTEGER)) FROM requests WHERE {col} LIKE ?',
                     (len(head) + 1, head + '%')).fetchone()[0]
    return f'{head}{(last or 0) + 1:06d}'


def audit(ctx, rid, action, label, note=None, visible=True, user_id=None):
    ctx.c.execute('INSERT INTO audit_logs (request_id,user_id,action,label,note,visible_to_teacher,ip,created_at) '
                  'VALUES (?,?,?,?,?,?,?,?)', (rid, user_id or (ctx.user and ctx.user['id']), action, label,
                                               note or None, int(visible), ctx.ip, now()))


def notify(c, user_ids, rid, title, body=None):
    c.executemany('INSERT INTO notifications (user_id,request_id,title,body,created_at) VALUES (?,?,?,?,?)',
                  [(u, rid, title, body, now()) for u in user_ids])


def staff_ids(c, role, governorate):
    return [r[0] for r in c.execute('SELECT id FROM users WHERE role=? AND active=1 AND '
                                    '(governorate IS NULL OR governorate=?)', (role, governorate))]


def public_user(u):
    return {'id': u['id'], 'username': u['username'], 'full_name': u['full_name'], 'role': u['role'],
            'role_label': ROLE_AR[u['role']], 'governorate': u['governorate']}


REQ_SQL = '''
SELECT r.*, u.full_name teacher_name, t.employee_no, s.name school_name, s.governorate, s.wilayat,
       s.directorate, rt.name type_name, rt.code type_code,
       (SELECT value FROM request_details d WHERE d.request_id=r.id AND d.field='leave_type') leave_type,
       CAST(julianday(COALESCE(r.decided_at, 'now')) - julianday(r.submitted_at) AS INTEGER) wait_days,
       ROUND(julianday(r.decided_at) - julianday(r.submitted_at), 1) process_days
FROM requests r JOIN users u ON u.id=r.teacher_id LEFT JOIN teachers t ON t.user_id=r.teacher_id
LEFT JOIN schools s ON s.id=r.school_id JOIN request_types rt ON rt.id=r.request_type_id
'''


def can_see(user, r):
    if user['role'] == 'teacher':
        return r['teacher_id'] == user['id']
    if user['role'] == 'admin':
        return True
    return r['status'] != 'draft' and (not user['governorate'] or user['governorate'] == r['governorate'])


def load_request(ctx, rid):
    r = ctx.c.execute(REQ_SQL + ' WHERE r.id=?', (int(rid),)).fetchone()
    if not r or not can_see(ctx.user, r):
        raise ApiError(404, 'الطلب غير موجود')   # 404 لا 403: لا نكشف وجود طلبات الآخرين
    return r


def row_out(r):
    d = dict(r)
    d['status_label'] = STATUS_AR[r['status']]
    return d


def list_filters(ctx):
    u, g = ctx.user, lambda k: clean(ctx.q.get(k), 100)
    if u['role'] == 'teacher':
        w, a = ['r.teacher_id = ?'], [u['id']]
    else:
        w, a = ["r.status <> 'draft'"], []
        if u['role'] != 'admin' and u['governorate']:
            w.append('s.governorate = ?')
            a.append(u['governorate'])
    if g('q'):
        w.append('(r.request_no LIKE ? OR u.full_name LIKE ? OR t.employee_no LIKE ? OR s.name LIKE ?)')
        a += ['%' + g('q') + '%'] * 4
    if g('status') == 'in_progress':
        w.append("r.status IN ('submitted','under_review','needs_completion','resubmitted')")
    elif g('status'):
        w.append('r.status = ?')
        a.append(g('status'))
    for key, col in (('stage', 'r.stage'), ('wilayat', 's.wilayat'), ('school_id', 'r.school_id')):
        if g(key):
            w.append(f'{col} = ?')
            a.append(g(key))
    if g('leave_type'):
        w.append("EXISTS (SELECT 1 FROM request_details d WHERE d.request_id=r.id AND d.field='leave_type' AND d.value=?)")
        a.append(g('leave_type'))
    if g('from'):
        w.append('date(r.submitted_at) >= ?')
        a.append(g('from'))
    if g('to'):
        w.append('date(r.submitted_at) <= ?')
        a.append(g('to'))
    return ' AND '.join(w), a


def list_rows(ctx, limit=2000):
    where, args = list_filters(ctx)
    sql = REQ_SQL + f' WHERE {where} ORDER BY r.updated_at DESC, r.id DESC LIMIT {int(limit)}'
    return [row_out(r) for r in ctx.c.execute(sql, args)]


def counts(rows):
    st = Counter(r['status'] for r in rows)
    return {'total': len(rows), 'new': st['submitted'] + st['resubmitted'], 'under_review': st['under_review'],
            'in_review': st['submitted'] + st['under_review'] + st['resubmitted'],
            'needs_completion': st['needs_completion'], 'drafts': st['draft'],
            'approved': sum(r['outcome'] == 'approved' for r in rows),
            'rejected': sum(r['outcome'] == 'rejected' for r in rows)}


# ───────────────────────── التوجيه ─────────────────────────

ROUTES = []
ANY = ()          # أي مستخدم مسجّل
STAFF = ('employee', 'approver', 'admin')


def route(method, pattern, roles=ANY):
    def deco(fn):
        ROUTES.append((method, re.compile(pattern), fn, roles))
        return fn
    return deco


class Ctx:
    def __init__(self, h, c, user, q, body, ip):
        self.h, self.c, self.user, self.q, self.body, self.ip = h, c, user, q, body, ip
        self.cookies = []

    def set_session(self, token, max_age):
        secure = '; Secure' if SECURE_COOKIE else ''
        self.cookies.append(f'sid={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={max_age}{secure}')


# ─── الدخول والجلسة ───

@route('GET', r'/api/config', None)
def config(ctx):
    return {'org': ORG_NAME, 'demo': DEMO}


@route('POST', r'/api/login', None)
def login(ctx):
    name, pw = clean(ctx.body.get('username'), 64).lower(), str(ctx.body.get('password') or '')
    with FAILS_LOCK:
        f = FAILS.get(name)
        if f and f[1] > time.time():
            raise ApiError(429, 'تم إيقاف الدخول مؤقتًا بسبب محاولات خاطئة متكررة. حاول بعد 5 دقائق.')
    u = ctx.c.execute('SELECT * FROM users WHERE username=? AND active=1', (name,)).fetchone()
    if not check_pw(pw, u['password_hash'] if u else DUMMY_HASH) or not u:
        with FAILS_LOCK:
            n = FAILS.get(name, [0, 0])[0] + 1
            FAILS[name] = [0, time.time() + 300] if n >= 5 else [n, 0]
        raise ApiError(401, 'اسم المستخدم أو كلمة المرور غير صحيحة')
    with FAILS_LOCK:
        FAILS.pop(name, None)
    token = secrets.token_urlsafe(32)
    ctx.c.execute('DELETE FROM sessions WHERE expires_at < ?', (now(),))
    exp = (datetime.now(timezone.utc) + timedelta(hours=SESSION_HOURS)).strftime('%Y-%m-%d %H:%M:%S')
    ctx.c.execute('INSERT INTO sessions VALUES (?,?,?)', (sha(token), u['id'], exp))
    audit(ctx, None, 'login', 'تسجيل الدخول', visible=False, user_id=u['id'])
    ctx.set_session(token, SESSION_HOURS * 3600)
    return {'user': public_user(u)}


@route('POST', r'/api/logout', None)
def logout(ctx):
    if ctx.h.session_token:
        ctx.c.execute('DELETE FROM sessions WHERE token_hash=?', (sha(ctx.h.session_token),))
    ctx.set_session('', 0)
    return {'ok': True}


@route('POST', r'/api/forgot', None)
def forgot(ctx):
    name = clean(ctx.body.get('username'), 64).lower()
    u = ctx.c.execute('SELECT id FROM users WHERE username=? AND active=1', (name,)).fetchone()
    if u:
        admins = [r[0] for r in ctx.c.execute("SELECT id FROM users WHERE role='admin' AND active=1")]
        notify(ctx.c, admins, None, 'طلب إعادة تعيين كلمة مرور', f'اسم المستخدم: {name}')
        audit(ctx, None, 'forgot_password', 'طلب إعادة تعيين كلمة المرور', visible=False, user_id=u['id'])
    # نفس الرد دائمًا حتى لا نكشف أسماء المستخدمين
    return {'message': 'إذا كان اسم المستخدم صحيحًا فقد أُبلغ مدير النظام، وسيتواصل معك لإعادة تعيين كلمة المرور.'}


@route('GET', r'/api/me')
def me(ctx):
    unread = ctx.c.execute('SELECT COUNT(*) FROM notifications WHERE user_id=? AND is_read=0',
                           (ctx.user['id'],)).fetchone()[0]
    return {'user': public_user(ctx.user), 'unread': unread}


@route('GET', r'/api/lookups')
def lookups(ctx):
    c = ctx.c
    types = [dict(r, fields=json.loads(r['fields_json']), documents=doc_types(c, r['id']))
             for r in c.execute('SELECT id,code,name,fields_json FROM request_types WHERE active=1')]
    return {
        'schools': [dict(r) for r in c.execute('SELECT * FROM schools WHERE active=1 ORDER BY governorate, name')],
        'types': types, 'statuses': STATUS_AR, 'roles': ROLE_AR, 'teacher_fields': TEACHER_FIELDS,
        'completion_reasons': COMPLETION_REASONS, 'checklist': CHECKLIST,
        'wilayats': sorted({r[0] for r in c.execute('SELECT wilayat FROM schools')}),
        'governorates': sorted({r[0] for r in c.execute('SELECT governorate FROM schools')}),
        'leave_types': next((f['options'] for t in types for f in t['fields'] if f['name'] == 'leave_type'), []),
    }


# ─── لوحات المعلومات ───

@route('GET', r'/api/dashboard')
def dashboard(ctx):
    rows = list_rows(ctx)
    role = ctx.user['role']
    if role == 'teacher':
        inbox = rows[:8]
    elif role == 'employee':
        inbox = [r for r in rows if r['stage'] == 'employee' or r['status'] in ('approved', 'rejected')][:15]
    elif role == 'approver':
        inbox = [r for r in rows if r['stage'] == 'approver'][:15]
    else:
        inbox = rows[:15]
    return {'counts': counts(rows), 'requests': inbox}


@route('GET', r'/api/stats', STAFF)
def stats(ctx):
    rows = list_rows(ctx, limit=100000)
    decided = [r['process_days'] for r in rows if r['process_days'] is not None]
    k = counts(rows)
    k['avg_days'] = round(sum(decided) / len(decided), 1) if decided else None
    by = lambda key: Counter(r[key] or 'غير محدد' for r in rows).most_common()
    return {
        'kpis': k,
        'by_month': sorted(Counter(r['submitted_at'][:7] for r in rows if r['submitted_at']).items()),
        'by_wilayat': by('wilayat'), 'by_school': by('school_name'), 'by_leave_type': by('leave_type'),
        'by_status': [[s, STATUS_AR[s], n] for s, n in Counter(r['status'] for r in rows).most_common()],
    }


# ─── الطلبات ───

@route('GET', r'/api/requests')
def list_requests(ctx):
    return {'requests': list_rows(ctx, limit=500)}


@route('POST', r'/api/requests', ('teacher',))
def create_request(ctx):
    c = ctx.c
    tid = ctx.body.get('request_type_id') or 1
    t = c.execute('SELECT * FROM request_types WHERE id=? AND active=1', (tid,)).fetchone()
    if not t:
        raise ApiError(400, 'نوع الطلب غير متاح')
    snap = profile_snapshot(c, ctx.user['id'])
    school = c.execute('SELECT school_id FROM teachers WHERE user_id=?', (ctx.user['id'],)).fetchone()[0]
    rid = c.execute('INSERT INTO requests (request_type_id,teacher_id,school_id,created_at,updated_at) '
                    'VALUES (?,?,?,?,?)', (t['id'], ctx.user['id'], school, now(), now())).lastrowid
    save_details(c, rid, snap)
    audit(ctx, rid, 'create', 'إنشاء الطلب (مسودة)')
    notify(c, [ctx.user['id']], rid, f'تم إنشاء مسودة {t["name"]}', 'يمكنك استكمالها وإرسالها في أي وقت.')
    return {'id': rid}


@route('GET', r'/api/requests/(\d+)')
def get_request(ctx, rid):
    c, u = ctx.c, ctx.user
    r = load_request(ctx, rid)
    teacher = u['role'] == 'teacher'
    hide = ' AND internal=0' if teacher else ''
    comments = [dict(x) for x in c.execute(
        'SELECT cm.*, us.full_name user_name, us.role user_role FROM comments cm JOIN users us ON us.id=cm.user_id '
        f'WHERE request_id=?{hide} ORDER BY cm.id', (r['id'],))]
    events = [dict(x) for x in c.execute(
        'SELECT a.id, a.action, a.label, a.note, a.created_at, us.full_name user_name, us.role user_role '
        'FROM audit_logs a LEFT JOIN users us ON us.id=a.user_id WHERE a.request_id=?'
        + (' AND a.visible_to_teacher=1' if teacher else '') + ' ORDER BY a.id', (r['id'],))]
    actions = [{'action': w['action'], 'label': w['label']} for w in c.execute(
        'SELECT action,label FROM workflow WHERE active=1 AND from_status=? AND from_stage=? AND role=?',
        (r['status'], r['stage'], u['role']))]
    if u['role'] in ('employee', 'approver') and r['status'] != 'draft':
        actions.append({'action': 'add_note', 'label': 'إضافة ملاحظة'})
    return {
        'request': row_out(r), 'details': get_details(c, r['id']),
        'fields': type_fields(c, r['request_type_id']), 'doc_types': doc_types(c, r['request_type_id']),
        'documents': [dict(x) for x in c.execute(
            'SELECT id,doc_type_id,original_name,mime,size,uploaded_at FROM documents WHERE request_id=?', (r['id'],))],
        'comments': comments, 'events': events,
        'approvals': [dict(x) for x in c.execute(
            'SELECT ap.*, us.full_name user_name FROM approvals ap JOIN users us ON us.id=ap.user_id '
            'WHERE request_id=? ORDER BY ap.id', (r['id'],))],
        'actions': actions,
        'can_edit': teacher and r['status'] in ('draft', 'needs_completion'),
    }


def editable(ctx, rid):
    r = load_request(ctx, rid)
    if ctx.user['role'] != 'teacher' or r['status'] not in ('draft', 'needs_completion'):
        raise ApiError(409, 'لا يمكن تعديل الطلب في حالته الحالية')
    return r


@route('PUT', r'/api/requests/(\d+)', ('teacher',))
def update_request(ctx, rid):
    r = editable(ctx, rid)
    fields = type_fields(ctx.c, r['request_type_id'])
    allowed = {f['name'] for f in fields if f['kind'] != 'computed'} | {n for n, _, e in TEACHER_FIELDS if e}
    incoming = ctx.body.get('details') or {}
    d = get_details(ctx.c, r['id'])
    d.update({k: clean(v) for k, v in incoming.items() if k in allowed})
    compute_days(d)
    errs = validate_details(fields, d, strict=False)
    if errs:
        raise ApiError(400, 'تحقق من الحقول المظللة', errs)
    save_details(ctx.c, r['id'], d)
    ctx.c.execute('UPDATE requests SET updated_at=? WHERE id=?', (now(), r['id']))
    return {'ok': True, 'details': d}


def sniff(b):
    if b.startswith(b'%PDF-'):
        return 'application/pdf', {'pdf'}
    if b.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png', {'png'}
    if b.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg', {'jpg', 'jpeg'}
    return None, set()


@route('POST', r'/api/requests/(\d+)/documents', ('teacher',))
def upload_document(ctx, rid):
    c = ctx.c
    r = editable(ctx, rid)
    dt = c.execute('SELECT * FROM document_types WHERE id=? AND request_type_id=? AND active=1',
                   (ctx.body.get('doc_type_id'), r['request_type_id'])).fetchone()
    if not dt:
        raise ApiError(400, 'نوع المستند غير صحيح')
    name = re.sub(r'[\x00-\x1f/\\]', '', clean(ctx.body.get('filename'), 120)) or 'file'
    try:
        data = base64.b64decode(ctx.body.get('data') or '', validate=True)
    except ValueError:
        raise ApiError(400, 'تعذر قراءة الملف')
    if not data or len(data) > MAX_FILE:
        raise ApiError(400, 'حجم الملف يجب ألا يتجاوز 5 ميغابايت')
    mime, exts = sniff(data)   # نحدد النوع من محتوى الملف لا من اسمه
    if not mime or name.rsplit('.', 1)[-1].lower() not in exts:
        raise ApiError(400, 'نوع الملف غير مسموح. المسموح: PDF أو JPG أو PNG')
    stored = secrets.token_hex(16)
    (UPLOADS / stored).write_bytes(data)
    old = c.execute('SELECT id, stored_name FROM documents WHERE request_id=? AND doc_type_id=?',
                    (r['id'], dt['id'])).fetchall()
    c.execute('DELETE FROM documents WHERE request_id=? AND doc_type_id=?', (r['id'], dt['id']))
    did = c.execute('INSERT INTO documents (request_id,doc_type_id,original_name,stored_name,mime,size,uploaded_by,'
                    'uploaded_at) VALUES (?,?,?,?,?,?,?,?)',
                    (r['id'], dt['id'], name, stored, mime, len(data), ctx.user['id'], now())).lastrowid
    for o in old:
        (UPLOADS / o['stored_name']).unlink(missing_ok=True)
    audit(ctx, r['id'], 'upload', 'إعادة رفع مستند' if old else 'رفع مستند', f'{dt["name"]}: {name}')
    c.execute('UPDATE requests SET updated_at=? WHERE id=?', (now(), r['id']))
    return {'id': did, 'doc_type_id': dt['id'], 'original_name': name, 'mime': mime, 'size': len(data)}


def load_document(ctx, did):
    d = ctx.c.execute('SELECT * FROM documents WHERE id=?', (int(did),)).fetchone()
    if not d:
        raise ApiError(404, 'المستند غير موجود')
    return d, load_request(ctx, d['request_id'])   # يطبق صلاحية الوصول للطلب


@route('GET', r'/api/documents/(\d+)')
def get_document(ctx, did):
    d, _ = load_document(ctx, did)
    return Raw((UPLOADS / d['stored_name']).read_bytes(), d['mime'], d['original_name'],
               inline=ctx.q.get('download') != '1')


@route('DELETE', r'/api/documents/(\d+)', ('teacher',))
def delete_document(ctx, did):
    d, r = load_document(ctx, did)
    editable(ctx, r['id'])
    ctx.c.execute('DELETE FROM documents WHERE id=?', (d['id'],))
    (UPLOADS / d['stored_name']).unlink(missing_ok=True)
    audit(ctx, r['id'], 'delete_document', 'حذف مستند', d['original_name'])
    return {'ok': True}


def submit_errors(c, r, d):
    errs = validate_details(type_fields(c, r['request_type_id']), d, strict=True)
    for name in missing_docs(c, r):
        errs['doc:' + name] = f'مستند إلزامي غير مرفوع: {name}'
    return errs


@route('POST', r'/api/requests/(\d+)/actions/(\w+)', ('teacher', 'employee', 'approver'))
def act(ctx, rid, action):
    c, u = ctx.c, ctx.user
    r = load_request(ctx, rid)
    note = clean(ctx.body.get('note'))
    if action == 'add_note':
        if u['role'] == 'teacher' or r['status'] == 'draft':
            raise ApiError(403, 'ليست لديك صلاحية')
        if not note:
            raise ApiError(400, 'اكتب الملاحظة')
        c.execute('INSERT INTO comments (request_id,user_id,kind,body,internal,created_at) VALUES (?,?,?,?,1,?)',
                  (r['id'], u['id'], 'note', note, now()))
        audit(ctx, r['id'], 'add_note', 'إضافة ملاحظة داخلية', note, visible=False)
        return {'ok': True}
    wf = c.execute('SELECT * FROM workflow WHERE active=1 AND from_status=? AND from_stage=? AND action=? AND role=?',
                   (r['status'], r['stage'], action, u['role'])).fetchone()
    if not wf:
        raise ApiError(409, 'هذا الإجراء غير متاح للطلب في حالته الحالية')
    ts = now()
    sets = {'status': wf['to_status'], 'stage': wf['to_stage'], 'updated_at': ts}

    def approval(level, decision, reason=None):
        c.execute('INSERT INTO approvals (request_id,user_id,level,decision,reason,created_at) VALUES (?,?,?,?,?,?)',
                  (r['id'], u['id'], level, decision, reason or None, ts))

    def comment(kind, body, reasons=None):
        c.execute('INSERT INTO comments (request_id,user_id,kind,reasons_json,body,created_at) VALUES (?,?,?,?,?,?)',
                  (r['id'], u['id'], kind, json.dumps(reasons, ensure_ascii=False) if reasons else None, body, ts))

    if action in ('submit', 'resubmit'):
        d = get_details(c, r['id'])
        d.update(profile_snapshot(c, r['teacher_id']) | {k: d.get(k, '') for k, _, e in TEACHER_FIELDS if e})
        compute_days(d)
        save_details(c, r['id'], d)
        errs = submit_errors(c, r, d)
        if ctx.body.get('declaration') is not True:
            errs['declaration'] = 'يجب الإقرار بصحة البيانات المدخلة'
        if errs:
            raise ApiError(400, 'الطلب غير مكتمل', errs)
        if not r['request_no']:
            sets['request_no'] = next_no(c, r['type_code'], 'request_no')
        if not r['submitted_at']:
            sets['submitted_at'] = ts
        sets['prelim_approved'] = 0
    elif action in ('request_completion', 'return_completion'):
        reasons = [x for x in ctx.body.get('reasons') or [] if x in COMPLETION_REASONS]
        if not reasons or not note:
            raise ApiError(400, 'حدد سبب الاستكمال واكتب ملاحظة توضح المطلوب من المعلم')
        comment('completion', note, reasons)
        sets['prelim_approved'] = 0
        if action == 'return_completion':
            approval('final', 'returned', note)
        note = '، '.join(reasons) + ' — ' + note
    elif action == 'prelim_approve':
        checklist = ctx.body.get('checklist') or {}
        if not all(checklist.get(k) is True for k, _ in CHECKLIST):
            raise ApiError(400, 'أكمل جميع بنود قائمة التحقق قبل الاعتماد المبدئي')
        sets['prelim_approved'] = 1
        sets['checklist_json'] = json.dumps({k: True for k, _ in CHECKLIST})
        approval('preliminary', 'approved', note)
    elif action == 'refer' and not r['prelim_approved']:
        raise ApiError(409, 'يجب الاعتماد المبدئي قبل إحالة الطلب')
    elif action == 'approve':
        sets.update(decision_no=next_no(c, 'DEC', 'decision_no'), decided_at=ts, outcome='approved')
        approval('final', 'approved', note)
        comment('decision', note or 'تمت الموافقة على الطلب')
    elif action == 'reject':
        if not note:
            raise ApiError(400, 'يجب إدخال سبب الرفض')
        sets.update(decided_at=ts, outcome='rejected')
        approval('final', 'rejected', note)
        comment('rejection', note)
    elif action == 'close':
        sets['closed_at'] = ts
    c.execute(f'UPDATE requests SET {", ".join(k + "=?" for k in sets)} WHERE id=?', (*sets.values(), r['id']))
    audit(ctx, r['id'], action, wf['label'], note)
    if action == 'approve':
        audit(ctx, r['id'], 'issue_decision', 'إصدار القرار', f'رقم القرار: {sets["decision_no"]}')
    no, dec = sets.get('request_no') or r['request_no'], sets.get('decision_no', '')
    t_title, staff_role, s_title = NOTIFY[action]
    if u['id'] != r['teacher_id'] or action in ('submit', 'resubmit'):
        notify(c, [r['teacher_id']], r['id'], t_title.format(no=no, dec=dec), note or None)
    if staff_role:
        notify(c, staff_ids(c, staff_role, r['governorate']), r['id'], s_title.format(no=no), None)
    return {'ok': True, 'status': sets['status'], 'status_label': STATUS_AR[sets['status']],
            'request_no': no, 'decision_no': dec or None}


@route('GET', r'/api/requests/(\d+)/assistant', ('employee', 'approver'))
def assistant(ctx, rid):
    """مساعد آلي للموظف: يحلل الطلب محليًا (لا تُرسل أي بيانات شخصية لخدمة خارجية) ولا يتخذ قرارًا."""
    c = ctx.c
    r = load_request(ctx, rid)
    d = get_details(c, r['id'])
    fields = type_fields(c, r['request_type_id'])
    missing_teacher = [label for n, label, _ in TEACHER_FIELDS if not (d.get(n) or '').strip()]
    missing_fields = [f['label'] for f in fields if f.get('required') and visible(f, d) and not (d.get(f['name']) or '').strip()]
    miss_docs = missing_docs(c, r)
    uploaded = {x['name'] for x in c.execute(
        'SELECT dt.name FROM documents dc JOIN document_types dt ON dt.id=dc.doc_type_id WHERE dc.request_id=?', (r['id'],))}
    checks = []
    s, e = parse_date(d.get('start_date')), parse_date(d.get('end_date'))
    if s and e:
        checks.append(('ok', f'مدة التفرغ {(e - s).days + 1} يومًا') if e >= s else ('warn', 'تاريخ النهاية قبل البداية'))
        if s < date.today() and r['status'] != 'closed':
            checks.append(('warn', 'تاريخ بداية التفرغ قد مضى'))
        if (e - s).days > 366:
            checks.append(('warn', 'مدة التفرغ تتجاوز سنة'))
        overlap = c.execute(
            "SELECT r.request_no FROM requests r JOIN request_details a ON a.request_id=r.id AND a.field='start_date' "
            "JOIN request_details b ON b.request_id=r.id AND b.field='end_date' WHERE r.teacher_id=? AND r.id<>? "
            "AND r.outcome='approved' AND a.value<=? AND b.value>=?",
            (r['teacher_id'], r['id'], e.isoformat(), s.isoformat())).fetchall()
        for o in overlap:
            checks.append(('warn', f'تتداخل الفترة مع طلب معتمد سابق: {o[0]}'))
    if (d.get('hours') or '').isdigit() and int(d['hours']) > 20:
        checks.append(('warn', f'عدد الساعات الأسبوعية مرتفع ({d["hours"]} ساعة)'))
    profile = profile_snapshot(c, r['teacher_id'])
    for n, label, editable_ in TEACHER_FIELDS:
        if not editable_ and d.get(n) and d.get(n) != profile[n]:
            checks.append(('warn', f'{label} في الطلب يختلف عن السجل الوظيفي'))
    principal = any('مدير المدرسة' in n for n in uploaded)
    checks.append(('ok' if principal else 'warn', 'موافقة مدير المدرسة ' + ('مرفوعة' if principal else 'غير مرفوعة')))
    if d.get('leave_type') == STUDY:
        checks.append(('ok' if d.get('contract_ack') == '1' else 'warn', 'الإقرار ببنود عقد الالتحاق ' +
                       ('موجود' if d.get('contract_ack') == '1' else 'غير موجود')))
    summary = (f'{r["type_name"]} مقدَّم من {d.get("t_name", "")} ({d.get("t_job_title", "")} – {d.get("t_subject", "")}) '
               f'في {d.get("t_school", "")}، ولاية {d.get("t_wilayat", "")}. نوع التفرغ: {d.get("leave_type", "—")}، '
               f'للفترة من {d.get("start_date", "—")} إلى {d.get("end_date", "—")} ({d.get("days", "—")} يومًا) '
               f'بواقع {d.get("hours", "—")} ساعة أسبوعيًا – {d.get("period", "—")}. '
               f'الجهة/النشاط: {d.get("entity", "—")}. السبب: {d.get("reason", "—")}.')
    if d.get('leave_type') == STUDY:
        summary += (f' الدراسة: {d.get("qualification", "—")} في تخصص {d.get("specialization", "—")} '
                    f'بـ{d.get("university", "—")} ({d.get("country", "—")}).')
    warns = [t for lvl, t in checks if lvl == 'warn']
    return {
        'summary': summary, 'missing_teacher': missing_teacher, 'missing_fields': missing_fields,
        'missing_docs': miss_docs, 'checks': [{'level': lvl, 'text': t} for lvl, t in checks],
        'suggested_checklist': {
            'teacher_complete': not missing_teacher, 'request_complete': not missing_fields,
            'principal_approval': principal, 'docs_complete': not miss_docs,
            'conditions_met': not warns and not missing_fields and not miss_docs,
        },
        'disclaimer': 'اقتراحات آلية للمساعدة فقط، والقرار النهائي للموظف المخوّل. '
                      'لا يرسل المساعد أي بيانات شخصية إلى خدمات خارجية.',
    }


# ─── الإشعارات ───

@route('GET', r'/api/notifications')
def notifications(ctx):
    return {'notifications': [dict(r) for r in ctx.c.execute(
        'SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100', (ctx.user['id'],))]}


@route('POST', r'/api/notifications/read')
def read_notifications(ctx):
    nid = ctx.body.get('id')
    sql = 'UPDATE notifications SET is_read=1 WHERE user_id=?' + (' AND id=?' if nid else '')
    ctx.c.execute(sql, (ctx.user['id'], nid) if nid else (ctx.user['id'],))
    return {'ok': True}


# ─── التقارير ───

REPORTS = {
    'all': 'تقرير الطلبات', 'approved': 'تقرير الطلبات المعتمدة', 'rejected': 'تقرير الطلبات المرفوضة',
    'in_progress': 'تقرير الطلبات قيد المعالجة', 'by_school': 'تقرير الطلبات حسب المدرسة',
    'by_wilayat': 'تقرير الطلبات حسب الولاية', 'by_month': 'التقرير الزمني (حسب الشهر)',
}
ROW_COLS = [('request_no', 'رقم الطلب'), ('teacher_name', 'اسم المعلم'), ('employee_no', 'الرقم الوظيفي'),
            ('school_name', 'المدرسة'), ('wilayat', 'الولاية'), ('leave_type', 'نوع التفرغ'),
            ('submitted_at', 'تاريخ التقديم'), ('status_label', 'الحالة'), ('wait_days', 'مدة الانتظار (يوم)'),
            ('decision_no', 'رقم القرار')]


@route('GET', r'/api/reports', STAFF)
def reports(ctx):
    kind = ctx.q.get('kind') or 'all'
    if kind not in REPORTS:
        raise ApiError(400, 'نوع التقرير غير معروف')
    rows = list_rows(ctx, limit=100000)
    if kind in ('all', 'approved', 'rejected', 'in_progress'):
        keep = {'approved': lambda r: r['outcome'] == 'approved', 'rejected': lambda r: r['outcome'] == 'rejected',
                'in_progress': lambda r: r['status'] in IN_PROGRESS}.get(kind, lambda r: True)
        columns = [label for _, label in ROW_COLS]
        out = [[(r[k] or '')[:10] if k == 'submitted_at' else r[k] for k, _ in ROW_COLS] for r in rows if keep(r)]
    else:
        key = {'by_school': 'school_name', 'by_wilayat': 'wilayat', 'by_month': 'month'}[kind]
        groups = {}
        for r in rows:
            g = (r['submitted_at'] or '')[:7] if key == 'month' else r[key]
            groups.setdefault(g or 'غير محدد', []).append(r)
        columns = [{'by_school': 'المدرسة', 'by_wilayat': 'الولاية', 'by_month': 'الشهر'}[kind],
                   'الإجمالي', 'قيد المعالجة', 'المعتمدة', 'المرفوضة', 'متوسط زمن المعالجة (يوم)']
        out = []
        for g, rs in sorted(groups.items(), reverse=key != 'month', key=lambda x: x[0] if key == 'month' else len(x[1])):
            done = [r['process_days'] for r in rs if r['process_days'] is not None]
            out.append([g, len(rs), sum(r['status'] in IN_PROGRESS for r in rs),
                        sum(r['outcome'] == 'approved' for r in rs), sum(r['outcome'] == 'rejected' for r in rs),
                        round(sum(done) / len(done), 1) if done else ''])
    if ctx.q.get('format') == 'csv':
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(columns)
        w.writerows(out)
        return Raw(('﻿' + buf.getvalue()).encode('utf-8'), 'text/csv; charset=utf-8',
                   f'report-{kind}-{date.today().isoformat()}.csv', inline=False)
    return {'title': REPORTS[kind], 'columns': columns, 'rows': out, 'generated_at': now()}


# ─── الإدارة ───

ADMIN = ('admin',)


def admin_audit(ctx, action, label, note):
    audit(ctx, None, action, label, note, visible=False)


@route('GET', r'/api/admin/users', ADMIN)
def admin_users(ctx):
    return {'users': [dict(r) for r in ctx.c.execute(
        'SELECT u.id,u.username,u.full_name,u.role,u.email,u.phone,u.governorate,u.active,u.created_at,'
        't.employee_no,t.civil_id,t.school_id,t.job_title,t.subject,t.grade,s.name school_name '
        'FROM users u LEFT JOIN teachers t ON t.user_id=u.id LEFT JOIN schools s ON s.id=t.school_id ORDER BY u.id')]}


def user_payload(b, creating):
    out = {k: clean(b.get(k), 200) or None for k in ('full_name', 'email', 'phone', 'governorate')}
    if not out['full_name']:
        raise ApiError(400, 'الاسم مطلوب', {'full_name': 'مطلوب'})
    pw = str(b.get('password') or '')
    if pw or creating:
        if not strong_password(pw):
            raise ApiError(400, 'كلمة المرور 8 أحرف على الأقل وتحتوي حروفًا وأرقامًا', {'password': 'ضعيفة'})
        out['password_hash'] = hash_pw(pw)
    return out


def save_teacher(c, uid, t):
    t = {k: clean(t.get(k), 120) or None for k in
         ('employee_no', 'civil_id', 'school_id', 'job_title', 'subject', 'grade', 'appointment_date')}
    if not t['employee_no'] or not t['civil_id'] or not t['school_id']:
        raise ApiError(400, 'للمعلم: الرقم الوظيفي والرقم المدني والمدرسة مطلوبة')
    c.execute('INSERT INTO teachers (user_id,employee_no,civil_id,school_id,job_title,subject,grade,appointment_date) '
              'VALUES (:uid,:employee_no,:civil_id,:school_id,:job_title,:subject,:grade,:appointment_date) '
              'ON CONFLICT(user_id) DO UPDATE SET employee_no=excluded.employee_no, civil_id=excluded.civil_id, '
              'school_id=excluded.school_id, job_title=excluded.job_title, subject=excluded.subject, '
              'grade=excluded.grade, appointment_date=excluded.appointment_date', t | {'uid': uid})


@route('POST', r'/api/admin/users', ADMIN)
def admin_create_user(ctx):
    b = ctx.body
    username, role = clean(b.get('username'), 32).lower(), b.get('role')
    if not re.fullmatch(r'[a-z0-9_.]{3,32}', username):
        raise ApiError(400, 'اسم المستخدم: 3–32 حرفًا إنجليزيًا صغيرًا أو أرقامًا', {'username': 'غير صالح'})
    if role not in ROLE_AR:
        raise ApiError(400, 'الدور غير صحيح')
    p = user_payload(b, True)
    try:
        uid = ctx.c.execute('INSERT INTO users (username,password_hash,full_name,role,email,phone,governorate) '
                            'VALUES (?,?,?,?,?,?,?)', (username, p['password_hash'], p['full_name'], role,
                                                       p['email'], p['phone'], p['governorate'])).lastrowid
        if role == 'teacher':
            save_teacher(ctx.c, uid, b.get('teacher') or {})
    except sqlite3.IntegrityError:
        raise ApiError(400, 'اسم المستخدم أو الرقم الوظيفي أو المدني مستخدم مسبقًا')
    admin_audit(ctx, 'admin_create_user', 'إضافة مستخدم', f'{username} ({ROLE_AR[role]})')
    return {'id': uid}


@route('PUT', r'/api/admin/users/(\d+)', ADMIN)
def admin_update_user(ctx, uid):
    b, c = ctx.body, ctx.c
    u = c.execute('SELECT * FROM users WHERE id=?', (int(uid),)).fetchone()
    if not u:
        raise ApiError(404, 'المستخدم غير موجود')
    p = user_payload(b, False)
    active = 1 if b.get('active', True) else 0
    if u['id'] == ctx.user['id'] and not active:
        raise ApiError(400, 'لا يمكنك تعطيل حسابك')
    role = b.get('role') or u['role']
    if role != u['role'] and ('teacher' in (role, u['role']) or role not in ROLE_AR):
        raise ApiError(400, 'لا يمكن تحويل حساب معلم إلى دور آخر أو العكس؛ أنشئ حسابًا جديدًا')
    c.execute('UPDATE users SET full_name=?, email=?, phone=?, governorate=?, active=?, role=? WHERE id=?',
              (p['full_name'], p['email'], p['phone'], p['governorate'], active, role, u['id']))
    if 'password_hash' in p:
        c.execute('UPDATE users SET password_hash=? WHERE id=?', (p['password_hash'], u['id']))
        c.execute('DELETE FROM sessions WHERE user_id=?', (u['id'],))
    if not active:
        c.execute('DELETE FROM sessions WHERE user_id=?', (u['id'],))
    if role == 'teacher' and b.get('teacher'):
        try:
            save_teacher(c, u['id'], b['teacher'])
        except sqlite3.IntegrityError:
            raise ApiError(400, 'الرقم الوظيفي أو المدني مستخدم مسبقًا')
    admin_audit(ctx, 'admin_update_user', 'تعديل مستخدم',
                u['username'] + (' — إعادة تعيين كلمة المرور' if 'password_hash' in p else ''))
    return {'ok': True}


@route('GET', r'/api/admin/schools', ADMIN)
def admin_schools(ctx):
    return {'schools': [dict(r) for r in ctx.c.execute('SELECT * FROM schools ORDER BY governorate, name')]}


def school_payload(b):
    s = {k: clean(b.get(k), 150) for k in ('name', 'governorate', 'wilayat', 'directorate')}
    if not all(s.values()):
        raise ApiError(400, 'جميع حقول المدرسة مطلوبة')
    return s | {'active': 1 if b.get('active', True) else 0}


@route('POST', r'/api/admin/schools', ADMIN)
def admin_create_school(ctx):
    s = school_payload(ctx.body)
    sid = ctx.c.execute('INSERT INTO schools (name,governorate,wilayat,directorate,active) VALUES '
                        '(:name,:governorate,:wilayat,:directorate,:active)', s).lastrowid
    admin_audit(ctx, 'admin_school', 'إضافة مدرسة', s['name'])
    return {'id': sid}


@route('PUT', r'/api/admin/schools/(\d+)', ADMIN)
def admin_update_school(ctx, sid):
    s = school_payload(ctx.body) | {'id': int(sid)}
    ctx.c.execute('UPDATE schools SET name=:name, governorate=:governorate, wilayat=:wilayat, '
                  'directorate=:directorate, active=:active WHERE id=:id', s)
    admin_audit(ctx, 'admin_school', 'تعديل مدرسة', s['name'])
    return {'ok': True}


@route('GET', r'/api/admin/types', ADMIN)
def admin_types(ctx):
    c = ctx.c
    return {'types': [dict(t, documents=[dict(d) for d in c.execute(
        'SELECT * FROM document_types WHERE request_type_id=? ORDER BY sort, id', (t['id'],))])
        for t in c.execute('SELECT * FROM request_types ORDER BY id')]}


def fields_payload(raw):
    try:
        fields = json.loads(raw) if isinstance(raw, str) else raw
        assert isinstance(fields, list) and all(isinstance(f, dict) and f.get('name') and f.get('label')
                                                and f.get('kind') for f in fields)
    except (ValueError, AssertionError):
        raise ApiError(400, 'تعريف الحقول يجب أن يكون قائمة JSON لكل عنصر فيها name وlabel وkind')
    return json.dumps(fields, ensure_ascii=False)


@route('POST', r'/api/admin/types', ADMIN)
def admin_create_type(ctx):
    b = ctx.body
    code, name = clean(b.get('code'), 6).upper(), clean(b.get('name'), 100)
    if not re.fullmatch(r'[A-Z]{2,6}', code) or not name:
        raise ApiError(400, 'الرمز 2–6 أحرف إنجليزية كبيرة، والاسم مطلوب')
    fields = fields_payload(b.get('fields_json') or ctx.c.execute(
        'SELECT fields_json FROM request_types WHERE id=1').fetchone()[0])
    try:
        tid = ctx.c.execute('INSERT INTO request_types (code,name,fields_json) VALUES (?,?,?)',
                            (code, name, fields)).lastrowid
    except sqlite3.IntegrityError:
        raise ApiError(400, 'الرمز مستخدم مسبقًا')
    admin_audit(ctx, 'admin_type', 'إضافة نوع طلب', f'{code} — {name}')
    return {'id': tid}


@route('PUT', r'/api/admin/types/(\d+)', ADMIN)
def admin_update_type(ctx, tid):
    b = ctx.body
    name = clean(b.get('name'), 100)
    if not name:
        raise ApiError(400, 'الاسم مطلوب')
    sets, args = ['name=?', 'active=?'], [name, 1 if b.get('active', True) else 0]
    if 'fields_json' in b:
        sets.append('fields_json=?')
        args.append(fields_payload(b['fields_json']))
    ctx.c.execute(f'UPDATE request_types SET {", ".join(sets)} WHERE id=?', (*args, int(tid)))
    admin_audit(ctx, 'admin_type', 'تعديل نوع طلب', name)
    return {'ok': True}


@route('POST', r'/api/admin/document-types', ADMIN)
def admin_create_doc_type(ctx):
    b = ctx.body
    name = clean(b.get('name'), 150)
    if not name or not ctx.c.execute('SELECT 1 FROM request_types WHERE id=?', (b.get('request_type_id'),)).fetchone():
        raise ApiError(400, 'اسم المستند ونوع الطلب مطلوبان')
    did = ctx.c.execute('INSERT INTO document_types (request_type_id,name,hint,required,sort) VALUES (?,?,?,?,?)',
                        (b['request_type_id'], name, clean(b.get('hint'), 300), 1 if b.get('required') else 0,
                         int(b.get('sort') or 99))).lastrowid
    admin_audit(ctx, 'admin_doc_type', 'إضافة مستند مطلوب', name)
    return {'id': did}


@route('PUT', r'/api/admin/document-types/(\d+)', ADMIN)
def admin_update_doc_type(ctx, did):
    b = ctx.body
    name = clean(b.get('name'), 150)
    if not name:
        raise ApiError(400, 'اسم المستند مطلوب')
    ctx.c.execute('UPDATE document_types SET name=?, hint=?, required=?, active=?, sort=? WHERE id=?',
                  (name, clean(b.get('hint'), 300), 1 if b.get('required') else 0, 1 if b.get('active', True) else 0,
                   int(b.get('sort') or 0), int(did)))
    admin_audit(ctx, 'admin_doc_type', 'تعديل مستند مطلوب', name)
    return {'ok': True}


@route('GET', r'/api/admin/workflow', ADMIN)
def admin_workflow(ctx):
    return {'workflow': [dict(r) for r in ctx.c.execute('SELECT * FROM workflow ORDER BY id')],
            'statuses': STATUS_AR, 'roles': ROLE_AR}


@route('PUT', r'/api/admin/workflow/(\d+)', ADMIN)
def admin_update_workflow(ctx, wid):
    label = clean(ctx.body.get('label'), 100)
    if not label:
        raise ApiError(400, 'اسم المرحلة مطلوب')
    ctx.c.execute('UPDATE workflow SET label=?, active=? WHERE id=?',
                  (label, 1 if ctx.body.get('active', True) else 0, int(wid)))
    admin_audit(ctx, 'admin_workflow', 'تعديل مرحلة سير العمل', label)
    return {'ok': True}


@route('GET', r'/api/admin/audit', ADMIN)
def admin_audit_log(ctx):
    w, a = ['1=1'], []
    for key, col in (('request_no', 'r.request_no'), ('username', 'us.username'), ('action', 'a.action')):
        v = clean(ctx.q.get(key), 60)
        if v:
            w.append(f'{col} LIKE ?')
            a.append(f'%{v}%')
    return {'logs': [dict(r) for r in ctx.c.execute(
        'SELECT a.*, us.username, us.full_name user_name, r.request_no FROM audit_logs a '
        'LEFT JOIN users us ON us.id=a.user_id LEFT JOIN requests r ON r.id=a.request_id '
        f'WHERE {" AND ".join(w)} ORDER BY a.id DESC LIMIT 500', a)]}


# ───────────────────────── خادم HTTP ─────────────────────────

CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
       "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; frame-src 'self'; "
       "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'")
STATIC_TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
                '.ico': 'image/x-icon'}


class Handler(BaseHTTPRequestHandler):
    server_version = 'PTMS'
    sys_version = ''
    session_token = None

    def log_message(self, fmt, *args):
        if os.environ.get('PTMS_QUIET') != '1':
            super().log_message(fmt, *args)

    def do_GET(self):
        self.dispatch('GET')

    def do_POST(self):
        self.dispatch('POST')

    def do_PUT(self):
        self.dispatch('PUT')

    def do_DELETE(self):
        self.dispatch('DELETE')

    def send(self, status, body, ctype, extra=()):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('X-Frame-Options', 'SAMEORIGIN')
        self.send_header('Content-Security-Policy', CSP)
        for k, v in extra:
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def send_json(self, status, obj, extra=()):
        body = json.dumps(obj, ensure_ascii=False, default=str).encode('utf-8')
        self.send(status, body, 'application/json; charset=utf-8', [('Cache-Control', 'no-store'), *extra])

    def serve_static(self, path):
        rel = path.lstrip('/') or 'index.html'
        f = (PUBLIC / rel).resolve()
        if PUBLIC.resolve() not in f.parents or not f.is_file():
            if '.' in rel.rsplit('/', 1)[-1]:
                return self.send(404, 'غير موجود'.encode(), 'text/plain; charset=utf-8')
            f = PUBLIC / 'index.html'
        self.send(200, f.read_bytes(), STATIC_TYPES.get(f.suffix, 'application/octet-stream'),
                  [('Cache-Control', 'no-cache')])

    def current_user(self, c):
        cookie = self.headers.get('Cookie') or ''
        m = re.search(r'(?:^|;\s*)sid=([A-Za-z0-9_-]+)', cookie)
        self.session_token = m.group(1) if m else None
        if not self.session_token:
            return None
        return c.execute('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id '
                         'WHERE s.token_hash=? AND s.expires_at > ? AND u.active=1',
                         (sha(self.session_token), now())).fetchone()

    def dispatch(self, method):
        url = urlparse(self.path)
        if not url.path.startswith('/api/'):
            return self.serve_static(url.path) if method == 'GET' else self.send_json(405, {'error': 'غير مسموح'})
        c = connect()
        try:
            length = int(self.headers.get('Content-Length') or 0)
            if length > MAX_BODY:
                raise ApiError(413, 'حجم الطلب كبير جدًا')
            raw = self.rfile.read(length) if length else b''
            for m, rx, fn, roles in ROUTES:
                match = rx.fullmatch(url.path) if m == method else None
                if not match:
                    continue
                if method != 'GET' and self.headers.get('X-Requested-With') != 'fetch':
                    raise ApiError(403, 'طلب غير مسموح')   # حماية CSRF مع SameSite=Strict
                try:
                    body = json.loads(raw) if raw else {}
                    assert isinstance(body, dict)
                except (ValueError, AssertionError):
                    raise ApiError(400, 'صيغة البيانات غير صحيحة')
                user = self.current_user(c)
                if roles is not None and not user:
                    raise ApiError(401, 'انتهت الجلسة، يرجى تسجيل الدخول')
                if roles and user['role'] not in roles:
                    raise ApiError(403, 'ليست لديك صلاحية لهذا الإجراء')
                ip = (self.headers.get('X-Forwarded-For', '').split(',')[0].strip() if TRUST_PROXY else '') \
                    or self.client_address[0]
                ctx = Ctx(self, c, user, {k: v[0] for k, v in parse_qs(url.query).items()}, body, ip)
                if method != 'GET':
                    c.execute('BEGIN IMMEDIATE')
                result = fn(ctx, *match.groups())
                if c.in_transaction:
                    c.commit()
                cookies = [('Set-Cookie', v) for v in ctx.cookies]
                if isinstance(result, Raw):
                    disp = 'inline' if result.inline else 'attachment'
                    return self.send(200, result.body, result.ctype, [
                        ('Cache-Control', 'private, no-store'),
                        ('Content-Disposition', f"{disp}; filename*=UTF-8''{quote(result.filename)}")])
                return self.send_json(200, result, cookies)
            raise ApiError(404, 'غير موجود')
        except ApiError as e:
            if c.in_transaction:
                c.rollback()
            self.send_json(e.status, {'error': e.msg, 'fields': e.fields})
        except Exception:
            if c.in_transaction:
                c.rollback()
            traceback.print_exc()
            self.send_json(500, {'error': 'حدث خطأ غير متوقع في الخادم'})
        finally:
            c.close()


def create_admin(username):
    init_db()
    pw = getpass.getpass('كلمة المرور: ')
    if not strong_password(pw):
        sys.exit('كلمة المرور 8 أحرف على الأقل وتحتوي حروفًا وأرقامًا')
    c = connect()
    c.execute("INSERT INTO users (username,password_hash,full_name,role) VALUES (?,?,'مدير النظام','admin')",
              (username.lower(), hash_pw(pw)))
    print('تم إنشاء حساب مدير النظام:', username)


def main():
    if len(sys.argv) == 3 and sys.argv[1] == 'create-admin':
        return create_admin(sys.argv[2])
    host = os.environ.get('PTMS_HOST', '127.0.0.1')
    port = int(os.environ.get('PTMS_PORT', '8000'))
    init_db()
    print(f'نظام إدارة طلبات التفرغ الجزئي يعمل على http://{host}:{port}'
          + ('  (وضع العرض التجريبي)' if DEMO else ''))
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == '__main__':
    main()
