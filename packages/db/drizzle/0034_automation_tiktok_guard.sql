-- Plan 6 Unit RR11 / Task 3: guard against orphan tiktok automation rows.
--
-- Postgres does not support dropping values from an existing enum, so the
-- `automation_channel` enum keeps its `tiktok` value in the DB. The TypeScript
-- schema no longer accepts it (zod enums on the API reject new inserts), but
-- this guard ensures no existing rows still reference the retired value. Pre-
-- launch there are no automations using tiktok; this migration aborts loudly
-- if that ever changes so an operator can migrate the data before retry.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM automations WHERE channel = 'tiktok') THEN
    RAISE EXCEPTION 'Cannot drop tiktok channel: % automation rows still use it', (SELECT count(*) FROM automations WHERE channel = 'tiktok');
  END IF;
END $$;
