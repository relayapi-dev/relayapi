import { readConfig, readLock, writeLock } from "./config.js";
import { RELEASE_TAG_PREFIX } from "./constants.js";
import type { CliOptions } from "./types.js";

interface GithubRelease {
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
}

export async function upgrade(options: CliOptions): Promise<boolean> {
	await readConfig(options.configPath);
	const lock = await readLock(options.configPath);
	const response = await fetch(
		`https://api.github.com/repos/${lock.sourceRepository}/releases?per_page=100`,
		{
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": "@relayapi/self-host",
			},
		},
	);
	if (!response.ok)
		throw new Error(
			`GitHub releases request failed with HTTP ${response.status}`,
		);
	const releases = (await response.json()) as GithubRelease[];
	const versions = releases.flatMap((release) => {
		if (release.draft || release.prerelease) return [];
		if (!release.tag_name.startsWith(RELEASE_TAG_PREFIX)) return [];
		const version = release.tag_name.slice(RELEASE_TAG_PREFIX.length);
		return /^\d+\.\d+\.\d+$/.test(version) ? [version] : [];
	});
	const version = versions.sort(compareVersions).at(-1);
	if (!version)
		throw new Error("No stable RelayAPI self-host release was found");
	if (compareVersions(version, lock.version) <= 0) {
		console.log(`RelayAPI ${lock.version} is already current`);
		return false;
	}
	await writeLock(
		{ ...lock, version, updatedAt: new Date().toISOString() },
		options.configPath,
	);
	console.log(`Updated ${lock.version} → ${version}`);
	return true;
}

export function compareVersions(left: string, right: string): number {
	const a = left.split(".").map(Number);
	const b = right.split(".").map(Number);
	for (let index = 0; index < 3; index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}
