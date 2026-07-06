-- 010: Israeli regulated funds (קרן פנסיה / קופת גמל / קרן השתלמות / קרן כספית)
--   * investments: new types 'gemel' + 'money_market' (requires table rebuild
--     because the type CHECK constraint can't be altered in place), plus
--     Gemel-Net/Pensia-Net linkage (fund_id, fund_track) and personal
--     management fees (fee_deposit_pct = דמי ניהול מהפקדה, fee_balance_pct =
--     דמי ניהול מצבירה, both as percent per the fund's fee statement).
--   * transactions: drop the dead wallet_id column (crypto_wallets had no CRUD
--     and no rows; wallets live in the investment name/notes).
--   * il_fund_cache: cached monthly rows from the regulator datasets.

PRAGMA foreign_keys=OFF;

BEGIN;

-- Re-run safety: a crash between CREATE and the final COMMIT of an earlier
-- attempt can leave temp tables behind; start clean.
DROP TABLE IF EXISTS investments_new;
DROP TABLE IF EXISTS transactions_new;

CREATE TABLE investments_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type             TEXT    NOT NULL CHECK(type IN ('crypto','stock','etf','pension','gemel','education','money_market','other')),
  name             TEXT    NOT NULL,
  ticker           TEXT,
  isin             TEXT,
  broker           TEXT,
  etf_kind         TEXT    CHECK(etf_kind IN ('accumulating','distributing') OR etf_kind IS NULL),
  liquid_date      TEXT,
  closed_at        TEXT,
  deleted_at       TEXT,
  monthly_deposit  REAL,
  deposit_currency TEXT    NOT NULL DEFAULT 'NIS',
  expected_annual_return REAL,
  monthly_contribution   REAL,
  fund_id          INTEGER,
  fund_track       TEXT,
  fee_deposit_pct  REAL,
  fee_balance_pct  REAL,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

INSERT INTO investments_new
  (id, user_id, type, name, ticker, isin, broker, etf_kind, liquid_date,
   closed_at, deleted_at, monthly_deposit, deposit_currency,
   expected_annual_return, monthly_contribution, created_at)
SELECT
   id, user_id, type, name, ticker, isin, broker, etf_kind, liquid_date,
   closed_at, deleted_at, monthly_deposit, deposit_currency,
   expected_annual_return, monthly_contribution, created_at
FROM investments;

DROP TABLE investments;
ALTER TABLE investments_new RENAME TO investments;
CREATE INDEX IF NOT EXISTS idx_investments_user_type ON investments(user_id, type);

CREATE TABLE transactions_new (
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

INSERT INTO transactions_new
  (id, investment_id, user_id, kind, units, price_per_unit, total_amount,
   currency, occurred_at, notes, realized_pl, fx_rate_at_buy, created_at)
SELECT
   id, investment_id, user_id, kind, units, price_per_unit, total_amount,
   currency, occurred_at, notes, realized_pl, fx_rate_at_buy, created_at
FROM transactions;

DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;
CREATE INDEX IF NOT EXISTS idx_transactions_investment_occurred ON transactions(investment_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);

DROP TABLE IF EXISTS crypto_wallets;

-- Cached monthly rows from data.gov.il (Gemel-Net / Pensia-Net).
-- period is YYYYMM as published in REPORT_PERIOD. Yields are percent (2.31 = +2.31%).
CREATE TABLE IF NOT EXISTS il_fund_cache (
  dataset             TEXT    NOT NULL CHECK(dataset IN ('gemel','pensia')),
  fund_id             INTEGER NOT NULL,
  period              INTEGER NOT NULL,
  fund_name           TEXT,
  fund_classification TEXT,
  monthly_yield       REAL,
  avg_annual_mgmt_fee REAL,
  avg_deposit_fee     REAL,
  fetched_at          TEXT    NOT NULL,
  PRIMARY KEY (dataset, fund_id, period)
);

COMMIT;

PRAGMA foreign_keys=ON;
