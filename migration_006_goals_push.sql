-- Metas de gasto (usa a coluna categories.monthly_budget, que já existe no schema.sql)
-- e infraestrutura de notificações push (fatura perto de vencer, meta estourada).

ALTER TABLE bills ADD COLUMN alerted_due_soon INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  person_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS budget_alerts (
  category TEXT NOT NULL,
  month TEXT NOT NULL,
  alerted_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (category, month)
);
