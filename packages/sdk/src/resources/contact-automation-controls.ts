// SDK resource for per-contact automation pause controls (Unit 7 — §9.6 of the
// design spec). Mirrors apps/api/src/routes/contact-automation-controls.ts.
//
// Pauses can be either global (automation_id = null → blocks ALL automations
// for the contact) or per-automation. The server enforces at most one global
// row and one row per (contact_id, automation_id).

import { APIResource } from "../core/resource";
import { APIPromise } from "../core/api-promise";
import { buildHeaders } from "../internal/headers";
import { RequestOptions } from "../internal/request-options";
import { path } from "../internal/utils/path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContactAutomationControlResponse {
	id: string;
	organization_id: string;
	contact_id: string;
	automation_id: string | null;
	pause_reason: string | null;
	paused_until: string | null;
	paused_by_user_id: string | null;
	created_at: string;
	updated_at: string;
}

export interface ContactAutomationControlListResponse {
	data: ContactAutomationControlResponse[];
}

export interface ContactAutomationPauseParams {
	/** Omit for a global pause (blocks all automations for this contact). */
	automation_id?: string;
	pause_reason?: string;
	paused_until?: string;
}

export interface ContactAutomationResumeParams {
	/** Omit to clear the global pause. */
	automation_id?: string;
}

// ---------------------------------------------------------------------------
// Resource
// ---------------------------------------------------------------------------

export class ContactAutomationControls extends APIResource {
	/**
	 * List pause controls for a contact (global + per-automation).
	 */
	list(
		contactId: string,
		options?: RequestOptions,
	): APIPromise<ContactAutomationControlListResponse> {
		return this._client.get(
			path`/v1/contacts/${contactId}/automation-controls`,
			options,
		);
	}

	/**
	 * Upsert a pause row. Omit `automation_id` for a global pause.
	 */
	pause(
		contactId: string,
		body: ContactAutomationPauseParams | null | undefined = {},
		options?: RequestOptions,
	): APIPromise<ContactAutomationControlResponse> {
		return this._client.post(
			path`/v1/contacts/${contactId}/automation-pause`,
			{ body: body ?? {}, ...options },
		);
	}

	/**
	 * Delete a pause row. Omit `automation_id` to clear the global pause.
	 */
	resume(
		contactId: string,
		body: ContactAutomationResumeParams | null | undefined = {},
		options?: RequestOptions,
	): APIPromise<void> {
		return this._client.post(
			path`/v1/contacts/${contactId}/automation-resume`,
			{
				body: body ?? {},
				...options,
				headers: buildHeaders([{ Accept: "*/*" }, options?.headers]),
			},
		);
	}
}
