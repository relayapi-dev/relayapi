import { describe, expect, it } from "bun:test";
import {
	assertSafeSeedEnvironment,
	LOCAL_SEED_CONFIRMATION,
} from "./seed-safety";

const safeEnvironment = {
	NODE_ENV: "development",
	RELAYAPI_ALLOW_LOCAL_SEED: LOCAL_SEED_CONFIRMATION,
	DATABASE_URL: "postgresql://relay:secret@localhost:5433/relayapi",
};

describe("development seed safety", () => {
	it("accepts only an explicitly confirmed loopback database", () => {
		expect(assertSafeSeedEnvironment(safeEnvironment)).toBe(
			safeEnvironment.DATABASE_URL,
		);
		expect(
			assertSafeSeedEnvironment({
				...safeEnvironment,
				DATABASE_URL: "postgres://relay:secret@127.0.0.1:5433/relayapi",
			}),
		).toContain("127.0.0.1");
	});

	it("rejects production even when the database is loopback", () => {
		expect(() =>
			assertSafeSeedEnvironment({ ...safeEnvironment, NODE_ENV: "production" }),
		).toThrow("NODE_ENV=production");
	});

	it("requires an explicit development environment", () => {
		expect(() =>
			assertSafeSeedEnvironment({ ...safeEnvironment, NODE_ENV: undefined }),
		).toThrow("requires NODE_ENV=development");
	});

	it("rejects a missing or incorrect explicit confirmation", () => {
		expect(() =>
			assertSafeSeedEnvironment({
				...safeEnvironment,
				RELAYAPI_ALLOW_LOCAL_SEED: undefined,
			}),
		).toThrow("RELAYAPI_ALLOW_LOCAL_SEED");
	});

	it("rejects remote database hosts", () => {
		expect(() =>
			assertSafeSeedEnvironment({
				...safeEnvironment,
				DATABASE_URL: "postgresql://relay:secret@db.example.com:5432/relayapi",
			}),
		).toThrow("non-loopback");
	});

	it("rejects non-PostgreSQL connection protocols", () => {
		expect(() =>
			assertSafeSeedEnvironment({
				...safeEnvironment,
				DATABASE_URL: "https://localhost:5433/relayapi",
			}),
		).toThrow("postgres or postgresql");
	});

	it("keeps the seed transaction/idempotency and free-entitlement invariants", async () => {
		const source = await Bun.file(new URL("./seed.ts", import.meta.url)).text();
		expect(source).toContain("db.transaction(async (tx)");
		expect(source).toContain(".onConflictDoNothing(");
		expect(source).toContain(".onConflictDoUpdate({");
		expect(source).toContain('status: "cancelled"');
		expect(source).not.toContain('status: "active"');
	});
});
