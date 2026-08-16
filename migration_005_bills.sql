CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  due_date TEXT,
  total_amount REAL,
  minimum_payment REAL,
  updated_at TEXT
);