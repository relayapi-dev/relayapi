// SDK resource for automation runs + step runs (Unit 7 — §9.5 of the design spec).
// Mirrors apps/api/src/routes/automation-runs.ts.

import { APIResource } from "../core/resource";
import { APIPromise } from "../core/api-promise";
import { RequestOptions } from "../internal/request-options";
import { path } from "../internal/utils/path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutomationRunStatus =
	| "active"
	| "waiting"
	| "completed"
	| "exited"
	| "failed";

export interface AutomationRunResponse {
	id: string;
	automation_id: string;
	organization_id: string;
	entrypoint_id: string | null;
	binding_id: string | null;
	contact_id: string;
	conversation_id: string | null;
	status: string;
	current_node_key: string | null;
	current_port_key: string | null;
	context: Record<string, unknown> | null;
	waiting_until: string | null;
	waiting_for: string | null;
	exit_reason: string | null;
	started_at: string;
	completed_at: string | null;
	updated_at: string;
}

export interface AutomationRunStepResponse {
	id: string;
	run_id: string;
	automation_id: string;
	node_key: string;
	node_kind: string;
	entered_via_port_key: string | null;
	exited_via_port_key: string | null;
	outcome: string;
	duration_ms: number;
	payload: unknown | null;
	error: unknown | null;
	executed_at: string;
}

export interface AutomationRunListResponse {
	data: AutomationRunResponse[];
	next_cursor: string | null;
	has_more: boolean;
}

export interface AutomationRunStepListResponse {
	data: AutomationRunStepResponse[];
	next_cursor: string | null;
	has_more: boolean;
}

export interface AutomationRunListParams {
	cursor?: string;
	limit?: number;
	status?: AutomationRunStatus;
	contact_id?: string;
	started_after?: string;
	started_before?: string;
}

export interface AutomationRunStepListParams {
	cursor?: string;
	limit?: number;
}

// ---------------------------------------------------------------------------
// Resource
// ---------------------------------------------------------------------------

export class AutomationRuns extends APIResource {
	/**
	 * List runs for an automation, newest-first. Supports cursor pagination on
	 * `started_at`.
	 */
	list(
		automationId: string,
		query: AutomationRunListParams | null | undefined = {},
		options?: RequestOptions,
	): APIPromise<AutomationRunListResponse> {
		return this._client.get(path`/v1/automations/${automationId}/runs`, {
			query,
			...options,
		});
	}

	/**
	 * Retrieve a run by id (includes the current run context JSON).
	 */
	retrieve(
		id: string,
		options?: RequestOptions,
	): APIPromise<AutomationRunResponse> {
		return this._client.get(path`/v1/automation-runs/${id}`, options);
	}

	/**
	 * List the append-only step log for a run (oldest-first).
	 */
	listSteps(
		id: string,
		query: AutomationRunStepListParams | null | undefined = {},
		options?: RequestOptions,
	): APIPromise<AutomationRunStepListResponse> {
		return this._client.get(path`/v1/automation-runs/${id}/steps`, {
			query,
			...options,
		});
	}

	/**
	 * Force-exit an active or waiting run. Sets status=exited, exit_reason=admin_stopped.
	 */
	stop(id: string, options?: RequestOptions): APIPromise<AutomationRunResponse> {
		return this._client.post(path`/v1/automation-runs/${id}/stop`, options);
	}
}
