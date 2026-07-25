ALTER TYPE "public"."automation_binding_type" ADD VALUE 'get_started' BEFORE 'main_menu';--> statement-breakpoint
CREATE TABLE "automation_conversion_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"automation_id" text NOT NULL,
	"run_id" text NOT NULL,
	"contact_id" text NOT NULL,
	"occurrence_id" text NOT NULL,
	"event_name" text NOT NULL,
	"value" text,
	"currency" varchar(3),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_entrypoint_daily_counts" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"scope_key" text DEFAULT 'org' NOT NULL,
	"entrypoint_id" text NOT NULL,
	"day" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_entrypoint_daily_counts_day_check" CHECK ("automation_entrypoint_daily_counts"."day" ~ '^\d{4}-\d{2}-\d{2}$'),
	CONSTRAINT "automation_entrypoint_daily_counts_count_check" CHECK ("automation_entrypoint_daily_counts"."count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "automation_bindings" ADD COLUMN "desired_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_bindings" ADD COLUMN "delete_after_sync" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_bindings" ADD COLUMN "sync_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_bindings" ADD COLUMN "last_synced_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_bindings" ADD COLUMN "sync_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "automation_bindings" ADD COLUMN "last_enqueued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automation_entrypoints" ADD COLUMN "daily_cap" integer;--> statement-breakpoint
ALTER TABLE "automation_entrypoints" ADD CONSTRAINT "automation_entrypoints_id_org_scope_uniq" UNIQUE("id","organization_id","scope_key");--> statement-breakpoint
ALTER TABLE "automation_conversion_events" ADD CONSTRAINT "automation_conversion_events_run_org_scope_fk" FOREIGN KEY ("run_id","organization_id","scope_key") REFERENCES "public"."automation_runs"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_conversion_events" ADD CONSTRAINT "automation_conversion_events_automation_org_scope_fk" FOREIGN KEY ("automation_id","organization_id","scope_key") REFERENCES "public"."automations"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_conversion_events" ADD CONSTRAINT "automation_conversion_events_contact_org_scope_fk" FOREIGN KEY ("contact_id","organization_id","scope_key") REFERENCES "public"."contacts"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_entrypoint_daily_counts" ADD CONSTRAINT "automation_entrypoint_daily_counts_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_entrypoint_daily_counts" ADD CONSTRAINT "automation_entrypoint_daily_counts_entrypoint_org_scope_fk" FOREIGN KEY ("entrypoint_id","organization_id","scope_key") REFERENCES "public"."automation_entrypoints"("id","organization_id","scope_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_conversion_events_occurrence_uniq" ON "automation_conversion_events" USING btree ("occurrence_id");--> statement-breakpoint
CREATE INDEX "automation_conversion_events_org_created_idx" ON "automation_conversion_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_conversion_events_contact_created_idx" ON "automation_conversion_events" USING btree ("contact_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_entrypoint_daily_counts_entrypoint_day_uniq" ON "automation_entrypoint_daily_counts" USING btree ("entrypoint_id","day");--> statement-breakpoint
CREATE INDEX "automation_entrypoint_daily_counts_org_day_idx" ON "automation_entrypoint_daily_counts" USING btree ("organization_id","day");--> statement-breakpoint
ALTER TABLE "automation_bindings" ADD CONSTRAINT "automation_bindings_sync_counters_check" CHECK ("automation_bindings"."sync_revision" >= 0
				AND "automation_bindings"."last_synced_revision" >= 0
				AND "automation_bindings"."last_synced_revision" <= "automation_bindings"."sync_revision"
				AND "automation_bindings"."sync_attempts" >= 0);--> statement-breakpoint
CREATE TRIGGER "project_automation_entrypoint_daily_counts_entrypoint_id"
BEFORE INSERT OR UPDATE OF "entrypoint_id", "organization_id", "scope_key"
ON public."automation_entrypoint_daily_counts"
FOR EACH ROW
EXECUTE FUNCTION public."project_parent_identity"('automation_entrypoints', 'entrypoint_id', 'scope_key:scope_key');
--> statement-breakpoint
CREATE TRIGGER "project_automation_conversion_events_run_id"
BEFORE INSERT OR UPDATE OF "run_id", "organization_id", "scope_key"
ON public."automation_conversion_events"
FOR EACH ROW
EXECUTE FUNCTION public."project_parent_identity"('automation_runs', 'run_id', 'scope_key:scope_key');
