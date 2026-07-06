-- 011: RSU grants + vesting schedules.
--   * investments: new type 'rsu' (CHECK constraint → table rebuild, same
--     pattern as 010). Each grant is one investment row so RSUs aggregate into
--     the portfolio like any market asset.
--   * rsu_grants: grant metadata, 1:1 with its investments row.
--   * rsu_vesting_events: discrete vesting schedule. When an event vests it is
--     materialized as a BUY transaction (units × fmv_at_vest = FIFO cost
--     basis) and linked via transaction_id, so valuation, FX, and realized
--     P/L on sale all reuse the existing engines.
-- Reversal: drop rsu_vesting_events + rsu_grants, delete investments where
-- type='rsu' (cascades their transactions), and rebuild investments without
-- 'rsu' in the CHECK.

PRAGMA foreign_keys=OFF;

BEGIN;

-- Re-run safety: clear any temp table left by a crashed earlier attempt.
DROP TABLE IF EXISTS investments_new;

CREATE TABLE investments_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type             TEXT    NOT NULL CHECK(type IN ('crypto','stock','etf','rsu','pension','gemel','education','money_market','other')),
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
   expected_annual_return, monthly_contribution,
   fund_id, fund_track, fee_deposit_pct, fee_balance_pct, created_at)
SELECT
   id, user_id, type, name, ticker, isin, broker, etf_kind, liquid_date,
   closed_at, deleted_at, monthly_deposit, deposit_currency,
   expected_annual_return, monthly_contribution,
   fund_id, fund_track, fee_deposit_pct, fee_balance_pct, created_at
FROM investments;

DROP TABLE investments;
ALTER TABLE investments_new RENAME TO investments;
CREATE INDEX IF NOT EXISTS idx_investments_user_type ON investments(user_id, type);

CREATE TABLE IF NOT EXISTS rsu_grants (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  investment_id INTEGER NOT NULL UNIQUE REFERENCES investments(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol        TEXT    NOT NULL,
  company_name  TEXT,
  grant_date    TEXT    NOT NULL,
  total_units   REAL    NOT NULL CHECK(total_units > 0),
  -- FMV at grant, reference only (not cost basis)
  grant_price   REAL,
  currency      TEXT    NOT NULL DEFAULT 'USD' CHECK(currency IN ('NIS','USD')),
  notes         TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS rsu_vesting_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id       INTEGER NOT NULL REFERENCES rsu_grants(id) ON DELETE CASCADE,
  vest_date      TEXT    NOT NULL,
  units          REAL    NOT NULL CHECK(units > 0),
  -- Cost basis per unit at vest. NULL until fetched (historical close) or
  -- entered manually; the event can't materialize into a BUY lot without it.
  fmv_at_vest    REAL,
  status         TEXT    NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','vested')),
  -- The BUY transaction this event materialized into (NULL while scheduled).
  transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_rsu_events_grant_date ON rsu_vesting_events(grant_id, vest_date);

COMMIT;

PRAGMA foreign_keys=ON;
