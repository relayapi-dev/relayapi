CREATE TABLE "inbox_conversation_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inbox_conversation_notes" ADD CONSTRAINT "inbox_conversation_notes_conversation_id_inbox_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."inbox_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_conversation_notes" ADD CONSTRAINT "inbox_conversation_notes_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_conversation_notes" ADD CONSTRAINT "inbox_conversation_notes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inbox_note_conv_created_idx" ON "inbox_conversation_notes" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "inbox_note_org_idx" ON "inbox_conversation_notes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "inbox_note_user_idx" ON "inbox_conversation_notes" USING btree ("user_id");