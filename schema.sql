-- Schema do banco de finanças (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,          -- 'you' | 'partner' (ou nomes de vocês)
  name TEXT NOT NULL
);

INSERT OR IGNORE INTO people (id, name) VALUES ('you', 'Você');
INSERT OR IGNORE INTO people (id, name) VALUES ('partner', 'Namorado');

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,          -- accountId da Pluggy
  item_id TEXT NOT NULL,        -- itemId da Pluggy (a conexão com o banco)
  person_id TEXT NOT NULL REFERENCES people(id),
  name TEXT NOT NULL,           -- ex: "Nubank Cartão", "Inter Conta"
  type TEXT NOT NULL,           -- BANK | CREDIT
  subtype TEXT,
  balance REAL,
  credit_limit REAL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,          -- transactionId da Pluggy
  account_id TEXT NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL,           -- ISO date
  description TEXT NOT NULL,
  amount REAL NOT NULL,         -- positivo = gasto/débito, negativo = crédito/pagamento (ver worker)
  currency TEXT DEFAULT 'BRL',
  pluggy_category TEXT,         -- categoria vinda da Pluggy (se disponível)
  category TEXT,                -- categoria final usada no dashboard (override manual tem prioridade)
  category_override INTEGER DEFAULT 0, -- 1 se foi categorizado manualmente
  status TEXT,                  -- PENDING | POSTED
  installment_number INTEGER,
  total_installments INTEGER,
  is_recurring INTEGER DEFAULT 0,
  merchant_name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(category);

CREATE TABLE IF NOT EXISTS categories (
  name TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'variavel', -- 'fixa' | 'variavel'
  monthly_budget REAL,          -- meta mensal opcional
  color TEXT                    -- cor hex usada no dashboard
);

INSERT OR IGNORE INTO categories (name, type, color) VALUES
  ('Moradia', 'fixa', '#5B8C7B'),
  ('Mercado', 'variavel', '#D4A24C'),
  ('Alimentação', 'variavel', '#E0B84C'),
  ('Transporte', 'variavel', '#7B92C9'),
  ('Contas de casa', 'fixa', '#C97B5F'),
  ('Assinaturas', 'fixa', '#9B7BC9'),
  ('Cartão / Dívida', 'fixa', '#C95F5F'),
  ('Saúde', 'variavel', '#5FA8A0'),
  ('Lazer', 'variavel', '#D48CB8'),
  ('Transferências', 'variavel', '#6FA8DC'),
  ('Outros', 'variavel', '#8A8F99');

-- Guarda o cursor/estado de sync de cada conta pra sync incremental
CREATE TABLE IF NOT EXISTS sync_state (
  account_id TEXT PRIMARY KEY,
  last_synced_at TEXT,
  last_transaction_date TEXT
);
