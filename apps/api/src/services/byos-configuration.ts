import {
	type Database,
	generateId,
	media,
	storageCredentials,
	storageLocations,
} from "@relayapi/db";
import { and, desc, eq, isNull, lte, max, or, sql } from "drizzle-orm";
import type { Env } from "../types";
import { probeByosCredential } from "./storage-locator";

const PROBE_LEASE_MS = 5 * 60 * 1000;

export type ByosConfigurationView = {
	location: typeof storageLocations.$inferSelect;
	credential: typeof storageCredentials.$inferSelect;
};

type ByosConfigurationTransaction = Parameters<
	Parameters<Database["transaction"]>[0]
>[0];

export type StageByosConfigurationInput = {
	organizationId: string;
	endpoint: string;
	bucket: string;
	region: string;
	keyPrefix: string;
	forcePathStyle: boolean;
	encryptedAccessKeyId: string;
	encryptedSecretAccessKey: string;
	now?: Date;
};

export type ProbedByosCredentialClaim = ByosConfigurationView & {
	probeToken: string;
};

export type ByosProbeResult =
	| { kind: "failed"; view: ByosConfigurationView }
	| { kind: "ready"; claim: ProbedByosCredentialClaim };

export class ByosConfigurationNotFoundError extends Error {}
export class ByosProbeInProgressError extends Error {}
export class ByosActivationConflictError extends Error {}
export class ByosObjectsExistError extends Error {}

function lockOrganization(organizationId: string) {
	return sql`SELECT pg_advisory_xact_lock(hashtextextended(${`relayapi:byos:${organizationId}`}, 0))`;
}

async function loadCredentialView(
	db: Database,
	input: {
		organizationId: string;
		state?: "staged" | "active" | "retired" | "failed";
		credentialId?: string;
	},
): Promise<ByosConfigurationView | null> {
	const conditions = [
		eq(storageCredentials.organizationId, input.organizationId),
	];
	if (input.state) conditions.push(eq(storageCredentials.state, input.state));
	if (input.credentialId) {
		conditions.push(eq(storageCredentials.id, input.credentialId));
	}
	const [view] = await db
		.select({
			location: storageLocations,
			credential: storageCredentials,
		})
		.from(storageCredentials)
		.innerJoin(
			storageLocations,
			and(
				eq(storageLocations.id, storageCredentials.locationId),
				eq(storageLocations.organizationId, storageCredentials.organizationId),
			),
		)
		.where(and(...conditions))
		.orderBy(desc(storageCredentials.createdAt), desc(storageCredentials.id))
		.limit(1);
	return view ?? null;
}

export async function getCurrentByosConfiguration(
	db: Database,
	organizationId: string,
): Promise<ByosConfigurationView | null> {
	return (
		(await loadCredentialView(db, {
			organizationId,
			state: "staged",
		})) ??
		(await loadCredentialView(db, {
			organizationId,
			state: "active",
		}))
	);
}

/**
 * Insert a new immutable location when routing changes and always append a
 * staged credential version. A newer stage safely supersedes an older one;
 * neither operation touches the active credential used by existing objects.
 */
export async function stageByosConfiguration(
	db: Database,
	input: StageByosConfigurationInput,
): Promise<ByosConfigurationView> {
	return db.transaction((tx) => stageByosConfigurationInTransaction(tx, input));
}

/** Stage a candidate inside a caller-owned transaction. */
export async function stageByosConfigurationInTransaction(
	tx: ByosConfigurationTransaction,
	input: StageByosConfigurationInput,
): Promise<ByosConfigurationView> {
	const now = input.now ?? new Date();
	const credentialId = generateId("scred_");
	await tx.execute(lockOrganization(input.organizationId));
	const [existingLocation] = await tx
		.select()
		.from(storageLocations)
		.where(
			and(
				eq(storageLocations.organizationId, input.organizationId),
				eq(storageLocations.endpoint, input.endpoint),
				eq(storageLocations.bucket, input.bucket),
				eq(storageLocations.region, input.region),
				eq(storageLocations.keyPrefix, input.keyPrefix),
				eq(storageLocations.forcePathStyle, input.forcePathStyle),
				isNull(storageLocations.retiredAt),
			),
		)
		.for("update")
		.limit(1);
	const location =
		existingLocation ??
		(
			await tx
				.insert(storageLocations)
				.values({
					id: generateId("sloc_"),
					organizationId: input.organizationId,
					endpoint: input.endpoint,
					bucket: input.bucket,
					region: input.region,
					keyPrefix: input.keyPrefix,
					forcePathStyle: input.forcePathStyle,
				})
				.returning()
		)[0];
	if (!location) throw new Error("Failed to insert BYOS storage location");

	await tx
		.update(storageCredentials)
		.set({
			state: "failed",
			probeToken: null,
			probeLeaseExpiresAt: null,
			lastTestedAt: now,
			lastErrorCode: "superseded",
			updatedAt: now,
		})
		.where(
			and(
				eq(storageCredentials.organizationId, input.organizationId),
				eq(storageCredentials.state, "staged"),
			),
		);

	const [versionRow] = await tx
		.select({ value: max(storageCredentials.version) })
		.from(storageCredentials)
		.where(eq(storageCredentials.locationId, location.id));
	const version = (versionRow?.value ?? 0) + 1;
	const [credential] = await tx
		.insert(storageCredentials)
		.values({
			id: credentialId,
			locationId: location.id,
			organizationId: input.organizationId,
			version,
			accessKeyId: input.encryptedAccessKeyId,
			secretAccessKey: input.encryptedSecretAccessKey,
			state: "staged",
		})
		.returning();
	if (!credential) throw new Error("Failed to stage BYOS credential");
	return { location, credential };
}

async function claimStagedCredential(
	db: Database,
	organizationId: string,
	now: Date,
): Promise<ByosConfigurationView & { probeToken: string }> {
	return db.transaction(async (tx) => {
		await tx.execute(lockOrganization(organizationId));
		const [candidate] = await tx
			.select()
			.from(storageCredentials)
			.where(
				and(
					eq(storageCredentials.organizationId, organizationId),
					eq(storageCredentials.state, "staged"),
				),
			)
			.orderBy(desc(storageCredentials.createdAt), desc(storageCredentials.id))
			.for("update")
			.limit(1);
		if (!candidate) throw new ByosConfigurationNotFoundError();
		if (
			candidate.probeToken &&
			candidate.probeLeaseExpiresAt &&
			candidate.probeLeaseExpiresAt > now
		) {
			throw new ByosProbeInProgressError();
		}
		const probeToken = crypto.randomUUID();
		const [claimed] = await tx
			.update(storageCredentials)
			.set({
				probeToken,
				probeLeaseExpiresAt: new Date(now.getTime() + PROBE_LEASE_MS),
				updatedAt: now,
			})
			.where(
				and(
					eq(storageCredentials.id, candidate.id),
					eq(storageCredentials.state, "staged"),
					or(
						isNull(storageCredentials.probeToken),
						lte(storageCredentials.probeLeaseExpiresAt, now),
					),
				),
			)
			.returning();
		if (!claimed) throw new ByosProbeInProgressError();
		const [location] = await tx
			.select()
			.from(storageLocations)
			.where(
				and(
					eq(storageLocations.id, claimed.locationId),
					eq(storageLocations.organizationId, organizationId),
				),
			)
			.limit(1);
		if (!location) throw new ByosActivationConflictError();
		return { location, credential: claimed, probeToken };
	});
}

async function failStagedCredential(
	db: Database,
	claim: ByosConfigurationView & { probeToken: string },
	errorCode: string,
	now: Date,
): Promise<ByosConfigurationView> {
	return db.transaction(async (tx) => {
		await tx.execute(lockOrganization(claim.credential.organizationId));
		const [failed] = await tx
			.update(storageCredentials)
			.set({
				state: "failed",
				probeToken: null,
				probeLeaseExpiresAt: null,
				lastTestedAt: now,
				lastErrorCode: errorCode,
				updatedAt: now,
			})
			.where(
				and(
					eq(storageCredentials.id, claim.credential.id),
					eq(storageCredentials.state, "staged"),
					eq(storageCredentials.probeToken, claim.probeToken),
				),
			)
			.returning();
		if (!failed) throw new ByosActivationConflictError();
		return { location: claim.location, credential: failed };
	});
}

async function activateStagedCredential(
	db: Database,
	claim: ProbedByosCredentialClaim,
	now: Date,
): Promise<ByosConfigurationView> {
	return db.transaction((tx) =>
		activateProbedByosCredentialInTransaction(tx, claim, now),
	);
}

/**
 * Activate an exact successful probe claim inside a caller-owned transaction.
 * The claim token prevents a stale probe from activating a replacement stage.
 */
export async function activateProbedByosCredentialInTransaction(
	tx: ByosConfigurationTransaction,
	claim: ProbedByosCredentialClaim,
	now: Date = new Date(),
): Promise<ByosConfigurationView> {
	const organizationId = claim.credential.organizationId;
	await tx.execute(lockOrganization(organizationId));
	const [candidate] = await tx
		.select()
		.from(storageCredentials)
		.where(
			and(
				eq(storageCredentials.id, claim.credential.id),
				eq(storageCredentials.state, "staged"),
				eq(storageCredentials.probeToken, claim.probeToken),
			),
		)
		.for("update")
		.limit(1);
	if (!candidate) throw new ByosActivationConflictError();

	const [oldActive] = await tx
		.select()
		.from(storageCredentials)
		.where(
			and(
				eq(storageCredentials.organizationId, organizationId),
				eq(storageCredentials.state, "active"),
			),
		)
		.for("update")
		.limit(1);
	if (oldActive) {
		await tx
			.update(storageCredentials)
			.set({
				state: "retired",
				retiredAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(storageCredentials.id, oldActive.id),
					eq(storageCredentials.state, "active"),
				),
			);
		if (oldActive.locationId !== candidate.locationId) {
			await tx
				.update(storageLocations)
				.set({ retiredAt: now })
				.where(
					and(
						eq(storageLocations.id, oldActive.locationId),
						eq(storageLocations.organizationId, organizationId),
						isNull(storageLocations.retiredAt),
					),
				);
		}
	}
	const [activatedLocation] = await tx
		.update(storageLocations)
		.set({
			activatedAt: sql`COALESCE(${storageLocations.activatedAt}, ${now})`,
		})
		.where(
			and(
				eq(storageLocations.id, candidate.locationId),
				eq(storageLocations.organizationId, organizationId),
				isNull(storageLocations.retiredAt),
			),
		)
		.returning({ id: storageLocations.id });
	if (!activatedLocation) throw new ByosActivationConflictError();
	const [active] = await tx
		.update(storageCredentials)
		.set({
			state: "active",
			probeToken: null,
			probeLeaseExpiresAt: null,
			lastTestedAt: now,
			lastErrorCode: null,
			activatedAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(storageCredentials.id, candidate.id),
				eq(storageCredentials.state, "staged"),
				eq(storageCredentials.probeToken, claim.probeToken),
			),
		)
		.returning();
	if (!active) throw new ByosActivationConflictError();
	return { location: claim.location, credential: active };
}

/**
 * Probe outside the database transaction, then commit activation with the
 * exact claim token. Failure only terminalizes the staged candidate; the prior
 * active credential and location remain untouched.
 */
export async function testAndActivateStagedByosConfiguration(
	db: Database,
	env: Env,
	organizationId: string,
	classifyError: (error: unknown) => string,
	now: Date = new Date(),
): Promise<ByosConfigurationView> {
	const probe = await probeStagedByosConfiguration(
		db,
		env,
		organizationId,
		classifyError,
		now,
	);
	if (probe.kind === "failed") return probe.view;
	return activateStagedCredential(db, probe.claim, new Date());
}

/**
 * Claim and probe outside the final activation transaction. Callers must fence
 * the exact issuer again when committing a successful claim.
 */
export async function probeStagedByosConfiguration(
	db: Database,
	env: Env,
	organizationId: string,
	classifyError: (error: unknown) => string,
	now: Date = new Date(),
): Promise<ByosProbeResult> {
	const claim = await claimStagedCredential(db, organizationId, now);
	try {
		await probeByosCredential(db, env, {
			organizationId,
			locationId: claim.credential.locationId,
			credentialVersion: claim.credential.version,
		});
	} catch (error) {
		const view = await failStagedCredential(
			db,
			claim,
			classifyError(error),
			new Date(),
		);
		return { kind: "failed", view };
	}
	return { kind: "ready", claim };
}

export async function removeUnusedByosConfiguration(
	db: Database,
	organizationId: string,
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.execute(lockOrganization(organizationId));
		const [object] = await tx
			.select({ id: media.id })
			.from(media)
			.where(
				and(
					eq(media.organizationId, organizationId),
					eq(media.storageProvider, "byos"),
				),
			)
			.limit(1);
		if (object) throw new ByosObjectsExistError();
		await tx
			.delete(storageCredentials)
			.where(eq(storageCredentials.organizationId, organizationId));
		await tx
			.delete(storageLocations)
			.where(eq(storageLocations.organizationId, organizationId));
	});
}
