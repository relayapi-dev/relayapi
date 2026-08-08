/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { getExecutablePostgresRetentionContract } from "./executable-retention-contracts";
import { getPrivacyRetentionStore } from "./privacy-retention-registry";
import * as schema from "./schema";
import {
	SCHEMA_FREEZE_CAPABILITY_GAPS,
	SCHEMA_FREEZE_CAPABILITY_TRACE,
	type SchemaFreezeAuditAction,
} from "./schema-freeze-capability-trace";

const repoRoot = new URL("../../../", import.meta.url).pathname;
const auditPath = "docs/SCHEMA_OPTIMALITY_AUDIT_PRE_FREEZE_2026-07-27.md";

interface AuditDecision {
	ordinal: number;
	table: string;
	capability: string;
	actions: SchemaFreezeAuditAction[];
}

interface AuditLedgerRow {
	ordinal: number;
	table: string;
	disposition: string;
}

function normalizeCell(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

async function auditDecisions(): Promise<AuditDecision[]> {
	const markdown = await Bun.file(`${repoRoot}${auditPath}`).text();
	const sectionStart = markdown.indexOf("## 3.");
	const sectionEnd = markdown.indexOf("## 4.", sectionStart);
	if (sectionStart < 0 || sectionEnd < 0) {
		throw new Error("Could not locate the complete audit §3 ledger");
	}
	const section = markdown.slice(sectionStart, sectionEnd);
	const rowPattern =
		/^\|\s*(\d+)\s*\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*\*\*([^*]+)\*\*\s*\|/gm;
	const decisions: AuditDecision[] = [];
	for (const match of section.matchAll(rowPattern)) {
		const disposition = match[4]?.toLowerCase() ?? "";
		const actions = (["reshape", "complete", "remove", "fix"] as const).filter(
			(action) => disposition.includes(action),
		);
		if (actions.length === 0) continue;
		decisions.push({
			ordinal: Number(match[1]),
			table: match[2] ?? "",
			capability: normalizeCell(match[3] ?? ""),
			actions: [...actions],
		});
	}
	return decisions;
}

async function auditLedgerRows(): Promise<AuditLedgerRow[]> {
	const markdown = await Bun.file(`${repoRoot}${auditPath}`).text();
	const sectionStart = markdown.indexOf("## 3.");
	const sectionEnd = markdown.indexOf("## 4.", sectionStart);
	if (sectionStart < 0 || sectionEnd < 0) {
		throw new Error("Could not locate the complete audit §3 ledger");
	}
	const section = markdown.slice(sectionStart, sectionEnd);
	const rowPattern =
		/^\|\s*(\d+)\s*\|\s*`([^`]+)`\s*\|\s*[^|]+?\s*\|\s*\*\*([^*]+)\*\*\s*\|/gm;
	return [...section.matchAll(rowPattern)].map((match) => ({
		ordinal: Number(match[1]),
		table: match[2] ?? "",
		disposition: normalizeCell(match[3] ?? "").toLowerCase(),
	}));
}

function currentPostgresTables(): Set<string> {
	return new Set(
		Object.values(schema).flatMap((value) => {
			if (!is(value, PgTable)) return [];
			const config = getTableConfig(value);
			return [`${config.schema ?? "public"}.${config.name}`];
		}),
	);
}

describe("pre-freeze schema capability trace", () => {
	test("the full ledger exactly covers 143 active tables plus four removed legacy shapes", async () => {
		const ledger = await auditLedgerRows();
		const physicalTables = currentPostgresTables();
		const removed = ledger.filter(({ disposition }) =>
			disposition.includes("remove"),
		);
		const active = ledger.filter(
			({ disposition }) => !disposition.includes("remove"),
		);

		expect(physicalTables.size).toBe(143);
		expect(ledger).toHaveLength(147);
		expect(ledger.map(({ ordinal }) => ordinal)).toEqual(
			Array.from({ length: 147 }, (_, index) => index + 1),
		);
		expect(removed.map(({ table }) => table).sort()).toEqual([
			"public.byos_configs",
			"public.contact_suppressions",
			"public.usage_bucket_settlements",
			"public.usage_records",
		]);
		expect(new Set(active.map(({ table }) => table))).toEqual(physicalTables);
	});

	test("covers every Remove/Reshape/Complete/Fix decision in audit §3 exactly once", async () => {
		const audit = await auditDecisions();
		expect(audit).toHaveLength(56);
		expect(new Set(audit.map((decision) => decision.table)).size).toBe(
			audit.length,
		);
		expect(
			new Set(SCHEMA_FREEZE_CAPABILITY_TRACE.map((entry) => entry.table)).size,
		).toBe(SCHEMA_FREEZE_CAPABILITY_TRACE.length);
		expect(SCHEMA_FREEZE_CAPABILITY_TRACE).toHaveLength(audit.length);

		for (const [index, decision] of audit.entries()) {
			const trace = SCHEMA_FREEZE_CAPABILITY_TRACE[index];
			expect(trace?.table).toBe(decision.table);
			expect(trace?.capability).toBe(decision.capability);
			expect([...(trace?.actions ?? [])].sort()).toEqual(
				[...decision.actions].sort(),
			);
		}
	});

	test("checks every asserted source and keeps exceptions explicit", async () => {
		for (const entry of SCHEMA_FREEZE_CAPABILITY_TRACE) {
			expect(entry.capability.trim().length).toBeGreaterThan(3);
			for (const [layer, evidence] of [
				["schema", entry.schema],
				["runtime", entry.runtime],
				["apiSdk", entry.apiSdk],
				["retention", entry.retention],
				["tests", entry.tests],
			] as const) {
				if (evidence.status !== "verified") {
					expect(
						evidence.reason.trim().length,
						`${entry.table}.${layer} needs a substantive exception`,
					).toBeGreaterThan(24);
					continue;
				}
				expect(evidence.note.trim().length).toBeGreaterThan(8);
				expect(
					evidence.sources.length,
					`${entry.table}.${layer} needs executable source evidence`,
				).toBeGreaterThan(0);
				for (const assertion of evidence.sources) {
					const absolutePath = `${repoRoot}${assertion.path}`;
					const file = Bun.file(absolutePath);
					expect(
						await file.exists(),
						`${entry.table}.${layer}: missing ${assertion.path}`,
					).toBe(true);
					const contents = await file.text();
					for (const marker of assertion.contains ?? []) {
						expect(
							contents,
							`${entry.table}.${layer}: ${assertion.path} lacks ${marker}`,
						).toContain(marker);
					}
					for (const marker of assertion.excludes ?? []) {
						expect(
							contents,
							`${entry.table}.${layer}: ${assertion.path} still contains ${marker}`,
						).not.toContain(marker);
					}
				}
			}

			if (entry.apiSdk.status === "verified") {
				const paths = entry.apiSdk.sources.map(({ path }) => path);
				expect(paths.some((path) => path.startsWith("apps/api/"))).toBe(true);
				expect(paths.some((path) => path.startsWith("packages/sdk/"))).toBe(
					true,
				);
			}
			if (entry.tests.status === "verified") {
				expect(
					entry.tests.sources.every(({ path }) => path.includes(".test.")),
				).toBe(true);
			}
		}
	});

	test("ties table removal/existence and retention to the same trace", () => {
		const physicalTables = currentPostgresTables();
		for (const entry of SCHEMA_FREEZE_CAPABILITY_TRACE) {
			const removed = entry.actions.includes("remove");
			expect(
				physicalTables.has(entry.table),
				`${entry.table} physical presence disagrees with its disposition`,
			).toBe(!removed);
			if (removed) {
				expect(entry.replacementTable).toBeDefined();
				expect(physicalTables.has(entry.replacementTable ?? "")).toBe(true);
			} else {
				expect(entry.replacementTable).toBeUndefined();
			}
			expect(
				getPrivacyRetentionStore(entry.retentionStore),
				`${entry.table} cannot resolve retention store ${entry.retentionStore}`,
			).toBeDefined();
			expect(getPrivacyRetentionStore(`postgres:${entry.table}`)).toBe(
				removed ? undefined : getPrivacyRetentionStore(entry.retentionStore),
			);
			const executable = getExecutablePostgresRetentionContract(
				entry.retentionStore,
			);
			if (executable) {
				expect(entry.retention.status).toBe("verified");
				// `retentionStore` is the normalized transitive edge. The central
				// contract test resolves that store to its exact handler, executable
				// test marker, cadence, and indexes; repeating those paths in every
				// capability row would create a second hand-maintained registry.
				expect(executable.storeId).toBe(entry.retentionStore);
			}
		}
	});

	test("pins the honest freeze-gap inventory until each decisive shape lands", () => {
		expect(
			SCHEMA_FREEZE_CAPABILITY_GAPS.map(
				({ table, layer }) => `${table}:${layer}`,
			),
		).toEqual([]);
	});
});
