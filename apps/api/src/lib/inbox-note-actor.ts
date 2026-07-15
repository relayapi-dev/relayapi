export type InboxNoteActor = {
	actorType: "dashboard_user" | "service";
	actorId: string;
	userId: string | null;
};

/** Derive immutable note ownership solely from the authenticated credential. */
export function resolveInboxNoteActor(input: {
	principalType: "dashboard_user" | "service";
	principalId: string | null;
	keyId: string;
}): InboxNoteActor {
	if (input.principalType === "dashboard_user") {
		if (!input.principalId) {
			throw new Error(
				"Authenticated dashboard principal is missing its user id",
			);
		}
		return {
			actorType: "dashboard_user",
			actorId: input.principalId,
			userId: input.principalId,
		};
	}

	return {
		actorType: "service",
		actorId: input.keyId,
		userId: null,
	};
}
