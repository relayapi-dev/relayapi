CREATE TABLE "contact_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"contact_id" text NOT NULL,
	"social_account_id" text NOT NULL,
	"platform" text NOT NULL,
	"identifier" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text,
	"email" text,
	"phone" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"opted_in" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_field_values" DROP CONSTRAINT IF EXISTS "custom_field_values_contact_id_whatsapp_contacts_id_fk";--> statement-breakpoint
ALTER TABLE "whatsapp_contact_group_members" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "whatsapp_contact_groups" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "whatsapp_contacts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "whatsapp_contact_group_members" CASCADE;--> statement-breakpoint
DROP TABLE "whatsapp_contact_groups" CASCADE;--> statement-breakpoint
DROP TABLE "whatsapp_contacts" CASCADE;
--> statement-breakpoint
ALTER TABLE "inbox_conversations" ADD COLUMN "contact_id" text;--> statement-breakpoint
ALTER TABLE "contact_channels" ADD CONSTRAINT "contact_channels_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_channels" ADD CONSTRAINT "contact_channels_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_channels_contact_idx" ON "contact_channels" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_channels_account_identifier_idx" ON "contact_channels" USING btree ("social_account_id","identifier");--> statement-breakpoint
CREATE INDEX "contacts_org_idx" ON "contacts" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "contacts_workspace_idx" ON "contacts" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_conversations" ADD CONSTRAINT "inbox_conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_conv_contact_idx" ON "inbox_conversations" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_workspace_email_idx" ON "contacts" USING btree ("workspace_id","email") WHERE "email" IS NOT NULL;