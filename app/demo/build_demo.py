#!/usr/bin/env python3
"""يبني نسخة العرض التجريبية: صفحة HTML واحدة تعمل بلا خادم (الواجهة + محاكٍ لـ /api داخل المتصفح).

الاستخدام: python3 demo/build_demo.py [مسار الملف الناتج]   (الافتراضي: demo/ptms-demo.html)
البيانات الأولية والثوابت تُؤخذ من server.py نفسه حتى تبقى النسخة مطابقة للنظام.
"""
import base64
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
APP = HERE.parent
tmp = tempfile.mkdtemp()
os.environ.update(PTMS_DB=f'{tmp}/demo.db', PTMS_UPLOADS=f'{tmp}/uploads', PTMS_DEMO='1')
sys.path.insert(0, str(APP))
import server  # noqa: E402

server.init_db()
c = server.connect()
TABLES = ['schools', 'users', 'teachers', 'request_types', 'document_types', 'requests', 'request_details',
          'documents', 'comments', 'workflow', 'approvals', 'notifications', 'audit_logs']
seed = {t: [dict(r) for r in c.execute(f'SELECT * FROM {t}')] for t in TABLES}
for u in seed['users']:
    del u['password_hash']   # كلمة مرور العرض ثابتة في المحاكي
const = dict(ORG=server.ORG_NAME, STATUS_AR=server.STATUS_AR, ROLE_AR=server.ROLE_AR, IN_PROGRESS=server.IN_PROGRESS,
             COMPLETION_REASONS=server.COMPLETION_REASONS, CHECKLIST=server.CHECKLIST, TEACHER_FIELDS=server.TEACHER_FIELDS,
             STUDY=server.STUDY, NOTIFY=server.NOTIFY, REPORTS=server.REPORTS, ROW_COLS=server.ROW_COLS)


def js_json(obj):
    return json.dumps(obj, ensure_ascii=False).replace('</', '<\\/')


logo = 'data:image/svg+xml;base64,' + base64.b64encode((APP / 'public/logo.svg').read_bytes()).decode()
css = (APP / 'public/style.css').read_text(encoding='utf-8').replace('/logo.svg', logo)
app_js = (APP / 'public/app.js').read_text(encoding='utf-8').replace('/logo.svg', logo)
mock = (HERE / 'mock_api.js').read_text(encoding='utf-8')
# التنزيل غير مسموح داخل إطار العرض: نحذف رابط تصدير Excel من نسخة العرض
excel = '<a class="btn success" href="/api/reports?${q}&format=csv" download>تصدير Excel</a>'
assert app_js.count(excel) == 1
app_js = app_js.replace(excel, '')
assert '</script' not in app_js + mock

page = f'''<title>نظام التفرغ الجزئي</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&display=swap">
<style>
{css}
/* نسخة العرض: الطباعة والتنزيل غير متاحين داخل إطار العرض */
[data-act=print], a[download] {{ display: none !important; }}
.demo-bar {{ display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: .4rem .8rem; padding: .45rem 16px;
  background: var(--warn-soft); color: var(--ink); border-bottom: 1px solid #f5cf9b; font-size: .85rem; text-align: center; }}
.demo-bar button {{ background: none; border: 1px solid var(--warn); color: var(--warn); border-radius: 7px; padding: .15rem .6rem; font: inherit; cursor: pointer; }}
</style>
<div class="demo-bar" dir="rtl" lang="ar"><span><b>نسخة عرض تجريبية</b> — بيانات وهمية تُحفظ في متصفحك فقط. كلمة المرور لجميع الحسابات: <code>Demo@1234</code></span>
<button type="button" id="demo-reset">إعادة ضبط بيانات العرض</button></div>
<div id="app" dir="rtl" lang="ar"><div class="boot">جارٍ التحميل…</div></div>
<div id="toasts" aria-live="polite" dir="rtl"></div>
<div id="modal-root" dir="rtl" lang="ar"></div>
<script>
document.documentElement.lang = 'ar';
document.documentElement.dir = 'rtl';
window.PTMS_CONST = {js_json(const)};
window.PTMS_SEED = {js_json(seed)};
</script>
<script>
{mock}
document.getElementById('demo-reset').addEventListener('click', e => {{
  if (e.target.dataset.armed) return window.PTMS_DEMO.reset();
  e.target.dataset.armed = '1';
  e.target.textContent = 'اضغط مرة أخرى للتأكيد';
  setTimeout(() => {{ delete e.target.dataset.armed; e.target.textContent = 'إعادة ضبط بيانات العرض'; }}, 4000);
}});
</script>
<script>
{app_js}
</script>
'''
out = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / 'ptms-demo.html'
out.write_text(page, encoding='utf-8')
print(f'{out} ({len(page.encode()) // 1024} KB)')
