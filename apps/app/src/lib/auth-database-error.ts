type DatabaseErrorLike = {
	code?: unknown;
	message?: unknown;
	cause?: unknown;
};

function findDatabaseError(error: unknown): DatabaseErrorLike | null {
	let current = error;
	for (let depth = 0; depth < 4; depth += 1) {
		if (!current || typeof current !== "object") return null;
		const candidate = current as DatabaseErrorLike;
		if (typeof candidate.code === "string") return candidate;
		current = candidate.cause;
	}
	return null;
}

/** Map only RelayAPI's known auth invariants; unrelated DB errors stay opaque. */
export function mapAuthDatabaseError(error: unknown): Response | null {
	const databaseError = findDatabaseError(error);
	if (!databaseError) return null;

	if (databaseError.code === "40001") {
		return Response.json(
			{
				error: {
					code: "AUTH_WRITE_CONFLICT",
					message:
						"The authentication state changed concurrently. Retry the request.",
				},
			},
			{ status: 409, headers: { "Retry-After": "1" } },
		);
	}

	if (databaseError.code !== "23514") return null;
	if (
		databaseError.message ===
		"an active organization must retain at least one owner"
	) {
		return Response.json(
			{
				error: {
					code: "SOLE_ORGANIZATION_OWNER",
					message:
						"Transfer ownership or delete the organization before removing its sole owner.",
				},
			},
			{ status: 409 },
		);
	}
	if (
		databaseError.message ===
		"an active organization must have at least one owner"
	) {
		return Response.json(
			{
				error: {
					code: "ORGANIZATION_OWNER_REQUIRED",
					message:
						"Organization creation could not be completed. Retry the request.",
				},
			},
			{ status: 409, headers: { "Retry-After": "1" } },
		);
	}
	if (
		databaseError.message ===
		"members may only be added to active organizations"
	) {
		return Response.json(
			{
				error: {
					code: "ORGANIZATION_NOT_ACTIVE",
					message: "Members cannot be added while an organization is deleting.",
				},
			},
			{ status: 409 },
		);
	}
	if (databaseError.message === "members may only be added for active users") {
		return Response.json(
			{
				error: {
					code: "USER_NOT_ACTIVE",
					message:
						"Your account is not currently authorized to accept this invitation.",
				},
			},
			{ status: 401 },
		);
	}
	return null;
}
