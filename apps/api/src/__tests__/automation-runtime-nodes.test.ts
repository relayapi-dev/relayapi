import { describe, expect, it } from "bun:test";
import type { Database } from "@relayapi/db";
import { encryptAccountToken } from "../lib/account-token-crypto";
import { waitingRunMatchesEventScope } from "../services/automations/event-resume";
import { endHandler } from "../services/automations/nodes/end";
import { messageHandler } from "../services/automations/nodes/message";
import { socialProfileCheckHandler } from "../services/automations/nodes/social-profile-check";
import { waitEventHandler } from "../services/automations/nodes/wait-event";
import type { RunContext } from "../services/automations/types";

const ENCRYPTION_KEY = `test=${"33".repeat(32)}`;

function context(overrides: Partial<RunContext> = {}): RunContext {
	return {
		runId: "arun_nodes",
		automationId: "auto_nodes",
		organizationId: "org_nodes",
		workspaceId: null,
		contactId: "ct_nodes",
		conversationId: null,
		channel: "instagram",
		graph: { schema_version: 1, root_node_key: null, nodes: [], edges: [] },
		context: {},
		now: new Date("2026-07-18T12:00:00.000Z"),
		db: {} as Database,
		env: {},
		...overrides,
	};
}

describe("wait_event node", () => {
	it("deduplicates event kinds and computes a deterministic timeout", async () => {
		const result = await waitEventHandler.handle(
			{
				key: "wait",
				kind: "wait_event",
				config: {
					event_kinds: ["story_mention", "story_mention", "dm_received"],
					timeout_min: 15,
				},
			},
			context(),
		);
		expect(result).toMatchObject({
			result: "wait_event",
			event_kinds: ["story_mention", "dm_received"],
		});
		if (result.result !== "wait_event") throw new Error("expected wait_event");
		expect(result.timeout_at?.toISOString()).toBe("2026-07-18T12:15:00.000Z");
	});

	it("fails closed when no event kind is configured", async () => {
		const result = await waitEventHandler.handle(
			{ key: "wait", kind: "wait_event", config: { event_kinds: [] } },
			context(),
		);
		expect(result.result).toBe("fail");
	});

	it("accepts only events from the run's channel and pinned account", () => {
		const instagramEvent = {
			channel: "instagram" as const,
			socialAccountId: "acc_instagram",
		};
		expect(
			waitingRunMatchesEventScope("instagram", "acc_instagram", instagramEvent),
		).toBe(true);
		expect(waitingRunMatchesEventScope("facebook", null, instagramEvent)).toBe(
			false,
		);
		expect(
			waitingRunMatchesEventScope("instagram", "acc_other", instagramEvent),
		).toBe(false);
	});
});

describe("message and terminal nodes", () => {
	it("parks an empty explicit reply wait without requiring a timeout", async () => {
		const result = await messageHandler.handle(
			{
				key: "wait",
				kind: "message",
				config: { blocks: [], wait_for_reply: true },
			},
			context(),
		);
		expect(result).toMatchObject({ result: "wait_input" });
		if (result.result !== "wait_input") throw new Error("expected wait_input");
		expect(result.timeout_at).toBeUndefined();
	});

	it("defaults malformed legacy end reasons instead of throwing", async () => {
		const result = await endHandler.handle(
			{
				key: "end",
				kind: "end",
				config: { reason: 42 as never },
			},
			context(),
		);
		expect(result).toMatchObject({ result: "end", exit_reason: "completed" });
	});
});

describe("social_profile_check node", () => {
	it("rejects non-Instagram automations before provider access", async () => {
		const result = await socialProfileCheckHandler.handle(
			{ key: "check", kind: "social_profile_check", config: {} },
			context({ channel: "facebook" }),
		);
		expect(result.result).toBe("fail");
	});

	it("uses the persisted triggering account and branches on live follow state", async () => {
		const accountId = "acc_instagram";
		const encryptedToken = await encryptAccountToken(
			"IGAA-test-token",
			ENCRYPTION_KEY,
			accountId,
			"access_token",
		);
		const db = {
			query: {
				contactChannels: {
					findFirst: async () => ({ identifier: "igsid_123" }),
				},
				socialAccounts: {
					findFirst: async () => ({
						id: accountId,
						accessToken: encryptedToken,
					}),
				},
			},
		} as unknown as Database;
		let requestedUrl = "";
		let requestedAuthorization = "";
		const profileFetch = (async (input: unknown, init?: RequestInit) => {
			requestedUrl = String(input);
			requestedAuthorization =
				new Headers(init?.headers).get("Authorization") ?? "";
			return new Response(JSON.stringify({ is_user_follow_business: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;
		const ctx = context({
			db,
			context: { _triggering_social_account_id: accountId },
			env: { ENCRYPTION_KEY, profileFetch },
		});

		const result = await socialProfileCheckHandler.handle(
			{ key: "check", kind: "social_profile_check", config: {} },
			ctx,
		);

		expect(result).toMatchObject({
			result: "advance",
			via_port: "follows",
			payload: { is_user_follow_business: true },
		});
		expect(requestedUrl).toContain("/igsid_123");
		expect(requestedUrl).toContain("fields=is_user_follow_business");
		expect(requestedAuthorization).toBe("Bearer IGAA-test-token");
		expect(ctx.context.social_profile).toMatchObject({
			is_user_follow_business: true,
		});
	});
});
