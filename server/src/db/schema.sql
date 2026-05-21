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
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_login_at     TEXT
);

-- ── Investments ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS investments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT    NOT NULL CHECK(type IN ('crypto','stock','etf','pension','education','other')),
  name         TEXT    NOT NULL,
  ticker       TEXT,
  isin         TEXT,
  broker       TEXT,
  etf_kind     TEXT    CHECK(etf_kind IN ('accumulating','distributing') OR etf_kind IS NULL),
  liquid_date  TEXT,
  closed_at    TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_investments_user_type ON investments(user_id, type);

-- ── Crypto wallets ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crypto_wallets (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name    TEXT    NOT NULL
);

-- ── Transactions ──────────────────────────────────────────────────────────────
-- kind=UPDATE: Pension/Education/Other manual balance snapshots.
--   total_amount = new balance (NOT a delta). realized_pl = delta vs previous UPDATE.
-- kind=BUY/SELL/DIV: standard market transactions for Crypto/Stock/ETF.
CREATE TABLE IF NOT EXISTS transactions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  investment_id   INTEGER NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
  kind            TEXT    NOT NULL CHECK(kind IN ('BUY','SELL','DIV','UPDATE')),
  units           REAL,
  price_per_unit  REAL,
  total_amount    REAL    NOT NULL,
  currency        TEXT    NOT NULL CHECK(currency IN ('NIS','USD')),
  wallet_id       INTEGER REFERENCES crypto_wallets(id) ON DELETE SET NULL,
  occurred_at     TEXT    NOT NULL,
  notes           TEXT,
  realized_pl     REAL,
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
