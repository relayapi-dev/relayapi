import {
	type Database,
	type QueueScheduleSlot,
	queueSchedules,
} from "@relayapi/db";
import { and, asc, eq, sql } from "drizzle-orm";

const QUEUE_SCHEDULE_CACHE_TTL_SECONDS = 5 * 60;
const QUEUE_SCHEDULE_CACHE_VERSION = 1;

export interface StoredQueueSchedule {
	id: string;
	name: string | null;
	slots: QueueScheduleSlot[];
	is_default: boolean;
	created_at: string;
	updated_at: string;
}

interface QueueScheduleCacheEnvelope {
	version: typeof QUEUE_SCHEDULE_CACHE_VERSION;
	schedules: StoredQueueSchedule[];
}

function queueScheduleCacheKey(organizationId: string): string {
	return `queue-schedule:${organizationId}`;
}

function serializeQueueSchedule(
	row: typeof queueSchedules.$inferSelect,
): StoredQueueSchedule {
	return {
		id: row.id,
		name: row.name,
		slots: row.slots,
		is_default: row.isDefault,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}

async function refreshQueueScheduleCache(
	kv: KVNamespace,
	organizationId: string,
	rows: StoredQueueSchedule[],
): Promise<void> {
	await kv.put(
		queueScheduleCacheKey(organizationId),
		JSON.stringify({
			version: QUEUE_SCHEDULE_CACHE_VERSION,
			schedules: rows,
		} satisfies QueueScheduleCacheEnvelope),
		{ expirationTtl: QUEUE_SCHEDULE_CACHE_TTL_SECONDS },
	);
}

async function readAuthoritativeQueueSchedules(
	db: Database,
	organizationId: string,
): Promise<StoredQueueSchedule[]> {
	const rows = await db
		.select()
		.from(queueSchedules)
		.where(eq(queueSchedules.organizationId, organizationId))
		.orderBy(
			sql`${queueSchedules.isDefault} DESC`,
			asc(queueSchedules.createdAt),
			asc(queueSchedules.id),
		);
	return rows.map(serializeQueueSchedule);
}

/**
 * PostgreSQL is authoritative. KV is only a five-minute read cache and every
 * mutation invalidates/rebuilds it; loss or expiry cannot remove schedules.
 */
export async function listQueueSchedules(
	db: Database,
	kv: KVNamespace,
	organizationId: string,
): Promise<StoredQueueSchedule[]> {
	const cached = await kv
		.get<QueueScheduleCacheEnvelope>(
			queueScheduleCacheKey(organizationId),
			"json",
		)
		.catch(() => null);
	if (
		cached?.version === QUEUE_SCHEDULE_CACHE_VERSION &&
		Array.isArray(cached.schedules)
	) {
		return cached.schedules;
	}

	const rows = await readAuthoritativeQueueSchedules(db, organizationId);
	await refreshQueueScheduleCache(kv, organizationId, rows).catch(() => {});
	return rows;
}

export async function createQueueSchedule(
	db: Database,
	kv: KVNamespace,
	input: {
		organizationId: string;
		name: string | null;
		slots: QueueScheduleSlot[];
	},
): Promise<StoredQueueSchedule> {
	const created = await db.transaction(async (tx) => {
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtext(${`relayapi:queue-schedule:${input.organizationId}`}))`,
		);
		const [existing] = await tx
			.select({ id: queueSchedules.id })
			.from(queueSchedules)
			.where(eq(queueSchedules.organizationId, input.organizationId))
			.limit(1);
		const [row] = await tx
			.insert(queueSchedules)
			.values({
				organizationId: input.organizationId,
				name: input.name,
				slots: input.slots,
				isDefault: existing === undefined,
			})
			.returning();
		if (!row) throw new Error("Queue schedule insert returned no row");
		return serializeQueueSchedule(row);
	});
	await kv.delete(queueScheduleCacheKey(input.organizationId)).catch(() => {});
	return created;
}

export async function updateDefaultQueueSchedule(
	db: Database,
	kv: KVNamespace,
	input: {
		organizationId: string;
		name?: string;
		slots?: QueueScheduleSlot[];
		setAsDefault?: boolean;
	},
): Promise<StoredQueueSchedule | null> {
	const updated = await db.transaction(async (tx) => {
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtext(${`relayapi:queue-schedule:${input.organizationId}`}))`,
		);
		const rows = await tx
			.select()
			.from(queueSchedules)
			.where(eq(queueSchedules.organizationId, input.organizationId))
			.orderBy(
				sql`${queueSchedules.isDefault} DESC`,
				asc(queueSchedules.createdAt),
				asc(queueSchedules.id),
			)
			.for("update");
		const current = rows.find((row) => row.isDefault) ?? rows[0];
		if (!current) return null;

		let remainsDefault = true;
		const replacement = rows.find((row) => row.id !== current.id);
		if (input.setAsDefault === false && replacement) {
			await tx
				.update(queueSchedules)
				.set({ isDefault: false, updatedAt: new Date() })
				.where(
					and(
						eq(queueSchedules.id, current.id),
						eq(queueSchedules.organizationId, input.organizationId),
					),
				);
			await tx
				.update(queueSchedules)
				.set({ isDefault: true, updatedAt: new Date() })
				.where(
					and(
						eq(queueSchedules.id, replacement.id),
						eq(queueSchedules.organizationId, input.organizationId),
					),
				);
			remainsDefault = false;
		}

		const now = new Date();
		const [row] = await tx
			.update(queueSchedules)
			.set({
				...(input.name !== undefined ? { name: input.name } : {}),
				...(input.slots !== undefined ? { slots: input.slots } : {}),
				isDefault: remainsDefault,
				updatedAt: now,
			})
			.where(
				and(
					eq(queueSchedules.id, current.id),
					eq(queueSchedules.organizationId, input.organizationId),
				),
			)
			.returning();
		if (!row) throw new Error("Queue schedule update lost its row lock");
		return serializeQueueSchedule(row);
	});
	await kv.delete(queueScheduleCacheKey(input.organizationId)).catch(() => {});
	return updated;
}

export async function deleteQueueSchedules(
	db: Database,
	kv: KVNamespace,
	organizationId: string,
): Promise<void> {
	await db
		.delete(queueSchedules)
		.where(eq(queueSchedules.organizationId, organizationId))
		.returning({ id: queueSchedules.id });
	await kv.delete(queueScheduleCacheKey(organizationId)).catch(() => {});
}
