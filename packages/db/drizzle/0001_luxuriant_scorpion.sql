CREATE TYPE "public"."ad_connection_status" AS ENUM('pending', 'active', 'expired', 'revoked', 'error');--> statement-breakpoint
CREATE TABLE "ad_account_promotable_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"ad_account_id" text NOT NULL,
	"social_account_id" text,
	"provider_identity_id" text NOT NULL,
	"identity_type" text NOT NULL,
	"display_name" text,
	"status" text DEFAULT 'active' NOT NULL,
	"capabilities" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"scope_key" text GENERATED ALWAYS AS (CASE WHEN "workspace_id" IS NULL THEN 'org' ELSE 'ws/' || "workspace_id" END) STORED NOT NULL,
	"platform" "ad_platform" NOT NULL,
	"provider_principal_id" text NOT NULL,
	"display_name" text,
	"access_token" text,
	"refresh_token" text,
	"token_secret" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"status" "ad_connection_status" DEFAULT 'pending' NOT NULL,
	"credential_version" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb,
	"refresh_lease_expires_at" timestamp with time zone,
	"last_refresh_attempt_at" timestamp with time zone,
	"last_error" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_connections_id_org_uniq" UNIQUE("id","organization_id"),
	CONSTRAINT "ad_connections_id_org_scope_platform_uniq" UNIQUE("id","organization_id","scope_key","platform"),
	CONSTRAINT "ad_connections_credential_version_check" CHECK ("ad_connections"."credential_version" > 0),
	CONSTRAINT "ad_connections_revocation_state_check" CHECK (("ad_connections"."status" = 'revoked' AND "ad_connections"."revoked_at" IS NOT NULL)
				OR ("ad_connections"."status" <> 'revoked' AND "ad_connections"."revoked_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "ad_accounts" ALTER COLUMN "social_account_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "ad_connection_id" text;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "capabilities" jsonb;--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD COLUMN "capabilities_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ad_account_promotable_identities" ADD CONSTRAINT "ad_account_promotable_identities_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_account_promotable_identities" ADD CONSTRAINT "ad_account_promotable_identities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_account_promotable_identities" ADD CONSTRAINT "ad_account_promotable_identities_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_account_promotable_identities" ADD CONSTRAINT "ad_account_identities_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_account_promotable_identities" ADD CONSTRAINT "ad_account_identities_account_org_scope_fk" FOREIGN KEY ("ad_account_id","organization_id","scope_key") REFERENCES "public"."ad_accounts"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_connections" ADD CONSTRAINT "ad_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_connections" ADD CONSTRAINT "ad_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_connections" ADD CONSTRAINT "ad_connections_workspace_org_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_account_identities_provider_uniq" ON "ad_account_promotable_identities" USING btree ("ad_account_id","identity_type","provider_identity_id");--> statement-breakpoint
CREATE INDEX "ad_account_identities_social_idx" ON "ad_account_promotable_identities" USING btree ("social_account_id");--> statement-breakpoint
CREATE INDEX "ad_account_identities_account_idx" ON "ad_account_promotable_identities" USING btree ("ad_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_connections_principal_scope_uniq" ON "ad_connections" USING btree ("organization_id","scope_key","platform","provider_principal_id");--> statement-breakpoint
CREATE INDEX "ad_connections_org_status_idx" ON "ad_connections" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "ad_connections_refresh_due_idx" ON "ad_connections" USING btree ("status","access_token_expires_at","refresh_lease_expires_at");--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_connection_org_scope_platform_fk" FOREIGN KEY ("ad_connection_id","organization_id","scope_key","platform") REFERENCES "public"."ad_connections"("id","organization_id","scope_key","platform") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_accounts_connection_idx" ON "ad_accounts" USING btree ("ad_connection_id");--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_authority_check" CHECK ("ad_accounts"."ad_connection_id" IS NOT NULL OR "ad_accounts"."social_account_id" IS NOT NULL);