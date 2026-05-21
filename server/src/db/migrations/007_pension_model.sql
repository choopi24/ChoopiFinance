-- Add pension deposit model columns to investments.
-- monthly_deposit: expected monthly contribution (NIS or deposit_currency).
--   Used by the pension profit model: net_deposited = monthly_deposit * whole_months_elapsed.
-- deposit_currency: currency of monthly_deposit (defaults to NIS).
ALTER TABLE investments ADD COLUMN monthly_deposit REAL;
ALTER TABLE investments ADD COLUMN deposit_currency TEXT NOT NULL DEFAULT 'NIS';
