-- Drop legacy automation tables (13) and enums (7)
DROP TABLE IF EXISTS "automation_scheduled_ticks" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "automation_run_logs" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "automation_contact_controls" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "automation_bindings" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "automation_enrollments" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "automation_edges" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "automation_nodes" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "automation_versions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "automation_triggers" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "automations" CASCADE;--> statement-breakpoint

-- Drop enums (IF EXISTS is enum-safe via DROP TYPE)
DROP TYPE IF EXISTS "automation_trigger_type" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "automation_node_type" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "automation_status" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "automation_enrollment_status" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "automation_binding_type" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "automation_contact_control_status" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "automation_channel" CASCADE;
