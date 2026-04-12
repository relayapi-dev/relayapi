ALTER TABLE "inbox_conversations" ADD COLUMN "participant_metadata" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
CREATE INDEX "ad_accounts_status_idx" ON "ad_accounts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ads_org_campaign_idx" ON "ads" USING btree ("organization_id","campaign_id");