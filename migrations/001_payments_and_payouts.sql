-- Shares the same RDS instance and database as the other unblur services (pragmatic reuse of
-- existing infra) -- but this service owns and only touches the payments/payouts tables.
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- soft reference to user-service's users.id (the payer) -- same physical DB but a different
  -- service's table, so no cross-db FK here
  user_id UUID NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  -- only 1-on-1 resolution payments exist so far -- extend this check when seminar/GD payments land
  type TEXT NOT NULL CHECK (type IN ('resolution')),
  reference_type TEXT NOT NULL CHECK (reference_type IN ('booking')),
  reference_id UUID NOT NULL,
  -- soft reference to user-service's users.id (the payout recipient) -- resolved once at
  -- collect-time since this service has no other way to know who the resolver is for a booking
  recipient_user_id UUID NULL,
  platform_fee_cents INTEGER NULL,
  recipient_amount_cents INTEGER NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- one payment per booking -- a retried collect call must never create a second charge
  UNIQUE (reference_type, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_payments_reference ON payments (reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments (user_id);

CREATE TABLE IF NOT EXISTS payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- the recipient of the payout, not the payer
  user_id UUID NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  payment_id UUID NOT NULL REFERENCES payments(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payouts_user ON payouts (user_id);
CREATE INDEX IF NOT EXISTS idx_payouts_payment ON payouts (payment_id);
