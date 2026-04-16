CREATE TYPE "public"."idea_activity_action" AS ENUM('created', 'moved', 'assigned', 'commented', 'converted', 'updated', 'media_added', 'media_removed', 'tagged', 'untagged');--> statement-breakpoint
CREATE TYPE "public"."idea_media_type" AS ENUM('image', 'video', 'gif', 'document');--> statement-breakpoint
CREATE TABLE "idea_activity" (
	"id" text PRIMARY KEY NOT NULL,
	"idea_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" "idea_activity_action" NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idea_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"idea_id" text NOT NULL,
	"author_id" text NOT NULL,
	"content" text NOT NULL,
	"parent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idea_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"name" text NOT NULL,
	"position" real DEFAULT 0 NOT NULL,
	"color" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idea_media" (
	"id" text PRIMARY KEY NOT NULL,
	"idea_id" text NOT NULL,
	"url" text NOT NULL,
	"type" "idea_media_type" NOT NULL,
	"alt" text,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idea_tags" (
	"idea_id" text NOT NULL,
	"tag_id" text NOT NULL,
	CONSTRAINT "idea_tags_idea_id_tag_id_pk" PRIMARY KEY("idea_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "ideas" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"title" text,
	"content" text,
	"group_id" text NOT NULL,
	"position" real DEFAULT 0 NOT NULL,
	"assigned_to" text,
	"converted_to_post_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_tags" (
	"post_id" text NOT NULL,
	"tag_id" text NOT NULL,
	CONSTRAINT "post_tags_post_id_tag_id_pk" PRIMARY KEY("post_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"workspace_id" text,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "idea_activity" ADD CONSTRAINT "idea_activity_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_activity" ADD CONSTRAINT "idea_activity_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_comments" ADD CONSTRAINT "idea_comments_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_comments" ADD CONSTRAINT "idea_comments_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_comments" ADD CONSTRAINT "idea_comments_parent_id_idea_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."idea_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_groups" ADD CONSTRAINT "idea_groups_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_groups" ADD CONSTRAINT "idea_groups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_media" ADD CONSTRAINT "idea_media_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_tags" ADD CONSTRAINT "idea_tags_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idea_tags" ADD CONSTRAINT "idea_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_group_id_idea_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."idea_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_assigned_to_user_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_converted_to_post_id_posts_id_fk" FOREIGN KEY ("converted_to_post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_tags" ADD CONSTRAINT "post_tags_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_tags" ADD CONSTRAINT "post_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idea_activity_idea_idx" ON "idea_activity" USING btree ("idea_id");--> statement-breakpoint
CREATE INDEX "idea_activity_idea_created_idx" ON "idea_activity" USING btree ("idea_id","created_at");--> statement-breakpoint
CREATE INDEX "idea_comments_idea_idx" ON "idea_comments" USING btree ("idea_id");--> statement-breakpoint
CREATE INDEX "idea_comments_parent_idx" ON "idea_comments" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idea_groups_org_idx" ON "idea_groups" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "idea_groups_workspace_idx" ON "idea_groups" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idea_groups_workspace_position_idx" ON "idea_groups" USING btree ("workspace_id","position");--> statement-breakpoint
CREATE INDEX "idea_media_idea_idx" ON "idea_media" USING btree ("idea_id");--> statement-breakpoint
CREATE INDEX "ideas_org_idx" ON "ideas" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ideas_workspace_idx" ON "ideas" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "ideas_group_position_idx" ON "ideas" USING btree ("group_id","position");--> statement-breakpoint
CREATE INDEX "ideas_assigned_to_idx" ON "ideas" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "ideas_org_created_idx" ON "ideas" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "tags_org_idx" ON "tags" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "tags_workspace_idx" ON "tags" USING btree ("workspace_id");