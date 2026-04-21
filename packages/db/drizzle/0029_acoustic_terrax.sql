CREATE TYPE "public"."automation_binding_type" AS ENUM('welcome_message', 'default_reply');--> statement-breakpoint
CREATE TYPE "public"."automation_contact_control_status" AS ENUM('paused');--> statement-breakpoint
CREATE TABLE "automation_bindings" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"binding_type" "automation_binding_type" NOT NULL,
	"channel" "automation_channel" NOT NULL,
	"social_account_id" text,
	"automation_id" text NOT NULL,
	"trigger_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_contact_controls" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"automation_id" text,
	"contact_id" text,
	"conversation_id" text,
	"status" "automation_contact_control_status" DEFAULT 'paused' NOT NULL,
	"reason" text,
	"expires_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automation_bindings" ADD CONSTRAINT "automation_bindings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_bindings" ADD CONSTRAINT "automation_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_bindings" ADD CONSTRAINT "automation_bindings_social_account_id_social_accounts_id_fk" FOREIGN KEY ("social_account_id") REFERENCES "public"."social_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_bindings" ADD CONSTRAINT "automation_bindings_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_bindings" ADD CONSTRAINT "automation_bindings_trigger_id_automation_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."automation_triggers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_contact_controls" ADD CONSTRAINT "automation_contact_controls_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_contact_controls" ADD CONSTRAINT "automation_contact_controls_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_bindings_org_idx" ON "automation_bindings" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "automation_bindings_auto_idx" ON "automation_bindings" USING btree ("automation_id");--> statement-breakpoint
CREATE INDEX "automation_bindings_scope_idx" ON "automation_bindings" USING btree ("organization_id","binding_type","channel","social_account_id");--> statement-breakpoint
CREATE INDEX "automation_bindings_workspace_idx" ON "automation_bindings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "automation_contact_controls_org_idx" ON "automation_contact_controls" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "automation_contact_controls_contact_idx" ON "automation_contact_controls" USING btree ("organization_id","contact_id","status");--> statement-breakpoint
CREATE INDEX "automation_contact_controls_conversation_idx" ON "automation_contact_controls" USING btree ("organization_id","conversation_id","status");--> statement-breakpoint
CREATE INDEX "automation_contact_controls_auto_idx" ON "automation_contact_controls" USING btree ("organization_id","automation_id","status");