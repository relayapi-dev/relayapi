-- Required for the inbox_messages trigram search index (inbox_msg_text_trgm_idx).
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" DROP CONSTRAINT "webhook_endpoints_workspace_id_workspaces_id_fk";
--> statement-breakpoint
DROP INDEX "idx_automations_graph_gin";--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "billed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_automation_entrypoints_webhook_slug" ON "automation_entrypoints" USING btree (("config"->>'webhook_slug')) WHERE "automation_entrypoints"."kind" = 'webhook_inbound';--> statement-breakpoint
CREATE INDEX "inbox_conv_open_last_message_idx" ON "inbox_conversations" USING btree ("last_message_at") WHERE "inbox_conversations"."status" = 'open';--> statement-breakpoint
CREATE INDEX "inbox_msg_text_trgm_idx" ON "inbox_messages" USING gin ("text" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "media_storage_key_idx" ON "media" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "auth"."member" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "auth"."member" USING btree ("organizationId");--> statement-breakpoint
CREATE INDEX "posts_org_effective_date_idx" ON "posts" USING btree ("organization_id",coalesce("published_at", "created_at") desc);--> statement-breakpoint
CREATE INDEX "posts_metrics_refresh_idx" ON "posts" USING btree ("metrics_collected_at") WHERE "posts"."status" = 'published';--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_idx" ON "auth"."session" USING btree ("token");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "auth"."session" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "social_accounts_token_expiry_idx" ON "social_accounts" USING btree ("token_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_idx" ON "auth"."user" USING btree ("email");