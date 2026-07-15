export type MigrationJournalEntry = {
	idx: number;
	when: number;
	tag: string;
};

export type GeneratedMigrationIdentity = {
	folderMillis: number;
};

/**
 * Drizzle decides whether a migration is newer from its folder timestamp. A
 * duplicate or non-increasing `when` value can therefore pass a clean replay
 * yet be skipped on an existing database. Keep the journal a strict, ordered
 * sequence before deriving or comparing the protected manifest.
 */
export function assertOrderedMigrationHistory(
	entries: readonly MigrationJournalEntry[],
	migrations: readonly GeneratedMigrationIdentity[],
): void {
	if (entries.length !== migrations.length) {
		throw new Error(
			"The Drizzle journal and migration files have different lengths",
		);
	}

	const tags = new Set<string>();
	const timestamps = new Set<number>();
	let previousTimestamp = 0;

	for (const [index, entry] of entries.entries()) {
		if (entry.idx !== index) {
			throw new Error(
				`Migration journal index ${entry.idx} is invalid at position ${index}; indexes must be contiguous from zero`,
			);
		}
		if (!/^\d{4}_[a-z0-9_]+$/i.test(entry.tag)) {
			throw new Error(`Migration journal tag is invalid: ${entry.tag}`);
		}
		if (tags.has(entry.tag)) {
			throw new Error(`Migration journal tag is duplicated: ${entry.tag}`);
		}
		tags.add(entry.tag);

		if (!Number.isSafeInteger(entry.when) || entry.when <= 0) {
			throw new Error(
				`Migration ${entry.tag} has an invalid folder timestamp: ${entry.when}`,
			);
		}
		if (timestamps.has(entry.when)) {
			throw new Error(
				`Migration folder timestamp is duplicated: ${entry.when}`,
			);
		}
		if (index > 0 && entry.when <= previousTimestamp) {
			throw new Error(
				`Migration ${entry.tag} timestamp ${entry.when} must be greater than ${previousTimestamp}`,
			);
		}
		timestamps.add(entry.when);
		previousTimestamp = entry.when;

		const migration = migrations[index];
		if (!migration || migration.folderMillis !== entry.when) {
			throw new Error(`Migration journal mismatch at index ${entry.idx}`);
		}
	}
}
