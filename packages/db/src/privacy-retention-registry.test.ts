/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { EXTERNAL_PROVIDER_RETENTION_CONTRACTS } from "./external-provider-retention-registry";
import {
	EXTERNAL_PRIVACY_RETENTION_STORES,
	getPrivacyRetentionStore,
	POSTGRES_PRIVACY_FIELD_CLASSIFICATIONS,
	POSTGRES_PRIVACY_RETENTION_STORES,
	PRIVACY_FIELD_CLASSES,
	type PrivacyRetentionStore,
	validatePostgresPrivacyFieldColumns,
	validatePrivacyRetentionRegistry,
} from "./privacy-retention-registry";
import * as schema from "./schema";
import {
	erasureHolds,
	tenantDeletionJobs,
	workspaceErasureJobs,
} from "./schema";

function currentPostgresTables(): {
	id: string;
	columns: string[];
}[] {
	return Object.values(schema)
		.flatMap((value) => {
			if (!is(value, PgTable)) return [];
			const table = getTableConfig(value);
			return [
				{
					id: `postgres:${table.schema ?? "public"}.${table.name}`,
					columns: table.columns.map((column) => column.name),
				},
			];
		})
		.sort((left, right) => left.id.localeCompare(right.id));
}

function currentPostgresStoreIds(): string[] {
	return currentPostgresTables().map((table) => table.id);
}

function r2BindingStoreIds(service: string, source: string): string[] {
	const bindings = [
		...source.matchAll(
			/\{[^{}]*"binding"\s*:\s*"([^"]+)"[^{}]*"bucket_name"\s*:\s*"[^"]+"[^{}]*\}/g,
		),
	].map((match) => `r2:${service}.${match[1]}`);
	return bindings.sort();
}

function queueStoreIds(source: string): string[] {
	const physical = new Set(
		[...source.matchAll(/"queue"\s*:\s*"(relayapi-[^"]+)"/g)].map(
			(match) => match[1] as string,
		),
	);
	return [...physical]
		.map((name) => {
			if (name === "relayapi-queue-rescue") return "queue:rescue";
			const logical = name.slice("relayapi-".length);
			return logical.endsWith("-dlq")
				? `queue:dlq:${logical.slice(0, -4)}`
				: `queue:main:${logical}`;
		})
		.sort();
}

test("the retention registry classifies every PostgreSQL table exactly once", () => {
	const current = currentPostgresStoreIds();
	const registered = POSTGRES_PRIVACY_RETENTION_STORES.map(
		(store) => store.id,
	).sort();

	expect(current).toContain("postgres:public.erasure_holds");
	expect(registered).toEqual(current);
	expect(new Set(registered).size).toBe(registered.length);
});

test("every PostgreSQL physical column has exactly one explicit field classification", () => {
	const tables = currentPostgresTables();
	expect(Object.keys(POSTGRES_PRIVACY_FIELD_CLASSIFICATIONS).sort()).toEqual(
		tables.map((table) => table.id),
	);

	for (const table of tables) {
		const store = getPrivacyRetentionStore(table.id);
		if (!store) throw new Error(`missing privacy store ${table.id}`);
		expect(validatePostgresPrivacyFieldColumns(store, table.columns)).toEqual(
			[],
		);
		expect(store.fields?.map((field) => field.column).sort()).toEqual(
			[...table.columns].sort(),
		);
		expect(new Set(store.fields?.map((field) => field.column)).size).toBe(
			table.columns.length,
		);
	}
});

test("a future or removed physical column fails closed until explicitly classified", () => {
	const base = POSTGRES_PRIVACY_RETENTION_STORES.find(
		(store) => store.id === "postgres:public.retention_drain_runs",
	);
	if (!base?.fields)
		throw new Error("expected retention field classifications");
	const physical = base.fields.map((field) => field.column);
	const firstField = base.fields[0];
	if (!firstField) throw new Error("expected at least one classified field");

	expect(
		validatePostgresPrivacyFieldColumns(base, [...physical, "future_column"]),
	).toContain(`${base.id} is missing privacy field: future_column`);
	expect(
		validatePostgresPrivacyFieldColumns(base, physical.slice(1)),
	).toContain(`${base.id} classifies unknown physical column: ${physical[0]}`);
	expect(
		validatePostgresPrivacyFieldColumns(
			{ ...base, fields: [...base.fields, firstField] },
			physical,
		),
	).toContain(`${base.id} has duplicate privacy field: ${firstField.column}`);
});

test("field classes and reviews are closed, current, and actionable", () => {
	const now = new Date("2026-07-29T00:00:00.000Z");
	for (const store of POSTGRES_PRIVACY_RETENTION_STORES) {
		expect(store.fields?.length).toBeGreaterThan(0);
		for (const field of store.fields ?? []) {
			expect(PRIVACY_FIELD_CLASSES).toContain(field.class);
			const reviewedAt = new Date(`${field.reviewedAt}T00:00:00.000Z`);
			const reviewExpiresAt = new Date(
				`${field.reviewExpiresAt}T00:00:00.000Z`,
			);
			const maximumExpiry = new Date(reviewedAt);
			maximumExpiry.setUTCFullYear(maximumExpiry.getUTCFullYear() + 1);
			expect(reviewedAt.getTime()).toBeLessThanOrEqual(now.getTime());
			expect(reviewExpiresAt.getTime()).toBeGreaterThan(now.getTime());
			expect(reviewExpiresAt.getTime()).toBeLessThanOrEqual(
				maximumExpiry.getTime(),
			);
			if (field.class === "non_personal") {
				expect(field.subjectLocator).toBeUndefined();
				expect(field.action).toBeUndefined();
				expect(field.retention).toBeUndefined();
			} else {
				expect(field.subjectLocator).toBeDefined();
				expect(field.subjectLocator).not.toBe("none");
				expect(field.action).toBeDefined();
				expect(field.retention?.trim()).not.toBe("");
			}
		}
	}
});

test("the complete registry cannot pause secret or ephemeral stores", () => {
	expect(validatePrivacyRetentionRegistry()).toEqual([]);
	for (const store of [
		...POSTGRES_PRIVACY_RETENTION_STORES,
		...EXTERNAL_PRIVACY_RETENTION_STORES,
	]) {
		if (store.ephemeral || store.secretFields.length > 0) {
			expect(store.legalHold).not.toBe("pause");
		}
		expect(store.retention.trim()).not.toBe("");
		expect(store.owner.trim()).not.toBe("");
	}
});

test("registry validation rejects unsafe future legal-hold classifications", () => {
	const base: PrivacyRetentionStore = {
		id: "test:unsafe",
		kind: "kv",
		rowPolicy: "ttl_delete",
		retentionExecution: "provider",
		subjects: ["organization"],
		purge: "ttl",
		legalHold: "pause",
		secretFields: ["token"],
		ephemeral: true,
		retention: "one minute",
		owner: "test",
		reviewedAt: "2026-07-28",
		reviewExpiresAt: "2027-07-28",
	};
	expect(validatePrivacyRetentionRegistry([base])).toEqual([
		"test:unsafe is ephemeral but legalHold=pause; holds cannot extend ephemera",
		"test:unsafe contains secrets but legalHold=pause; use minimize or never",
	]);
});

test("PostgreSQL TTL policy cannot omit an executable scheduled drain", () => {
	const store: PrivacyRetentionStore = {
		id: "postgres:public.future_ttl_store",
		kind: "postgres",
		rowPolicy: "ttl_delete",
		retentionExecution: "lifecycle",
		subjects: ["organization"],
		purge: "explicit_delete",
		legalHold: "pause",
		secretFields: [],
		ephemeral: false,
		retention: "delete after 30 days",
		owner: "test",
		reviewedAt: "2026-07-28",
		reviewExpiresAt: "2027-07-28",
	};
	expect(validatePrivacyRetentionRegistry([store])).toContain(
		"postgres:public.future_ttl_store promises PostgreSQL TTL deletion without a scheduled drain",
	);
});

test("governance review windows expire and cannot exceed twelve months", () => {
	const base = POSTGRES_PRIVACY_RETENTION_STORES[0];
	if (!base) throw new Error("expected a PostgreSQL privacy store");

	expect(
		validatePrivacyRetentionRegistry([
			{ ...base, reviewExpiresAt: "2028-07-28" },
		]),
	).toContain(`${base.id} governance review exceeds twelve months`);
	expect(
		validatePrivacyRetentionRegistry([
			{ ...base, reviewExpiresAt: "2026-07-29" },
		]),
	).toContain(`${base.id} governance review has expired`);
});

test("external coverage names every durable store class and physical R2 mapping", () => {
	const byKind = Map.groupBy(
		EXTERNAL_PRIVACY_RETENTION_STORES,
		(store) => store.kind,
	);
	expect(byKind.get("r2")).toHaveLength(8);
	expect(byKind.get("queue")).toHaveLength(21);
	for (const queue of byKind.get("queue") ?? []) {
		expect(queue.retention).toContain("24 hours");
	}
	expect(byKind.get("workers_logs")).toHaveLength(3);
	expect(byKind.get("durable_object")).toHaveLength(1);
	expect(byKind.get("external_provider")).toHaveLength(
		EXTERNAL_PROVIDER_RETENTION_CONTRACTS.length,
	);
	expect(
		byKind
			.get("r2")
			?.filter((store) => store.physicalResource === "relayapi-avatars"),
	).toHaveLength(2);
	expect(getPrivacyRetentionStore("kv:dashboard-key")?.legalHold).toBe("never");
	expect(getPrivacyRetentionStore("kv:maintenance-control")).toMatchObject({
		ephemeral: false,
		purge: "exact_key_delete",
		subjects: ["none"],
	});
	expect(getPrivacyRetentionStore("r2:api.MEDIA_BUCKET")?.legalHold).toBe(
		"pause",
	);
	expect(
		getPrivacyRetentionStore("r2:api.QUEUE_RESCUE_BUCKET")?.ephemeral,
	).toBe(true);
	expect(
		getPrivacyRetentionStore("external_provider:openai-embeddings"),
	).toBeDefined();
	expect(
		getPrivacyRetentionStore("external_provider:social:twitter"),
	).toBeDefined();
});

test("the shared maintenance key is registered as preserved runtime authority", async () => {
	const repoRoot = new URL("../../../", import.meta.url).pathname;
	const configSource = await Bun.file(
		`${repoRoot}packages/config/src/index.ts`,
	).text();
	const sources = await Promise.all(
		[
			"apps/api/src/lib/runtime-controls.ts",
			"apps/app/src/lib/runtime-control.ts",
			"scripts/prelive-cloudflare-cutover.ts",
		].map((path) => Bun.file(`${repoRoot}${path}`).text()),
	);
	expect(configSource).toContain(
		'export const MAINTENANCE_CONTROL_KEY = "control:maintenance:v1";',
	);
	for (const source of sources) {
		expect(source).toContain("MAINTENANCE_CONTROL_KEY");
		expect(source).toContain('from "@relayapi/config"');
		expect(source).not.toContain('"control:maintenance:v1"');
	}
	expect(
		getPrivacyRetentionStore("kv:maintenance-control")?.retention,
	).toContain("control:maintenance:v1");
});

test("R2 privacy coverage is derived from every Worker binding", async () => {
	const repoRoot = new URL("../../../", import.meta.url).pathname;
	const configured: string[] = [];
	for await (const path of new Bun.Glob("apps/*/wrangler.jsonc").scan({
		cwd: repoRoot,
	})) {
		const service = path.split("/")[1];
		if (!service) continue;
		configured.push(
			...r2BindingStoreIds(
				service,
				await Bun.file(`${repoRoot}${path}`).text(),
			),
		);
	}
	configured.sort();
	const registered = EXTERNAL_PRIVACY_RETENTION_STORES.filter(
		(store) => store.kind === "r2",
	)
		.map((store) => store.id)
		.sort();
	expect(registered).toEqual(configured);
});

test("Queue privacy coverage is derived from every configured consumer", async () => {
	const repoRoot = new URL("../../../", import.meta.url).pathname;
	const configured = queueStoreIds(
		await Bun.file(`${repoRoot}apps/api/wrangler.jsonc`).text(),
	);
	const registered = EXTERNAL_PRIVACY_RETENTION_STORES.filter(
		(store) => store.kind === "queue",
	)
		.map((store) => store.id)
		.sort();
	expect(registered).toEqual(configured);
});

test("Workers Logs coverage is derived from every observable Worker", async () => {
	const repoRoot = new URL("../../../", import.meta.url).pathname;
	const configured: string[] = [];
	for await (const path of new Bun.Glob("apps/*/wrangler.jsonc").scan({
		cwd: repoRoot,
	})) {
		const source = await Bun.file(`${repoRoot}${path}`).text();
		if (!/"observability"\s*:\s*\{[\s\S]*?"enabled"\s*:\s*true/.test(source)) {
			continue;
		}
		const service = path.split("/")[1];
		if (service) configured.push(`workers_logs:${service}`);
	}
	const registered = EXTERNAL_PRIVACY_RETENTION_STORES.filter(
		(store) => store.kind === "workers_logs",
	)
		.map((store) => store.id)
		.sort();
	expect(registered).toEqual(configured.sort());
});

test("legal holds have a typed target, audited release tuple, and active uniqueness", () => {
	const config = getTableConfig(erasureHolds);
	expect(
		config.columns.find((column) => column.name === "subject_kind")?.enumValues,
	).toEqual(["organization", "workspace"]);
	expect(config.columns.map((column) => column.name)).toEqual(
		expect.arrayContaining([
			"subject_id",
			"organization_tombstone_id",
			"placed_by",
			"placed_at",
			"released_by",
			"released_at",
			"release_reason_summary",
			"evidence_ciphertext",
			"evidence_redacted_at",
		]),
	);
	expect(config.foreignKeys).toHaveLength(0);
	expect(config.checks.map((constraint) => constraint.name)).toEqual(
		expect.arrayContaining([
			"erasure_holds_target_tuple_check",
			"erasure_holds_release_tuple_check",
			"erasure_holds_evidence_redaction_check",
		]),
	);
	const activeUnique = config.indexes.find(
		(index) => index.config.name === "erasure_holds_active_subject_uniq",
	);
	expect(activeUnique?.config.unique).toBe(true);
	expect(activeUnique?.config.where).toBeDefined();
	expect(
		config.indexes.find(
			(index) => index.config.name === "erasure_holds_active_organization_idx",
		)?.config.where,
	).toBeDefined();
});

test("both typed erasure jobs expose an explicit held state and durable aged alert", () => {
	for (const table of [tenantDeletionJobs, workspaceErasureJobs]) {
		const config = getTableConfig(table);
		expect(
			config.columns.find((column) => column.name === "status")?.enumValues,
		).toContain("held");
		expect(config.columns.map((column) => column.name)).toContain(
			"aged_alerted_at",
		);
	}
});
