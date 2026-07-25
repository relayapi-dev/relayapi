-- relayapi:contract-after-compatible-release
-- Expand the four automation-state checks only after code that understands the
-- new waiting and timeout values is ready to deploy.
ALTER TABLE "automation_entrypoints" DROP CONSTRAINT "automation_entrypoints_numeric_check";
--> statement-breakpoint
ALTER TABLE "automation_entrypoints" ADD CONSTRAINT "automation_entrypoints_numeric_check" CHECK (
	"reentry_cooldown_min" >= 0
	AND ("daily_cap" IS NULL OR "daily_cap" > 0)
	AND "specificity" >= 0
);
--> statement-breakpoint
ALTER TABLE "automation_runs" DROP CONSTRAINT "automation_runs_waiting_for_check";
--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_waiting_for_check" CHECK (
	"waiting_for" IS NULL
	OR "waiting_for" IN ('input', 'delay', 'inbound_event', 'external_event')
);
--> statement-breakpoint
ALTER TABLE "automation_scheduled_jobs" DROP CONSTRAINT "automation_scheduled_jobs_type_check";
--> statement-breakpoint
ALTER TABLE "automation_scheduled_jobs" ADD CONSTRAINT "automation_scheduled_jobs_type_check" CHECK (
	"job_type" IN ('resume_run', 'input_timeout', 'event_timeout', 'scheduled_trigger', 'webhook_reception_failure')
);
--> statement-breakpoint
ALTER TABLE "automation_step_runs" DROP CONSTRAINT "automation_step_runs_outcome_check";
--> statement-breakpoint
ALTER TABLE "automation_step_runs" ADD CONSTRAINT "automation_step_runs_outcome_check" CHECK (
	"outcome" IN ('ok', 'wait_input', 'wait_delay', 'wait_event', 'end', 'failed', 'graph_changed')
);
--> statement-breakpoint
-- Normalize the former Facebook conversation-starter placeholder into the
-- provider-backed Get Started binding. The enum value added in 0006 must be
-- committed before PostgreSQL allows rows to use it, hence this second file.
UPDATE "automation_bindings"
SET
	"binding_type" = 'get_started',
	"config" = jsonb_build_object(
		'payload',
		COALESCE(NULLIF("config" #>> '{starters,0,payload}', ''), 'GET_STARTED')
	),
	"updated_at" = now()
WHERE "binding_type" = 'conversation_starter';
--> statement-breakpoint
-- The old stub stored website destinations in `payload` and allowed nested
-- items that the provider-backed flat editor does not expose. Preserve each
-- top-level item in order while translating the URL field and dropping only
-- the never-published nested placeholder data.
UPDATE "automation_bindings" AS binding
SET
	"config" = jsonb_build_object(
		'items',
		CASE
			WHEN jsonb_typeof(binding."config" -> 'items') = 'array'
				AND jsonb_array_length(binding."config" -> 'items') > 0
			THEN (
				SELECT jsonb_agg(
					CASE
						WHEN item.value ->> 'action' = 'url' THEN
							jsonb_build_object(
								'label', COALESCE(item.value ->> 'label', ''),
								'action', 'url',
								'url', COALESCE(item.value ->> 'url', item.value ->> 'payload', '')
							)
						ELSE
							jsonb_build_object(
								'label', COALESCE(item.value ->> 'label', ''),
								'action', 'postback',
								'payload', COALESCE(item.value ->> 'payload', '')
							)
					END
					ORDER BY item.ordinality
				)
				FROM jsonb_array_elements(binding."config" -> 'items')
					WITH ORDINALITY AS item(value, ordinality)
			)
			ELSE jsonb_build_array(
				jsonb_build_object(
					'label', 'Help',
					'action', 'postback',
					'payload', 'HELP'
				)
			)
		END,
		'composer_input_disabled',
		CASE
			WHEN binding."channel" = 'facebook'
				AND binding."config" ->> 'composer_input_disabled' = 'true'
			THEN true
			ELSE false
		END
	),
	"updated_at" = now()
WHERE binding."binding_type" = 'main_menu';
--> statement-breakpoint
-- Every provider-owned binding needs one acknowledged synchronization after
-- rollout. Paused bindings deliberately enqueue a provider DELETE while
-- active/failed legacy rows enqueue a POST.
UPDATE "automation_bindings"
SET
	"desired_active" = ("status" <> 'paused'),
	"delete_after_sync" = false,
	"status" = 'pending_sync',
	"sync_revision" = "sync_revision" + 1,
	"sync_attempts" = 0,
	"last_enqueued_at" = NULL,
	"sync_error" = NULL,
	"updated_at" = now()
WHERE "binding_type" IN ('get_started', 'main_menu', 'ice_breaker');
