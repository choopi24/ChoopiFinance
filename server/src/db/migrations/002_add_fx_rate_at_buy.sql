-- Store the USD/NIS FX rate at the moment of each BUY transaction
-- so FIFO cost-basis calculations remain correct regardless of future rate moves
ALTER TABLE transactions ADD COLUMN fx_rate_at_buy REAL;
