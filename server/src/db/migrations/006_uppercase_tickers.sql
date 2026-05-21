-- Normalise existing ticker symbols to UPPERCASE so price_cache lookups always match.
-- price_cache stores symbols in UPPER (inserted by prices.ts), but investments.ticker
-- was previously stored as-typed (mixed case / lowercase possible).
UPDATE investments SET ticker = UPPER(ticker) WHERE ticker IS NOT NULL;
