import { createHash } from "node:crypto";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { validateStableVersion } from "./config.js";
import { RELEASE_TAG_PREFIX } from "./constants.js";
import { fetchBounded } from "./http.js";
import { run } from "./process.js";
import type { SelfHostLock } from "./types.js";

const MAX_RELEASE_ARCHIVE_BYTES = 256 * 1024 * 1024;
const RELEASE_ARCHIVE_TIMEOUT_MS = 60_000;

export interface ResolvedSource {
	root: string;
	temporary: boolean;
	cleanup: () => Promise<void>;
}

export interface SourceResolutionOptions {
	fetcher?: typeof fetch;
	temporaryParent?: string;
}

async function isSourceRoot(path: string): Promise<boolean> {
	try {
		await Promise.all([
			access(join(path, "apps/api/package.json")),
			access(join(path, "apps/app/package.json")),
			access(join(path, "packages/db/package.json")),
		]);
		return true;
	} catch {
		return false;
	}
}

function releaseArchiveUrl(repository: string, version: string): string {
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
		throw new Error(
			"Release source repository must use owner/repository format",
		);
	}
	const stableVersion = validateStableVersion(version, "release version");
	const tag = `${RELEASE_TAG_PREFIX}${stableVersion}`;
	return `https://github.com/${repository}/archive/refs/tags/${encodeURIComponent(tag)}.tar.gz`;
}

async function downloadReleaseArchive(
	repository: string,
	version: string,
	fetcher?: typeof fetch,
): Promise<{ bytes: Uint8Array; sha256: string }> {
	const { response, bytes } = await fetchBounded(
		releaseArchiveUrl(repository, version),
		{
			headers: {
				Accept: "application/gzip",
				"User-Agent": "@relayapi/self-host",
			},
			redirect: "follow",
		},
		{
			label: `RelayAPI ${version} release archive download`,
			maxBytes: MAX_RELEASE_ARCHIVE_BYTES,
			timeoutMs: RELEASE_ARCHIVE_TIMEOUT_MS,
			...(fetcher ? { fetcher } : {}),
		},
	);
	if (!response.ok) {
		throw new Error(
			`Unable to download RelayAPI ${version} (HTTP ${response.status})`,
		);
	}
	return {
		bytes,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

export async function resolveReleaseArchiveSha256(
	repository: string,
	version: string,
	fetcher?: typeof fetch,
): Promise<string> {
	return (await downloadReleaseArchive(repository, version, fetcher)).sha256;
}

export async function resolveSource(
	lock: SelfHostLock,
	explicitSource?: string,
	options: SourceResolutionOptions = {},
): Promise<ResolvedSource> {
	if (explicitSource) {
		const root = resolve(explicitSource);
		if (!(await isSourceRoot(root))) {
			throw new Error(`${root} is not a RelayAPI source checkout`);
		}
		return { root, temporary: false, cleanup: async () => {} };
	}

	if (!lock.sourceArchiveSha256) {
		throw new Error(
			"relayapi.lock.json has no sourceArchiveSha256; run upgrade to seal the current stable release before deploying",
		);
	}

	const working = await mkdtemp(
		join(options.temporaryParent ?? tmpdir(), "relayapi-self-host-"),
	);
	try {
		const archive = join(working, "source.tar.gz");
		const downloaded = await downloadReleaseArchive(
			lock.sourceRepository,
			lock.version,
			options.fetcher,
		);
		if (downloaded.sha256 !== lock.sourceArchiveSha256) {
			throw new Error(
				`RelayAPI ${lock.version} release archive SHA-256 does not match relayapi.lock.json; ` +
					"run upgrade to re-resolve the digest for this version, then re-run deploy",
			);
		}
		await writeFile(archive, downloaded.bytes, { mode: 0o600, flag: "wx" });
		await run("tar", ["-xzf", archive, "-C", working]);
		const candidates = (await readdir(working, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(working, entry.name));
		let root: string | undefined;
		for (const candidate of candidates) {
			if (await isSourceRoot(candidate)) {
				root = candidate;
				break;
			}
		}
		if (!root) {
			throw new Error(
				"Downloaded release does not contain the RelayAPI source tree",
			);
		}
		let cleaned = false;
		return {
			root,
			temporary: true,
			cleanup: async () => {
				if (cleaned) return;
				cleaned = true;
				await rm(working, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await rm(working, { recursive: true, force: true });
		throw error;
	}
}

export async function withResolvedSource<T>(
	lock: SelfHostLock,
	explicitSource: string | undefined,
	operation: (source: ResolvedSource) => Promise<T>,
	options: SourceResolutionOptions = {},
): Promise<T> {
	const source = await resolveSource(lock, explicitSource, options);
	try {
		return await operation(source);
	} finally {
		await source.cleanup();
	}
}

export function lockPathForConfig(configPath: string): string {
	return join(dirname(resolve(configPath)), "relayapi.lock.json");
}
