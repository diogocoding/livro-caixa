CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  contract_number TEXT,
  loan_type TEXT,
  principal_amount REAL,
  outstanding_balance REAL,
  interest_rate REAL,
  installment_amount REAL,
  number_of_installments INTEGER,
  paid_installments INTEGER,
  updated_at TEXT
);