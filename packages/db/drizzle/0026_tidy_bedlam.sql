CREATE TABLE "contact_segment_memberships" (
	"contact_id" text NOT NULL,
	"segment_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_segment_memberships_pk" PRIMARY KEY("contact_id","segment_id")
);
--> statement-breakpoint
ALTER TABLE "inbox_conversations" ADD COLUMN "assigned_user_id" text;--> statement-breakpoint
ALTER TABLE "contact_segment_memberships" ADD CONSTRAINT "contact_segment_memberships_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_segment_memberships" ADD CONSTRAINT "contact_segment_memberships_segment_id_segments_id_fk" FOREIGN KEY ("segment_id") REFERENCES "public"."segments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_segment_memberships" ADD CONSTRAINT "contact_segment_memberships_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_segment_memberships" ADD CONSTRAINT "contact_segment_memberships_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_segment_memberships_org_idx" ON "contact_segment_memberships" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "contact_segment_memberships_segment_idx" ON "contact_segment_memberships" USING btree ("segment_id");--> statement-breakpoint
CREATE INDEX "contact_segment_memberships_contact_idx" ON "contact_segment_memberships" USING btree ("contact_id");--> statement-breakpoint
ALTER TABLE "inbox_conversations" ADD CONSTRAINT "inbox_conversations_assigned_user_id_user_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_conv_assigned_user_idx" ON "inbox_conversations" USING btree ("assigned_user_id");