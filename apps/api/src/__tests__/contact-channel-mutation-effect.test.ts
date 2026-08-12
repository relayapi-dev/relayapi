import { describe, expect, it } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Database } from "@relayapi/db";
import {
	instrumentMutationDatabase,
	MutationEffectTracker,
} from "../lib/mutation-effect";
import { contactsRouter } from "../routes/contacts";
import type { Env, Variables } from "../types";

const TEST_ENCRYPTION_KEY = `test=${"31".repeat(32)},identity=${"32".repeat(32)}`;

type InsertMode = "committed_then_bad_ciphertext" | "unique_conflict";

function makeDatabase(mode: InsertMode): Database {
	let selectCount = 0;
	// biome-ignore lint/suspicious/noExplicitAny: minimal Drizzle route-test double
	const db: any = {
		select: () => ({
			from: () => {
				// biome-ignore lint/suspicious/noExplicitAny: chainable route-test double
				const chain: any = {
					where: () => chain,
					limit: async () => {
						selectCount += 1;
						return selectCount === 1
							? [{ id: "ct_1", workspaceId: null }]
							: [{ id: "acc_1", platform: "whatsapp" }];
					},
				};
				return chain;
			},
		}),
		insert: () => ({
			// biome-ignore lint/suspicious/noExplicitAny: captures a Drizzle values object
			values: (values: any) => ({
				returning: async () => {
					if (mode === "unique_conflict") {
						throw Object.assign(new Error("duplicate channel"), {
							code: "23505",
						});
					}
					return [
						{
							...values,
							identifierCiphertext: "not-a-valid-ciphertext",
							createdAt: new Date(),
						},
					];
				},
			}),
		}),
	};
	return db as Database;
}

function makeApp(mode: InsertMode) {
	const tracker = new MutationEffectTracker();
	const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
	app.use("*", async (c, next) => {
		tracker.markRouteEntered();
		tracker.markCoverageComplete();
		c.set("orgId", "org_test");
		c.set("workspaceScope", "all");
		c.set("mutationEffectTracker", tracker);
		c.set("db", instrumentMutationDatabase(makeDatabase(mode), tracker));
		await next();
	});
	app.route("/v1/contacts", contactsRouter);
	return { app, tracker };
}

function addChannelRequest(app: ReturnType<typeof makeApp>["app"]) {
	return app.request(
		"/v1/contacts/ct_1/channels",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				account_id: "acc_1",
				platform: "whatsapp",
				identifier: "+447700900123",
			}),
		},
		{ ENCRYPTION_KEY: TEST_ENCRYPTION_KEY } as unknown as Env,
	);
}

describe("contact-channel mutation evidence", () => {
	it("does not turn a post-commit serialization failure into a 409/K=0", async () => {
		const { app, tracker } = makeApp("committed_then_bad_ciphertext");

		const response = await addChannelRequest(app);

		expect(response.status).toBe(500);
		expect(tracker.outcome(1)).toEqual({ kind: "committed", units: 1 });
		expect(tracker.isProvenNotApplied()).toBe(false);
	});

	it("proves a PostgreSQL unique conflict did not apply", async () => {
		const { app, tracker } = makeApp("unique_conflict");

		const response = await addChannelRequest(app);
		const body: unknown = await response.json();

		expect(response.status).toBe(409);
		expect(body).toEqual({
			error: {
				code: "CONFLICT",
				message: "Channel already exists for this account and identifier",
			},
		});
		expect(tracker.outcome(1)).toEqual({ kind: "not_applied" });
		expect(tracker.isProvenNotApplied()).toBe(true);
	});
});
