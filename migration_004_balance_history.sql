CREATE TABLE IF NOT EXISTS balance_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  balance REAL,
  recorded_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_balance_history_account ON balance_history(account_id, recorded_at);
INSERT OR IGNORE INTO categories (name, type, color) VALUES ('Investimentos', 'variavel', '#4CA6A8');