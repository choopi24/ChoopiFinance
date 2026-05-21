-- Add soft-delete support to investments
ALTER TABLE investments ADD COLUMN deleted_at TEXT;
