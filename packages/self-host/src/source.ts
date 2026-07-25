import { access, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { RELEASE_TAG_PREFIX } from "./constants.js";
import { run } from "./process.js";
import type { SelfHostLock } from "./types.js";

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

export async function resolveSource(
	lock: SelfHostLock,
	explicitSource?: string,
): Promise<{ root: string; temporary: boolean }> {
	if (explicitSource) {
		const root = resolve(explicitSource);
		if (!(await isSourceRoot(root))) {
			throw new Error(`${root} is not a RelayAPI source checkout`);
		}
		return { root, temporary: false };
	}
	if (await isSourceRoot(process.cwd())) {
		return { root: process.cwd(), temporary: false };
	}

	const working = await mkdtemp(join(tmpdir(), "relayapi-self-host-"));
	const archive = join(working, "source.tar.gz");
	const tag = `${RELEASE_TAG_PREFIX}${lock.version}`;
	const url = `https://github.com/${lock.sourceRepository}/archive/refs/tags/${encodeURIComponent(tag)}.tar.gz`;
	const response = await fetch(url, {
		headers: { "User-Agent": "@relayapi/self-host" },
	});
	if (!response.ok) {
		throw new Error(
			`Unable to download RelayAPI ${lock.version} (HTTP ${response.status})`,
		);
	}
	await writeFile(archive, Buffer.from(await response.arrayBuffer()), {
		mode: 0o600,
	});
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
	return { root, temporary: true };
}

export function lockPathForConfig(configPath: string): string {
	return join(dirname(resolve(configPath)), "relayapi.lock.json");
}
