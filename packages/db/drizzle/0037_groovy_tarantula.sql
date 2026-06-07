-- Make notification preferences per-organization.
-- Existing rows (one per user, no org) are back-filled to each user's earliest
-- organization membership; orphan rows (users with no membership) are removed.

-- 1. Add organization_id as NULLABLE first so the populated table doesn't fail.
ALTER TABLE "notification_preferences" ADD COLUMN "organization_id" text;--> statement-breakpoint

-- 2. Back-fill each existing row to the user's earliest organization membership.
UPDATE "notification_preferences" np
SET "organization_id" = (
	SELECT m."organizationId"
	FROM "auth"."member" m
	WHERE m."userId" = np."user_id"
	ORDER BY m."createdAt" ASC
	LIMIT 1
);--> statement-breakpoint

-- 3. Remove preference rows for users with no organization membership
--    (unreachable orphans — the settings UI always requires an active org).
DELETE FROM "notification_preferences" WHERE "organization_id" IS NULL;--> statement-breakpoint

-- 4. Swap the per-user unique constraint for a per-(user, organization) unique index.
ALTER TABLE "notification_preferences" DROP CONSTRAINT "notification_preferences_user_id_unique";--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "auth"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_user_org_idx" ON "notification_preferences" USING btree ("user_id","organization_id");--> statement-breakpoint

-- 5. Enforce NOT NULL now that every row has an organization_id.
ALTER TABLE "notification_preferences" ALTER COLUMN "organization_id" SET NOT NULL;
