/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import ts from "typescript";
import { SOCIAL_PLATFORM_IDS } from "./domain-contracts";
import {
	EXTERNAL_PROVIDER_RETENTION_CONTRACTS,
	validateExternalProviderRetentionRegistry,
} from "./external-provider-retention-registry";

const repositoryRoot = new URL("../../../", import.meta.url).pathname;

test("every connected platform and infrastructure processor has a typed contract", () => {
	expect(validateExternalProviderRetentionRegistry()).toEqual([]);
	const ids = EXTERNAL_PROVIDER_RETENTION_CONTRACTS.map(({ id }) => id);
	expect(ids.filter((id) => id.startsWith("social:")).sort()).toEqual(
		SOCIAL_PLATFORM_IDS.map((platform) => `social:${platform}`).sort(),
	);
	expect(ids).toEqual(
		expect.arrayContaining([
			"workers-ai",
			"openai-embeddings",
			"cloudflare-media-transforms",
			"email",
			"downloader",
			"stripe",
			"byos",
			"shortener:dub",
			"shortener:short_io",
			"shortener:bitly",
			"telnyx",
			"dns-safety",
			"customer-selected-egress",
		]),
	);
});

test("every provider contract resolves its source-owned evidence", async () => {
	for (const contract of EXTERNAL_PROVIDER_RETENTION_CONTRACTS) {
		for (const evidence of contract.evidence) {
			const source = await Bun.file(
				`${repositoryRoot}${evidence.sourcePath}`,
			).text();
			expect(source).toContain(evidence.marker);
		}
	}
});

test("the registry states boundaries instead of inventing remote deadlines", () => {
	for (const contract of EXTERNAL_PROVIDER_RETENTION_CONTRACTS) {
		expect(contract.legalHoldTreatment).toBe("provider_policy_only");
		expect(contract.retentionBoundary.length).toBeGreaterThan(30);
		expect(contract.credentialAction.toLowerCase()).toMatch(
			/revoke|remove|rotate|shred/,
		);
	}
});

const productionTypeScriptRoots = ["apps/api/src", "packages/auth/src"] as const;
const productionTransportPattern =
	/(?:fetchWithTimeout|\bfetch\s*\(|new\s+Resend|new\s+Stripe|AwsClient|\.fetch\s*\(|env\.(?:AI|IMAGES|MEDIA))/;
const firstPartyHosts = new Set(["api.relayapi.dev", "app.relayapi.dev"]);

async function productionTypeScriptSources(): Promise<
	Array<{ path: string; source: string }>
> {
	const files: Array<{ path: string; source: string }> = [];
	const glob = new Bun.Glob("**/*.{ts,tsx}");
	for (const root of productionTypeScriptRoots) {
		for await (const relative of glob.scan({ cwd: `${repositoryRoot}${root}` })) {
			if (
				relative.includes("__tests__/") ||
				relative.endsWith(".test.ts") ||
				relative.endsWith(".test.tsx")
			) {
				continue;
			}
			const path = `${root}/${relative}`;
			files.push({
				path,
				source: await Bun.file(`${repositoryRoot}${path}`).text(),
			});
		}
	}
	return files;
}

function staticHttpsHosts(path: string, source: string): string[] {
	if (!productionTransportPattern.test(source)) return [];
	const parsed = ts.createSourceFile(
		path,
		source,
		ts.ScriptTarget.Latest,
		true,
	);
	const hosts = new Set<string>();
	function visit(node: ts.Node): void {
		if (ts.isStringLiteralLike(node) && node.text.startsWith("https://")) {
			try {
				hosts.add(new URL(node.text).hostname.toLowerCase());
			} catch {
				// A malformed URL literal is validated at its owning boundary.
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(parsed);
	return [...hosts];
}

test("production transport hosts are derived from source and registered", async () => {
	const registeredHosts = new Set(
		EXTERNAL_PROVIDER_RETENTION_CONTRACTS.flatMap(
			(contract) => contract.egressHosts,
		),
	);
	const unregistered: string[] = [];
	for (const { path, source } of await productionTypeScriptSources()) {
		for (const host of staticHttpsHosts(path, source)) {
			if (!firstPartyHosts.has(host) && !registeredHosts.has(host)) {
				unregistered.push(`${host} (${path})`);
			}
		}
	}
	expect(unregistered).toEqual([]);
});

test("dynamic public-url transports are source-owned by a provider boundary", async () => {
	const evidencePaths = new Set(
		EXTERNAL_PROVIDER_RETENTION_CONTRACTS.flatMap((contract) =>
			contract.evidence.map((evidence) => evidence.sourcePath),
		),
	);
	const dynamicSources = (await productionTypeScriptSources())
		.filter(
			({ path, source }) =>
				path !== "apps/api/src/lib/fetch-public-url.ts" &&
				(source.includes("fetchPublicUrl(") ||
					source.includes("fetchWithTimeout(endpoint.url")),
		)
		.map(({ path }) => path);
	const uncovered = dynamicSources.filter((path) => {
		if (evidencePaths.has(path)) return false;
		if (path.startsWith("apps/api/src/publishers/")) {
			return !EXTERNAL_PROVIDER_RETENTION_CONTRACTS.some((contract) =>
				contract.id.startsWith("social:"),
			);
		}
		if (path === "apps/api/src/routes/whatsapp.ts") {
			return !EXTERNAL_PROVIDER_RETENTION_CONTRACTS.some(
				(contract) => contract.id === "social:whatsapp",
			);
		}
		if (path === "apps/api/src/routes/tools.ts") {
			return !EXTERNAL_PROVIDER_RETENTION_CONTRACTS.some(
				(contract) => contract.id === "downloader",
			);
		}
		return true;
	});
	expect(uncovered).toEqual([]);
});

test("browser assets are self-hosted and Cache API stores cannot appear unregistered", async () => {
	const browserGlob = new Bun.Glob("**/*.{astro,css,tsx}");
	const remoteBrowserLoads: string[] = [];
	const edgeCacheSources: string[] = [];
	for (const root of ["apps/app/src", "apps/docs/src", "apps/api/src"]) {
		for await (const relative of browserGlob.scan({
			cwd: `${repositoryRoot}${root}`,
		})) {
			if (relative.includes("__tests__/")) continue;
			const path = `${root}/${relative}`;
			const source = await Bun.file(`${repositoryRoot}${path}`).text();
			if (
				/<link\b[^>]*\bhref=["']https:\/\//.test(source) ||
				/@import\s+(?:url\()?["']?https:\/\//i.test(source)
			) {
				remoteBrowserLoads.push(path);
			}
			if (/\bcaches\.(?:default|open|match)\b/.test(source)) {
				edgeCacheSources.push(path);
			}
		}
	}
	expect(remoteBrowserLoads).toEqual([]);
	expect(edgeCacheSources).toEqual([]);
});
