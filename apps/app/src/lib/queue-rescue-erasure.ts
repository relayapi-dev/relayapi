interface QueueRescueLocator {
	kind: "workspace" | "user" | "contact" | "account";
	id: string;
}

export interface QueueRescueUserCleanupOptions {
	maxPagesPerOrganization?: number;
	pageSize?: number;
}

export interface QueueRescueErasureBucket {
	list(options: {
		prefix: string;
		limit: number;
		cursor?: string;
		include: ["customMetadata"];
	}): Promise<{
		objects: Array<{
			key: string;
			customMetadata?: Record<string, string>;
		}>;
		truncated: boolean;
		cursor?: string;
	}>;
	delete(keys: string[]): Promise<void>;
}

function safeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180) || "unknown";
}

function hasUserLocator(encoded: string | undefined, userId: string): boolean {
	if (!encoded) return false;
	try {
		const locators = JSON.parse(encoded) as unknown;
		return (
			Array.isArray(locators) &&
			locators.some((value) => {
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					return false;
				}
				const locator = value as Partial<QueueRescueLocator>;
				return locator.kind === "user" && locator.id === userId;
			})
		);
	} catch {
		return false;
	}
}

/**
 * Remove application-encrypted terminal queue evidence addressed to a deleted
 * identity. R2 has no secondary index, so metadata is scanned only beneath each
 * tenant prefix and every page is bounded. The bucket lifecycle remains the
 * 30-day hard backstop when R2 is temporarily unavailable.
 */
export async function deleteUserQueueRescueEvidence(
	bucket: QueueRescueErasureBucket,
	organizationIds: readonly string[],
	userId: string,
	options?: QueueRescueUserCleanupOptions,
): Promise<number> {
	const maxPages = Math.min(
		Math.max(Math.trunc(options?.maxPagesPerOrganization ?? 20), 1),
		100,
	);
	const pageSize = Math.min(
		Math.max(Math.trunc(options?.pageSize ?? 500), 1),
		1_000,
	);
	let deleted = 0;

	for (const organizationId of [...new Set(organizationIds)].sort()) {
		let cursor: string | undefined;
		let complete = false;
		for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
			const page = await bucket.list({
				prefix: `queue-rescue/by-organization/${safeSegment(organizationId)}/`,
				limit: pageSize,
				...(cursor ? { cursor } : {}),
				include: ["customMetadata"],
			});
			const matchingKeys = page.objects
				.filter((object) =>
					hasUserLocator(object.customMetadata?.subjectLocators, userId),
				)
				.map((object) => object.key);
			if (matchingKeys.length > 0) {
				await bucket.delete(matchingKeys);
				deleted += matchingKeys.length;
			}
			if (!page.truncated) {
				complete = true;
				break;
			}
			cursor = page.cursor;
			if (!cursor) break;
		}
		if (!complete) {
			throw new Error(
				`Queue rescue user cleanup exceeded ${maxPages} bounded pages`,
			);
		}
	}

	return deleted;
}
