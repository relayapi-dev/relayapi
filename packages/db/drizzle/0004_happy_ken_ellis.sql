-- relayapi:contract-after-compatible-release
-- The preceding API release writes only the legacy disposition/edit-state subset and remains compatible with the widened replacement checks below.
ALTER TYPE "public"."post_status" ADD VALUE 'provider_draft' BEFORE 'failed';--> statement-breakpoint
CREATE TABLE "ad_advanced_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"ad_account_id" text NOT NULL,
	"platform" "ad_platform" NOT NULL,
	"kind" text NOT NULL,
	"provider_resource_id" text,
	"parent_id" text,
	"name" text,
	"status" text DEFAULT 'linked' NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_advanced_resources_id_org_scope_account_platform_uniq" UNIQUE("id","organization_id","scope_key","ad_account_id","platform"),
	CONSTRAINT "ad_advanced_resources_kind_check" CHECK ("ad_advanced_resources"."kind" IN (E'messaging_experience', E'creative_asset', E'catalog', E'product_set')),
	CONSTRAINT "ad_advanced_resources_status_check" CHECK ("ad_advanced_resources"."status" IN ('linked', 'unavailable', 'archived')),
	CONSTRAINT "ad_advanced_resources_parent_check" CHECK (("ad_advanced_resources"."kind" = 'product_set') = ("ad_advanced_resources"."parent_id" IS NOT NULL)),
	CONSTRAINT "ad_advanced_resources_configuration_check" CHECK (jsonb_typeof("ad_advanced_resources"."configuration") = 'object')
);
--> statement-breakpoint
CREATE TABLE "ad_conversion_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"ad_account_id" text NOT NULL,
	"platform" "ad_platform" NOT NULL,
	"conversion_rule_id" text NOT NULL,
	"event_id" text NOT NULL,
	"operation_key_hash" varchar(64) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"payload_ciphertext" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_event_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"request_may_have_been_sent_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ad_conversion_events_org_rule_operation_uniq" UNIQUE("organization_id","conversion_rule_id","operation_key_hash"),
	CONSTRAINT "ad_conversion_events_status_check" CHECK ("ad_conversion_events"."status" IN ('pending', 'processing', 'request_may_have_been_sent', 'unknown', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "ad_conversion_events_hash_check" CHECK ("ad_conversion_events"."operation_key_hash" ~ '^[0-9a-f]{64}$'
				AND "ad_conversion_events"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ad_conversion_events_ciphertext_check" CHECK ("ad_conversion_events"."payload_ciphertext" IS NULL OR "ad_conversion_events"."payload_ciphertext" LIKE 'enc:v2:%'),
	CONSTRAINT "ad_conversion_events_payload_lifecycle_check" CHECK ("ad_conversion_events"."status" IN ('completed', 'failed', 'cancelled')
				OR "ad_conversion_events"."payload_ciphertext" IS NOT NULL),
	CONSTRAINT "ad_conversion_events_counters_check" CHECK ("ad_conversion_events"."attempts" >= 0 AND "ad_conversion_events"."lease_token" >= 0),
	CONSTRAINT "ad_conversion_events_lease_check" CHECK (("ad_conversion_events"."status" IN ('processing', 'request_may_have_been_sent')) = ("ad_conversion_events"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "ad_conversion_events_request_boundary_check" CHECK ("ad_conversion_events"."status" <> 'request_may_have_been_sent'
				OR "ad_conversion_events"."request_may_have_been_sent_at" IS NOT NULL),
	CONSTRAINT "ad_conversion_events_completion_check" CHECK (("ad_conversion_events"."status" IN ('completed', 'failed', 'cancelled')) = ("ad_conversion_events"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ad_conversion_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"ad_account_id" text NOT NULL,
	"platform" "ad_platform" NOT NULL,
	"name" text NOT NULL,
	"event_name" text NOT NULL,
	"provider_destination_id" text NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_conversion_rules_id_org_scope_account_platform_uniq" UNIQUE("id","organization_id","scope_key","ad_account_id","platform"),
	CONSTRAINT "ad_conversion_rules_configuration_check" CHECK (jsonb_typeof("ad_conversion_rules"."configuration") = 'object')
);
--> statement-breakpoint
CREATE TABLE "ad_lead_forms" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"ad_account_id" text NOT NULL,
	"platform" "ad_platform" NOT NULL,
	"provider_form_id" text NOT NULL,
	"name" text,
	"status" text DEFAULT 'unknown' NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_lead_forms_id_org_scope_account_platform_uniq" UNIQUE("id","organization_id","scope_key","ad_account_id","platform"),
	CONSTRAINT "ad_lead_forms_org_account_provider_uniq" UNIQUE("organization_id","ad_account_id","provider_form_id"),
	CONSTRAINT "ad_lead_forms_status_check" CHECK ("ad_lead_forms"."status" IN ('draft', 'active', 'archived', 'unknown')),
	CONSTRAINT "ad_lead_forms_configuration_check" CHECK (jsonb_typeof("ad_lead_forms"."configuration") = 'object')
);
--> statement-breakpoint
CREATE TABLE "ad_leads" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"ad_account_id" text NOT NULL,
	"platform" "ad_platform" NOT NULL,
	"lead_form_id" text,
	"provider_lead_id" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"payload_ciphertext" text NOT NULL,
	"contact_id" text,
	"provider_created_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_leads_org_account_provider_uniq" UNIQUE("organization_id","ad_account_id","provider_lead_id"),
	CONSTRAINT "ad_leads_status_check" CHECK ("ad_leads"."status" IN ('new', 'promoted', 'dismissed')),
	CONSTRAINT "ad_leads_ciphertext_check" CHECK ("ad_leads"."payload_ciphertext" LIKE 'enc:v2:%'),
	CONSTRAINT "ad_leads_retention_check" CHECK ("ad_leads"."expires_at" > "ad_leads"."created_at"
				AND "ad_leads"."expires_at" <= "ad_leads"."created_at" + interval '30 days'),
	CONSTRAINT "ad_leads_promotion_check" CHECK (("ad_leads"."status" = 'promoted') = ("ad_leads"."contact_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ad_report_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"ad_account_id" text NOT NULL,
	"platform" "ad_platform" NOT NULL,
	"operation_key_hash" varchar(64) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"request_payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_job_id" text,
	"result_object_key" text,
	"row_count" integer,
	"result_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now(),
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"request_may_have_been_sent_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ad_report_jobs_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "ad_report_jobs_org_operation_uniq" UNIQUE("organization_id","operation_key_hash"),
	CONSTRAINT "ad_report_jobs_status_check" CHECK ("ad_report_jobs"."status" IN ('pending', 'submitting', 'provider_pending', 'downloading', 'completed', 'failed', 'unknown', 'cancelled')),
	CONSTRAINT "ad_report_jobs_hash_check" CHECK ("ad_report_jobs"."operation_key_hash" ~ '^[0-9a-f]{64}$'
				AND "ad_report_jobs"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ad_report_jobs_request_check" CHECK (jsonb_typeof("ad_report_jobs"."request_payload") = 'object'),
	CONSTRAINT "ad_report_jobs_counters_check" CHECK ("ad_report_jobs"."attempts" >= 0
				AND "ad_report_jobs"."lease_token" >= 0
				AND ("ad_report_jobs"."row_count" IS NULL OR "ad_report_jobs"."row_count" >= 0)),
	CONSTRAINT "ad_report_jobs_request_boundary_check" CHECK ("ad_report_jobs"."status" <> 'submitting'
				OR "ad_report_jobs"."request_may_have_been_sent_at" IS NOT NULL),
	CONSTRAINT "ad_report_jobs_completion_check" CHECK (("ad_report_jobs"."status" IN ('completed', 'failed', 'cancelled')) = ("ad_report_jobs"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ad_report_rows" (
	"organization_id" text NOT NULL,
	"report_job_id" text NOT NULL,
	"row_number" integer NOT NULL,
	"dimensions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "ad_report_rows_report_job_id_row_number_pk" PRIMARY KEY("report_job_id","row_number"),
	CONSTRAINT "ad_report_rows_number_check" CHECK ("ad_report_rows"."row_number" > 0),
	CONSTRAINT "ad_report_rows_payload_check" CHECK (jsonb_typeof("ad_report_rows"."dimensions") = 'object'
				AND jsonb_typeof("ad_report_rows"."metrics") = 'object')
);
--> statement-breakpoint
CREATE TABLE "media_derivatives" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"media_id" text NOT NULL,
	"processing_job_id" text NOT NULL,
	"kind" text NOT NULL,
	"profile" text NOT NULL,
	"options_hash" varchar(64) NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"duration" integer,
	"checksum_sha256" varchar(64) NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"delete_after" timestamp with time zone,
	CONSTRAINT "media_derivatives_state_check" CHECK ("media_derivatives"."kind" IN (E'normalized', E'provider', E'cover', E'gif_video')
				AND "media_derivatives"."status" IN ('processing', 'ready', 'failed', 'deleting')),
	CONSTRAINT "media_derivatives_numeric_check" CHECK ("media_derivatives"."size" >= 0
				AND ("media_derivatives"."width" IS NULL OR "media_derivatives"."width" > 0)
				AND ("media_derivatives"."height" IS NULL OR "media_derivatives"."height" > 0)
				AND ("media_derivatives"."duration" IS NULL OR "media_derivatives"."duration" >= 0)),
	CONSTRAINT "media_derivatives_checksum_check" CHECK ("media_derivatives"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "media_derivatives_ready_check" CHECK (("media_derivatives"."status" = 'ready') = ("media_derivatives"."ready_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "media_processing_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"media_id" text NOT NULL,
	"operation" text NOT NULL,
	"profile" text NOT NULL,
	"options" jsonb NOT NULL,
	"options_hash" varchar(64) NOT NULL,
	"source_etag" text NOT NULL,
	"processor_version" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"workflow_id" text,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error_code" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "media_processing_jobs_state_check" CHECK ("media_processing_jobs"."operation" IN ('normalize', 'provider_variant', 'cover')
				AND "media_processing_jobs"."status" IN ('pending', 'processing', 'completed', 'failed', 'manual_review')),
	CONSTRAINT "media_processing_jobs_counter_check" CHECK ("media_processing_jobs"."attempts" >= 0 AND "media_processing_jobs"."lease_token" >= 0),
	CONSTRAINT "media_processing_jobs_lease_check" CHECK (("media_processing_jobs"."status" = 'processing' AND "media_processing_jobs"."lease_expires_at" IS NOT NULL)
				OR ("media_processing_jobs"."status" <> 'processing' AND "media_processing_jobs"."lease_expires_at" IS NULL)),
	CONSTRAINT "media_processing_jobs_completion_check" CHECK (("media_processing_jobs"."status" = 'completed') = ("media_processing_jobs"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "media_upload_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"media_id" text NOT NULL,
	"mode" text NOT NULL,
	"expected_size" integer NOT NULL,
	"expected_mime_type" text NOT NULL,
	"part_size" integer,
	"part_count" integer,
	"multipart_upload_id_ciphertext" text,
	"status" text DEFAULT 'created' NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"last_error_code" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "media_upload_sessions_mode_check" CHECK ("media_upload_sessions"."mode" IN ('single', 'multipart')),
	CONSTRAINT "media_upload_sessions_status_check" CHECK ("media_upload_sessions"."status" IN ('created', 'uploading', 'completing', 'completed', 'aborting', 'aborted', 'failed', 'expired')),
	CONSTRAINT "media_upload_sessions_size_check" CHECK ("media_upload_sessions"."expected_size" > 0 AND "media_upload_sessions"."expected_size" <= 209715200),
	CONSTRAINT "media_upload_sessions_multipart_shape_check" CHECK (("media_upload_sessions"."mode" = 'single'
					AND "media_upload_sessions"."part_size" IS NULL
					AND "media_upload_sessions"."part_count" IS NULL
					AND "media_upload_sessions"."multipart_upload_id_ciphertext" IS NULL)
				OR ("media_upload_sessions"."mode" = 'multipart'
					AND "media_upload_sessions"."part_size" >= 5242880
					AND "media_upload_sessions"."part_count" > 1
					AND (
						("media_upload_sessions"."status" IN ('created', 'uploading', 'completing', 'aborting')
							AND "media_upload_sessions"."multipart_upload_id_ciphertext" LIKE 'enc:v2:%')
						OR ("media_upload_sessions"."status" IN ('completed', 'aborted', 'expired')
							AND "media_upload_sessions"."multipart_upload_id_ciphertext" IS NULL)
						OR "media_upload_sessions"."status" = 'failed'
					))),
	CONSTRAINT "media_upload_sessions_completion_check" CHECK (("media_upload_sessions"."status" = 'completed') = ("media_upload_sessions"."completed_at" IS NOT NULL)),
	CONSTRAINT "media_upload_sessions_lease_check" CHECK ("media_upload_sessions"."lease_token" >= 0
				AND ("media_upload_sessions"."status" IN ('completing', 'aborting')) = ("media_upload_sessions"."lease_expires_at" IS NOT NULL)),
	CONSTRAINT "media_upload_sessions_timestamp_check" CHECK ("media_upload_sessions"."expires_at" > "media_upload_sessions"."created_at"
				AND "media_upload_sessions"."updated_at" >= "media_upload_sessions"."created_at"
				AND ("media_upload_sessions"."completed_at" IS NULL OR "media_upload_sessions"."completed_at" >= "media_upload_sessions"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "social_mutation_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"account_id" text NOT NULL,
	"platform" "platform" NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"kind" text NOT NULL,
	"operation_key_hash" varchar(64) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"request_payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"phase" text DEFAULT 'provider' NOT NULL,
	"lease_token" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"request_may_have_been_sent_at" timestamp with time zone,
	"provider_confirmed_at" timestamp with time zone,
	"provider_operation_id" text,
	"provider_result" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "social_mutation_operations_target_check" CHECK ("social_mutation_operations"."target_type" IN (E'post_target', E'provider_post', E'inbox_message', E'comment', E'whatsapp_group', E'whatsapp_account', E'whatsapp_template')),
	CONSTRAINT "social_mutation_operations_kind_check" CHECK ("social_mutation_operations"."kind" IN (E'post_edit', E'message_edit', E'read_receipt', E'comment_edit', E'moderation', E'reaction', E'group_create', E'group_update', E'group_delete', E'group_join_approve', E'group_join_reject', E'group_participant_remove', E'group_message', E'group_pin', E'block_users', E'unblock_users', E'username_set', E'username_delete', E'template_edit', E'template_library_create')),
	CONSTRAINT "social_mutation_operations_status_check" CHECK ("social_mutation_operations"."status" IN ('pending', 'processing', 'request_may_have_been_sent', 'unknown', 'completed', 'failed')),
	CONSTRAINT "social_mutation_operations_phase_check" CHECK ("social_mutation_operations"."phase" IN ('provider', 'projection', 'completed')),
	CONSTRAINT "social_mutation_operations_counter_check" CHECK ("social_mutation_operations"."attempts" >= 0 AND "social_mutation_operations"."lease_token" >= 0),
	CONSTRAINT "social_mutation_operations_lease_check" CHECK (("social_mutation_operations"."status" IN ('processing', 'request_may_have_been_sent') AND "social_mutation_operations"."lease_expires_at" IS NOT NULL)
				OR ("social_mutation_operations"."status" NOT IN ('processing', 'request_may_have_been_sent') AND "social_mutation_operations"."lease_expires_at" IS NULL)),
	CONSTRAINT "social_mutation_operations_boundary_check" CHECK ("social_mutation_operations"."status" <> 'request_may_have_been_sent' OR "social_mutation_operations"."request_may_have_been_sent_at" IS NOT NULL),
	CONSTRAINT "social_mutation_operations_completion_check" CHECK (("social_mutation_operations"."status" = 'completed'
					AND "social_mutation_operations"."phase" = 'completed'
					AND "social_mutation_operations"."provider_confirmed_at" IS NOT NULL
					AND "social_mutation_operations"."completed_at" IS NOT NULL)
				OR ("social_mutation_operations"."status" <> 'completed'
					AND "social_mutation_operations"."phase" <> 'completed'
					AND "social_mutation_operations"."completed_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "whatsapp_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"account_id" text NOT NULL,
	"platform" "platform" DEFAULT 'whatsapp' NOT NULL,
	"provider_group_id" text,
	"subject" text NOT NULL,
	"description" text,
	"join_approval_mode" text,
	"lifecycle_status" text DEFAULT 'creating' NOT NULL,
	"provider_request_id" text,
	"invite_link_ciphertext" text,
	"participant_count" integer,
	"provider_created_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_groups_platform_check" CHECK ("whatsapp_groups"."platform" = 'whatsapp'),
	CONSTRAINT "whatsapp_groups_status_check" CHECK ("whatsapp_groups"."lifecycle_status" IN ('creating', 'active', 'suspended', 'deleting', 'deleted', 'failed')),
	CONSTRAINT "whatsapp_groups_join_approval_check" CHECK ("whatsapp_groups"."join_approval_mode" IS NULL OR "whatsapp_groups"."join_approval_mode" IN ('approval_required', 'auto_approve')),
	CONSTRAINT "whatsapp_groups_participant_count_check" CHECK ("whatsapp_groups"."participant_count" IS NULL OR "whatsapp_groups"."participant_count" BETWEEN 0 AND 8),
	CONSTRAINT "whatsapp_groups_provider_identity_check" CHECK ("whatsapp_groups"."lifecycle_status" IN ('creating', 'failed')
				OR "whatsapp_groups"."provider_group_id" IS NOT NULL),
	CONSTRAINT "whatsapp_groups_timestamp_check" CHECK ("whatsapp_groups"."updated_at" >= "whatsapp_groups"."created_at"
				AND ("whatsapp_groups"."last_synced_at" IS NULL OR "whatsapp_groups"."last_synced_at" >= "whatsapp_groups"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "whatsapp_identity_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"account_id" text NOT NULL,
	"platform" "platform" DEFAULT 'whatsapp' NOT NULL,
	"conversation_id" text,
	"bsuid_hash" varchar(64) NOT NULL,
	"bsuid_ciphertext" text NOT NULL,
	"parent_bsuid_hash" varchar(64),
	"parent_bsuid_ciphertext" text,
	"wa_id_hash" varchar(64),
	"wa_id_ciphertext" text,
	"username_ciphertext" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_identity_aliases_hash_check" CHECK ("whatsapp_identity_aliases"."platform" = 'whatsapp'
				AND "whatsapp_identity_aliases"."bsuid_hash" ~ '^[0-9a-f]{64}$'
				AND ("whatsapp_identity_aliases"."parent_bsuid_hash" IS NULL OR "whatsapp_identity_aliases"."parent_bsuid_hash" ~ '^[0-9a-f]{64}$')
				AND ("whatsapp_identity_aliases"."wa_id_hash" IS NULL OR "whatsapp_identity_aliases"."wa_id_hash" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "whatsapp_identity_aliases_ciphertext_check" CHECK ("whatsapp_identity_aliases"."bsuid_ciphertext" LIKE 'enc:v2:%'
				AND ("whatsapp_identity_aliases"."parent_bsuid_ciphertext" IS NULL OR "whatsapp_identity_aliases"."parent_bsuid_ciphertext" LIKE 'enc:v2:%')
				AND ("whatsapp_identity_aliases"."wa_id_ciphertext" IS NULL OR "whatsapp_identity_aliases"."wa_id_ciphertext" LIKE 'enc:v2:%')
				AND ("whatsapp_identity_aliases"."username_ciphertext" IS NULL OR "whatsapp_identity_aliases"."username_ciphertext" LIKE 'enc:v2:%')),
	CONSTRAINT "whatsapp_identity_aliases_pair_check" CHECK (("whatsapp_identity_aliases"."parent_bsuid_hash" IS NULL) = ("whatsapp_identity_aliases"."parent_bsuid_ciphertext" IS NULL)
				AND ("whatsapp_identity_aliases"."wa_id_hash" IS NULL) = ("whatsapp_identity_aliases"."wa_id_ciphertext" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "post_targets" DROP CONSTRAINT "post_targets_delivery_projection_check";--> statement-breakpoint
ALTER TABLE "post_targets" DROP CONSTRAINT "post_targets_reconcile_attempts_nonnegative_check";--> statement-breakpoint
ALTER TABLE "post_targets" DROP CONSTRAINT "post_targets_provider_disposition_check";--> statement-breakpoint
ALTER TABLE "publish_attempts" DROP CONSTRAINT "publish_attempts_provider_disposition_check";--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD COLUMN "edit_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD COLUMN "provider_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "post_targets" ADD COLUMN "confirmed_content" text;--> statement-breakpoint
ALTER TABLE "post_targets" ADD COLUMN "edit_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "post_targets" ADD COLUMN "last_edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "post_targets" ADD COLUMN "platform_post_id_history" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_connections" ADD CONSTRAINT "ad_connections_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key");--> statement-breakpoint
CREATE TRIGGER "zz_require_workspace_ad_connections"
BEFORE INSERT OR UPDATE OF "workspace_id", "organization_id"
ON public."ad_connections"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_workspace_requirement"('', '');
--> statement-breakpoint
ALTER TABLE "ad_advanced_resources" ADD CONSTRAINT "ad_advanced_resources_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_advanced_resources" ADD CONSTRAINT "ad_advanced_resources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_advanced_resources" ADD CONSTRAINT "ad_advanced_resources_parent_id_ad_advanced_resources_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."ad_advanced_resources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_advanced_resources" ADD CONSTRAINT "ad_advanced_resources_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_advanced_resources" ADD CONSTRAINT "ad_advanced_resources_account_org_scope_platform_fk" FOREIGN KEY ("ad_account_id","organization_id","scope_key","platform") REFERENCES "public"."ad_accounts"("id","organization_id","scope_key","platform") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_conversion_events" ADD CONSTRAINT "ad_conversion_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_conversion_events" ADD CONSTRAINT "ad_conversion_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_conversion_events" ADD CONSTRAINT "ad_conversion_events_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_conversion_events" ADD CONSTRAINT "ad_conversion_events_rule_org_scope_account_platform_fk" FOREIGN KEY ("conversion_rule_id","organization_id","scope_key","ad_account_id","platform") REFERENCES "public"."ad_conversion_rules"("id","organization_id","scope_key","ad_account_id","platform") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_conversion_rules" ADD CONSTRAINT "ad_conversion_rules_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_conversion_rules" ADD CONSTRAINT "ad_conversion_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_conversion_rules" ADD CONSTRAINT "ad_conversion_rules_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_conversion_rules" ADD CONSTRAINT "ad_conversion_rules_account_org_scope_platform_fk" FOREIGN KEY ("ad_account_id","organization_id","scope_key","platform") REFERENCES "public"."ad_accounts"("id","organization_id","scope_key","platform") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_lead_forms" ADD CONSTRAINT "ad_lead_forms_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_lead_forms" ADD CONSTRAINT "ad_lead_forms_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_lead_forms" ADD CONSTRAINT "ad_lead_forms_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_lead_forms" ADD CONSTRAINT "ad_lead_forms_account_org_scope_platform_fk" FOREIGN KEY ("ad_account_id","organization_id","scope_key","platform") REFERENCES "public"."ad_accounts"("id","organization_id","scope_key","platform") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_leads" ADD CONSTRAINT "ad_leads_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_leads" ADD CONSTRAINT "ad_leads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_leads" ADD CONSTRAINT "ad_leads_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_leads" ADD CONSTRAINT "ad_leads_account_org_scope_platform_fk" FOREIGN KEY ("ad_account_id","organization_id","scope_key","platform") REFERENCES "public"."ad_accounts"("id","organization_id","scope_key","platform") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_leads" ADD CONSTRAINT "ad_leads_form_org_scope_account_platform_fk" FOREIGN KEY ("lead_form_id","organization_id","scope_key","ad_account_id","platform") REFERENCES "public"."ad_lead_forms"("id","organization_id","scope_key","ad_account_id","platform") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_leads" ADD CONSTRAINT "ad_leads_contact_org_scope_fk" FOREIGN KEY ("contact_id","organization_id","scope_key") REFERENCES "public"."contacts"("id","organization_id","scope_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_report_jobs" ADD CONSTRAINT "ad_report_jobs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_report_jobs" ADD CONSTRAINT "ad_report_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_report_jobs" ADD CONSTRAINT "ad_report_jobs_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_report_jobs" ADD CONSTRAINT "ad_report_jobs_account_org_scope_platform_fk" FOREIGN KEY ("ad_account_id","organization_id","scope_key","platform") REFERENCES "public"."ad_accounts"("id","organization_id","scope_key","platform") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_report_rows" ADD CONSTRAINT "ad_report_rows_job_org_fk" FOREIGN KEY ("report_job_id","organization_id") REFERENCES "public"."ad_report_jobs"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_derivatives" ADD CONSTRAINT "media_derivatives_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_derivatives" ADD CONSTRAINT "media_derivatives_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_derivatives" ADD CONSTRAINT "media_derivatives_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_derivatives" ADD CONSTRAINT "media_derivatives_media_org_scope_fk" FOREIGN KEY ("media_id","organization_id","scope_key") REFERENCES "public"."media"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_derivatives" ADD CONSTRAINT "media_derivatives_processing_job_fk" FOREIGN KEY ("processing_job_id") REFERENCES "public"."media_processing_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_processing_jobs" ADD CONSTRAINT "media_processing_jobs_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_processing_jobs" ADD CONSTRAINT "media_processing_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_processing_jobs" ADD CONSTRAINT "media_processing_jobs_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_processing_jobs" ADD CONSTRAINT "media_processing_jobs_media_org_scope_fk" FOREIGN KEY ("media_id","organization_id","scope_key") REFERENCES "public"."media"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_upload_sessions" ADD CONSTRAINT "media_upload_sessions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_upload_sessions" ADD CONSTRAINT "media_upload_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_upload_sessions" ADD CONSTRAINT "media_upload_sessions_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_upload_sessions" ADD CONSTRAINT "media_upload_sessions_media_org_scope_fk" FOREIGN KEY ("media_id","organization_id","scope_key") REFERENCES "public"."media"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_mutation_operations" ADD CONSTRAINT "social_mutation_operations_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_mutation_operations" ADD CONSTRAINT "social_mutation_operations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_mutation_operations" ADD CONSTRAINT "social_mutation_operations_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_mutation_operations" ADD CONSTRAINT "social_mutation_operations_account_org_scope_platform_fk" FOREIGN KEY ("account_id","organization_id","scope_key","platform") REFERENCES "public"."social_accounts"("id","organization_id","scope_key","platform") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_groups" ADD CONSTRAINT "whatsapp_groups_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_groups" ADD CONSTRAINT "whatsapp_groups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_groups" ADD CONSTRAINT "whatsapp_groups_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_groups" ADD CONSTRAINT "whatsapp_groups_account_org_scope_platform_fk" FOREIGN KEY ("account_id","organization_id","scope_key","platform") REFERENCES "public"."social_accounts"("id","organization_id","scope_key","platform") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_identity_aliases" ADD CONSTRAINT "whatsapp_identity_aliases_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_identity_aliases" ADD CONSTRAINT "whatsapp_identity_aliases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_identity_aliases" ADD CONSTRAINT "whatsapp_identity_aliases_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_identity_aliases" ADD CONSTRAINT "whatsapp_identity_aliases_account_org_scope_platform_fk" FOREIGN KEY ("account_id","organization_id","scope_key","platform") REFERENCES "public"."social_accounts"("id","organization_id","scope_key","platform") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- PostgreSQL rejects SET NULL actions on foreign keys containing generated
-- columns. Conversation-linked aliases are derived webhook projections, so
-- deleting their authoritative conversation removes that linked projection.
ALTER TABLE "whatsapp_identity_aliases" ADD CONSTRAINT "whatsapp_identity_aliases_conversation_org_scope_fk" FOREIGN KEY ("conversation_id","organization_id","scope_key") REFERENCES "public"."inbox_conversations"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_advanced_resources_provider_uniq" ON "ad_advanced_resources" USING btree ("ad_account_id","kind","provider_resource_id") WHERE "ad_advanced_resources"."provider_resource_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ad_advanced_resources_account_kind_idx" ON "ad_advanced_resources" USING btree ("ad_account_id","kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_conversion_events_rule_active_uniq" ON "ad_conversion_events" USING btree ("organization_id","conversion_rule_id","event_id") WHERE "ad_conversion_events"."status" IN ('pending', 'processing', 'request_may_have_been_sent', 'unknown');--> statement-breakpoint
CREATE INDEX "ad_conversion_events_due_idx" ON "ad_conversion_events" USING btree ("status","next_attempt_at","lease_expires_at","id");--> statement-breakpoint
CREATE INDEX "ad_conversion_rules_account_enabled_idx" ON "ad_conversion_rules" USING btree ("ad_account_id","enabled");--> statement-breakpoint
CREATE INDEX "ad_lead_forms_account_created_idx" ON "ad_lead_forms" USING btree ("ad_account_id","created_at","id");--> statement-breakpoint
CREATE INDEX "ad_leads_account_created_idx" ON "ad_leads" USING btree ("ad_account_id","created_at","id");--> statement-breakpoint
CREATE INDEX "ad_leads_expiry_idx" ON "ad_leads" USING btree ("expires_at","id");--> statement-breakpoint
CREATE INDEX "ad_report_jobs_due_idx" ON "ad_report_jobs" USING btree ("status","next_attempt_at","lease_expires_at","id");--> statement-breakpoint
CREATE INDEX "ad_report_jobs_result_expiry_idx" ON "ad_report_jobs" USING btree ("result_expires_at","id");--> statement-breakpoint
CREATE INDEX "ad_report_jobs_terminal_retention_idx" ON "ad_report_jobs" USING btree ("status","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_derivatives_profile_uniq" ON "media_derivatives" USING btree ("media_id","kind","profile","options_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "media_derivatives_storage_key_uniq" ON "media_derivatives" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "media_derivatives_cleanup_idx" ON "media_derivatives" USING btree ("status","delete_after","id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_processing_jobs_request_uniq" ON "media_processing_jobs" USING btree ("media_id","operation","profile","options_hash","source_etag","processor_version");--> statement-breakpoint
CREATE INDEX "media_processing_jobs_due_idx" ON "media_processing_jobs" USING btree ("status","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "media_upload_sessions_media_uniq" ON "media_upload_sessions" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "media_upload_sessions_org_status_idx" ON "media_upload_sessions" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "media_upload_sessions_expiry_idx" ON "media_upload_sessions" USING btree ("status","expires_at","lease_expires_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "social_mutation_operations_org_key_uniq" ON "social_mutation_operations" USING btree ("organization_id","target_type","target_id","operation_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "social_mutation_operations_target_active_uniq" ON "social_mutation_operations" USING btree ("organization_id","target_type","target_id") WHERE "social_mutation_operations"."status" IN ('pending', 'processing', 'request_may_have_been_sent', 'unknown');--> statement-breakpoint
CREATE INDEX "social_mutation_operations_due_idx" ON "social_mutation_operations" USING btree ("status","lease_expires_at","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_groups_account_provider_uniq" ON "whatsapp_groups" USING btree ("account_id","provider_group_id") WHERE "whatsapp_groups"."provider_group_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "whatsapp_groups_org_status_idx" ON "whatsapp_groups" USING btree ("organization_id","lifecycle_status","id");--> statement-breakpoint
CREATE INDEX "whatsapp_groups_provider_request_idx" ON "whatsapp_groups" USING btree ("account_id","provider_request_id") WHERE "whatsapp_groups"."provider_request_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_identity_aliases_account_bsuid_uniq" ON "whatsapp_identity_aliases" USING btree ("account_id","bsuid_hash");--> statement-breakpoint
CREATE INDEX "whatsapp_identity_aliases_wa_id_idx" ON "whatsapp_identity_aliases" USING btree ("account_id","wa_id_hash");--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_edit_state_check" CHECK ("inbox_messages"."edit_revision" >= 0
				AND ("inbox_messages"."edited_at" IS NULL OR ("inbox_messages"."edit_revision" > 0 AND "inbox_messages"."edited_at" >= "inbox_messages"."created_at"))
				AND ("inbox_messages"."provider_read_at" IS NULL OR "inbox_messages"."provider_read_at" >= "inbox_messages"."created_at")
				AND ("inbox_messages"."deleted_at" IS NULL OR "inbox_messages"."deleted_at" >= "inbox_messages"."created_at")
				AND "inbox_messages"."updated_at" >= "inbox_messages"."created_at");--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_edit_projection_check" CHECK (("post_targets"."last_edited_at" IS NULL AND "post_targets"."edit_revision" = 0)
				OR ("post_targets"."last_edited_at" IS NOT NULL
					AND "post_targets"."edit_revision" > 0
					AND "post_targets"."last_edited_at" <= "post_targets"."updated_at"));--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_platform_id_history_check" CHECK (jsonb_typeof("post_targets"."platform_post_id_history") = 'array');--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_delivery_projection_check" CHECK (("post_targets"."delivery_state" = 'queued')
				OR ("post_targets"."delivery_state" = 'in_flight'
					AND "post_targets"."status" = 'publishing'
					AND "post_targets"."attempt_id" IS NOT NULL
					AND "post_targets"."claimed_at" IS NOT NULL
					AND "post_targets"."lease_expires_at" IS NOT NULL
					AND "post_targets"."request_may_have_been_sent_at" IS NULL)
				OR ("post_targets"."delivery_state" = 'unknown'
					AND "post_targets"."status" = 'publishing'
					AND "post_targets"."attempt_id" IS NOT NULL
					AND "post_targets"."claimed_at" IS NOT NULL
					AND "post_targets"."request_may_have_been_sent_at" IS NOT NULL)
				OR ("post_targets"."delivery_state" = 'succeeded'
					AND (
						("post_targets"."status" = 'published' AND "post_targets"."published_at" IS NOT NULL)
						-- post_status is expanded earlier in this transaction; compare the
						-- freshly-added value through text until PostgreSQL commits it.
						OR ("post_targets"."status"::text = 'provider_draft'
							AND "post_targets"."provider_disposition" = 'provider_draft'
							AND "post_targets"."published_at" IS NULL)
					))
				OR ("post_targets"."delivery_state" = 'failed' AND "post_targets"."status" = 'failed'));--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_reconcile_attempts_nonnegative_check" CHECK ("post_targets"."reconcile_attempts" >= 0 AND "post_targets"."edit_revision" >= 0);--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_provider_disposition_check" CHECK ("post_targets"."provider_disposition" IS NULL OR "post_targets"."provider_disposition" IN ('published', 'provider_draft', 'sent', 'delivered', 'scheduled', 'accepted', 'processing', 'pending_review', 'awaiting_user_action', 'partial', 'failed', 'outcome_unknown'));--> statement-breakpoint
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_provider_disposition_check" CHECK ("publish_attempts"."provider_disposition" IS NULL OR "publish_attempts"."provider_disposition" IN ('published', 'provider_draft', 'sent', 'delivered', 'scheduled', 'accepted', 'processing', 'pending_review', 'awaiting_user_action', 'partial', 'failed', 'outcome_unknown'));
