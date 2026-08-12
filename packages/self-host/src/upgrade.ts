import {
	readConfig,
	readLock,
	validateStableVersion,
	writeLock,
} from "./config.js";
import { RELEASE_TAG_PREFIX } from "./constants.js";
import { fetchBounded, parseJsonBytes } from "./http.js";
import { resolveReleaseArchiveSha256 } from "./source.js";
import type { CliOptions } from "./types.js";

interface GithubRelease {
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
}

interface UpgradeDependencies {
	fetcher?: typeof fetch;
	now?: () => Date;
}

const MAX_GITHUB_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RELEASE_PAGES = 100;

function nextLink(value: string | null): string | undefined {
	if (!value) return undefined;
	for (const part of value.split(",")) {
		const match = /^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/.exec(part);
		if (match?.[2]?.split(/\s+/).includes("next")) return match[1];
	}
	return undefined;
}

function assertGithubReleasesUrl(value: string, repository: string): string {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.hostname !== "api.github.com" ||
		url.pathname !== `/repos/${repository}/releases`
	) {
		throw new Error("GitHub releases pagination returned an unexpected URL");
	}
	return url.toString();
}

async function listGithubReleases(
	repository: string,
	fetcher?: typeof fetch,
): Promise<GithubRelease[]> {
	const releases: GithubRelease[] = [];
	let url = `https://api.github.com/repos/${repository}/releases?per_page=100&page=1`;
	const visited = new Set<string>();
	for (let page = 0; page < MAX_RELEASE_PAGES; page += 1) {
		url = assertGithubReleasesUrl(url, repository);
		if (visited.has(url)) {
			throw new Error("GitHub releases pagination repeated a page");
		}
		visited.add(url);
		const { response, bytes } = await fetchBounded(
			url,
			{
				headers: {
					Accept: "application/vnd.github+json",
					"User-Agent": "@relayapi/self-host",
					"X-GitHub-Api-Version": "2022-11-28",
				},
				redirect: "error",
			},
			{
				label: "GitHub releases request",
				maxBytes: MAX_GITHUB_RESPONSE_BYTES,
				...(fetcher ? { fetcher } : {}),
			},
		);
		if (!response.ok) {
			throw new Error(
				`GitHub releases request failed with HTTP ${response.status}`,
			);
		}
		const pageReleases = parseJsonBytes<unknown>(
			bytes,
			"GitHub releases request",
		);
		if (!Array.isArray(pageReleases)) {
			throw new Error("GitHub releases request returned an invalid result");
		}
		releases.push(...(pageReleases as GithubRelease[]));
		const next = nextLink(response.headers.get("link"));
		if (!next) return releases;
		url = next;
	}
	throw new Error(
		`GitHub releases pagination exceeded ${MAX_RELEASE_PAGES} pages`,
	);
}

export async function upgrade(
	options: CliOptions,
	dependencies: UpgradeDependencies = {},
): Promise<boolean> {
	await readConfig(options.configPath);
	const lock = await readLock(options.configPath);
	const releases = await listGithubReleases(
		lock.sourceRepository,
		dependencies.fetcher,
	);
	const versions = releases.flatMap((release) => {
		if (
			typeof release.tag_name !== "string" ||
			typeof release.draft !== "boolean" ||
			typeof release.prerelease !== "boolean"
		) {
			return [];
		}
		if (release.draft || release.prerelease) return [];
		if (!release.tag_name.startsWith(RELEASE_TAG_PREFIX)) return [];
		const version = release.tag_name.slice(RELEASE_TAG_PREFIX.length);
		try {
			return [validateStableVersion(version, "release tag version")];
		} catch {
			return [];
		}
	});
	const latestVersion = versions.sort(compareVersions).at(-1);
	if (!latestVersion) {
		throw new Error("No stable RelayAPI self-host release was found");
	}

	const targetVersion =
		compareVersions(latestVersion, lock.version) > 0
			? latestVersion
			: lock.version;
	// Resolve the authoritative digest before deciding there is nothing to do.
	// Checking only that *some* digest is present cannot repair a lock whose
	// version was bumped without its digest — the shape produced by the update
	// workflow older operator repositories still have, which only rewrites
	// `.version`. Deploy then fails the digest check on every release, and an
	// upgrade that short-circuits here reports "already sealed" and changes
	// nothing, so the operator has no way out.
	const sourceArchiveSha256 = await resolveReleaseArchiveSha256(
		lock.sourceRepository,
		targetVersion,
		dependencies.fetcher,
	);
	if (
		targetVersion === lock.version &&
		lock.sourceArchiveSha256 === sourceArchiveSha256
	) {
		console.log(`RelayAPI ${lock.version} is already current and sealed`);
		return false;
	}
	await writeLock(
		{
			...lock,
			version: targetVersion,
			sourceArchiveSha256,
			updatedAt: (dependencies.now?.() ?? new Date()).toISOString(),
		},
		options.configPath,
	);
	if (targetVersion === lock.version) {
		console.log(
			lock.sourceArchiveSha256
				? `Repaired the RelayAPI ${lock.version} release archive digest`
				: `Sealed RelayAPI ${lock.version} release archive`,
		);
	} else {
		console.log(`Updated ${lock.version} → ${targetVersion}`);
	}
	return true;
}

export function compareVersions(left: string, right: string): number {
	const a = validateStableVersion(left, "left version").split(".").map(BigInt);
	const b = validateStableVersion(right, "right version")
		.split(".")
		.map(BigInt);
	for (let index = 0; index < 3; index += 1) {
		const leftPart = a[index];
		const rightPart = b[index];
		if (leftPart === undefined || rightPart === undefined) {
			throw new Error("Stable semantic versions require three components");
		}
		if (leftPart > rightPart) return 1;
		if (leftPart < rightPart) return -1;
	}
	return 0;
}
