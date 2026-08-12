import { APIPromise } from "../core/api-promise";
import { APIResource } from "../core/resource";
import type { RequestOptions } from "../internal/request-options";
import { path } from "../internal/utils/path";

export interface StagedEmailResponse {
	delivery_id: string;
	status: "staged";
}

export interface OnDemandPlatformRequest {
	platform: string;
	name?: string;
	email: string;
	message?: string;
}

export class EmailIntents extends APIResource {
	resendInvitation(
		id: string,
		options: RequestOptions & { idempotencyKey: string },
	): APIPromise<StagedEmailResponse> {
		return this._client.post(path`/v1/invitations/${id}/resend`, {
			...options,
			idempotencyKey: options.idempotencyKey,
		});
	}

	requestOnDemandPlatform(
		body: OnDemandPlatformRequest,
		options: RequestOptions & { idempotencyKey: string },
	): APIPromise<StagedEmailResponse> {
		return this._client.post("/v1/support/on-demand-platform-requests", {
			body,
			...options,
			idempotencyKey: options.idempotencyKey,
		});
	}
}
