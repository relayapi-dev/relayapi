export interface AvatarObjectBucket {
	list(options: { prefix: string; limit?: number; cursor?: string }): Promise<{
		objects: Array<{ key: string }>;
		truncated?: boolean;
		cursor?: string;
	}>;
	delete(keys: string[]): Promise<void>;
}

function subjectSegment(id: string): string {
	return encodeURIComponent(id);
}

export function userAvatarPrefix(userId: string): string {
	return `user/${subjectSegment(userId)}/`;
}

export function organizationLogoPrefix(organizationId: string): string {
	return `organization/${subjectSegment(organizationId)}/`;
}

export async function deleteAvatarObjectPrefix(
	bucket: AvatarObjectBucket,
	prefix: string,
	options?: { maxPages?: number },
): Promise<number> {
	const maxPages = Math.min(
		Math.max(Math.trunc(options?.maxPages ?? 20), 1),
		100,
	);
	let cursor: string | undefined;
	let deleted = 0;
	for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
		const page = await bucket.list({
			prefix,
			limit: 1_000,
			...(cursor ? { cursor } : {}),
		});
		const keys = page.objects.map(({ key }) => key);
		if (keys.length > 0) {
			await bucket.delete(keys);
			deleted += keys.length;
		}
		if (!page.truncated) return deleted;
		cursor = page.cursor;
		if (!cursor) break;
	}
	throw new Error(`Avatar prefix cleanup exceeded ${maxPages} bounded pages`);
}
