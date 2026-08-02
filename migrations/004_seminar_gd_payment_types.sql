DO $$
DECLARE
  con RECORD;
BEGIN
  FOR con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'payments'::regclass
      AND pg_get_constraintdef(oid) LIKE '%type = ANY%'
      AND pg_get_constraintdef(oid) NOT LIKE '%reference_type%'
  LOOP
    EXECUTE format('ALTER TABLE payments DROP CONSTRAINT %I', con.conname);
  END LOOP;

  FOR con IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'payments'::regclass
      AND pg_get_constraintdef(oid) LIKE '%reference_type = ANY%'
  LOOP
    EXECUTE format('ALTER TABLE payments DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;

ALTER TABLE payments ADD CONSTRAINT payments_type_check
  CHECK (type IN ('resolution', 'seminar_entry', 'gd_organizer', 'gd_entry'));

ALTER TABLE payments ADD CONSTRAINT payments_reference_type_check
  CHECK (reference_type IN ('booking', 'seminar_registration', 'gd', 'gd_participant'));
