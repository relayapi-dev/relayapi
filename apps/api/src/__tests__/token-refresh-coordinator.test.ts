import { describe, expect, test } from "bun:test";
import {
	type CoordinatorDependencies,
	coordinateTokenRefresh,
	type PersistedRefreshTokens,
	type RefreshAccountRecord,
	type RefreshClaim,
	type RefreshClaimOutcome,
	type RefreshMode,
	TOKEN_REFRESH_BOUNDARY_STALE_MS,
	TokenRefreshInProgressError,
	type TokenRefreshStore,
	TokenRefreshUnknownError,
} from "../services/token-refresh-coordinator";

type Operation = NonNullable<
	Awaited<ReturnType<TokenRefreshStore["observe"]>>["operation"]
> & {
	fencingToken: number;
	leaseExpiresAt: Date | null;
};

function makeAccount(): RefreshAccountRecord {
	return {
		id: "acc_test",
		organizationId: "org_test",
		platform: "twitter",
		platformAccountId: "provider-account",
		username: "relay",
		displayName: "Relay",
		accessToken: "access-v1",
		refreshToken: "refresh-v1",
		tokenVersion: 0,
		tokenExpiresAt: new Date(0),
		metadata: null,
	};
}

function sameSource(
	account: RefreshAccountRecord,
	source: Operation | RefreshClaim,
): boolean {
	return account.tokenVersion === source.sourceTokenVersion;
}

class FakeRefreshStore implements TokenRefreshStore {
	account: RefreshAccountRecord | null = makeAccount();
	operation: Operation | null = null;
	providerBoundaryCount = 0;
	persistCount = 0;

	async claim(
		_accountId: string,
		_mode: RefreshMode,
		now: Date,
	): Promise<RefreshClaimOutcome> {
		if (!this.account) return { kind: "missing" };
		if (this.operation && sameSource(this.account, this.operation)) {
			if (this.operation.state === "unknown") {
				return {
					kind: "blocked_unknown",
					operationId: this.operation.operationId,
					account: { ...this.account },
				};
			}
			if (this.operation.state === "request_may_have_been_sent") {
				const boundaryExpired =
					!this.operation.requestMayHaveBeenSentAt ||
					this.operation.requestMayHaveBeenSentAt.getTime() <=
						now.getTime() - TOKEN_REFRESH_BOUNDARY_STALE_MS;
				if (boundaryExpired) {
					this.operation.state = "unknown";
					return {
						kind: "blocked_unknown",
						operationId: this.operation.operationId,
						account: { ...this.account },
					};
				}
				return { kind: "busy", account: { ...this.account } };
			}
			if (
				this.operation.state === "claimed_pre_request" &&
				this.operation.leaseExpiresAt &&
				this.operation.leaseExpiresAt.getTime() > now.getTime()
			) {
				return { kind: "busy", account: { ...this.account } };
			}
		}

		const fencingToken = (this.operation?.fencingToken ?? 0) + 1;
		this.operation = {
			operationId: `refresh-${fencingToken}`,
			state: "claimed_pre_request",
			fencingToken,
			sourceTokenVersion: this.account.tokenVersion,
			leaseExpiresAt: new Date(now.getTime() + 30_000),
			requestMayHaveBeenSentAt: null,
		};
		return {
			kind: "claimed",
			claim: {
				operationId: this.operation.operationId,
				fencingToken,
				sourceTokenVersion: this.account.tokenVersion,
				account: { ...this.account },
			},
		};
	}

	async markRequestMayHaveBeenSent(
		claim: RefreshClaim,
		now: Date,
	): Promise<boolean> {
		if (
			!this.operation ||
			this.operation.operationId !== claim.operationId ||
			this.operation.fencingToken !== claim.fencingToken ||
			this.operation.state !== "claimed_pre_request"
		) {
			return false;
		}
		this.operation.state = "request_may_have_been_sent";
		this.operation.leaseExpiresAt = null;
		this.operation.requestMayHaveBeenSentAt = now;
		this.providerBoundaryCount++;
		return true;
	}

	async persistSuccess(
		claim: RefreshClaim,
		tokens: PersistedRefreshTokens,
	): Promise<RefreshAccountRecord | null> {
		if (
			!this.account ||
			!this.operation ||
			this.operation.operationId !== claim.operationId ||
			this.operation.fencingToken !== claim.fencingToken ||
			this.operation.state !== "request_may_have_been_sent" ||
			!sameSource(this.account, claim)
		) {
			return null;
		}
		this.account = {
			...this.account,
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken ?? this.account.refreshToken,
			tokenExpiresAt: tokens.tokenExpiresAt ?? this.account.tokenExpiresAt,
			tokenVersion: this.account.tokenVersion + 1,
		};
		this.operation.state = "succeeded";
		this.persistCount++;
		return { ...this.account };
	}

	async markUnknown(claim: RefreshClaim): Promise<void> {
		if (
			this.operation?.operationId === claim.operationId &&
			this.operation.fencingToken === claim.fencingToken &&
			this.operation.state === "request_may_have_been_sent"
		) {
			this.operation.state = "unknown";
			this.operation.leaseExpiresAt = null;
		}
	}

	async observe(): ReturnType<TokenRefreshStore["observe"]> {
		return {
			account: this.account ? { ...this.account } : null,
			operation: this.operation ? { ...this.operation } : null,
		};
	}
}

function dependencies(
	store: FakeRefreshStore,
	refreshProvider: CoordinatorDependencies["refreshProvider"],
): CoordinatorDependencies {
	return {
		store,
		decrypt: async (account) => ({
			accessToken: account.accessToken,
			refreshToken: account.refreshToken,
		}),
		encrypt: async (_claim, result, now) => ({
			accessToken: result.access_token,
			...(result.refresh_token ? { refreshToken: result.refresh_token } : {}),
			...(result.expires_in
				? {
						tokenExpiresAt: new Date(now.getTime() + result.expires_in * 1_000),
					}
				: {}),
		}),
		refreshProvider,
		sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
	};
}

describe("durable token refresh coordination", () => {
	test("simultaneous callers make one provider request and observe one rotation", async () => {
		const store = new FakeRefreshStore();
		let releaseProvider: (() => void) | undefined;
		let providerCalls = 0;
		const providerStarted = Promise.withResolvers<void>();
		const deps = dependencies(store, async () => {
			providerCalls++;
			providerStarted.resolve();
			await new Promise<void>((resolve) => {
				releaseProvider = resolve;
			});
			return {
				access_token: "access-v2",
				refresh_token: "refresh-v2",
				expires_in: 3_600,
			};
		});

		const first = coordinateTokenRefresh(deps, "acc_test", "force");
		await providerStarted.promise;
		const second = coordinateTokenRefresh(deps, "acc_test", "force");
		releaseProvider?.();
		const [firstResult, secondResult] = await Promise.all([first, second]);

		expect(providerCalls).toBe(1);
		expect(store.providerBoundaryCount).toBe(1);
		expect(store.persistCount).toBe(1);
		expect(firstResult.accessToken).toBe("access-v2");
		expect(secondResult.accessToken).toBe("access-v2");
		expect(store.account?.tokenVersion).toBe(1);
	});

	test("a crash/failure after the request boundary is never auto-reclaimed", async () => {
		const store = new FakeRefreshStore();
		let providerCalls = 0;
		const deps = dependencies(store, async () => {
			providerCalls++;
			throw new Error("worker terminated after request dispatch");
		});

		await expect(
			coordinateTokenRefresh(deps, "acc_test", "force"),
		).rejects.toBeInstanceOf(TokenRefreshUnknownError);
		expect(store.operation?.state).toBe("unknown");

		await expect(
			coordinateTokenRefresh(deps, "acc_test", "force"),
		).rejects.toBeInstanceOf(TokenRefreshUnknownError);
		expect(providerCalls).toBe(1);
	});

	test("a stale persisted request boundary becomes manual unknown without another provider call", async () => {
		const store = new FakeRefreshStore();
		const now = new Date("2026-07-13T12:00:00.000Z");
		store.operation = {
			operationId: "crashed-after-request-dispatch",
			state: "request_may_have_been_sent",
			fencingToken: 7,
			sourceTokenVersion: 0,
			leaseExpiresAt: null,
			requestMayHaveBeenSentAt: new Date(
				now.getTime() - TOKEN_REFRESH_BOUNDARY_STALE_MS,
			),
		};
		let providerCalls = 0;
		const deps = {
			...dependencies(store, async () => {
				providerCalls++;
				return { access_token: "duplicate-refresh" };
			}),
			now: () => now,
		};

		await expect(
			coordinateTokenRefresh(deps, "acc_test", "force"),
		).rejects.toBeInstanceOf(TokenRefreshUnknownError);
		expect(providerCalls).toBe(0);
		expect(store.operation.state).toBe("unknown");
	});

	test("a fresh persisted request boundary remains in progress", async () => {
		const store = new FakeRefreshStore();
		const now = new Date("2026-07-13T12:00:00.000Z");
		store.operation = {
			operationId: "active-provider-request",
			state: "request_may_have_been_sent",
			fencingToken: 7,
			sourceTokenVersion: 0,
			leaseExpiresAt: null,
			requestMayHaveBeenSentAt: now,
		};
		let providerCalls = 0;
		const deps = {
			...dependencies(store, async () => {
				providerCalls++;
				return { access_token: "duplicate-refresh" };
			}),
			now: () => now,
		};

		await expect(
			coordinateTokenRefresh(deps, "acc_test", "force"),
		).rejects.toBeInstanceOf(TokenRefreshInProgressError);
		expect(providerCalls).toBe(0);
		expect(store.operation.state).toBe("request_may_have_been_sent");
	});

	test("the source-version CAS never overwrites a concurrent reconnect", async () => {
		const store = new FakeRefreshStore();
		const deps = dependencies(store, async () => {
			if (!store.account) throw new Error("missing test account");
			store.account = {
				...store.account,
				accessToken: "access-from-reconnect",
				refreshToken: "refresh-from-reconnect",
				tokenVersion: store.account.tokenVersion + 1,
			};
			return {
				access_token: "stale-provider-access",
				refresh_token: "stale-provider-refresh",
			};
		});

		await expect(
			coordinateTokenRefresh(deps, "acc_test", "force"),
		).rejects.toBeInstanceOf(TokenRefreshUnknownError);
		expect(store.persistCount).toBe(0);
		expect(store.account?.accessToken).toBe("access-from-reconnect");
		expect(store.account?.refreshToken).toBe("refresh-from-reconnect");
	});

	test("key re-encryption cannot masquerade as a new credential source", async () => {
		const store = new FakeRefreshStore();
		store.operation = {
			operationId: "unknown-before-key-rotation",
			state: "unknown",
			fencingToken: 3,
			sourceTokenVersion: 0,
			leaseExpiresAt: null,
			requestMayHaveBeenSentAt: new Date(0),
		};
		if (!store.account) throw new Error("missing test account");
		store.account = {
			...store.account,
			accessToken: "new-key-access-ciphertext",
			refreshToken: "new-key-refresh-ciphertext",
			// Key rotation deliberately preserves the grant version.
			tokenVersion: 0,
		};
		let providerCalls = 0;
		const deps = dependencies(store, async () => {
			providerCalls++;
			return { access_token: "unsafe-duplicate-refresh" };
		});

		await expect(
			coordinateTokenRefresh(deps, "acc_test", "force"),
		).rejects.toBeInstanceOf(TokenRefreshUnknownError);
		expect(providerCalls).toBe(0);
	});

	test("only a pre-request claim with an expired lease can be reclaimed", async () => {
		const store = new FakeRefreshStore();
		store.operation = {
			operationId: "abandoned-pre-request",
			state: "claimed_pre_request",
			fencingToken: 4,
			sourceTokenVersion: 0,
			leaseExpiresAt: new Date(0),
			requestMayHaveBeenSentAt: null,
		};
		let providerCalls = 0;
		const deps = dependencies(store, async () => {
			providerCalls++;
			return { access_token: "access-v2", refresh_token: "refresh-v2" };
		});

		const result = await coordinateTokenRefresh(deps, "acc_test", "force");
		expect(result.accessToken).toBe("access-v2");
		expect(providerCalls).toBe(1);
		expect(store.operation?.fencingToken).toBe(5);
	});
});
