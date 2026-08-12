import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { posts, threadExecutions } from "@relayapi/db";
import { lockProviderReconciliationScope } from "../services/provider-reconciliation-persistence";

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

class RowLockManager {
	private readonly held = new Set<string>();
	private readonly waiters = new Map<string, Array<() => void>>();

	async acquire(key: string): Promise<void> {
		if (!this.held.has(key)) {
			this.held.add(key);
			return;
		}
		await new Promise<void>((resolve) => {
			const queue = this.waiters.get(key) ?? [];
			queue.push(resolve);
			this.waiters.set(key, queue);
		});
	}

	release(key: string): void {
		const queue = this.waiters.get(key);
		const next = queue?.shift();
		if (next) {
			if (queue?.length === 0) this.waiters.delete(key);
			next();
			return;
		}
		this.held.delete(key);
	}
}

interface TestScope {
	postId: string;
	organizationId: string;
	threadGroupId: string | null;
}

async function inFakeTransaction<T>(
	label: string,
	scope: TestScope,
	locks: RowLockManager,
	events: string[],
	work: (tx: unknown) => Promise<T>,
): Promise<T> {
	const acquired: string[] = [];
	const tx = {
		select() {
			let table: unknown;
			let forUpdate = false;
			const chain = {
				from(value: unknown) {
					table = value;
					return chain;
				},
				where() {
					return chain;
				},
				for(mode: string) {
					expect(mode).toBe("update");
					forUpdate = true;
					return chain;
				},
				async limit() {
					expect(forUpdate).toBe(true);
					const kind = table === threadExecutions ? "thread" : "post";
					expect(table === threadExecutions || table === posts).toBe(true);
					const key =
						kind === "thread"
							? `thread:${scope.organizationId}:${scope.threadGroupId}`
							: `post:${scope.organizationId}:${scope.postId}`;
					events.push(`${label}:wait:${kind}`);
					await locks.acquire(key);
					acquired.push(key);
					events.push(`${label}:lock:${kind}`);
					return kind === "thread"
						? [{ threadGroupId: scope.threadGroupId }]
						: [
								{
									id: scope.postId,
									organizationId: scope.organizationId,
									threadGroupId: scope.threadGroupId,
									publishLeaseId: null,
								},
							];
				},
			};
			return chain;
		},
	};

	try {
		return await work(tx);
	} finally {
		for (const key of acquired.reverse()) locks.release(key);
	}
}

async function expectSerializedPair(
	firstLabel: string,
	secondLabel: string,
	threaded: boolean,
): Promise<string[]> {
	const scope = {
		postId: "post_1",
		organizationId: "org_1",
		threadGroupId: threaded ? "thread_1" : null,
	};
	const locks = new RowLockManager();
	const events: string[] = [];
	const firstEntered = deferred();
	const releaseFirst = deferred();
	const first = inFakeTransaction(
		firstLabel,
		scope,
		locks,
		events,
		async (tx) => {
			const locked = await lockProviderReconciliationScope(tx as never, scope);
			expect(locked.locked).toBe(true);
			events.push(`${firstLabel}:entered`);
			firstEntered.resolve();
			await releaseFirst.promise;
		},
	);
	await firstEntered.promise;

	const second = inFakeTransaction(
		secondLabel,
		scope,
		locks,
		events,
		async (tx) => {
			const locked = await lockProviderReconciliationScope(tx as never, scope);
			expect(locked.locked).toBe(true);
			events.push(`${secondLabel}:entered`);
		},
	);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(events).not.toContain(`${secondLabel}:entered`);
	releaseFirst.resolve();
	await Promise.all([first, second]);
	expect(events.indexOf(`${firstLabel}:entered`)).toBeLessThan(
		events.indexOf(`${secondLabel}:entered`),
	);
	return events;
}

describe("provider reconciliation lock order", () => {
	for (const scenario of [
		{
			name: "manual/manual standalone",
			first: "manual-1",
			second: "manual-2",
			threaded: false,
		},
		{
			name: "auto/manual standalone",
			first: "auto",
			second: "manual",
			threaded: false,
		},
		{
			name: "manual/manual thread",
			first: "manual-1",
			second: "manual-2",
			threaded: true,
		},
		{
			name: "auto/manual thread",
			first: "auto",
			second: "manual",
			threaded: true,
		},
	]) {
		it(`serializes ${scenario.name} terminalization`, async () => {
			const events = await expectSerializedPair(
				scenario.first,
				scenario.second,
				scenario.threaded,
			);
			for (const label of [scenario.first, scenario.second]) {
				const locks = events.filter((event) =>
					event.startsWith(`${label}:lock:`),
				);
				expect(locks).toEqual(
					scenario.threaded
						? [`${label}:lock:thread`, `${label}:lock:post`]
						: [`${label}:lock:post`],
				);
			}
		});
	}

	it("routes both automatic and manual terminalization through the shared scope lock", () => {
		const manual = readFileSync(
			join(import.meta.dir, "../routes/posts.ts"),
			"utf8",
		);
		const manualHandler = manual.slice(
			manual.indexOf("app.openapi(reconcilePublishTarget"),
			manual.indexOf(
				"// ---------------------------------------------------------------------------\n// Bulk create",
			),
		);
		expect(
			manualHandler.indexOf("lockProviderReconciliationScope(tx"),
		).toBeLessThan(
			manualHandler.indexOf("persistManualProviderReconciliation(tx"),
		);

		const automatic = readFileSync(
			join(import.meta.dir, "../services/provider-outcome-reconciler.ts"),
			"utf8",
		);
		const terminal = automatic.slice(
			automatic.indexOf(
				"export async function persistTerminalProviderReconciliation",
			),
			automatic.indexOf("export async function reconcileProviderOutcomes"),
		);
		expect(terminal.indexOf("lockProviderReconciliationScope(tx")).toBeLessThan(
			terminal.indexOf(".update(postTargets)"),
		);
	});
});
