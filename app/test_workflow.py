"""اختبار السيناريو الأساسي (19 خطوة) + فحوص الأمان عبر HTTP حقيقي.  تشغيل: python3 -m unittest -v"""
import base64
import json
import os
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

TMP = tempfile.mkdtemp()
os.environ.update(PTMS_DB=f'{TMP}/t.db', PTMS_UPLOADS=f'{TMP}/up', PTMS_DEMO='1', PTMS_QUIET='1')
import server  # noqa: E402

PDF = b'%PDF-1.4\n% test\n'
PNG = b'\x89PNG\r\n\x1a\n' + b'\0' * 16


class Client:
    def __init__(self, base):
        self.base = base
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))

    def call(self, method, path, body=None, csrf=True):
        req = urllib.request.Request(self.base + path, method=method,
                                     data=json.dumps(body).encode() if body is not None else None)
        req.add_header('Content-Type', 'application/json')
        if csrf:
            req.add_header('X-Requested-With', 'fetch')
        try:
            with self.op.open(req) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if 'json' in r.headers['Content-Type'] else raw)
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def ok(self, method, path, body=None):
        status, data = self.call(method, path, body)
        assert status == 200, (status, data)
        return data

    def login(self, user):
        return self.ok('POST', '/api/login', {'username': user, 'password': 'Demo@1234'})


class Scenario(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.init_db()
        cls.httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.base = f'http://127.0.0.1:{cls.httpd.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def client(self, user=None):
        c = Client(self.base)
        if user:
            c.login(user)
        return c

    def new_complete_request(self, t, skip_doc=None):
        rid = t.ok('POST', '/api/requests', {'request_type_id': 1})['id']
        t.ok('PUT', f'/api/requests/{rid}', {'details': {
            'leave_type': server.STUDY, 'qualification': 'الماجستير', 'specialization': 'الإدارة التربوية',
            'university': 'جامعة تجريبية', 'country': 'سلطنة عمان', 'reason': 'استكمال الدراسة',
            'start_date': '2027-02-01', 'end_date': '2027-06-30', 'hours': '10', 'period': 'الفترة المسائية',
            'entity': 'جامعة تجريبية', 'description': 'دراسة الماجستير بنظام التفرغ الجزئي', 'contract_ack': '1'}})
        docs = t.ok('GET', f'/api/requests/{rid}')['doc_types']
        for d in docs:
            if d['required'] and d['name'] != skip_doc:
                t.ok('POST', f'/api/requests/{rid}/documents',
                     {'doc_type_id': d['id'], 'filename': 'doc.pdf', 'data': base64.b64encode(PDF).decode()})
        return rid, docs

    def test_full_scenario(self):
        # 1–6: المعلم يسجل الدخول، ينشئ الطلب، يدخل البيانات، يرفع المستندات (ينسى موافقة المدير) ويرسل
        t = self.client('teacher1')
        rid, docs = self.new_complete_request(t, skip_doc='موافقة مدير المدرسة')
        d = t.ok('GET', f'/api/requests/{rid}')
        self.assertEqual(d['details']['days'], '150')
        self.assertEqual(d['details']['t_employee_no'], 'EMP-10001')   # تعبئة تلقائية من السجل
        # لا يُرسل بدون المستند الإلزامي ولا بدون الإقرار
        status, err = t.call('POST', f'/api/requests/{rid}/actions/submit', {'declaration': True})
        self.assertEqual(status, 400)
        self.assertIn('doc:موافقة مدير المدرسة', err['fields'])
        principal = next(x for x in docs if x['name'] == 'موافقة مدير المدرسة')
        # نرفعه الآن بصيغة غير مدعومة ثم بصورة PNG سليمة
        status, _ = t.call('POST', f'/api/requests/{rid}/documents',
                           {'doc_type_id': principal['id'], 'filename': 'x.exe', 'data': base64.b64encode(b'MZ..').decode()})
        self.assertEqual(status, 400)
        status, _ = t.call('POST', f'/api/requests/{rid}/documents',   # امتداد PDF لكن المحتوى ليس PDF
                           {'doc_type_id': principal['id'], 'filename': 'x.pdf', 'data': base64.b64encode(PNG).decode()})
        self.assertEqual(status, 400)
        status, _ = t.call('POST', f'/api/requests/{rid}/actions/submit', {'declaration': False})
        self.assertEqual(status, 400)
        t.ok('POST', f'/api/requests/{rid}/documents',
             {'doc_type_id': principal['id'], 'filename': 'principal.png', 'data': base64.b64encode(PNG).decode()})
        res = t.ok('POST', f'/api/requests/{rid}/actions/submit', {'declaration': True})
        self.assertRegex(res['request_no'], r'^PT-\d{4}-\d{6}$')
        self.assertEqual(res['status'], 'submitted')
        no = res['request_no']

        # 7–9: الموظف يستلم ويراجع ويطلب استكمال مستند
        e = self.client('employee1')
        inbox = e.ok('GET', '/api/dashboard')['requests']
        self.assertIn(no, [x['request_no'] for x in inbox])
        e.ok('POST', f'/api/requests/{rid}/actions/start_review', {})
        assist = e.ok('GET', f'/api/requests/{rid}/assistant')
        self.assertTrue(assist['suggested_checklist']['docs_complete'])
        status, _ = e.call('POST', f'/api/requests/{rid}/actions/refer', {})   # لا إحالة قبل الاعتماد المبدئي
        self.assertEqual(status, 409)
        status, _ = e.call('POST', f'/api/requests/{rid}/actions/request_completion', {'reasons': ['مستند ناقص']})
        self.assertEqual(status, 400)   # الملاحظة إلزامية
        e.ok('POST', f'/api/requests/{rid}/actions/add_note', {'note': 'ملاحظة داخلية للموظفين'})
        e.ok('POST', f'/api/requests/{rid}/actions/request_completion',
             {'reasons': ['مستند ناقص'], 'note': 'يرجى إرفاق استمارة تفويض دارس موقعة.'})

        # 10–12: المعلم يستلم الإشعار، يرفع المستند، يعيد الإرسال
        notes = t.ok('GET', '/api/notifications')['notifications']
        self.assertTrue(any('يحتاج إلى استكمال' in n['title'] for n in notes))
        d = t.ok('GET', f'/api/requests/{rid}')
        self.assertEqual(d['request']['status'], 'needs_completion')
        self.assertTrue(d['can_edit'])
        self.assertNotIn('ملاحظة داخلية للموظفين', json.dumps(d, ensure_ascii=False))   # الداخلية مخفية عن المعلم
        auth = next(x for x in docs if x['name'] == 'استمارة تفويض دارس')
        t.ok('POST', f'/api/requests/{rid}/documents',
             {'doc_type_id': auth['id'], 'filename': 'authorization.pdf', 'data': base64.b64encode(PDF).decode()})
        res = t.ok('POST', f'/api/requests/{rid}/actions/resubmit', {'declaration': True})
        self.assertEqual((res['status'], res['request_no']), ('resubmitted', no))   # نفس الرقم

        # 13–14: الموظف يراجع ويعتمد مبدئيًا ويحيل
        e.ok('POST', f'/api/requests/{rid}/actions/start_review', {})
        status, _ = e.call('POST', f'/api/requests/{rid}/actions/prelim_approve', {'checklist': {'teacher_complete': True}})
        self.assertEqual(status, 400)
        e.ok('POST', f'/api/requests/{rid}/actions/prelim_approve',
             {'checklist': {k: True for k, _ in server.CHECKLIST}, 'note': 'مستوفٍ للشروط'})
        e.ok('POST', f'/api/requests/{rid}/actions/refer', {})
        status, _ = e.call('POST', f'/api/requests/{rid}/actions/approve', {})   # الموظف لا يعتمد نهائيًا
        self.assertEqual(status, 409)

        # 15–16: المسؤول يعتمد (والرفض بلا سبب ممنوع)
        a = self.client('approver1')
        self.assertIn(no, [x['request_no'] for x in a.ok('GET', '/api/dashboard')['requests']])
        status, _ = a.call('POST', f'/api/requests/{rid}/actions/reject', {'note': ''})
        self.assertEqual(status, 400)
        res = a.ok('POST', f'/api/requests/{rid}/actions/approve', {'note': 'معتمد'})
        self.assertEqual(res['status'], 'approved')
        self.assertRegex(res['decision_no'], r'^DEC-\d{4}-\d{6}$')

        # 17: القرار يظهر للمعلم
        d = t.ok('GET', f'/api/requests/{rid}')
        self.assertEqual(d['request']['status_label'], 'تمت الموافقة')
        self.assertEqual(d['request']['decision_no'], res['decision_no'])
        self.assertTrue(any('تمت الموافقة' in n['title'] for n in t.ok('GET', '/api/notifications')['notifications']))

        # 18: كل الإجراءات في سجل العمليات، ولا يمكن حذفه أو تعديله
        actions = [x['action'] for x in a.ok('GET', f'/api/requests/{rid}')['events']]
        for expected in ('create', 'upload', 'submit', 'start_review', 'add_note', 'request_completion', 'resubmit',
                         'prelim_approve', 'refer', 'approve', 'issue_decision'):
            self.assertIn(expected, actions)
        db = sqlite3.connect(server.DB_PATH)
        with self.assertRaises(sqlite3.DatabaseError):
            db.execute('DELETE FROM audit_logs')
        with self.assertRaises(sqlite3.DatabaseError):
            db.execute("UPDATE audit_logs SET note='x'")
        db.close()

        # 19: يظهر في لوحة المؤشرات والتقارير
        adm = self.client('admin')
        stats = adm.ok('GET', '/api/stats')
        self.assertGreaterEqual(stats['kpis']['approved'], 1)
        rep = adm.ok('GET', '/api/reports?kind=approved')
        self.assertIn(no, [row[0] for row in rep['rows']])
        status, csv_bytes = adm.call('GET', '/api/reports?kind=approved&format=csv')
        self.assertEqual(status, 200)
        self.assertIn(no, csv_bytes.decode('utf-8-sig'))
        self.assertTrue(adm.ok('GET', f'/api/admin/audit?request_no={no}')['logs'])

        # الإغلاق
        e.ok('POST', f'/api/requests/{rid}/actions/close', {})
        self.assertEqual(t.ok('GET', f'/api/requests/{rid}')['request']['status'], 'closed')

    def test_security(self):
        t1, t2 = self.client('teacher1'), self.client('teacher2')
        rid = t1.ok('POST', '/api/requests', {'request_type_id': 1})['id']
        # المعلم لا يرى طلبات غيره
        self.assertEqual(t2.call('GET', f'/api/requests/{rid}')[0], 404)
        self.assertNotIn(rid, [r['id'] for r in t2.ok('GET', '/api/requests')['requests']])
        # الموظف لا يرى المسودات
        self.assertEqual(self.client('employee1').call('GET', f'/api/requests/{rid}')[0], 404)
        # المعلم لا يصل لوظائف الموظف والإدارة
        self.assertEqual(t1.call('GET', '/api/admin/users')[0], 403)
        self.assertEqual(t1.call('GET', '/api/reports')[0], 403)
        # بدون تسجيل دخول
        self.assertEqual(self.client().call('GET', '/api/requests')[0], 401)
        # CSRF: طلب تعديل بدون الترويسة المخصصة
        self.assertEqual(t1.call('PUT', f'/api/requests/{rid}', {'details': {}}, csrf=False)[0], 403)
        # المعلم لا يعدل بياناته المقفلة (الاسم/الرقم الوظيفي)
        t1.ok('PUT', f'/api/requests/{rid}', {'details': {'t_name': 'اسم مزيف', 't_employee_no': 'X'}})
        d = t1.ok('GET', f'/api/requests/{rid}')['details']
        self.assertEqual((d['t_name'], d['t_employee_no']), ('معلم تجريبي أول', 'EMP-10001'))
        # قفل الدخول بعد 5 محاولات خاطئة
        c = self.client()
        for _ in range(5):
            self.assertEqual(c.call('POST', '/api/login', {'username': 'teacher3', 'password': 'wrong'})[0], 401)
        self.assertEqual(c.call('POST', '/api/login', {'username': 'teacher3', 'password': 'Demo@1234'})[0], 429)
        server.FAILS.clear()

    def test_reject_requires_reason_and_notifies(self):
        t = self.client('teacher2')
        rid, _ = self.new_complete_request(t)
        t.ok('POST', f'/api/requests/{rid}/actions/submit', {'declaration': True})
        e = self.client('employee1')
        e.ok('POST', f'/api/requests/{rid}/actions/start_review', {})
        e.ok('POST', f'/api/requests/{rid}/actions/prelim_approve', {'checklist': {k: True for k, _ in server.CHECKLIST}})
        e.ok('POST', f'/api/requests/{rid}/actions/refer', {})
        a = self.client('approver1')
        a.ok('POST', f'/api/requests/{rid}/actions/reject', {'note': 'الفترة تتعارض مع الجدول المدرسي'})
        d = t.ok('GET', f'/api/requests/{rid}')
        self.assertEqual(d['request']['status'], 'rejected')
        self.assertIn('الفترة تتعارض', json.dumps(d['comments'], ensure_ascii=False))

    def test_frontend_served(self):
        with urllib.request.urlopen(self.base + '/') as r:
            html = r.read().decode()
            self.assertIn('dir="rtl"', html)
            self.assertIn("script-src 'self'", r.headers['Content-Security-Policy'])


if __name__ == '__main__':
    unittest.main()
