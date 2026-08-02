ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_type_check;
ALTER TABLE payments ADD CONSTRAINT payments_type_check
  CHECK (type IN ('resolution', 'seminar_entry', 'gd_organizer', 'gd_entry'));

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_reference_type_check;
ALTER TABLE payments ADD CONSTRAINT payments_reference_type_check
  CHECK (reference_type IN ('booking', 'seminar_registration', 'gd', 'gd_participant'));
