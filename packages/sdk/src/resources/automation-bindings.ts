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
	| "get_started"
	| "main_menu"
	| "ice_breaker";

export type AutomationBindingStatus =
	| "active"
	| "paused";

export interface GetStartedBindingConfig {
	payload: string;
}

export type MainMenuBindingItem =
	| { label: string; action: "postback"; payload: string }
	| { label: string; action: "url"; url: string };

export interface MainMenuBindingConfig {
	items: MainMenuBindingItem[];
	composer_input_disabled?: boolean;
}

export interface IceBreakerBindingConfig {
	questions: Array<{ question: string; payload: string }>;
}

export type AutomationBindingConfig =
	| Record<string, never>
	| GetStartedBindingConfig
	| MainMenuBindingConfig
	| IceBreakerBindingConfig;

export interface AutomationBindingResponse {
	id: string;
	organization_id: string;
	workspace_id: string | null;
	social_account_id: string;
	channel: AutomationChannel;
	/**
	 * Read-compatible with legacy rows. New writes accept only
	 * `AutomationBindingType`.
	 */
	binding_type: string;
	automation_id: string;
	config: Record<string, unknown> | null;
	status: string;
	desired_active: boolean;
	delete_after_sync: boolean;
	sync_revision: number;
	last_synced_revision: number;
	sync_attempts: number;
	last_synced_at: string | null;
	sync_error: string | null;
	created_at: string;
	updated_at: string;
	/**
	 * Account hydration populated by list/retrieve so clients can render a real
	 * handle/avatar instead of a truncated id. Omitted on create/update.
	 */
	social_account?: {
		id: string;
		handle: string | null;
		display_name: string | null;
		avatar_url: string | null;
	} | null;
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

interface AutomationBindingCreateBase {
	social_account_id: string;
	automation_id: string;
	workspace_id?: string;
}

export type AutomationBindingCreateParams = AutomationBindingCreateBase &
	(
		| {
				channel: AutomationChannel;
				binding_type: "default_reply" | "welcome_message";
				config?: Record<string, never>;
		  }
		| {
				channel: "facebook";
				binding_type: "get_started";
				config: GetStartedBindingConfig;
		  }
		| {
				channel: "instagram" | "facebook";
				binding_type: "main_menu";
				config: MainMenuBindingConfig;
		  }
		| {
				channel: "instagram";
				binding_type: "ice_breaker";
				config: IceBreakerBindingConfig;
		  }
	);

export interface AutomationBindingUpdateParams {
	automation_id?: string;
	config?: AutomationBindingConfig;
	status?: AutomationBindingStatus;
}

// ---------------------------------------------------------------------------
// Resource
// ---------------------------------------------------------------------------

export class AutomationBindings extends APIResource {
	/**
	 * List bindings. The hydrated `social_account` is scoped to the caller's org
	 * — a binding pointing at a foreign account hydrates to `null` rather than
	 * leaking its handle/display_name/avatar.
	 */
	list(
		query: AutomationBindingListParams | null | undefined = {},
		options?: RequestOptions,
	): APIPromise<AutomationBindingListResponse> {
		return this._client.get("/v1/automation-bindings", {
			query,
			...options,
		});
	}

	/**
	 * Create a binding. Throws `404 NOT_FOUND` when `social_account_id`
	 * references a social account not owned by the caller's org.
	 */
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

	/**
	 * Update a binding's automation, config, or desired active/paused state. The
	 * binding's account, channel, workspace, and type are immutable.
	 */
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
