import { describe, expect, it, spyOn } from "bun:test";
import {
	armToolJobProviderBoundary,
	type ClaimedToolJob,
	executeClaimedToolJob,
	type ToolJobExecutorOverrides,
} from "../services/tool-jobs";
import type { Env } from "../types";

function claim(attempts = 1): ClaimedToolJob {
	return {
		id: "tj_executor",
		organizationId: "org_executor",
		kind: "download",
		request: { url: "https://example.test/video" },
		attempts,
		leaseToken: attempts,
		deadlineAt: new Date(Date.now() + 60_000),
		usageReservation: {
			id: "ur_executor",
			bucketId: "ub_executor",
			organizationId: "org_executor",
		},
	};
}

const env = {} as Env;

describe("fenced tool-job executor", () => {
	it("rejects an elapsed hard deadline before opening the provider boundary", async () => {
		const expired = claim();
		const now = new Date();
		expired.deadlineAt = new Date(now.getTime() - 1);

		await expect(armToolJobProviderBoundary(env, expired, now)).rejects.toThrow(
			"Tool job deadline elapsed before provider egress",
		);
	});

	it("performs exactly one provider request for one durable claim", async () => {
		let providerCalls = 0;
		let armCalls = 0;
		const overrides: ToolJobExecutorOverrides = {
			callProvider: async (_env, _path, _body, timeoutMs, onBoundary) => {
				providerCalls += 1;
				expect(timeoutMs).toBe(60_000);
				await onBoundary?.();
				return {
					ok: true,
					requestStarted: true,
					data: { download_url: "https://cdn.example.test/video.mp4" },
				};
			},
			armBoundary: async () => {
				armCalls += 1;
			},
			complete: async () => true,
		};

		const result = await executeClaimedToolJob(env, claim(), overrides);

		expect(result).toEqual({
			delivery: "ack",
			outcome: "completed",
			data: { download_url: "https://cdn.example.test/video.mp4" },
		});
		expect(providerCalls).toBe(1);
		expect(armCalls).toBe(1);
	});

	it("reconciles late success after expired-lease manual review", async () => {
		let reconciled = 0;
		const result = await executeClaimedToolJob(env, claim(), {
			callProvider: async (_env, _path, _body, _timeoutMs, onBoundary) => {
				await onBoundary?.();
				return {
					ok: true,
					requestStarted: true,
					data: { transcript: "known good" },
				};
			},
			armBoundary: async () => {},
			complete: async () => false,
			reconcileDefinitive: async (_env, _claim, outcome) => {
				expect(outcome).toEqual({
					kind: "completed",
					result: { transcript: "known good" },
				});
				reconciled += 1;
				return true;
			},
		});

		expect(reconciled).toBe(1);
		expect(result.outcome).toBe("completed");
		expect(result.delivery).toBe("ack");
	});

	it("reconciles a late definitive provider rejection without replay", async () => {
		let reconciled = 0;
		const result = await executeClaimedToolJob(env, claim(), {
			callProvider: async (_env, _path, _body, _timeoutMs, onBoundary) => {
				await onBoundary?.();
				return {
					ok: false,
					requestStarted: true,
					error: "captions disabled",
				};
			},
			armBoundary: async () => {},
			fail: async () => false,
			reconcileDefinitive: async (_env, _claim, outcome) => {
				expect(outcome).toEqual({
					kind: "failed",
					error: "captions disabled",
					errorCode: "EXTRACTION_FAILED",
				});
				reconciled += 1;
				return true;
			},
		});

		expect(reconciled).toBe(1);
		expect(result).toEqual({
			delivery: "ack",
			outcome: "failed",
			error: "captions disabled",
			errorCode: "EXTRACTION_FAILED",
		});
	});

	it("preserves known success when its first terminal settlement throws", async () => {
		let providerCalls = 0;
		let reconcileCalls = 0;
		const result = await executeClaimedToolJob(env, claim(), {
			callProvider: async (_env, _path, _body, _timeoutMs, onBoundary) => {
				providerCalls += 1;
				await onBoundary?.();
				return {
					ok: true,
					requestStarted: true,
					data: { download_url: "https://cdn.test/late" },
				};
			},
			armBoundary: async () => {},
			complete: async () => {
				throw new Error("commit response lost");
			},
			reconcileDefinitive: async () => {
				reconcileCalls += 1;
				return reconcileCalls === 2;
			},
			sameFenceHasDefinitiveOutcome: async () => false,
			markUnknown: async () => true,
		});

		expect(providerCalls).toBe(1);
		expect(reconcileCalls).toBe(2);
		expect(result).toEqual({
			delivery: "ack",
			outcome: "completed",
			data: { download_url: "https://cdn.test/late" },
		});
	});

	it("preserves known rejection when its first terminal settlement throws", async () => {
		let providerCalls = 0;
		let reconcileCalls = 0;
		const result = await executeClaimedToolJob(env, claim(), {
			callProvider: async (_env, _path, _body, _timeoutMs, onBoundary) => {
				providerCalls += 1;
				await onBoundary?.();
				return {
					ok: false,
					requestStarted: true,
					error: "captions disabled",
				};
			},
			armBoundary: async () => {},
			fail: async () => {
				throw new Error("commit response lost");
			},
			reconcileDefinitive: async () => {
				reconcileCalls += 1;
				return reconcileCalls === 2;
			},
			sameFenceHasDefinitiveOutcome: async () => false,
			markUnknown: async () => true,
		});

		expect(providerCalls).toBe(1);
		expect(reconcileCalls).toBe(2);
		expect(result).toEqual({
			delivery: "ack",
			outcome: "failed",
			error: "captions disabled",
			errorCode: "EXTRACTION_FAILED",
		});
	});

	it("logs reconciliation failure and safely acks without provider replay", async () => {
		const consoleError = spyOn(console, "error").mockImplementation(() => {});
		let providerCalls = 0;
		try {
			const result = await executeClaimedToolJob(env, claim(), {
				callProvider: async (_env, _path, _body, _timeoutMs, onBoundary) => {
					providerCalls += 1;
					await onBoundary?.();
					return {
						ok: true,
						requestStarted: true,
						data: { download_url: "https://cdn.test/uncertain" },
					};
				},
				armBoundary: async () => {},
				complete: async () => false,
				reconcileDefinitive: async () => {
					throw new Error("database unavailable");
				},
				sameFenceHasDefinitiveOutcome: async () => false,
				markUnknown: async () => true,
			});

			expect(providerCalls).toBe(1);
			expect(result).toEqual({ delivery: "ack", outcome: "lost_fence" });
			expect(
				consoleError.mock.calls.some(
					([message, detail]) =>
						message === "[tools] definitive provider reconciliation failed" &&
						(detail as { event?: string }).event ===
							"tool_job_definitive_reconciliation_failed",
				),
			).toBe(true);
		} finally {
			consoleError.mockRestore();
		}
	});

	it("keeps a second ambiguous outcome on the same fence in manual review", async () => {
		const result = await executeClaimedToolJob(env, claim(), {
			callProvider: async (_env, _path, _body, _timeoutMs, onBoundary) => {
				await onBoundary?.();
				return {
					ok: false,
					requestStarted: true,
					outcomeUnknown: true,
					error: "Service timeout",
				};
			},
			armBoundary: async () => {},
			markUnknown: async () => false,
			sameFenceIsManualReview: async () => true,
		});

		expect(result).toEqual({ delivery: "ack", outcome: "manual_review" });
	});

	it("recovers an unknown-settlement response loss from durable manual review", async () => {
		const result = await executeClaimedToolJob(env, claim(), {
			callProvider: async (_env, _path, _body, _timeoutMs, onBoundary) => {
				await onBoundary?.();
				return {
					ok: false,
					requestStarted: true,
					outcomeUnknown: true,
					error: "Service timeout",
				};
			},
			armBoundary: async () => {},
			markUnknown: async () => {
				throw new Error("commit response lost");
			},
			sameFenceIsManualReview: async () => true,
		});

		expect(result).toEqual({ delivery: "ack", outcome: "manual_review" });
	});

	it("uses at most three database-authorized attempts for pre-boundary failure", async () => {
		let providerCalls = 0;
		let deferrals = 0;
		let terminalFailures = 0;
		const baseOverrides: ToolJobExecutorOverrides = {
			callProvider: async () => {
				providerCalls += 1;
				return {
					ok: false,
					requestStarted: false,
					error: "provider not configured",
				};
			},
			defer: async () => {
				deferrals += 1;
				return true;
			},
			fail: async () => {
				terminalFailures += 1;
				return true;
			},
		};

		const outcomes = [];
		for (const attempts of [1, 2, 3]) {
			outcomes.push(
				await executeClaimedToolJob(env, claim(attempts), baseOverrides),
			);
		}

		expect(providerCalls).toBe(3);
		expect(deferrals).toBe(2);
		expect(terminalFailures).toBe(1);
		expect(outcomes.map((outcome) => outcome.delivery)).toEqual([
			"retry",
			"retry",
			"ack",
		]);
	});
});
