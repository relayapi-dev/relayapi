DROP INDEX "comment_automations_account_post_idx";--> statement-breakpoint
ALTER TABLE "comment_automations" ALTER COLUMN "post_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "comment_automations_account_allposts_idx" ON "comment_automations" USING btree ("social_account_id") WHERE post_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "comment_automations_account_post_idx" ON "comment_automations" USING btree ("social_account_id","post_id") WHERE post_id IS NOT NULL;