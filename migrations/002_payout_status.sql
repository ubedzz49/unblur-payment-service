-- A payout can now also be created "withheld" when the resolver's attendance falls under the
-- 90% threshold (see Resolution Service's booking-completion flow) -- previously payouts were
-- only ever pending/completed/failed.
ALTER TABLE payouts DROP CONSTRAINT IF EXISTS payouts_status_check;
ALTER TABLE payouts ADD CONSTRAINT payouts_status_check CHECK (status IN ('pending', 'completed', 'failed', 'withheld'));
