import { describe, expect, it } from "bun:test";
import {
	getPrivacyRetentionStore,
	landingPages,
	publicGrowthEvents,
	qrCodes,
	refUrls,
	workspaces,
} from "@relayapi/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
	landingPagePublicUrl,
	publicGrowthIdempotencyKey,
	qrImageUrl,
	qrScanUrl,
	refPublicUrl,
} from "../lib/public-growth";
import { renderQrSvg } from "../lib/qr-renderer";
import publicGrowthRouter from "../routes/public-growth";
import { LandingPageConfig } from "../schemas/landing-pages";
import { validateLandingFields } from "../services/public-growth-events";

const repoRoot = new URL("../../../../", import.meta.url).pathname;

describe("blank-slate public growth shape", () => {
	it("encodes stable workspace slugs and closed ref destinations", () => {
		const workspace = getTableConfig(workspaces);
		expect(workspace.columns.some((column) => column.name === "slug")).toBe(
			true,
		);
		expect(
			workspace.uniqueConstraints.some(
				(constraint) => constraint.name === "workspaces_org_slug_uniq",
			),
		).toBe(true);

		const ref = getTableConfig(refUrls);
		expect(ref.columns.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"destination_type",
				"destination_url",
				"landing_page_id",
			]),
		);
		expect(ref.checks.map((check) => check.name)).toEqual(
			expect.arrayContaining([
				"ref_urls_destination_type_check",
				"ref_urls_destination_union_check",
			]),
		);
		expect(
			ref.foreignKeys.some(
				(foreignKey) => foreignKey.reference().foreignTable === landingPages,
			),
		).toBe(true);
	});

	it("keeps QR placement identity but no durable image-object state", () => {
		const qr = getTableConfig(qrCodes);
		expect(qr.columns.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"public_id",
				"ref_url_id",
				"label",
				"campaign_key",
				"scan_count",
			]),
		);
		expect(qr.columns.map((column) => column.name)).not.toContain(
			"image_r2_key",
		);
		expect(
			qr.indexes.some(
				(index) =>
					index.config.name === "qr_codes_ref_url_label_uniq" &&
					index.config.unique,
			),
		).toBe(true);
		expect(qr.checks.map((check) => check.name)).toContain(
			"qr_codes_public_id_format_check",
		);
	});

	it("uses one typed occurrence and dispatch lifecycle", () => {
		const event = getTableConfig(publicGrowthEvents);
		expect(event.columns.map((column) => column.name)).toEqual(
			expect.arrayContaining([
				"event_type",
				"ref_url_id",
				"qr_code_id",
				"landing_page_id",
				"contact_organization_id",
				"contact_scope_key",
				"automation_organization_id",
				"automation_scope_key",
				"idempotency_hash",
				"status",
				"attempts",
				"lease_token",
				"next_attempt_at",
				"lease_expires_at",
				"completed_at",
			]),
		);
		expect(event.checks.map((check) => check.name)).toEqual(
			expect.arrayContaining([
				"public_growth_events_target_union_check",
				"public_growth_events_contact_scope_check",
				"public_growth_events_automation_scope_check",
				"public_growth_events_idempotency_hash_check",
				"public_growth_events_lease_state_check",
				"public_growth_events_terminal_state_check",
			]),
		);
		expect(
			event.indexes.some(
				(index) =>
					index.config.name === "public_growth_events_idempotency_uniq" &&
					index.config.unique,
			),
		).toBe(true);
		expect(event.indexes.map((index) => index.config.name)).toEqual(
			expect.arrayContaining([
				"public_growth_events_due_dispatch_idx",
				"public_growth_events_stale_lease_idx",
				"public_growth_events_ref_target_idx",
				"public_growth_events_qr_target_idx",
				"public_growth_events_landing_target_idx",
				"public_growth_events_retention_idx",
			]),
		);
	});
});

describe("public growth runtime contracts", () => {
	it("builds stable-ID routes with slugs retained as friendly decoration", () => {
		const env = {
			PUBLIC_LINK_BASE_URL: "https://go.example.test/",
		} as never;
		expect(
			refPublicUrl(
				env,
				{
					kind: "organization",
					organizationId: "org_1",
					organizationSlug: "acme",
				},
				"ref_1",
				"offer",
			),
		).toBe("https://go.example.test/r/org_1/acme/o/ref_1/offer");
		expect(
			landingPagePublicUrl(
				env,
				{
					kind: "workspace",
					organizationId: "org_1",
					organizationSlug: "acme",
					workspaceId: "ws_1",
					workspaceSlug: "europe",
				},
				"lp_1",
				"welcome",
			),
		).toBe("https://go.example.test/l/org_1/acme/w/ws_1/europe/lp_1/welcome");
		expect(qrScanUrl(env, "qrp_123")).toBe("https://go.example.test/q/qrp_123");
		expect(qrImageUrl(env, "qrp_123")).toBe(
			"https://go.example.test/q/qrp_123.svg",
		);
	});

	it("resolves stable identities and never makes mutable slugs authoritative", async () => {
		const source = await Bun.file(
			`${repoRoot}apps/api/src/routes/public-growth.ts`,
		).text();
		expect(source).toContain("eq(organization.id, input.organizationId)");
		expect(source).toContain("eq(refUrls.id, input.refId)");
		expect(source).toContain("eq(landingPages.id, input.pageId)");
		expect(source).toContain(
			'"/r/:organizationId/:organizationSlug/w/:workspaceId/:workspaceSlug/:refId/:slug"',
		);
		expect(source).toContain(
			'"/l/:organizationId/:organizationSlug/w/:workspaceId/:workspaceSlug/:pageId/:slug"',
		);
		expect(source).not.toContain(
			"eq(organization.slug, input.organizationSlug)",
		);
		expect(source).not.toContain("eq(refUrls.slug, input.slug)");
		expect(source).not.toContain("eq(landingPages.slug, input.slug)");
	});

	it("uses explicit keys, then request-local fallbacks without fingerprints", () => {
		expect(
			publicGrowthIdempotencyKey(
				new Headers({ "Idempotency-Key": " conversion-1 " }),
			),
		).toBe("conversion-1");
		expect(publicGrowthIdempotencyKey(new Headers({ "CF-Ray": "ray-1" }))).toBe(
			"cf-ray:ray-1",
		);
		expect(publicGrowthIdempotencyKey(new Headers())).toMatch(/^request:/);
	});

	it("renders deterministic, self-contained SVG instead of R2 objects", async () => {
		const first = await renderQrSvg("https://go.example.test/q/qrp_123");
		const replay = await renderQrSvg("https://go.example.test/q/qrp_123");
		const other = await renderQrSvg("https://go.example.test/q/qrp_456");
		expect(first).toBe(replay);
		expect(first).not.toBe(other);
		expect(first).toContain("<svg");
		expect(first).not.toContain("<image");
	});

	it("validates a versioned block union and contact-resolvable forms", () => {
		const valid = LandingPageConfig.safeParse({
			version: 1,
			theme: {
				mode: "light",
				background_color: "#ffffff",
				text_color: "#111827",
				accent_color: "#2563eb",
				font: "sans",
			},
			blocks: [
				{ id: "hero", type: "heading", level: 1, text: "Welcome" },
				{
					id: "lead",
					type: "form",
					fields: [
						{
							key: "email",
							label: "Email",
							required: true,
						},
					],
					submit_label: "Join",
					success_message: "Thanks",
				},
			],
		});
		expect(valid.success).toBe(true);
		if (!valid.success) throw new Error("fixture failed");
		expect(
			validateLandingFields(valid.data, { email: "a@example.test" }),
		).toEqual({ ok: true });
		expect(validateLandingFields(valid.data, {})).toEqual({
			ok: false,
			message: "Field 'email' is required.",
		});
		expect(
			LandingPageConfig.safeParse({
				...valid.data,
				blocks: [
					{
						id: "bad",
						type: "form",
						fields: [{ key: "name", label: "Name", required: true }],
						submit_label: "Join",
						success_message: "Thanks",
					},
				],
			}).success,
		).toBe(false);
		expect(
			LandingPageConfig.safeParse({
				...valid.data,
				blocks: [
					{
						id: "unsafe",
						type: "cta",
						label: "Continue",
						url: "https://user:password@example.test/path",
					},
				],
			}).success,
		).toBe(false);
	});

	it("commits event before insert-wins counters and fences dispatch retries", async () => {
		const source = await Bun.file(
			`${repoRoot}apps/api/src/services/public-growth-events.ts`,
		).text();
		expect(source).toContain(".insert(publicGrowthEvents)");
		expect(source).toContain(".onConflictDoNothing()");
		expect(source).toContain("growthIdempotencyHash(");
		expect(source).toContain("lockDispatchAutomation(");
		expect(source).toContain("lockActiveOrganization(");
		expect(source).toContain("lockActiveWorkspace(");
		expect(source).toContain('.for("key share")');
		expect(source).toContain("of: [qrCodes, refUrls]");
		expect(source).toContain('.for("update")');
		expect(source).not.toContain("idempotencyKey: input.idempotencyKey");
		expect(source.indexOf(".insert(publicGrowthEvents)")).toBeLessThan(
			source.indexOf("uses: sql`" + "$" + "{refUrls.uses} + 1`"),
		);
		expect(source).toContain('status: "processing"');
		expect(source).toContain(
			"eq(publicGrowthEvents.leaseToken, claimed.leaseToken)",
		);
		expect(source).toContain("lt(publicGrowthEvents.attempts, MAX_ATTEMPTS)");
		expect(source).toContain(
			"Dispatch lease expired at the application attempt limit",
		);
		expect(source).toContain("row_number() OVER");
		expect(source).toContain(
			"PARTITION BY " + "$" + "{publicGrowthEvents.organizationId}",
		);
		expect(source).toContain("pinnedAutomationId: row.automationId");
		expect(source).toContain("ANONYMOUS_RETENTION_DAYS = 7");
		expect(source).toContain("IDENTIFIED_RETENTION_DAYS = 90");
		expect(source).toContain("CLEANUP_BATCH = 5_000");
		expect(source).toContain("count(*)::text AS deleted_count");
		expect(source).toContain("FROM erasure_holds AS hold");
		expect(source).toContain("hold.released_at IS NULL");

		expect(
			getPrivacyRetentionStore("postgres:public.public_growth_events"),
		).toMatchObject({
			rowPolicy: "ttl_delete",
			legalHold: "pause",
			purge: "explicit_delete",
		});
	});

	it("serializes definition deletion with occurrences and preserves pending outboxes", async () => {
		const [refRoute, landingRoute, qrRoute] = await Promise.all([
			Bun.file(`${repoRoot}apps/api/src/routes/ref-urls.ts`).text(),
			Bun.file(`${repoRoot}apps/api/src/routes/landing-pages.ts`).text(),
			Bun.file(`${repoRoot}apps/api/src/routes/qr-codes.ts`).text(),
		]);
		for (const source of [refRoute, landingRoute, qrRoute]) {
			expect(source).toContain('.for("update")');
		}
		for (const source of [refRoute, landingRoute]) {
			expect(source).toContain("PUBLIC_GROWTH_DISPATCH_PENDING");
			expect(source).toContain("inArray(publicGrowthEvents.status,");
		}
	});

	it("bounds anonymous request amplification before a database occurrence", async () => {
		const source = await Bun.file(
			`${repoRoot}apps/api/src/routes/public-growth.ts`,
		).text();
		expect(source).toContain("FREE_RATE_LIMITER.limit");
		expect(source).toContain("CF-Connecting-IP");
		expect(source).toContain("key: `pg:" + "$" + "{digest.slice(0, 48)}`");

		let limiterCalls = 0;
		const response = await publicGrowthRouter.request(
			"https://go.example.test/q/qrp_not_found",
			{},
			{
				FREE_RATE_LIMITER: {
					limit: async () => {
						limiterCalls += 1;
						return { success: false };
					},
				},
			} as never,
		);
		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe("60");
		expect(limiterCalls).toBe(1);
		expect(source).toContain("LANDING_CONVERSION_MAX_BODY_BYTES = 16 * 1024");
		expect(source).toContain("materializeBoundedRequestBody(");
		expect(source).toContain("seedBoundedRequestBody(c.req, bytes)");
		expect(source).toContain("new URLSearchParams(");
		expect(source).toContain("c.req.parseBody({ all: true })");
		expect(source).not.toContain("c.req.formData()");
	});

	it("removes the obsolete QR object erasure phase only after replacement", async () => {
		const source = await Bun.file(
			`${repoRoot}apps/api/src/services/workspace-erasure.ts`,
		).text();
		expect(source).not.toContain("deleteQrCodeObjectBatch");
		expect(source).not.toContain("imageR2Key");
		expect(source).not.toContain('"qr_codes" | "account_dependents"');
		expect(source).toContain('cursor.phase ?? "account_dependents"');
	});
});
