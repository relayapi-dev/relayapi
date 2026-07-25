-- relayapi:contract-after-compatible-release
-- Application deletion is compatible with both the old and new FK actions;
-- apply this contract only after that atomic lifecycle has been deployed.
DO $relay_identity_preflight$
BEGIN
	-- Fail fast instead of waiting in the opposite lock order from an active
	-- organization/member writer. Operators can retry once auth traffic drains.
	LOCK TABLE auth.organization, auth.member, auth.apikey
		IN SHARE ROW EXCLUSIVE MODE NOWAIT;

	IF EXISTS (
		SELECT 1
		FROM auth.organization AS organization_row
		WHERE organization_row.lifecycle_status = 'active'
			AND NOT EXISTS (
				SELECT 1
				FROM auth.member AS owner_member
				WHERE owner_member."organizationId" = organization_row.id
					AND 'owner' = ANY(string_to_array(replace(owner_member.role, ' ', ''), ','))
			)
	) THEN
		RAISE EXCEPTION 'identity migration preflight: active ownerless organization exists';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM auth.apikey AS key_row
		LEFT JOIN auth."user" AS user_row ON user_row.id = key_row."referenceId"
		WHERE key_row."referenceId" IS NOT NULL
			AND user_row.id IS NULL
	) THEN
		RAISE EXCEPTION 'identity migration preflight: orphan API key reference exists';
	END IF;
END;
$relay_identity_preflight$;--> statement-breakpoint
ALTER TABLE "auth"."account" DROP CONSTRAINT "account_userId_user_id_fk";
--> statement-breakpoint
ALTER TABLE "invite_tokens" DROP CONSTRAINT "invite_tokens_created_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "invite_tokens" DROP CONSTRAINT "invite_tokens_used_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "media" DROP CONSTRAINT "media_uploaded_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "posts" DROP CONSTRAINT "posts_created_by_user_id_fk";
--> statement-breakpoint
ALTER TABLE "auth"."session" DROP CONSTRAINT "session_userId_user_id_fk";
--> statement-breakpoint
ALTER TABLE "auth"."account" ADD CONSTRAINT "account_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."apikey" ADD CONSTRAINT "apikey_referenceId_user_id_fk" FOREIGN KEY ("referenceId") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_tokens" ADD CONSTRAINT "invite_tokens_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_tokens" ADD CONSTRAINT "invite_tokens_used_by_user_id_fk" FOREIGN KEY ("used_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth"."session" ADD CONSTRAINT "session_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "auth"."enforce_active_organization_owner"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, auth
AS $relay_active_organization_owner$
BEGIN
	IF NEW.lifecycle_status = 'active' AND NOT EXISTS (
		SELECT 1
		FROM auth.member AS owner_member
		WHERE owner_member."organizationId" = NEW.id
			AND 'owner' = ANY(string_to_array(replace(owner_member.role, ' ', ''), ','))
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'an active organization must have at least one owner',
			DETAIL = NEW.id;
	END IF;
	RETURN NEW;
END;
$relay_active_organization_owner$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "enforce_active_organization_owner_at_commit"
AFTER INSERT OR UPDATE OF "lifecycle_status"
ON "auth"."organization"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "auth"."enforce_active_organization_owner"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "auth"."enforce_organization_owner_invariant"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, auth
AS $relay_owner_invariant$
DECLARE
	organization_state text;
	owner_exit boolean := false;
	membership_exit boolean := false;
BEGIN
	IF TG_OP = 'INSERT' THEN
		-- Check before the tuple exists. If tenant erasure already owns the
		-- organization row this waits for its commit, observes tombstoned state,
		-- and prevents a late FK-valid membership from reviving local access.
		SELECT organization_row.lifecycle_status
		INTO organization_state
		FROM auth.organization AS organization_row
		WHERE organization_row.id = NEW."organizationId"
		FOR SHARE;
		IF NOT FOUND OR organization_state <> 'active' THEN
			RAISE EXCEPTION USING
				ERRCODE = '23514',
				MESSAGE = 'members may only be added to active organizations',
				DETAIL = NEW."organizationId";
		END IF;
		RETURN NEW;
	END IF;

	membership_exit := TG_OP = 'DELETE';
	owner_exit := membership_exit
		AND 'owner' = ANY(string_to_array(replace(OLD.role, ' ', ''), ','));
	IF TG_OP = 'UPDATE' THEN
		membership_exit := NEW."organizationId" IS DISTINCT FROM OLD."organizationId";
		owner_exit := 'owner' = ANY(string_to_array(replace(OLD.role, ' ', ''), ','))
			AND (
				membership_exit
				OR NOT ('owner' = ANY(string_to_array(replace(NEW.role, ' ', ''), ',')))
			);
	END IF;

	IF owner_exit THEN
		-- A row-level BEFORE trigger begins after PostgreSQL has locked OLD's
		-- member tuple. Keep the universally enforceable order aligned with
		-- identity and tenant deletion: member -> advisory -> organization.
		PERFORM pg_advisory_xact_lock(hashtext('relayapi:org-owner:' || OLD."organizationId"));

		-- The no-op parent update is an MVCC serialization fence. Under
		-- REPEATABLE READ/SERIALIZABLE, a waiter with a stale snapshot aborts instead
		-- of validating against pre-lock owner state; READ COMMITTED sees the winner.
		UPDATE auth.organization AS organization_row
		SET lifecycle_status = organization_row.lifecycle_status
		WHERE organization_row.id = OLD."organizationId"
		RETURNING organization_row.lifecycle_status INTO organization_state;

		-- Durable organization erasure marks the tenant non-active before deleting
		-- it. Do not make its cascading member deletion preserve an owner.
		IF FOUND AND organization_state = 'active' AND NOT EXISTS (
			SELECT 1
			FROM auth.member AS other_member
			WHERE other_member."organizationId" = OLD."organizationId"
				AND other_member.id <> OLD.id
				AND 'owner' = ANY(string_to_array(replace(other_member.role, ' ', ''), ','))
		) THEN
			RAISE EXCEPTION USING
				ERRCODE = '23514',
				MESSAGE = 'an active organization must retain at least one owner',
				DETAIL = OLD."organizationId";
		END IF;
	END IF;

	-- Credential/session state changes in the same statement as the membership
	-- exit. A rejected invariant or later statement failure rolls these back.
	IF membership_exit THEN
		UPDATE auth.apikey
		SET enabled = false, "updatedAt" = now()
		WHERE "organizationId" = OLD."organizationId"
			AND "referenceId" = OLD."userId"
			AND metadata ->> 'principal_type' = 'dashboard_user';

		UPDATE auth.session
		SET "activeOrganizationId" = NULL, "updatedAt" = now()
		WHERE "userId" = OLD."userId"
			AND "activeOrganizationId" = OLD."organizationId";
	END IF;

	RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$relay_owner_invariant$;--> statement-breakpoint
CREATE TRIGGER "enforce_organization_owner_before_write"
BEFORE INSERT OR DELETE OR UPDATE OF "role", "organizationId"
ON "auth"."member"
FOR EACH ROW
EXECUTE FUNCTION "auth"."enforce_organization_owner_invariant"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "auth"."delete_dashboard_principals_before_user"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, auth
AS $relay_delete_dashboard_principals$
BEGIN
	DELETE FROM auth.apikey
	WHERE "referenceId" = OLD.id
		AND metadata ->> 'principal_type' = 'dashboard_user';
	RETURN OLD;
END;
$relay_delete_dashboard_principals$;--> statement-breakpoint
CREATE TRIGGER "delete_dashboard_principals_before_user"
BEFORE DELETE ON "auth"."user"
FOR EACH ROW
EXECUTE FUNCTION "auth"."delete_dashboard_principals_before_user"();
