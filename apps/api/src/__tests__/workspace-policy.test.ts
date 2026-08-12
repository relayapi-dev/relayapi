import { describe, expect, it } from "bun:test";
import type { Database } from "@relayapi/db";
import { parseApiKeyWorkspaceScope } from "../lib/api-key-workspace-scope";
import {
	decideOperationalCreateScope,
	decideParentBoundCreateScope,
} from "../lib/request-access";
import { canAccessWorkspaceScope } from "../lib/workspace-scope";
import {
	getWorkspaceScopeBlockers,
	UpdateOrgSettingsBody,
} from "../routes/org-settings";
import {
	CompleteOAuthBody,
	ConnectBeehiivBody,
	ConnectBlueskyBody,
	ConnectConvertKitBody,
	ConnectListMonkBody,
	ConnectMailchimpBody,
	InitTelegramQuery,
	StartOAuthQuery,
	WhatsAppCredentialsBody,
	WhatsAppEmbeddedSignupBody,
} from "../schemas/connect";
import { BulkCreateContactsBody, CreateContactBody } from "../schemas/contacts";

const repoRoot = new URL("../../../../", import.meta.url).pathname;

describe("operational workspace policy", () => {
	it("parses API-key workspace grants without coercion or substring access", () => {
		expect(parseApiKeyWorkspaceScope(null)).toBe("all");
		expect(parseApiKeyWorkspaceScope({})).toBe("all");
		expect(parseApiKeyWorkspaceScope({ workspace_scope: "all" })).toBe("all");
		expect(
			parseApiKeyWorkspaceScope({
				workspace_scope: ["ws_a", "ws_a", " ws_b "],
			}),
		).toEqual(["ws_a", "ws_b"]);
		for (const workspace_scope of [
			"ws_a,ws_b",
			"ws_a",
			[""],
			["ws_a", 1],
			{},
		]) {
			expect(parseApiKeyWorkspaceScope({ workspace_scope })).toBeNull();
		}
	});
	it("rejects an empty settings patch", () => {
		expect(UpdateOrgSettingsBody.safeParse({}).success).toBe(false);
	});

	it("requires a compare-and-swap revision when changing policy", () => {
		expect(
			UpdateOrgSettingsBody.safeParse({ require_workspace_id: true }).success,
		).toBe(false);
		expect(
			UpdateOrgSettingsBody.safeParse({
				require_workspace_id: true,
				expected_revision: 3,
			}).success,
		).toBe(true);
	});

	it("returns a typed inventory containing only nonzero operational roots", async () => {
		const values = Array.from({ length: 21 }, () => 0);
		values[1] = 1;
		values[2] = 2;
		let queryIndex = 0;
		const db = {
			select: () => ({
				from: () => ({
					where: () => Promise.resolve([{ value: values[queryIndex++] ?? 0 }]),
				}),
			}),
		} as unknown as Database;

		await expect(getWorkspaceScopeBlockers(db, "org_test")).resolves.toEqual([
			{ resource_type: "post_threads", count: 1 },
			{ resource_type: "posts", count: 2 },
		]);
		expect(queryIndex).toBe(21);
	});

	it("creates an organization-scoped root for an all-workspace key in optional mode", () => {
		expect(
			decideOperationalCreateScope({
				requireWorkspaceId: false,
				workspaceScope: "all",
				requestedWorkspaceId: undefined,
			}),
		).toEqual({ ok: true, workspaceId: null });
	});

	it("creates an organization-scoped root for a scoped key in optional mode", () => {
		expect(
			decideOperationalCreateScope({
				requireWorkspaceId: false,
				workspaceScope: ["ws_only"],
				requestedWorkspaceId: undefined,
			}),
		).toEqual({ ok: true, workspaceId: null });
	});

	it("never requires an omitted workspace in optional mode", () => {
		expect(
			decideOperationalCreateScope({
				requireWorkspaceId: false,
				workspaceScope: ["ws_a", "ws_b"],
				requestedWorkspaceId: undefined,
				resourceName: "post",
			}),
		).toEqual({ ok: true, workspaceId: null });
	});

	it("keeps every account-connection contract workspace-optional before policy resolution", async () => {
		for (const parsed of [
			StartOAuthQuery.safeParse({}),
			CompleteOAuthBody.safeParse({ code: "provider-code" }),
			ConnectBlueskyBody.safeParse({
				handle: "user.bsky.social",
				app_password: "test-password",
			}),
			ConnectBeehiivBody.safeParse({
				api_key: "test-key",
				publication_id: "publication",
			}),
			ConnectConvertKitBody.safeParse({
				api_key: "test-key",
			}),
			ConnectMailchimpBody.safeParse({ api_key: "test-us21" }),
			ConnectListMonkBody.safeParse({
				instance_url: "https://list.example.com",
				username: "admin",
				password: "secret",
			}),
			InitTelegramQuery.safeParse({}),
			WhatsAppEmbeddedSignupBody.safeParse({ code: "provider-code" }),
			WhatsAppCredentialsBody.safeParse({
				access_token: "token",
				phone_number_id: "phone",
				waba_id: "business",
			}),
		]) {
			expect(parsed.success).toBe(true);
		}

		const connectSource = await Bun.file(
			`${repoRoot}apps/api/src/routes/connect.ts`,
		).text();
		expect(connectSource).toContain("resolveOperationalCreateScope");
		expect(connectSource).not.toContain("assertAllWorkspaceScope");
	});

	it("keeps contact create contracts optional and channel tuples complete", () => {
		expect(CreateContactBody.safeParse({ name: "Org contact" }).success).toBe(
			true,
		);
		expect(
			CreateContactBody.safeParse({ name: "Broken", account_id: "acc_1" })
				.success,
		).toBe(false);
		expect(
			BulkCreateContactsBody.safeParse({ contacts: [{ name: "Org contact" }] })
				.success,
		).toBe(true);
	});

	it("rejects a zero-grant credential as unauthorized, not as workspace-required", () => {
		expect(
			decideOperationalCreateScope({
				requireWorkspaceId: false,
				workspaceScope: [],
				requestedWorkspaceId: undefined,
				resourceName: "post",
			}),
		).toMatchObject({
			ok: false,
			status: 403,
			code: "WORKSPACE_ACCESS_DENIED",
		});
	});

	it("shares organization-scoped rows with every non-empty workspace scope", () => {
		expect(canAccessWorkspaceScope("all", null)).toBe(true);
		expect(canAccessWorkspaceScope(["ws_a"], null)).toBe(true);
		expect(canAccessWorkspaceScope(["ws_a", "ws_b"], null)).toBe(true);
		expect(canAccessWorkspaceScope([], null)).toBe(false);
		expect(canAccessWorkspaceScope(["ws_a"], "ws_a")).toBe(true);
		expect(canAccessWorkspaceScope(["ws_a"], "ws_b")).toBe(false);
	});

	it("requires an explicit ID for every credential in required mode", () => {
		for (const workspaceScope of ["all" as const, ["ws_only"]]) {
			const result = decideOperationalCreateScope({
				requireWorkspaceId: true,
				workspaceScope,
				requestedWorkspaceId: null,
				resourceName: "contact",
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.code).toBe("WORKSPACE_ID_REQUIRED");
		}
	});

	it("accepts an explicit allowed workspace", () => {
		expect(
			decideOperationalCreateScope({
				requireWorkspaceId: true,
				workspaceScope: ["ws_a", "ws_b"],
				requestedWorkspaceId: "ws_b",
			}),
		).toEqual({ ok: true, workspaceId: "ws_b" });
	});

	it("lets an authoritative parent satisfy strict mode before missing-ID validation", () => {
		const parentDecision = decideParentBoundCreateScope({
			requestedWorkspaceId: undefined,
			parentWorkspaceIds: ["ws_parent"],
			resourceName: "post",
		});
		expect(parentDecision).toEqual({
			ok: true,
			requestedWorkspaceId: "ws_parent",
		});
		if (!parentDecision.ok) throw new Error("unexpected scope conflict");
		expect(
			decideOperationalCreateScope({
				requireWorkspaceId: true,
				workspaceScope: ["ws_parent"],
				requestedWorkspaceId: parentDecision.requestedWorkspaceId,
				resourceName: "post",
			}),
		).toEqual({ ok: true, workspaceId: "ws_parent" });
	});

	it("does not let inheritance override a mismatched explicit workspace", () => {
		expect(
			decideParentBoundCreateScope({
				requestedWorkspaceId: "ws_requested",
				parentWorkspaceIds: ["ws_parent"],
				resourceName: "broadcast",
			}),
		).toMatchObject({ ok: false, code: "WORKSPACE_SCOPE_CONFLICT" });
	});

	it("rejects mixed authoritative parent scopes", () => {
		expect(
			decideParentBoundCreateScope({
				requestedWorkspaceId: undefined,
				parentWorkspaceIds: ["ws_a", "ws_b"],
				resourceName: "post",
			}),
		).toMatchObject({ ok: false, code: "WORKSPACE_SCOPE_CONFLICT" });
	});

	it("keeps independent and organization-scoped-parent omission strict", () => {
		for (const parentWorkspaceIds of [[], [null]] as Array<
			Array<string | null>
		>) {
			const parentDecision = decideParentBoundCreateScope({
				requestedWorkspaceId: undefined,
				parentWorkspaceIds,
			});
			expect(parentDecision).toEqual({
				ok: true,
				requestedWorkspaceId: null,
			});
			if (!parentDecision.ok) throw new Error("unexpected scope conflict");
			expect(
				decideOperationalCreateScope({
					requireWorkspaceId: true,
					workspaceScope: "all",
					requestedWorkspaceId: parentDecision.requestedWorkspaceId,
				}),
			).toMatchObject({ ok: false, code: "WORKSPACE_ID_REQUIRED" });
		}
	});

	it("rejects an explicit workspace outside the credential scope", () => {
		const result = decideOperationalCreateScope({
			requireWorkspaceId: false,
			workspaceScope: ["ws_a"],
			requestedWorkspaceId: "ws_b",
		});

		expect(result).toMatchObject({
			ok: false,
			status: 403,
			code: "WORKSPACE_ACCESS_DENIED",
		});
	});

	it("does not treat an empty workspace query value as explicit", () => {
		const result = decideOperationalCreateScope({
			requireWorkspaceId: true,
			workspaceScope: "all",
			requestedWorkspaceId: "   ",
		});

		expect(result).toMatchObject({
			ok: false,
			code: "WORKSPACE_ID_REQUIRED",
		});
	});

	it("wires the canonical resolver into operational create routes", async () => {
		const routeNames = [
			"media",
			"webhooks",
			"automations",
			"ideas",
			"segments",
			"ai-knowledge",
			"short-links",
		];
		for (const routeName of routeNames) {
			const source = await Bun.file(
				`${repoRoot}apps/api/src/routes/${routeName}.ts`,
			).text();
			expect(source, routeName).toContain("resolveOperationalCreateScope");
			expect(source, routeName).not.toContain("assertScopedCreateWorkspace");
		}
	});

	it("inherits authoritative parent scope without requiring an omitted ID", async () => {
		for (const routeName of [
			"posts",
			"threads",
			"broadcasts",
			"contacts",
			"auto-post-rules",
			"ref-urls",
		]) {
			const source = await Bun.file(
				`${repoRoot}apps/api/src/routes/${routeName}.ts`,
			).text();
			expect(source, routeName).toContain("inheritOperationalCreateScope");
		}

		const phoneProvisioning = await Bun.file(
			`${repoRoot}apps/api/src/routes/whatsapp-phone-provisioning.ts`,
		).text();
		expect(phoneProvisioning).toContain("workspaceId: account.workspaceId");
		expect(phoneProvisioning).toContain("workspaceId,");
	});

	it("keeps shared definitions organization-global and all-scope managed", async () => {
		for (const routeName of [
			"custom-fields",
			"content-templates",
			"tags",
			"idea-groups",
			"signatures",
		]) {
			const source = await Bun.file(
				`${repoRoot}apps/api/src/routes/${routeName}.ts`,
			).text();
			expect(source, routeName).toContain("assertAllWorkspaceScope");
			expect(source, routeName).toContain("workspaceId: null");
		}
	});
});
