-- Future-value projection inputs (per investment).
-- expected_annual_return: decimal rate, e.g. 0.07 = 7%/yr (NULL → client falls back to per-type default).
-- monthly_contribution:   recurring monthly contribution used in the projection (NULL/0 = none).
ALTER TABLE investments ADD COLUMN expected_annual_return REAL;
ALTER TABLE investments ADD COLUMN monthly_contribution REAL;
