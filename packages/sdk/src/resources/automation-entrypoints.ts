// SDK resource for automation entrypoints (Unit 7 — §9.2 of the design spec).
// Mirrors apps/api/src/routes/automation-entrypoints.ts.
//
// Entrypoints are mounted two ways:
//   - POST / GET /v1/automations/{id}/entrypoints  (automation-scoped create + list)
//   - GET / PATCH / DELETE /v1/automation-entrypoints/{id}
//   - POST /v1/automation-entrypoints/{id}/rotate-secret
//   - GET /v1/automation-entrypoints/{id}/insights

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

export type AutomationEntrypointKind =
	| "dm_received"
	| "keyword"
	| "comment_created"
	| "story_reply"
	| "story_mention"
	| "live_comment"
	| "ad_click"
	| "ref_link_click"
	| "share_to_dm"
	| "follow"
	| "schedule"
	| "field_changed"
	| "tag_applied"
	| "tag_removed"
	| "conversion_event"
	| "webhook_inbound";

export interface AutomationEntrypointResponse {
	id: string;
	automation_id: string;
	channel: AutomationChannel;
	kind: string;
	status: string;
	social_account_id: string | null;
	config: Record<string, unknown> | null;
	filters: Record<string, unknown> | null;
	allow_reentry: boolean;
	reentry_cooldown_min: number;
	priority: number;
	specificity: number;
	created_at: string;
	updated_at: string;
}

/**
 * Returned from create / rotate-secret for `webhook_inbound` entrypoints.
 * `webhook_secret_plaintext` is only ever present on these two endpoints and
 * must be captured by the caller — it is never readable again.
 */
export interface AutomationEntrypointCreateResponse
	extends AutomationEntrypointResponse {
	webhook_secret_plaintext?: string;
}

export interface AutomationEntrypointListResponse {
	data: AutomationEntrypointResponse[];
}

export interface AutomationEntrypointCreateParams {
	channel: AutomationChannel;
	kind: AutomationEntrypointKind;
	social_account_id?: string;
	config?: Record<string, unknown>;
	filters?: Record<string, unknown>;
	allow_reentry?: boolean;
	reentry_cooldown_min?: number;
	priority?: number;
}

export interface AutomationEntrypointUpdateParams
	extends Partial<AutomationEntrypointCreateParams> {
	status?: "active" | "paused";
}

// ---------------------------------------------------------------------------
// Resource
// ---------------------------------------------------------------------------

export class AutomationEntrypoints extends APIResource {
	/**
	 * List entrypoints for an automation, ordered by specificity DESC,
	 * priority ASC, created_at ASC (same order used by the runtime matcher).
	 */
	list(
		automationId: string,
		options?: RequestOptions,
	): APIPromise<AutomationEntrypointListResponse> {
		return this._client.get(
			path`/v1/automations/${automationId}/entrypoints`,
			options,
		);
	}

	/**
	 * Create an entrypoint under an automation. For `webhook_inbound` kinds the
	 * server auto-generates slug + HMAC secret and returns the plaintext secret
	 * inline — capture it on the response or call `rotateSecret` later.
	 */
	create(
		automationId: string,
		body: AutomationEntrypointCreateParams,
		options?: RequestOptions,
	): APIPromise<AutomationEntrypointCreateResponse> {
		return this._client.post(
			path`/v1/automations/${automationId}/entrypoints`,
			{ body, ...options },
		);
	}

	retrieve(
		id: string,
		options?: RequestOptions,
	): APIPromise<AutomationEntrypointResponse> {
		return this._client.get(path`/v1/automation-entrypoints/${id}`, options);
	}

	update(
		id: string,
		body: AutomationEntrypointUpdateParams,
		options?: RequestOptions,
	): APIPromise<AutomationEntrypointResponse> {
		return this._client.patch(path`/v1/automation-entrypoints/${id}`, {
			body,
			...options,
		});
	}

	delete(id: string, options?: RequestOptions): APIPromise<void> {
		return this._client.delete(path`/v1/automation-entrypoints/${id}`, {
			...options,
			headers: buildHeaders([{ Accept: "*/*" }, options?.headers]),
		});
	}

	/**
	 * Rotate the HMAC secret for a `webhook_inbound` entrypoint. The new
	 * plaintext secret is returned in the response and cannot be retrieved
	 * afterwards.
	 */
	rotateSecret(
		id: string,
		options?: RequestOptions,
	): APIPromise<AutomationEntrypointCreateResponse> {
		return this._client.post(
			path`/v1/automation-entrypoints/${id}/rotate-secret`,
			options,
		);
	}

	insights(
		id: string,
		query?: AutomationInsightsParams,
		options?: RequestOptions,
	): APIPromise<AutomationInsightsResponse> {
		return this._client.get(
			path`/v1/automation-entrypoints/${id}/insights`,
			{ query, ...options },
		);
	}
}
