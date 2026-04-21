// SDK resource for automation bindings (Unit 7 — §9.4 of the design spec).
// Mirrors apps/api/src/routes/automation-bindings.ts.

import { APIResource } from "../core/resource";
import { APIPromise } from "../core/api-promise";
import { buildHeaders } from "../internal/headers";
import { RequestOptions } from "../internal/request-options";
import { path } from "../internal/utils/path";
import type {
	AutomationChannel,
	AutomationInsightsParams,
	AutomationInsightsResponse,
} from "./automations";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutomationBindingType =
	| "default_reply"
	| "welcome_message"
	| "conversation_starter"
	| "main_menu"
	| "ice_breaker";

export type AutomationBindingStatus =
	| "active"
	| "paused"
	| "pending_sync"
	| "sync_failed";

export interface AutomationBindingResponse {
	id: string;
	organization_id: string;
	workspace_id: string | null;
	social_account_id: string;
	channel: AutomationChannel;
	binding_type: AutomationBindingType;
	automation_id: string;
	config: Record<string, unknown> | null;
	status: string;
	last_synced_at: string | null;
	sync_error: string | null;
	created_at: string;
	updated_at: string;
}

export interface AutomationBindingListResponse {
	data: AutomationBindingResponse[];
}

export interface AutomationBindingListParams {
	social_account_id?: string;
	binding_type?: AutomationBindingType;
	automation_id?: string;
	workspace_id?: string;
}

export interface AutomationBindingCreateParams {
	social_account_id: string;
	channel: AutomationChannel;
	binding_type: AutomationBindingType;
	automation_id: string;
	config?: Record<string, unknown>;
	workspace_id?: string;
}

export interface AutomationBindingUpdateParams
	extends Partial<AutomationBindingCreateParams> {
	status?: AutomationBindingStatus;
}

// ---------------------------------------------------------------------------
// Resource
// ---------------------------------------------------------------------------

export class AutomationBindings extends APIResource {
	list(
		query: AutomationBindingListParams | null | undefined = {},
		options?: RequestOptions,
	): APIPromise<AutomationBindingListResponse> {
		return this._client.get("/v1/automation-bindings", {
			query,
			...options,
		});
	}

	create(
		body: AutomationBindingCreateParams,
		options?: RequestOptions,
	): APIPromise<AutomationBindingResponse> {
		return this._client.post("/v1/automation-bindings", { body, ...options });
	}

	retrieve(
		id: string,
		options?: RequestOptions,
	): APIPromise<AutomationBindingResponse> {
		return this._client.get(path`/v1/automation-bindings/${id}`, options);
	}

	update(
		id: string,
		body: AutomationBindingUpdateParams,
		options?: RequestOptions,
	): APIPromise<AutomationBindingResponse> {
		return this._client.patch(path`/v1/automation-bindings/${id}`, {
			body,
			...options,
		});
	}

	delete(id: string, options?: RequestOptions): APIPromise<void> {
		return this._client.delete(path`/v1/automation-bindings/${id}`, {
			...options,
			headers: buildHeaders([{ Accept: "*/*" }, options?.headers]),
		});
	}

	insights(
		id: string,
		query?: AutomationInsightsParams,
		options?: RequestOptions,
	): APIPromise<AutomationInsightsResponse> {
		return this._client.get(path`/v1/automation-bindings/${id}/insights`, {
			query,
			...options,
		});
	}
}
