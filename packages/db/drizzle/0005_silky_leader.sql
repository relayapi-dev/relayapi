-- relayapi:contract-after-compatible-release
-- The preceding API release writes media derivatives only from their exact processing job and creates product sets only beneath same-tenant catalog resources.
ALTER TABLE "ad_advanced_resources" DROP CONSTRAINT "ad_advanced_resources_parent_id_ad_advanced_resources_id_fk";
--> statement-breakpoint
ALTER TABLE "media_derivatives" DROP CONSTRAINT "media_derivatives_processing_job_fk";
--> statement-breakpoint
ALTER TABLE "ad_advanced_resources" ADD COLUMN "parent_resource_class" text GENERATED ALWAYS AS (CASE WHEN parent_id IS NULL THEN NULL ELSE 'catalog' END) STORED;--> statement-breakpoint
ALTER TABLE "ad_advanced_resources" ADD CONSTRAINT "ad_advanced_resources_parent_target_uniq" UNIQUE("id","organization_id","scope_key","ad_account_id","platform","kind");--> statement-breakpoint
ALTER TABLE "media_processing_jobs" ADD CONSTRAINT "media_processing_jobs_id_org_scope_media_uniq" UNIQUE("id","organization_id","scope_key","media_id");--> statement-breakpoint
ALTER TABLE "ad_advanced_resources" ADD CONSTRAINT "ad_advanced_resources_parent_org_scope_account_platform_kind_fk" FOREIGN KEY ("parent_id","organization_id","scope_key","ad_account_id","platform","parent_resource_class") REFERENCES "public"."ad_advanced_resources"("id","organization_id","scope_key","ad_account_id","platform","kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_derivatives" ADD CONSTRAINT "media_derivatives_processing_job_org_scope_media_fk" FOREIGN KEY ("processing_job_id","organization_id","scope_key","media_id") REFERENCES "public"."media_processing_jobs"("id","organization_id","scope_key","media_id") ON DELETE cascade ON UPDATE no action;
