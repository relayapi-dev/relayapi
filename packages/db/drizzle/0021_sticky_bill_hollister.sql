DROP INDEX "api_request_logs_org_id_desc_idx";--> statement-breakpoint
DROP INDEX "post_targets_post_id_idx";--> statement-breakpoint
CREATE INDEX "api_request_logs_api_key_idx" ON "api_request_logs" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "apikey_key_idx" ON "auth"."apikey" USING btree ("key");--> statement-breakpoint
CREATE INDEX "external_posts_org_platform_post_idx" ON "external_posts" USING btree ("organization_id","platform_post_id");--> statement-breakpoint
CREATE INDEX "idea_activity_actor_idx" ON "idea_activity" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "posts_org_workspace_created_idx" ON "posts" USING btree ("organization_id","workspace_id","created_at");