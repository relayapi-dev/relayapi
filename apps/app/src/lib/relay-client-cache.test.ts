import { expect, test } from "bun:test";
import type Relay from "@relayapi/sdk";
import {
	cacheRelayClient,
	clearClientCache,
	getCachedRelayClient,
} from "./relay-client-cache";

test("dashboard SDK clients are isolated by user credential generation", () => {
	const first = { generation: 1 } as unknown as Relay;
	const second = { generation: 2 } as unknown as Relay;
	const now = Date.now();

	cacheRelayClient("org_cache", "user_cache", "generation-1", first, now);
	expect(
		getCachedRelayClient(
			"org_cache",
			"user_cache",
			"generation-1",
			now,
		),
	).toBe(first);
	expect(
		getCachedRelayClient(
			"org_cache",
			"user_cache",
			"generation-2",
			now,
		),
	).toBeNull();

	cacheRelayClient("org_cache", "user_cache", "generation-2", second, now);
	expect(
		getCachedRelayClient(
			"org_cache",
			"user_cache",
			"generation-2",
			now,
		),
	).toBe(second);

	clearClientCache("org_cache", "user_cache");
	expect(
		getCachedRelayClient(
			"org_cache",
			"user_cache",
			"generation-1",
			now,
		),
	).toBeNull();
	expect(
		getCachedRelayClient(
			"org_cache",
			"user_cache",
			"generation-2",
			now,
		),
	).toBeNull();
});
