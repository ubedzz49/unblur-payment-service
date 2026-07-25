-- Version 5: a released payout is now held for a fixed window rather than paid out immediately,
-- so a poster's complaint filed within that window can still stop it. See the hold-window sweep
-- in app.ts.
ALTER TABLE payouts DROP CONSTRAINT IF EXISTS payouts_status_check;
ALTER TABLE payouts ADD CONSTRAINT payouts_status_check CHECK (status IN ('pending', 'completed', 'failed', 'withheld', 'held'));
ALTER TABLE payouts ADD COLUMN IF NOT EXISTS hold_until TIMESTAMPTZ NULL;
