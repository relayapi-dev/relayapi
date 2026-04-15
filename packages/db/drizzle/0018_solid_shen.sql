ALTER TABLE "ad_sync_logs" DROP CONSTRAINT "ad_sync_logs_ad_account_id_ad_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "ads" DROP CONSTRAINT "ads_ad_account_id_ad_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "ad_sync_logs" ADD CONSTRAINT "ad_sync_logs_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ads" ADD CONSTRAINT "ads_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE cascade ON UPDATE no action;