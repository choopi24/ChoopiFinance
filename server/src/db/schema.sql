-- Choopi Finance — schema v2 (manual-entry only, no external data sources)
--
-- Design principles:
--   * Every price, balance and FX rate is entered by hand and stored as a DATED
--     series. Nothing is a "cache" of a live feed — the newest value on-or-before
--     a date is carried forward, so any historical date can be valued.
--   * One ledger (`entries`) holds every money/unit event, discriminated by kind.
--   * The core question — how much is MY money / EARNINGS / FEES — is answered by
--     the identity:  value = principal + gross_earnings − fees
--     (see services/valuation.ts). Fees are recorded explicitly because a balance
--     statement already has them deducted; without fee rows they hide inside
--     earnings and both numbers are understated.
--   * Money is stored in each account's OWN currency. Conversion to a display
--     currency happens at read time using fx_rates.

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  username            TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash       TEXT    NOT NULL,
  display_currency    TEXT    NOT NULL DEFAULT 'ILS' CHECK(display_currency IN ('ILS','USD')),
  theme               TEXT    NOT NULL DEFAULT 'light',
  display_name        TEXT,
  stay_signed_in      INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_login_at       TEXT
);

-- ── Accounts ──────────────────────────────────────────────────────────────────
-- valuation_mode drives how value is derived:
--   'market'  → quantity held × latest manually-entered price for `symbol`
--   'balance' → latest manually-entered balance snapshot
-- funding_mode drives how principal arrives:
--   'manual'  → ad-hoc deposits whenever you make them
--   'salary'  → fixed monthly deposits auto-generated from deposit_rules
--   'passive' → no deposits; value just moves
CREATE TABLE IF NOT EXISTS accounts (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                   TEXT    NOT NULL,
  kind                   TEXT    NOT NULL CHECK(kind IN (
                             'stock','etf','crypto','rsu',
                             'keren_hishtalmut','pension','gemel_lehashkaa','other')),
  valuation_mode         TEXT    NOT NULL CHECK(valuation_mode IN ('market','balance')),
  funding_mode           TEXT    NOT NULL DEFAULT 'manual' CHECK(funding_mode IN ('manual','salary','passive')),
  currency               TEXT    NOT NULL DEFAULT 'ILS' CHECK(currency IN ('ILS','USD')),
  -- Market accounts only: the key into price_points. Free text (your own label).
  symbol                 TEXT,
  -- Fee accrual inputs (hybrid model): estimates are generated from these between
  -- statements, then superseded when you enter a real fee for a period.
  fee_deposit_pct        REAL,   -- % taken off each deposit (דמי ניהול מהפקדה)
  fee_balance_annual_pct REAL,   -- % per year on balance (דמי ניהול מצבירה)
  notes                  TEXT,
  closed_at              TEXT,
  archived_at            TEXT,
  created_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  -- A market account needs a symbol to be priceable.
  CHECK (valuation_mode <> 'market' OR symbol IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id, archived_at);

-- ── Ledger ────────────────────────────────────────────────────────────────────
-- kind semantics (all amounts in the account's currency):
--   deposit    → principal IN            (amount)
--   withdrawal → principal OUT           (amount)
--   buy        → units acquired          (quantity, price_per_unit; amount = qty × price)
--   sell       → units disposed          (quantity, price_per_unit)
--   balance    → statement snapshot      (amount = total value on that date)
--   fee        → management fee charged  (amount)
-- occurred_on is a DATE (YYYY-MM-DD): day granularity is the right resolution
-- for hand-entered records and makes carry-forward lookups unambiguous.
CREATE TABLE IF NOT EXISTS entries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id     INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT    NOT NULL CHECK(kind IN ('deposit','withdrawal','buy','sell','balance','fee')),
  occurred_on    TEXT    NOT NULL,
  amount         REAL,
  quantity       REAL,
  price_per_unit REAL,
  -- Provenance: 'manual' (you typed it), 'rule' (recurring deposit), 'vest'
  -- (RSU vesting event), 'accrual' (estimated fee).
  source         TEXT    NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','rule','vest','accrual')),
  rule_id        INTEGER REFERENCES deposit_rules(id) ON DELETE SET NULL,
  -- Fee rows only:
  fee_kind       TEXT    CHECK(fee_kind IS NULL OR fee_kind IN ('deposit','balance','other')),
  is_estimate    INTEGER NOT NULL DEFAULT 0,
  period_start   TEXT,   -- fee rows: period this fee covers (drives estimate true-up)
  period_end     TEXT,
  note           TEXT,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  -- Shape guards so a row can't be half-specified.
  CHECK (kind NOT IN ('buy','sell') OR (quantity IS NOT NULL AND quantity > 0)),
  CHECK (kind IN ('buy','sell') OR (amount IS NOT NULL AND amount >= 0))
);

CREATE INDEX IF NOT EXISTS idx_entries_account_date ON entries(account_id, occurred_on);
CREATE INDEX IF NOT EXISTS idx_entries_user_date ON entries(user_id, occurred_on);
-- A recurring rule can produce at most one deposit per date — makes generation
-- idempotent at the DB level, not just in application logic.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entries_rule_date ON entries(rule_id, occurred_on)
  WHERE rule_id IS NOT NULL;

-- ── Manual price series (market accounts) ──────────────────────────────────────
-- One row per (symbol, date). Value at date t uses the newest row with as_of <= t.
CREATE TABLE IF NOT EXISTS price_points (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol     TEXT    NOT NULL,
  price      REAL    NOT NULL CHECK(price >= 0),
  currency   TEXT    NOT NULL CHECK(currency IN ('ILS','USD')),
  as_of      TEXT    NOT NULL,
  note       TEXT,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (user_id, symbol, as_of)
);

CREATE INDEX IF NOT EXISTS idx_price_points_lookup ON price_points(user_id, symbol, as_of);

-- ── Manual FX series ──────────────────────────────────────────────────────────
-- rate = how many `quote` units per 1 `base` (e.g. base USD, quote ILS, rate 3.7).
CREATE TABLE IF NOT EXISTS fx_rates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  base       TEXT    NOT NULL CHECK(base IN ('ILS','USD')),
  quote      TEXT    NOT NULL CHECK(quote IN ('ILS','USD')),
  rate       REAL    NOT NULL CHECK(rate > 0),
  as_of      TEXT    NOT NULL,
  note       TEXT,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (user_id, base, quote, as_of),
  CHECK (base <> quote)
);

CREATE INDEX IF NOT EXISTS idx_fx_rates_lookup ON fx_rates(user_id, base, quote, as_of);

-- ── Recurring deposit rules (salary-funded accounts) ──────────────────────────
CREATE TABLE IF NOT EXISTS deposit_rules (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id        INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount            REAL    NOT NULL CHECK(amount > 0),
  currency          TEXT    NOT NULL CHECK(currency IN ('ILS','USD')),
  -- Day of month the deposit lands; clamped to the last day of shorter months.
  day_of_month      INTEGER NOT NULL CHECK(day_of_month BETWEEN 1 AND 31),
  start_on          TEXT    NOT NULL,
  end_on            TEXT,
  active            INTEGER NOT NULL DEFAULT 1,
  note              TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_deposit_rules_account ON deposit_rules(account_id, active);

-- ── RSU grants + vesting ──────────────────────────────────────────────────────
-- A grant belongs to a market account (kind='rsu'). A vesting event materializes
-- into a 'buy' entry (source='vest') at fmv_at_vest — that FMV is your cost basis
-- (you're taxed on it at vest), so vested units count as principal.
CREATE TABLE IF NOT EXISTS rsu_grants (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grant_date   TEXT    NOT NULL,
  total_units  REAL    NOT NULL CHECK(total_units > 0),
  grant_price  REAL,   -- FMV at grant, reference only
  notes        TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_rsu_grants_account ON rsu_grants(account_id);

CREATE TABLE IF NOT EXISTS rsu_vesting_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id    INTEGER NOT NULL REFERENCES rsu_grants(id) ON DELETE CASCADE,
  vest_on     TEXT    NOT NULL,
  units       REAL    NOT NULL CHECK(units > 0),
  -- Cost basis per unit at vest. NULL until you enter it; a vest can't become a
  -- lot without it (no external source can fill it in for you).
  fmv_at_vest REAL,
  status      TEXT    NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','vested')),
  entry_id    INTEGER REFERENCES entries(id) ON DELETE SET NULL,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_rsu_events_grant ON rsu_vesting_events(grant_id, vest_on);

-- ── Portfolio snapshots (history chart) ───────────────────────────────────────
-- Stored in the user's display currency at capture time, with the decomposition
-- so the stacked principal/earnings/fees chart needs no recomputation.
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  currency       TEXT    NOT NULL,
  value          REAL    NOT NULL,
  principal      REAL    NOT NULL,
  gross_earnings REAL    NOT NULL,
  fees           REAL    NOT NULL,
  snapshot_on    TEXT    NOT NULL,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (user_id, snapshot_on)
);
