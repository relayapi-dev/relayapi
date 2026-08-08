export type AccountEmailKind =
	| "verify-email"
	| "reset-password"
	| "delete-account";

export type InternalEmailIntent =
	| {
			type: "organization_invitation";
			invitationId: string;
			occurrenceId: string;
	  }
	| {
			type: "account_action";
			kind: AccountEmailKind;
			authUserId: string;
			actionUrl: string;
			token: string;
	  };

export interface StagedEmailIntent {
	deliveryId: string;
	status: "staged";
}

/**
 * Minimal structural contract exposed by the API Worker's named
 * WorkerEntrypoint. It deliberately has no recipient, subject, or HTML fields.
 */
export interface EmailIntentService {
	stageEmailIntent(intent: InternalEmailIntent): Promise<StagedEmailIntent>;
}

export class EmailIntentClient {
	readonly #service: EmailIntentService;

	constructor(service: EmailIntentService) {
		this.#service = service;
	}

	stage(intent: InternalEmailIntent): Promise<StagedEmailIntent> {
		return this.#service.stageEmailIntent(intent);
	}
}

export function createEmailIntentClient(
	service: EmailIntentService,
): EmailIntentClient {
	return new EmailIntentClient(service);
}
