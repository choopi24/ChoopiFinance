-- ════════════════════════════════════════════════════════════════════════════
-- 001_init — Choopi Finance initial schema
--
-- CONVENTIONS (enforced by CHECK constraints, not just documented):
--   * MONEY is always INTEGER minor units — agorot for ILS, cents for USD.
--     Never REAL: 0.1 + 0.2 != 0.3 in binary floating point, and money must
--     total exactly. Column names carry the `_minor` suffix as a reminder.
--     (Rates and percentages are NOT money and stay REAL: mgmt_fee_*_pct,
--     fx_rates.rate, and unit quantities, which are genuinely fractional.)
--   * DATES are ISO 'YYYY-MM-DD' TEXT, guarded by a GLOB pattern. Text dates in
--     this format sort and compare chronologically, so BETWEEN / <= / ORDER BY
--     all work without conversion.
--   * SIGNS on transactions.amount_minor are enforced per type (see below), so
--     `SUM(amount_minor)` is meaningful without a CASE per type.
--
-- The runner owns the transaction — migration files must NOT contain
-- BEGIN/COMMIT of their own.
-- ════════════════════════════════════════════════════════════════════════════

-- ── settings ────────────────────────────────────────────────────────────────
-- Key/value app config. Single-user app, so no ownership column.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

INSERT INTO settings (key, value) VALUES
  ('display_currency', 'ILS'),
  ('schema_notes',     'money = INTEGER minor units; dates = ISO YYYY-MM-DD');

-- ── users ───────────────────────────────────────────────────────────────────
-- Login only. Deliberately NOT part of the financial model: this is a
-- single-user app, so no table below carries a user_id.
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_login_at TEXT
);

-- ── accounts ────────────────────────────────────────────────────────────────
-- valuation_mode is the primary axis of the whole model:
--   'market'  → worth = units held × latest manually-entered price
--   'balance' → worth = latest manually-entered balance snapshot
-- funding_mode says how money arrives: ad-hoc, from salary via a recurring
-- rule, or not at all (passive).
CREATE TABLE accounts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT    NOT NULL,
  institution          TEXT,
  category             TEXT    NOT NULL CHECK (category IN
                         ('stock','etf','crypto','keren_hishtalmut','pension',
                          'gemel_lehashkaa','rsu','cash')),
  valuation_mode       TEXT    NOT NULL CHECK (valuation_mode IN ('market','balance')),
  currency             TEXT    NOT NULL CHECK (currency IN ('ILS','USD')),
  funding_mode         TEXT    NOT NULL DEFAULT 'manual'
                         CHECK (funding_mode IN ('manual','salary','passive')),
  -- Annual % charged on the accumulated balance (דמי ניהול מצבירה).
  mgmt_fee_balance_pct REAL    CHECK (mgmt_fee_balance_pct IS NULL OR
                                      (mgmt_fee_balance_pct >= 0 AND mgmt_fee_balance_pct <= 100)),
  -- % taken off each deposit (דמי ניהול מהפקדה).
  mgmt_fee_deposit_pct REAL    CHECK (mgmt_fee_deposit_pct IS NULL OR
                                      (mgmt_fee_deposit_pct >= 0 AND mgmt_fee_deposit_pct <= 100)),
  is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  notes                TEXT,
  created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ── holdings ────────────────────────────────────────────────────────────────
-- One row per instrument inside a market-valued account. `symbol` is your own
-- label (no provider validates it) and is the key the price series hangs on.
CREATE TABLE holdings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  symbol       TEXT    NOT NULL,
  display_name TEXT,
  asset_class  TEXT    NOT NULL CHECK (asset_class IN ('stock','etf','crypto')),
  currency     TEXT    NOT NULL CHECK (currency IN ('ILS','USD')),
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (account_id, symbol)
);

-- ── prices ──────────────────────────────────────────────────────────────────
-- MANUAL ENTRY ONLY. A dated series, not a cache: value on any date uses the
-- newest row with date <= that date (carry-forward), so history stays correct.
CREATE TABLE prices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  holding_id  INTEGER NOT NULL REFERENCES holdings(id) ON DELETE CASCADE,
  date        TEXT    NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  price_minor INTEGER NOT NULL CHECK (price_minor >= 0),
  currency    TEXT    NOT NULL CHECK (currency IN ('ILS','USD')),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (holding_id, date)
);

-- ── recurring_rules ─────────────────────────────────────────────────────────
-- Declared before `transactions` so the FK target exists when rows reference it.
-- 'quarterly' and 'annual' are already allowed by the CHECK so adding them
-- later needs code only, not a migration.
CREATE TABLE recurring_rules (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id          INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label               TEXT,
  frequency           TEXT    NOT NULL DEFAULT 'monthly'
                        CHECK (frequency IN ('monthly','quarterly','annual')),
  -- Clamped to the month's real length when generating (31 → 28/29/30).
  day_of_month        INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  amount_minor        INTEGER NOT NULL CHECK (amount_minor > 0),
  currency            TEXT    NOT NULL CHECK (currency IN ('ILS','USD')),
  contribution_part   TEXT    CHECK (contribution_part IS NULL OR contribution_part IN
                          ('employee','employer','severance')),
  start_date          TEXT    NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  end_date            TEXT    CHECK (end_date IS NULL OR end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  auto_generate       INTEGER NOT NULL DEFAULT 1 CHECK (auto_generate IN (0,1)),
  last_generated_date TEXT,
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (end_date IS NULL OR end_date >= start_date)
);

-- ── transactions ────────────────────────────────────────────────────────────
-- Every cash/unit event. amount_minor is SIGNED, in the account's currency,
-- with the sign fixed per type so plain SUM() is meaningful:
--   deposit   > 0   money in          withdrawal < 0   money out
--   sell      > 0   proceeds in       buy        < 0   cash out
--   dividend  > 0   income in         fee        < 0   charged
--   adjustment  either — a correcting entry
CREATE TABLE transactions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id        INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  holding_id        INTEGER REFERENCES holdings(id) ON DELETE CASCADE,
  date              TEXT    NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  type              TEXT    NOT NULL CHECK (type IN
                      ('deposit','withdrawal','buy','sell','fee','dividend','adjustment')),
  amount_minor      INTEGER NOT NULL,
  -- Units are genuinely fractional (0.0123 BTC), so REAL is correct here.
  quantity          REAL,
  price_minor       INTEGER CHECK (price_minor IS NULL OR price_minor >= 0),
  -- Which slice of a pension / hishtalmut deposit this is.
  contribution_part TEXT    CHECK (contribution_part IS NULL OR contribution_part IN
                      ('employee','employer','severance')),
  fee_kind          TEXT    CHECK (fee_kind IS NULL OR fee_kind IN
                      ('management_balance','management_deposit','trade','other')),
  currency          TEXT    NOT NULL CHECK (currency IN ('ILS','USD')),
  source            TEXT    NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','recurring')),
  recurring_rule_id INTEGER REFERENCES recurring_rules(id) ON DELETE SET NULL,
  note              TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),

  -- Sign discipline per type — keeps the derivation queries honest.
  CHECK (type <> 'deposit'    OR amount_minor > 0),
  CHECK (type <> 'withdrawal' OR amount_minor < 0),
  CHECK (type <> 'buy'        OR amount_minor < 0),
  CHECK (type <> 'sell'       OR amount_minor > 0),
  CHECK (type <> 'dividend'   OR amount_minor > 0),
  CHECK (type <> 'fee'        OR amount_minor < 0),
  -- A trade must say what, how many and at what price.
  CHECK (type NOT IN ('buy','sell') OR
         (holding_id IS NOT NULL AND quantity IS NOT NULL AND quantity > 0
          AND price_minor IS NOT NULL)),
  -- Only trades carry units.
  CHECK (type IN ('buy','sell') OR (quantity IS NULL AND price_minor IS NULL)),
  -- A fee must say which kind, so fee drag can be attributed.
  CHECK (type <> 'fee' OR fee_kind IS NOT NULL),
  CHECK (type =  'fee' OR fee_kind IS NULL),
  -- Contribution splits describe incoming money only.
  CHECK (type =  'deposit' OR contribution_part IS NULL),
  -- Provenance and rule linkage agree.
  CHECK ((source = 'recurring') = (recurring_rule_id IS NOT NULL))
);

-- ── valuations ──────────────────────────────────────────────────────────────
-- MANUAL ENTRY ONLY. A balance statement reading for a balance-valued account.
-- Fees are already deducted inside these numbers (see docs/schema.md).
CREATE TABLE valuations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date          TEXT    NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  balance_minor INTEGER NOT NULL CHECK (balance_minor >= 0),
  currency      TEXT    NOT NULL CHECK (currency IN ('ILS','USD')),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (account_id, date)
);

-- ── fx_rates ────────────────────────────────────────────────────────────────
-- MANUAL ENTRY ONLY. rate = how many quote_currency units per 1 base_currency.
-- Same carry-forward rule as prices: newest row on-or-before the date.
CREATE TABLE fx_rates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  date           TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  base_currency  TEXT NOT NULL CHECK (base_currency  IN ('ILS','USD')),
  quote_currency TEXT NOT NULL CHECK (quote_currency IN ('ILS','USD')),
  rate           REAL NOT NULL CHECK (rate > 0),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (date, base_currency, quote_currency),
  CHECK (base_currency <> quote_currency)
);

-- ── rsu_grants ──────────────────────────────────────────────────────────────
CREATE TABLE rsu_grants (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id           INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  symbol               TEXT    NOT NULL,
  grant_date           TEXT    NOT NULL CHECK (grant_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  total_units          REAL    NOT NULL CHECK (total_units > 0),
  -- FMV at grant: reference only. Cost basis comes from price_at_vest_minor.
  grant_price_minor    INTEGER CHECK (grant_price_minor IS NULL OR grant_price_minor >= 0),
  currency             TEXT    NOT NULL CHECK (currency IN ('ILS','USD')),
  cliff_months         INTEGER NOT NULL DEFAULT 0 CHECK (cliff_months >= 0),
  vest_duration_months INTEGER NOT NULL CHECK (vest_duration_months > 0),
  vest_frequency       TEXT    NOT NULL CHECK (vest_frequency IN ('monthly','quarterly','annual')),
  notes                TEXT,
  created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (cliff_months <= vest_duration_months)
);

-- ── rsu_vests ───────────────────────────────────────────────────────────────
-- One row per tranche. price_at_vest_minor is manual (nothing can look up a
-- historical close) and is the cost basis for the units it releases.
CREATE TABLE rsu_vests (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id                INTEGER NOT NULL REFERENCES rsu_grants(id) ON DELETE CASCADE,
  vest_date               TEXT    NOT NULL CHECK (vest_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  units                   REAL    NOT NULL CHECK (units > 0),
  price_at_vest_minor     INTEGER CHECK (price_at_vest_minor IS NULL OR price_at_vest_minor >= 0),
  units_sold_to_cover_tax REAL    NOT NULL DEFAULT 0 CHECK (units_sold_to_cover_tax >= 0),
  status                  TEXT    NOT NULL DEFAULT 'scheduled'
                            CHECK (status IN ('scheduled','vested','cancelled')),
  created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (grant_id, vest_date),
  CHECK (units_sold_to_cover_tax <= units)
);

-- ════════════════════════════════════════════════════════════════════════════
-- INDEXES
--
-- Note on the (x, date) lookup paths: the carry-forward query shape is
--   WHERE <fk> = ? AND date <= ? ORDER BY date DESC LIMIT 1
-- which needs the FK first and date second. `prices`, `valuations` and
-- `rsu_vests` already get exactly that ordering free from their UNIQUE
-- constraints, so they are not duplicated here. `fx_rates` does NOT —
-- its UNIQUE starts with `date` — so it gets an explicit index below.
-- ════════════════════════════════════════════════════════════════════════════

-- transactions: the hot paths — per account over time, per holding over time,
-- and whole-portfolio date ranges.
CREATE INDEX idx_transactions_account_date ON transactions(account_id, date);
CREATE INDEX idx_transactions_holding_date ON transactions(holding_id, date)
  WHERE holding_id IS NOT NULL;
CREATE INDEX idx_transactions_date         ON transactions(date);
CREATE INDEX idx_transactions_type_date    ON transactions(type, date);
-- Makes recurring-rule generation idempotent AND fast: at most one posting per
-- rule per date.
CREATE UNIQUE INDEX idx_transactions_rule_date ON transactions(recurring_rule_id, date)
  WHERE recurring_rule_id IS NOT NULL;

-- fx_rates: FK-equivalent columns first so carry-forward can seek, not scan.
CREATE INDEX idx_fx_rates_pair_date ON fx_rates(base_currency, quote_currency, date);

-- Parent → child fan-outs.
CREATE INDEX idx_holdings_account        ON holdings(account_id);
CREATE INDEX idx_valuations_account_date ON valuations(account_id, date);
CREATE INDEX idx_prices_holding_date     ON prices(holding_id, date);
CREATE INDEX idx_recurring_account       ON recurring_rules(account_id, is_active);
CREATE INDEX idx_rsu_grants_account      ON rsu_grants(account_id);
CREATE INDEX idx_rsu_vests_grant_date    ON rsu_vests(grant_id, vest_date);
CREATE INDEX idx_rsu_vests_status_date   ON rsu_vests(status, vest_date);
CREATE INDEX idx_accounts_active         ON accounts(is_active, category);
