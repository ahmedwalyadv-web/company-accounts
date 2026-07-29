-- ==========================================================
-- نظام الحسابات الداخلي للشركة - هيكل قاعدة البيانات (PostgreSQL)
-- ==========================================================

CREATE TABLE IF NOT EXISTS roles (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  permissions TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS company_settings (
  id INTEGER PRIMARY KEY DEFAULT 1,
  name TEXT NOT NULL DEFAULT 'اسم الشركة',
  logo_data TEXT,
  currency TEXT NOT NULL DEFAULT 'ج.م',
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT single_row CHECK (id = 1)
);

-- شجرة الحسابات
CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  code TEXT,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  type TEXT NOT NULL DEFAULT 'other', -- asset, liability, equity, revenue, expense, other
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- أسباب الصرف (قابلة للتعديل من الإعدادات)
CREATE TABLE IF NOT EXISTS expense_reasons (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

-- حركة الخزنة (تُسجَّل تلقائيًا من كل عملية)
CREATE TABLE IF NOT EXISTS treasury_ledger (
  id SERIAL PRIMARY KEY,
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  direction TEXT NOT NULL, -- in / out
  amount NUMERIC(14,2) NOT NULL,
  source_module TEXT NOT NULL, -- purchases/expenses/sales/receipts/adjustment
  source_id INTEGER,
  description TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchases (
  id SERIAL PRIMARY KEY,
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  party TEXT NOT NULL, -- المورد
  reason TEXT,
  amount NUMERIC(14,2) NOT NULL,
  account_id INTEGER REFERENCES accounts(id),
  description TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  party TEXT NOT NULL, -- المستلم
  reason TEXT NOT NULL, -- سبب الصرف: مرتبات / مصروفات تشغيل ...
  amount NUMERIC(14,2) NOT NULL,
  account_id INTEGER REFERENCES accounts(id),
  description TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  party TEXT NOT NULL, -- العميل
  reason TEXT,
  amount NUMERIC(14,2) NOT NULL,
  account_id INTEGER REFERENCES accounts(id),
  description TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS receipts (
  id SERIAL PRIMARY KEY,
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  party TEXT NOT NULL, -- المستلم منه / الدافع
  reason TEXT,
  amount NUMERIC(14,2) NOT NULL,
  account_id INTEGER REFERENCES accounts(id),
  description TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "session" (
  sid VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
)
WITH (OIDS=FALSE);
CREATE INDEX IF NOT EXISTS IDX_session_expire ON "session" ("expire");
