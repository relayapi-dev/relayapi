-- Reconcile tables adjacent to legacy automations that were affected by
-- the DROP TABLE ... CASCADE in migration 0030:
--   * landing_pages.automation_id        — column kept, FK constraint dropped
--   * ref_urls.automation_id             — column kept, FK constraint dropped
--   * subscription_lists.channel         — column dropped (depended on old
--                                          automation_channel enum)
-- The new "automations" table (0032) and new "automation_channel" enum (0031)
-- now exist, so we re-attach FKs and re-add the channel column.

-- Re-add FK from landing_pages.automation_id to new automations(id)
ALTER TABLE "landing_pages"
  ADD CONSTRAINT "landing_pages_automation_id_automations_id_fk"
  FOREIGN KEY ("automation_id") REFERENCES "automations"("id") ON DELETE SET NULL;--> statement-breakpoint

-- Re-add FK from ref_urls.automation_id to new automations(id)
ALTER TABLE "ref_urls"
  ADD CONSTRAINT "ref_urls_automation_id_automations_id_fk"
  FOREIGN KEY ("automation_id") REFERENCES "automations"("id") ON DELETE SET NULL;--> statement-breakpoint

-- Re-add channel column on subscription_lists using new automation_channel enum
-- Column was dropped by cascade when old enum was dropped
ALTER TABLE "subscription_lists"
  ADD COLUMN "channel" automation_channel NOT NULL DEFAULT 'instagram';--> statement-breakpoint

-- Remove the default since we only needed it for the NOT NULL backfill;
-- new inserts will specify channel explicitly from application code
ALTER TABLE "subscription_lists"
  ALTER COLUMN "channel" DROP DEFAULT;
