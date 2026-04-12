ALTER TABLE "post_targets" DROP CONSTRAINT "post_targets_post_id_posts_id_fk";
--> statement-breakpoint
ALTER TABLE "post_targets" DROP CONSTRAINT "post_targets_social_account_id_social_accounts_id_fk";
--> statement-breakpoint
DROP INDEX "comment_auto_logs_dedup_idx";--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_conv_org_workspace_idx" ON "inbox_conversations" USING btree ("organization_id","workspace_id");--> statement-breakpoint
CREATE INDEX "comment_auto_logs_dedup_idx" ON "comment_automation_logs" USING btree ("automation_id","commenter_id");