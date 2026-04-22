// Hand-written scaffold for the Manychat-parity automation API (Unit 7 + 8).
// When the OpenAPI spec is regenerated via Stainless, this file will be replaced
// by the generated equivalent. Until then, this shim matches the routes in
// apps/api/src/routes/automations.ts plus the mounted sub-routers (entrypoints,
// bindings, runs, contact controls).

import { APIResource } from "../core/resource";
import { APIPromise } from "../core/api-promise";
import { buildHeaders } from "../internal/headers";
import { RequestOptions } from "../internal/request-options";
import { path } from "../internal/utils/path";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type AutomationChannel =
	| "instagram"
	| "facebook"
	| "whatsapp"
	| "telegram";

export type AutomationStatus = "draft" | "active" | "paused" | "archived";

export interface ValidationError {
	node_key?: string;
	port_key?: string;
	edge_index?: number;
	code: string;
	message: string;
}

export interface AutomationValidation {
	valid: boolean;
	errors: ValidationError[];
	warnings: ValidationError[];
}

// -- Graph -----------------------------------------------------------------

export interface AutomationPort {
	key: string;
	direction: "input" | "output";
	role?: string;
	label?: string;
}

export interface AutomationNode {
	key: string;
	kind: string;
	title?: string;
	canvas_x?: number;
	canvas_y?: number;
	config: Record<string, unknown>;
	ports: AutomationPort[];
	ui_state?: Record<string, unknown>;
}

export interface AutomationEdge {
	from_node: string;
	from_port: string;
	to_node: string;
	to_port: string;
	order_index?: number;
	metadata?: Record<string, unknown>;
}

export interface AutomationGraph {
	schema_version: 1;
	root_node_key: string | null;
	nodes: AutomationNode[];
	edges: AutomationEdge[];
}

// -- Responses -------------------------------------------------------------

export interface AutomationResponse {
	id: string;
	organization_id: string;
	workspace_id: string | null;
	name: string;
	description: string | null;
	channel: AutomationChannel;
	status: AutomationStatus;
	graph: AutomationGraph;
	created_from_template: string | null;
	template_config: Record<string, unknown> | null;
	total_enrolled: number;
	total_completed: number;
	total_exited: number;
	total_failed: number;
	last_validated_at: string | null;
	validation_errors: ValidationError[] | null;
	created_by: string | null;
	created_at: string;
	updated_at: string;
}

export interface AutomationListResponse {
	data: AutomationResponse[];
	next_cursor: string | null;
	has_more: boolean;
}

export interface AutomationGraphUpdateResponse {
	graph: AutomationGraph;
	validation: AutomationValidation;
	automation: {
		status: AutomationStatus;
		validation_errors: ValidationError[] | null;
	};
}

export interface AutomationEnrollResponse {
	run_id: string;
}

export interface AutomationSimulateStep {
	node_key: string;
	node_kind: string;
	entered_via_port_key: string | null;
	exited_via_port_key: string | null;
	outcome: "advance" | "wait_input" | "wait_delay" | "end" | "fail";
	payload?: unknown;
}

export interface AutomationSimulateResponse {
	steps: AutomationSimulateStep[];
	ended_at_node: string | null;
	exit_reason: string;
}

// -- Catalog ---------------------------------------------------------------

export interface AutomationCatalogResponse {
	node_kinds: Array<Record<string, unknown>>;
	entrypoint_kinds: Array<Record<string, unknown>>;
	binding_types: Array<Record<string, unknown>>;
	action_types: Array<Record<string, unknown>>;
	channel_capabilities: Record<string, unknown>;
	template_kinds: string[];
}

// -- Insights --------------------------------------------------------------

export interface AutomationInsightsResponse {
	period: { from: string; to: string };
	totals: {
		enrolled: number;
		completed: number;
		exited: number;
		failed: number;
		active: number;
		waiting: number;
		avg_duration_ms: number;
	};
	exit_reasons: Array<{ reason: string; count: number }>;
	by_entrypoint: Array<{
		entrypoint_id: string | null;
		kind: string | null;
		runs: number;
		completion_rate: number;
	}>;
	per_node: Array<{
		node_key: string;
		kind: string;
		executions: number;
		success_rate: number;
		/**
		 * Breakdown of exit-port usage for this node within the period.
		 * Keys are `exited_via_port_key` values (e.g. `"next"`,
		 * `"button.btn_large"`); values are counts. Empty object when the
		 * node has no recorded exit ports in the window.
		 */
		per_port: Record<string, number>;
	}>;
}

// -- Params ----------------------------------------------------------------

export interface AutomationListParams {
	cursor?: string;
	limit?: number;
	workspace_id?: string;
	status?: AutomationStatus;
	channel?: AutomationChannel;
	created_from_template?: string;
	q?: string;
}

export interface AutomationTemplateInput {
	kind: string;
	config?: Record<string, unknown>;
}

export interface AutomationCreateParams {
	name: string;
	description?: string;
	channel: AutomationChannel;
	workspace_id?: string;
	template?: AutomationTemplateInput;
}

export interface AutomationUpdateParams {
	name?: string;
	description?: string;
}

export interface AutomationGraphUpdateParams {
	graph: AutomationGraph;
}

export interface AutomationEnrollParams {
	contact_id: string;
	entrypoint_id?: string;
	/**
	 * Pin the triggering social account for this manual enrollment.
	 * Required for multi-account workspaces where the contact has
	 * channels across several accounts on the same platform — without
	 * it, outbound sends may route through the wrong account.
	 */
	social_account_id?: string;
	context_overrides?: Record<string, unknown>;
}

export interface AutomationSimulateParams {
	start_node_key?: string;
	test_context?: Record<string, unknown>;
	branch_choices?: Record<string, string>;
	execute_side_effects?: boolean;
}

export type InsightsPeriod = "24h" | "7d" | "30d" | "90d" | "custom";

export interface AutomationInsightsParams {
	period?: InsightsPeriod;
	from?: string;
	to?: string;
}

export interface AutomationGlobalInsightsParams extends AutomationInsightsParams {
	created_from_template?: string;
	workspace_id?: string;
}

// ---------------------------------------------------------------------------
// Resource
// ---------------------------------------------------------------------------

export class Automations extends APIResource {
	/**
	 * List automations scoped to the authenticated org/workspace.
	 */
	list(
		query: AutomationListParams | null | undefined = {},
		options?: RequestOptions,
	): APIPromise<AutomationListResponse> {
		return this._client.get("/v1/automations", { query, ...options });
	}

	/**
	 * Create an automation, optionally expanding a template blueprint.
	 */
	create(
		body: AutomationCreateParams,
		options?: RequestOptions,
	): APIPromise<AutomationResponse> {
		return this._client.post("/v1/automations", { body, ...options });
	}

	/**
	 * Retrieve an automation (includes the full graph).
	 */
	retrieve(
		id: string,
		options?: RequestOptions,
	): APIPromise<AutomationResponse> {
		return this._client.get(path`/v1/automations/${id}`, options);
	}

	/**
	 * Update automation metadata (name, description).
	 */
	update(
		id: string,
		body: AutomationUpdateParams | null | undefined = {},
		options?: RequestOptions,
	): APIPromise<AutomationResponse> {
		return this._client.patch(path`/v1/automations/${id}`, {
			body,
			...options,
		});
	}

	/**
	 * Delete an automation (hard delete — cascades to entrypoints and runs).
	 */
	delete(id: string, options?: RequestOptions): APIPromise<void> {
		return this._client.delete(path`/v1/automations/${id}`, {
			...options,
			headers: buildHeaders([{ Accept: "*/*" }, options?.headers]),
		});
	}

	// -- Lifecycle ---------------------------------------------------------

	activate(id: string, options?: RequestOptions): APIPromise<AutomationResponse> {
		return this._client.post(path`/v1/automations/${id}/activate`, options);
	}

	pause(id: string, options?: RequestOptions): APIPromise<AutomationResponse> {
		return this._client.post(path`/v1/automations/${id}/pause`, options);
	}

	resume(id: string, options?: RequestOptions): APIPromise<AutomationResponse> {
		return this._client.post(path`/v1/automations/${id}/resume`, options);
	}

	archive(id: string, options?: RequestOptions): APIPromise<AutomationResponse> {
		return this._client.post(path`/v1/automations/${id}/archive`, options);
	}

	unarchive(
		id: string,
		options?: RequestOptions,
	): APIPromise<AutomationResponse> {
		return this._client.post(path`/v1/automations/${id}/unarchive`, options);
	}

	// -- Graph + execution -------------------------------------------------

	/**
	 * Replace the automation's graph. Returns the canonicalised graph plus the
	 * validation result; a graph with fatal errors yields 422 and, for active
	 * automations, force-pauses the automation.
	 */
	updateGraph(
		id: string,
		body: AutomationGraphUpdateParams,
		options?: RequestOptions,
	): APIPromise<AutomationGraphUpdateResponse> {
		return this._client.put(path`/v1/automations/${id}/graph`, {
			body,
			...options,
		});
	}

	/**
	 * Manually enroll a contact into an active automation.
	 */
	enroll(
		id: string,
		body: AutomationEnrollParams,
		options?: RequestOptions,
	): APIPromise<AutomationEnrollResponse> {
		return this._client.post(path`/v1/automations/${id}/enroll`, {
			body,
			...options,
		});
	}

	/**
	 * Dry-run the graph without executing handlers or performing side effects.
	 */
	simulate(
		id: string,
		body: AutomationSimulateParams | null | undefined = {},
		options?: RequestOptions,
	): APIPromise<AutomationSimulateResponse> {
		return this._client.post(path`/v1/automations/${id}/simulate`, {
			body,
			...options,
		});
	}

	// -- Catalog + insights ------------------------------------------------

	/**
	 * Static catalog of node kinds, entrypoint kinds, binding types, action
	 * types, channel capabilities, and template kinds.
	 */
	catalog(options?: RequestOptions): APIPromise<AutomationCatalogResponse> {
		return this._client.get("/v1/automations/catalog", options);
	}

	/**
	 * Aggregate run metrics. If `id` is omitted, returns the org-wide roll-up
	 * (optionally filtered by `created_from_template` or `workspace_id`); if an
	 * `id` is provided, scopes the query to a single automation.
	 */
	insights(
		id: string | null | undefined,
		query?: AutomationInsightsParams | AutomationGlobalInsightsParams,
		options?: RequestOptions,
	): APIPromise<AutomationInsightsResponse> {
		if (id) {
			return this._client.get(path`/v1/automations/${id}/insights`, {
				query,
				...options,
			});
		}
		return this._client.get("/v1/automations/insights", {
			query,
			...options,
		});
	}
}
