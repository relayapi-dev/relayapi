CREATE TYPE "public"."automation_status" AS ENUM('draft', 'active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."automation_channel" AS ENUM('instagram', 'facebook', 'whatsapp', 'telegram', 'tiktok');--> statement-breakpoint
CREATE TYPE "public"."automation_binding_type" AS ENUM('default_reply', 'welcome_message', 'conversation_starter', 'main_menu', 'ice_breaker');--> statement-breakpoint
CREATE TYPE "public"."automation_run_status" AS ENUM('active', 'waiting', 'completed', 'exited', 'failed');
