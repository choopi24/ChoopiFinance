-- Expand transactions.kind CHECK constraint to include 'DEPOSIT'.
-- DEPOSIT transactions record actual cash put into education / other funds,
-- separate from UPDATE snapshots (which record current value, not a deposit).
--
-- SQLite does not support ALTER TABLE … MODIFY CONSTRAINT, so we use the
-- standard table-recreation pattern.  Foreign-key enforcement is disabled for
-- the duration of this migration to allow the DROP + RENAME.

PRAGMA foreign_keys = OFF;

-- Clean up any leftover temp table from a previously interrupted migration run.
DROP TABLE IF EXISTS __tx_deposit_tmp__;

-- Note: wallet_id (dead column, dropped for good in 010) is intentionally NOT
-- carried over — current fresh installs no longer have it in schema.sql, and
-- upgrading DBs lose nothing (the column was never written by any code path).
CREATE TABLE __tx_deposit_tmp__ (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  investment_id   INTEGER NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
  kind            TEXT    NOT NULL CHECK(kind IN ('BUY','SELL','DIV','UPDATE','DEPOSIT')),
  units           REAL,
  price_per_unit  REAL,
  total_amount    REAL    NOT NULL,
  currency        TEXT    NOT NULL CHECK(currency IN ('NIS','USD')),
  occurred_at     TEXT    NOT NULL,
  notes           TEXT,
  realized_pl     REAL,
  fx_rate_at_buy  REAL,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

INSERT INTO __tx_deposit_tmp__
  (id, investment_id, user_id, kind, units, price_per_unit, total_amount,
   currency, occurred_at, notes, realized_pl, fx_rate_at_buy, created_at)
  SELECT id, investment_id, user_id, kind, units, price_per_unit, total_amount,
         currency, occurred_at, notes, realized_pl, fx_rate_at_buy, created_at
  FROM transactions;

DROP TABLE transactions;

ALTER TABLE __tx_deposit_tmp__ RENAME TO transactions;

CREATE INDEX IF NOT EXISTS idx_transactions_investment_occurred ON transactions(investment_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);

PRAGMA foreign_keys = ON;
