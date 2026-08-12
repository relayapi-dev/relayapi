import { describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSource, withResolvedSource } from "../src/source.js";
import type { SelfHostLock } from "../src/types.js";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

function lock(sourceArchiveSha256?: string): SelfHostLock {
	return {
		schemaVersion: 1,
		channel: "stable",
		version: "1.2.3",
		sourceRepository: "relayapi-dev/relayapi",
		...(sourceArchiveSha256 ? { sourceArchiveSha256 } : {}),
		updatedAt: "2026-08-08T00:00:00.000Z",
	};
}

describe("sealed self-host release source", () => {
	test("does not silently use a RelayAPI-looking current directory", async () => {
		await expect(resolveSource(lock())).rejects.toThrow(
			"has no sourceArchiveSha256",
		);
	});

	test("allows only an explicit source override to bypass the sealed archive", async () => {
		const source = await resolveSource(lock(), repositoryRoot);
		expect(source.root).toBe(repositoryRoot.replace(/\/$/, ""));
		expect(source.temporary).toBe(false);
		await expect(source.cleanup()).resolves.toBeUndefined();
	});

	test("rejects a changed archive before downstream mutations and removes its temporary tree", async () => {
		const parent = await mkdtemp(join(tmpdir(), "relayapi-source-parent-"));
		try {
			const fetcher = Object.assign(
				mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
					expect(init?.signal).toBeInstanceOf(AbortSignal);
					return new Response("not-the-approved-archive");
				}),
				{ preconnect: fetch.preconnect },
			);
			const mutate = mock(async () => {});
			await expect(
				withResolvedSource(lock("0".repeat(64)), undefined, mutate, {
					fetcher,
					temporaryParent: parent,
				}),
			).rejects.toThrow("SHA-256 does not match");
			expect(mutate).not.toHaveBeenCalled();
			expect(await readdir(parent)).toEqual([]);
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	test("verifies the sealed archive during dry-run before planning and cleans it", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "relayapi-source-fixture-"));
		const parent = await mkdtemp(join(tmpdir(), "relayapi-source-parent-"));
		try {
			const root = join(fixture, "relayapi-self-host-v1.2.3");
			for (const directory of ["apps/api", "apps/app", "packages/db"]) {
				await mkdir(join(root, directory), { recursive: true });
				await writeFile(join(root, directory, "package.json"), "{}\n");
			}
			const archive = join(fixture, "source.tar.gz");
			const tar = Bun.spawn(
				["tar", "-czf", archive, "-C", fixture, "relayapi-self-host-v1.2.3"],
				{ stdout: "ignore", stderr: "pipe" },
			);
			if ((await tar.exited) !== 0) {
				throw new Error(await new Response(tar.stderr).text());
			}
			const bytes = await readFile(archive);
			const digest = createHash("sha256").update(bytes).digest("hex");
			const events: string[] = [];
			const fetcher = Object.assign(
				mock(async () => {
					events.push("download");
					return new Response(bytes);
				}),
				{ preconnect: fetch.preconnect },
			);
			const apply = mock(async () => {});
			const persist = mock(async () => {});

			await withResolvedSource(
				lock(digest),
				undefined,
				async (source) => {
					await access(join(source.root, "apps/api/package.json"));
					events.push("plan");
					const dryRun = true;
					if (!dryRun) {
						await apply();
						await persist();
					}
				},
				{ fetcher, temporaryParent: parent },
			);

			expect(events).toEqual(["download", "plan"]);
			expect(apply).not.toHaveBeenCalled();
			expect(persist).not.toHaveBeenCalled();
			expect(await readdir(parent)).toEqual([]);
		} finally {
			await rm(fixture, { recursive: true, force: true });
			await rm(parent, { recursive: true, force: true });
		}
	});

	test("bounds release archives before extraction", async () => {
		const parent = await mkdtemp(join(tmpdir(), "relayapi-source-parent-"));
		try {
			const fetcher = Object.assign(
				mock(
					async () =>
						new Response("oversized", {
							headers: {
								"Content-Length": String(256 * 1024 * 1024 + 1),
							},
						}),
				),
				{ preconnect: fetch.preconnect },
			);
			await expect(
				resolveSource(lock("0".repeat(64)), undefined, {
					fetcher,
					temporaryParent: parent,
				}),
			).rejects.toThrow("exceeded 268435456 bytes");
			expect(await readdir(parent)).toEqual([]);
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	test("removes a successfully extracted release tree when cleanup runs", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "relayapi-source-fixture-"));
		const parent = await mkdtemp(join(tmpdir(), "relayapi-source-parent-"));
		try {
			const root = join(fixture, "relayapi-self-host-v1.2.3");
			for (const directory of ["apps/api", "apps/app", "packages/db"]) {
				await mkdir(join(root, directory), { recursive: true });
				await writeFile(join(root, directory, "package.json"), "{}\n");
			}
			const archive = join(fixture, "source.tar.gz");
			const tar = Bun.spawn(
				["tar", "-czf", archive, "-C", fixture, "relayapi-self-host-v1.2.3"],
				{ stdout: "ignore", stderr: "pipe" },
			);
			if ((await tar.exited) !== 0) {
				throw new Error(await new Response(tar.stderr).text());
			}
			const bytes = await readFile(archive);
			const digest = createHash("sha256").update(bytes).digest("hex");
			const fetcher = Object.assign(
				mock(async () => new Response(bytes)),
				{ preconnect: fetch.preconnect },
			);
			const source = await resolveSource(lock(digest), undefined, {
				fetcher,
				temporaryParent: parent,
			});
			expect(source.temporary).toBe(true);
			expect(await readdir(parent)).toHaveLength(1);
			await source.cleanup();
			await source.cleanup();
			expect(await readdir(parent)).toEqual([]);
		} finally {
			await rm(fixture, { recursive: true, force: true });
			await rm(parent, { recursive: true, force: true });
		}
	});
});
