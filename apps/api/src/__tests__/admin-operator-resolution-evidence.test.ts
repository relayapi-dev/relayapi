import { describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { getPrivacyRetentionStore } from "@relayapi/db";
import { encryptToken } from "../lib/crypto";
import admin from "../routes/admin";
import type { Env, Variables } from "../types";

type QueryChain = {
	from: () => QueryChain;
	innerJoin: () => QueryChain;
	leftJoin: () => QueryChain;
	where: () => QueryChain;
	orderBy: () => QueryChain;
	limit: () => Promise<Record<string, unknown>[]>;
};

const TEST_ENV = {
	ENCRYPTION_KEY: `test=${"a".repeat(64)}`,
} as Env;

function adminDb(
	role: string,
	evidence: Record<string, unknown>[] = [],
): Variables["db"] {
	let selectCall = 0;
	return {
		select: () => {
			selectCall += 1;
			const rows = selectCall === 1 ? [{ role }] : evidence;
			let chain: QueryChain;
			chain = {
				from: () => chain,
				innerJoin: () => chain,
				leftJoin: () => chain,
				where: () => chain,
				orderBy: () => chain,
				limit: async () => rows,
			};
			return chain;
		},
	} as unknown as Variables["db"];
}

function adminApp(options: {
	principalType: Variables["principalType"];
	principalUserId: string | null;
	role: string;
	evidence?: Record<string, unknown>[];
}) {
	const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
	app.use("*", async (c, next) => {
		c.set("principalType", options.principalType);
		c.set("principalUserId", options.principalUserId);
		c.set("keyId", "key_admin_probe");
		c.set("db", adminDb(options.role, options.evidence));
		await next();
	});
	app.route("/v1/admin", admin);
	return app;
}

describe("admin operator-resolution evidence", () => {
	it("rejects service principals and dashboard users without the system-admin role", async () => {
		const serviceResponse = await adminApp({
			principalType: "service",
			principalUserId: null,
			role: "admin",
		}).request("/v1/admin/operator-resolution-evidence", {}, TEST_ENV);
		expect(serviceResponse.status).toBe(403);

		const memberResponse = await adminApp({
			principalType: "dashboard_user",
			principalUserId: "usr_member",
			role: "member",
		}).request("/v1/admin/operator-resolution-evidence", {}, TEST_ENV);
		expect(memberResponse.status).toBe(403);
		expect(await memberResponse.json()).toMatchObject({
			error: { code: "FORBIDDEN" },
		});
	});

	it("returns only sanitized retained evidence to a system administrator", async () => {
		const resolvedAt = new Date("2026-07-28T12:00:00.000Z");
		const noteCiphertext = await encryptToken(
			"Deletion verified in the provider console",
			TEST_ENV.ENCRYPTION_KEY,
			{ recordId: "ore_1", field: "note_ciphertext" },
		);
		const response = await adminApp({
			principalType: "dashboard_user",
			principalUserId: "usr_admin",
			role: "admin",
			evidence: [
				{
					evidence: {
						id: "ore_1",
						organizationId: "org_1",
						targetType: "external_subject_cleanup_job",
						targetId: "escj_1",
						action: "mark_succeeded",
						reasonCode: "operator_asserted_succeeded",
						reasonDigest: "a".repeat(64),
						actorUserId: "usr_admin",
						beforeState: {
							status: "manual_review",
							bucket: "avatar",
							cursor_recorded: false,
						},
						afterState: {
							status: "completed",
							bucket: "avatar",
							cursor_recorded: false,
						},
						targetUpdatedAtBefore: resolvedAt,
						targetUpdatedAtAfter: resolvedAt,
						resolvedAt,
					},
					noteCiphertext,
					noteExpiresAt: new Date("2099-10-26T12:00:00.000Z"),
					cursorTimestamp: "2026-07-28T12:00:00.000000Z",
				},
			],
		}).request(
			"/v1/admin/operator-resolution-evidence?organizationId=org_1&targetType=external_subject_cleanup_job&action=mark_succeeded",
			{},
			TEST_ENV,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			has_more: false,
			next_cursor: null,
			evidence: [
				{
					id: "ore_1",
					targetType: "external_subject_cleanup_job",
					action: "mark_succeeded",
					reason: "Deletion verified in the provider console",
					reasonCode: "operator_asserted_succeeded",
					reasonDigest: "a".repeat(64),
				},
			],
		});
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("objectLocator");
		expect(serialized).not.toContain("credential");
	});

	it("rejects malformed history cursors instead of restarting at page one", async () => {
		const response = await adminApp({
			principalType: "dashboard_user",
			principalUserId: "usr_admin",
			role: "admin",
		}).request(
			"/v1/admin/operator-resolution-evidence?cursor=not-a-cursor",
			{},
			TEST_ENV,
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "INVALID_CURSOR" },
		});
	});

	it("keeps the immutable evidence receipt under the explicit retained-record policy", () => {
		expect(
			getPrivacyRetentionStore("postgres:public.operator_resolution_evidence"),
		).toMatchObject({
			rowPolicy: "retained_record",
			purge: "retained_receipt",
			legalHold: "never",
			secretFields: [],
		});
	});
});
