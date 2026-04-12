CREATE INDEX "broadcasts_status_scheduled_idx" ON "broadcasts" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "contact_channels_platform_account_contact_idx" ON "contact_channels" USING btree ("platform","social_account_id","contact_id");--> statement-breakpoint
CREATE INDEX "contacts_org_created_idx" ON "contacts" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE INDEX "contacts_org_workspace_created_idx" ON "contacts" USING btree ("organization_id","workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "external_posts_account_published_idx" ON "external_posts" USING btree ("social_account_id","published_at");--> statement-breakpoint
CREATE INDEX "short_links_created_sync_idx" ON "short_links" USING btree ("created_at","last_click_sync_at");
