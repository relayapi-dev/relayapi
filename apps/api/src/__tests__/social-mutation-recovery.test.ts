import { describe, expect, it } from "bun:test";
import {
	CommentIdParams,
	ProviderPostIdParams,
} from "../schemas/social-actions";
import { WhatsAppGroupParams } from "../schemas/whatsapp-admin";
import {
	runSocialMutation,
	type SocialMutationOperation,
} from "../services/social-mutation-operations";
import {
	classifySocialMutationRecovery,
	decryptSocialProjectionPayload,
	encryptSocialProjectionPayload,
} from "../services/social-mutation-projection";
import { SocialProviderActionError } from "../services/social-provider-actions";

const ENCRYPTION_KEY = `active=${"c".repeat(64)}`;
const identity = {
	organizationId: "org_1",
	targetType: "inbox_message" as const,
	targetId: "msg_1",
	kind: "message_edit" as const,
};

function mutationDb(events: string[]) {
	const operation = {
		id: "smut_1",
		organizationId: "org_1",
		workspaceId: null,
		accountId: "acc_1",
		platform: "discord",
		targetType: "post_target",
		targetId: "pt_1",
		kind: "post_edit",
		operationKeyHash: "a".repeat(64),
		requestHash: "b".repeat(64),
		requestPayload: {},
		status: "processing",
		phase: "provider",
		leaseToken: 1,
		leaseExpiresAt: new Date(Date.now() + 60_000),
		requestMayHaveBeenSentAt: null,
		providerConfirmedAt: null,
		providerOperationId: null,
		providerResult: null,
		attempts: 1,
		lastError: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		completedAt: null,
	} as SocialMutationOperation;

	const update = () => ({
		set(values: Record<string, unknown>) {
			if (values.requestMayHaveBeenSentAt) events.push("request_boundary");
			if (values.providerConfirmedAt) events.push("provider_confirmed");
			if (values.status === "completed") events.push("complete");
			if (values.status === "failed" || values.status === "unknown") {
				events.push(`park_${values.status}`);
			}
			return {
				where() {
					return {
						returning() {
							return Promise.resolve([
								values.status === "completed" ||
								values.status === "failed" ||
								values.status === "unknown"
									? { ...operation, ...values }
									: { id: operation.id },
							]);
						},
					};
				},
			};
		},
	});
	const insert = () => ({
		values() {
			return {
				onConflictDoNothing() {
					return {
						returning() {
							events.push("admitted");
							return Promise.resolve([operation]);
						},
					};
				},
			};
		},
	});
	const db = {
		insert,
		update,
		transaction<T>(callback: (tx: unknown) => Promise<T>) {
			return callback(db);
		},
	};
	return { db, operation };
}

describe("social mutation projection recovery", () => {
	it("accepts opaque IDs but rejects path, query, and control injection", () => {
		expect(
			CommentIdParams.safeParse({ comment_id: "t1_abc.def" }).success,
		).toBe(true);
		for (const value of ["a/b", "a?b", "a#b", "a\\b", "a\nb"]) {
			expect(CommentIdParams.safeParse({ comment_id: value }).success).toBe(
				false,
			);
			expect(
				ProviderPostIdParams.safeParse({ provider_post_id: value }).success,
			).toBe(false);
			expect(WhatsAppGroupParams.safeParse({ group_id: value }).success).toBe(
				false,
			);
		}
	});

	it("encrypts replay content with exact target-bound additional data", async () => {
		const ciphertext = await encryptSocialProjectionPayload(
			ENCRYPTION_KEY,
			identity,
			{ text: "private edit" },
		);
		expect(ciphertext).not.toContain("private edit");
		expect(
			await decryptSocialProjectionPayload(
				ENCRYPTION_KEY,
				identity,
				ciphertext,
			),
		).toEqual({ text: "private edit" });
		await expect(
			decryptSocialProjectionPayload(
				ENCRYPTION_KEY,
				{ ...identity, targetId: "msg_other" },
				ciphertext,
			),
		).rejects.toThrow();
	});

	it("replays only confirmed projections and leaves ambiguous provider work manual", () => {
		expect(
			classifySocialMutationRecovery({
				status: "unknown",
				phase: "projection",
				providerConfirmedAt: new Date(),
				attempts: 2,
			}),
		).toBe("projection_replay");
		expect(
			classifySocialMutationRecovery({
				status: "processing",
				phase: "projection",
				providerConfirmedAt: new Date(),
				attempts: 3,
			}),
		).toBe("projection_replay");
		expect(
			classifySocialMutationRecovery({
				status: "request_may_have_been_sent",
				phase: "provider",
				providerConfirmedAt: null,
				attempts: 1,
			}),
		).toBe("manual_reconciliation");
		expect(
			classifySocialMutationRecovery({
				status: "unknown",
				phase: "projection",
				providerConfirmedAt: new Date(),
				attempts: 8,
			}),
		).toBe("exhausted");
	});

	it("revalidates after admission and before crossing the provider boundary", async () => {
		const events: string[] = [];
		const { db } = mutationDb(events);
		const result = await runSocialMutation({
			db: db as never,
			organizationId: "org_1",
			workspaceId: null,
			accountId: "acc_1",
			platform: "discord",
			targetType: "post_target",
			targetId: "pt_1",
			kind: "post_edit",
			operationKey: "edit-1",
			requestPayload: {},
			validateBeforeProvider: async () => {
				events.push("validated_fresh_target");
			},
			provider: async () => {
				events.push("provider");
				return { providerId: "message-1" };
			},
			project: async () => {
				events.push("project");
			},
		});

		expect(result.status).toBe("completed");
		expect(events).toEqual([
			"admitted",
			"validated_fresh_target",
			"request_boundary",
			"provider",
			"provider_confirmed",
			"project",
			"complete",
		]);
	});

	it("parks a stale post-admission snapshot without provider I/O", async () => {
		const events: string[] = [];
		const { db } = mutationDb(events);
		const result = await runSocialMutation({
			db: db as never,
			organizationId: "org_1",
			workspaceId: null,
			accountId: "acc_1",
			platform: "discord",
			targetType: "post_target",
			targetId: "pt_1",
			kind: "post_edit",
			operationKey: "edit-2",
			requestPayload: {},
			validateBeforeProvider: async () => {
				events.push("validated_stale_target");
				throw new SocialProviderActionError(
					"PUBLISHED_EDIT_PRECONDITION_CHANGED",
					"stale",
					{ definitive: true },
				);
			},
			provider: async () => {
				events.push("provider");
				return { providerId: "must-not-run" };
			},
		});

		expect(result.status).toBe("failed");
		expect(events).toEqual([
			"admitted",
			"validated_stale_target",
			"park_failed",
		]);
	});
});
