import { describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliOptions, SelfHostLock } from "../src/types.js";
import { upgrade } from "../src/upgrade.js";

const config = {
	schemaVersion: 1,
	instance: "relayapi",
	cloudflare: {
		accountId: "account-id",
		zoneId: "zone-id",
		rootDomain: "example.com",
		apiHostname: "api.example.com",
		appHostname: "app.example.com",
		publicHostname: "go.example.com",
		mediaHostname: "media.example.com",
		thumbnailHostname: "thumbs.example.com",
		r2Jurisdiction: "default",
	},
	features: { email: false, ai: false, downloader: false },
};

async function operatorRepository(lock: SelfHostLock): Promise<{
	directory: string;
	configPath: string;
	options: CliOptions;
}> {
	const directory = await mkdtemp(join(tmpdir(), "relayapi-upgrade-"));
	const configPath = join(directory, "relayapi.selfhost.json");
	await writeFile(configPath, `${JSON.stringify(config)}\n`);
	await writeFile(
		join(directory, "relayapi.lock.json"),
		`${JSON.stringify(lock)}\n`,
	);
	return {
		directory,
		configPath,
		options: {
			configPath,
			nonInteractive: true,
			dryRun: false,
			force: false,
		},
	};
}

function release(version: string) {
	return {
		tag_name: `self-host-v${version}`,
		draft: false,
		prerelease: false,
	};
}

function lock(version: string, digest?: string): SelfHostLock {
	return {
		schemaVersion: 1,
		channel: "stable",
		version,
		sourceRepository: "relayapi-dev/relayapi",
		...(digest ? { sourceArchiveSha256: digest } : {}),
		updatedAt: "2026-08-01T00:00:00.000Z",
	};
}

describe("self-host stable updater", () => {
	test("never replaces a newer operator lock with an older available release", async () => {
		const archive = new TextEncoder().encode("sealed 2.0.0 archive");
		const sealed = createHash("sha256").update(archive).digest("hex");
		const repository = await operatorRepository(lock("2.0.0", sealed));
		try {
			const fetcher = Object.assign(
				mock(async (input: RequestInfo | URL) =>
					String(input).includes("api.github.com")
						? Response.json([release("1.9.9")])
						: new Response(archive),
				),
				{ preconnect: fetch.preconnect },
			);
			await expect(upgrade(repository.options, { fetcher })).resolves.toBe(
				false,
			);
			const persisted = JSON.parse(
				await readFile(
					join(repository.directory, "relayapi.lock.json"),
					"utf8",
				),
			) as SelfHostLock;
			expect(persisted.version).toBe("2.0.0");
			expect(persisted.sourceArchiveSha256).toBe(sealed);
		} finally {
			await rm(repository.directory, { recursive: true, force: true });
		}
	});

	test("repairs a lock whose digest belongs to a previous release", async () => {
		// The shape an older operator repository produces: its scaffolded update
		// workflow rewrites only `.version`, carrying the prior release's digest
		// forward. Deploy then rejects the archive on every release, so upgrade
		// has to be able to re-resolve the digest — reporting "already sealed"
		// here would wedge the operator with no way forward.
		const archive = new TextEncoder().encode("real 2.0.0 archive");
		const digest = createHash("sha256").update(archive).digest("hex");
		const staleDigest = "c".repeat(64);
		const repository = await operatorRepository(lock("2.0.0", staleDigest));
		try {
			const fetcher = Object.assign(
				mock(async (input: RequestInfo | URL) =>
					String(input).includes("api.github.com")
						? Response.json([release("2.0.0")])
						: new Response(archive),
				),
				{ preconnect: fetch.preconnect },
			);
			await expect(upgrade(repository.options, { fetcher })).resolves.toBe(
				true,
			);
			const persisted = JSON.parse(
				await readFile(
					join(repository.directory, "relayapi.lock.json"),
					"utf8",
				),
			) as SelfHostLock;
			expect(persisted.version).toBe("2.0.0");
			expect(persisted.sourceArchiveSha256).toBe(digest);
		} finally {
			await rm(repository.directory, { recursive: true, force: true });
		}
	});

	test("paginates releases and seals the selected archive digest", async () => {
		const repository = await operatorRepository(lock("1.0.0", "b".repeat(64)));
		const archive = new TextEncoder().encode("approved release archive");
		const digest = createHash("sha256").update(archive).digest("hex");
		try {
			const fetcher = Object.assign(
				mock(async (input: RequestInfo | URL, init?: RequestInit) => {
					const url = new URL(String(input));
					expect(init?.signal).toBeInstanceOf(AbortSignal);
					if (
						url.hostname === "api.github.com" &&
						url.searchParams.get("page") === "1"
					) {
						return Response.json([release("1.1.0")], {
							headers: {
								Link: '<https://api.github.com/repos/relayapi-dev/relayapi/releases?per_page=100&page=2>; rel="next"',
							},
						});
					}
					if (
						url.hostname === "api.github.com" &&
						url.searchParams.get("page") === "2"
					) {
						return Response.json([release("2.0.0")]);
					}
					if (url.pathname.includes("self-host-v2.0.0")) {
						return new Response(archive);
					}
					throw new Error(`Unexpected request ${url}`);
				}),
				{ preconnect: fetch.preconnect },
			);
			await expect(
				upgrade(repository.options, {
					fetcher,
					now: () => new Date("2026-08-08T12:00:00.000Z"),
				}),
			).resolves.toBe(true);
			const persisted = JSON.parse(
				await readFile(
					join(repository.directory, "relayapi.lock.json"),
					"utf8",
				),
			) as SelfHostLock;
			expect(persisted).toMatchObject({
				version: "2.0.0",
				sourceArchiveSha256: digest,
				updatedAt: "2026-08-08T12:00:00.000Z",
			});
			expect(fetcher).toHaveBeenCalledTimes(3);
		} finally {
			await rm(repository.directory, { recursive: true, force: true });
		}
	});

	test("seals a legacy current lock without changing its version", async () => {
		const repository = await operatorRepository(lock("2.0.0"));
		const archive = new TextEncoder().encode("current release archive");
		const digest = createHash("sha256").update(archive).digest("hex");
		try {
			const fetcher = Object.assign(
				mock(async (input: RequestInfo | URL) =>
					String(input).includes("api.github.com")
						? Response.json([release("1.9.9")])
						: new Response(archive),
				),
				{ preconnect: fetch.preconnect },
			);
			await expect(upgrade(repository.options, { fetcher })).resolves.toBe(
				true,
			);
			const persisted = JSON.parse(
				await readFile(
					join(repository.directory, "relayapi.lock.json"),
					"utf8",
				),
			) as SelfHostLock;
			expect(persisted.version).toBe("2.0.0");
			expect(persisted.sourceArchiveSha256).toBe(digest);
		} finally {
			await rm(repository.directory, { recursive: true, force: true });
		}
	});
});
