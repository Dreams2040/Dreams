-- نظام إدارة طلبات التفرغ الجزئي للمعلمين — مخطط قاعدة البيانات (SQLite)
-- التواريخ نصوص ISO-8601 بتوقيت UTC.

PRAGMA foreign_keys = ON;

-- المدارس
CREATE TABLE IF NOT EXISTS schools (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  governorate  TEXT NOT NULL,           -- المحافظة
  wilayat      TEXT NOT NULL,           -- الولاية
  directorate  TEXT NOT NULL,           -- المديرية التعليمية
  active       INTEGER NOT NULL DEFAULT 1
);

-- المستخدمون (كل الأدوار)
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('teacher','employee','approver','admin')),
  email          TEXT,
  phone          TEXT,
  governorate    TEXT,                  -- نطاق الموظف/المعتمد؛ NULL = كل المحافظات
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- بيانات المعلم الوظيفية (1:1 مع users)
CREATE TABLE IF NOT EXISTS teachers (
  user_id           INTEGER PRIMARY KEY REFERENCES users(id),
  employee_no       TEXT NOT NULL UNIQUE,   -- الرقم الوظيفي / رقم الملف
  civil_id          TEXT NOT NULL UNIQUE,   -- الرقم المدني
  school_id         INTEGER REFERENCES schools(id),
  job_title         TEXT,
  subject           TEXT,
  grade             TEXT,
  appointment_date  TEXT
);

-- أنواع الطلبات (تفرغ جزئي، ولاحقًا: نقل، ندب، تكليف...)
-- fields_json يصف حقول "بيانات الطلب" فتُبنى الواجهة والتحقق منها تلقائيًا.
CREATE TABLE IF NOT EXISTS request_types (
  id           INTEGER PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,     -- بادئة رقم الطلب: PT
  name         TEXT NOT NULL,
  fields_json  TEXT NOT NULL DEFAULT '[]',
  active       INTEGER NOT NULL DEFAULT 1
);

-- المستندات المطلوبة لكل نوع طلب
CREATE TABLE IF NOT EXISTS document_types (
  id               INTEGER PRIMARY KEY,
  request_type_id  INTEGER NOT NULL REFERENCES request_types(id),
  name             TEXT NOT NULL,
  hint             TEXT,
  required         INTEGER NOT NULL DEFAULT 1,
  sort             INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1
);

-- الطلبات
CREATE TABLE IF NOT EXISTS requests (
  id               INTEGER PRIMARY KEY,
  request_no       TEXT UNIQUE,          -- PT-2026-000001، يُولَّد عند أول إرسال
  request_type_id  INTEGER NOT NULL REFERENCES request_types(id),
  teacher_id       INTEGER NOT NULL REFERENCES users(id),
  school_id        INTEGER REFERENCES schools(id),
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','submitted','under_review','needs_completion',
                                     'resubmitted','approved','rejected','closed')),
  stage            TEXT NOT NULL DEFAULT 'teacher'
                   CHECK (stage IN ('teacher','employee','approver','none')),
  prelim_approved  INTEGER NOT NULL DEFAULT 0,
  outcome          TEXT CHECK (outcome IN ('approved','rejected')),   -- نتيجة القرار النهائي
  checklist_json   TEXT,
  decision_no      TEXT UNIQUE,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at     TEXT,
  decided_at       TEXT,
  closed_at        TEXT,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_requests_teacher ON requests(teacher_id);
CREATE INDEX IF NOT EXISTS idx_requests_status  ON requests(status, stage);

-- تفاصيل الطلب (مفتاح/قيمة) — تسمح بأنواع طلبات جديدة دون تعديل المخطط
CREATE TABLE IF NOT EXISTS request_details (
  request_id  INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  field       TEXT NOT NULL,
  value       TEXT,
  PRIMARY KEY (request_id, field)
);

-- المستندات المرفوعة (الملف نفسه خارج مجلد الواجهة باسم عشوائي)
CREATE TABLE IF NOT EXISTS documents (
  id             INTEGER PRIMARY KEY,
  request_id     INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  doc_type_id    INTEGER REFERENCES document_types(id),
  original_name  TEXT NOT NULL,
  stored_name    TEXT NOT NULL UNIQUE,
  mime           TEXT NOT NULL,
  size           INTEGER NOT NULL,
  uploaded_by    INTEGER NOT NULL REFERENCES users(id),
  uploaded_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- الملاحظات (داخلية للموظفين، أو ظاهرة للمعلم: طلب استكمال / سبب رفض)
CREATE TABLE IF NOT EXISTS comments (
  id            INTEGER PRIMARY KEY,
  request_id    INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL CHECK (kind IN ('note','completion','rejection','decision')),
  reasons_json  TEXT,
  body          TEXT NOT NULL,
  internal      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- مراحل سير العمل: كل صف انتقال مسموح (الحالة/المرحلة + الإجراء + الدور → الحالة/المرحلة التالية)
CREATE TABLE IF NOT EXISTS workflow (
  id           INTEGER PRIMARY KEY,
  from_status  TEXT NOT NULL,
  from_stage   TEXT NOT NULL,
  action       TEXT NOT NULL,
  role         TEXT NOT NULL,
  to_status    TEXT NOT NULL,
  to_stage     TEXT NOT NULL,
  label        TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  UNIQUE (from_status, from_stage, action, role)
);

-- قرارات الاعتماد (مبدئي من الموظف، نهائي من المعتمد)
CREATE TABLE IF NOT EXISTS approvals (
  id          INTEGER PRIMARY KEY,
  request_id  INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  level       TEXT NOT NULL CHECK (level IN ('preliminary','final')),
  decision    TEXT NOT NULL CHECK (decision IN ('approved','rejected','returned')),
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- الإشعارات داخل النظام
CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  request_id  INTEGER REFERENCES requests(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  body        TEXT,
  is_read     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

-- سجل العمليات: إضافة فقط، لا تعديل ولا حذف (مفروض بالمشغّلات أدناه)
CREATE TABLE IF NOT EXISTS audit_logs (
  id                  INTEGER PRIMARY KEY,
  request_id          INTEGER REFERENCES requests(id),
  user_id             INTEGER REFERENCES users(id),
  action              TEXT NOT NULL,
  label               TEXT NOT NULL,
  note                TEXT,
  visible_to_teacher  INTEGER NOT NULL DEFAULT 1,
  ip                  TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_logs(request_id);

CREATE TRIGGER IF NOT EXISTS audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_logs_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;

-- جلسات الدخول (يُخزَّن تجزئة الرمز فقط)
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  expires_at  TEXT NOT NULL
);
