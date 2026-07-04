-- Choopi Finance — SQLite schema
-- All monetary values stored in ORIGINAL currency (no forced conversion at write)

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  username          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash     TEXT    NOT NULL,
  display_currency  TEXT    NOT NULL DEFAULT 'NIS' CHECK(display_currency IN ('NIS','USD')),
  fx_override       REAL,
  theme             TEXT    NOT NULL DEFAULT 'light',
  display_name      TEXT,
  stay_signed_in    INTEGER NOT NULL DEFAULT 0,
  show_on_lock_screen INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_login_at     TEXT
);

-- ── Investments ───────────────────────────────────────────────────────────────
-- Israeli regulated funds: type pension (קרן פנסיה), gemel (קופת גמל),
-- education (קרן השתלמות), money_market (קרן כספית). fund_id/fund_track link
-- to the regulator's Gemel-Net/Pensia-Net datasets; fee_deposit_pct and
-- fee_balance_pct are the personal management fees (% on deposits / % per
-- year on balance).
CREATE TABLE IF NOT EXISTS investments (
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
  -- Contribution model for manual funds
  monthly_deposit  REAL,
  deposit_currency TEXT    NOT NULL DEFAULT 'NIS',
  -- Future-value projection inputs
  expected_annual_return REAL,
  monthly_contribution   REAL,
  -- Israeli fund linkage + fees
  fund_id          INTEGER,
  fund_track       TEXT,
  fee_deposit_pct  REAL,
  fee_balance_pct  REAL,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_investments_user_type ON investments(user_id, type);

-- ── Transactions ──────────────────────────────────────────────────────────────
-- kind=UPDATE : Manual-fund balance snapshot (total_amount = current balance, not a delta).
-- kind=DEPOSIT: Actual cash contribution to a manual fund (for net-deposited P/L model).
-- kind=BUY/SELL/DIV: Market transactions for Crypto/Stock/ETF.
CREATE TABLE IF NOT EXISTS transactions (
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

CREATE INDEX IF NOT EXISTS idx_transactions_investment_occurred ON transactions(investment_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);

-- ── Portfolio snapshots ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total_value_nis         REAL    NOT NULL,
  total_value_usd         REAL    NOT NULL,
  total_net_deposited_nis REAL    NOT NULL,
  total_net_deposited_usd REAL    NOT NULL,
  snapshot_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_snapshots_user_at ON portfolio_snapshots(user_id, snapshot_at);

-- ── FX cache ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fx_cache (
  pair        TEXT PRIMARY KEY,
  rate        REAL NOT NULL,
  fetched_at  TEXT NOT NULL
);

-- ── Price cache ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_cache (
  symbol      TEXT NOT NULL,
  asset_type  TEXT NOT NULL,
  currency    TEXT NOT NULL,
  price       REAL NOT NULL,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (symbol, asset_type)
);

-- ── Israeli fund cache ────────────────────────────────────────────────────────
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
