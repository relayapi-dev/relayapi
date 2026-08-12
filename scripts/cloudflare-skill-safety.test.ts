import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const skillRoot = join(repositoryRoot, ".agents/skills/cloudflare");

async function reference(path: string): Promise<string> {
	return readFile(join(skillRoot, "references", path), "utf8");
}

interface MarkdownDocument {
	content: string;
	relativePath: string;
}

async function markdownDocuments(): Promise<MarkdownDocument[]> {
	const documents: MarkdownDocument[] = [];

	async function collect(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				await collect(path);
			} else if (entry.isFile() && entry.name.endsWith(".md")) {
				documents.push({
					content: await readFile(path, "utf8"),
					relativePath: relative(skillRoot, path).split("\\").join("/"),
				});
			}
		}
	}

	await collect(skillRoot);
	documents.sort((left, right) =>
		left.relativePath.localeCompare(right.relativePath),
	);
	return documents;
}

async function skillHash(): Promise<string> {
	const files: Array<{ content: Buffer; relativePath: string }> = [];

	async function collect(directory: string): Promise<void> {
		const entries = await readdir(directory, { withFileTypes: true });
		await Promise.all(
			entries.map(async (entry) => {
				if (entry.name === ".git" || entry.name === "node_modules") return;
				const path = join(directory, entry.name);
				if (entry.isDirectory()) {
					await collect(path);
				} else if (entry.isFile()) {
					files.push({
						content: await readFile(path),
						relativePath: relative(skillRoot, path).split("\\").join("/"),
					});
				}
			}),
		);
	}

	await collect(skillRoot);
	files.sort((left, right) =>
		left.relativePath.localeCompare(right.relativePath),
	);
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(file.relativePath);
		hash.update(file.content);
	}
	return hash.digest("hex");
}

describe("repository-owned Cloudflare skill safety", () => {
	it("uses Cloudflare's low-is-malicious WAF polarity", async () => {
		const waf = (
			await Promise.all(
				[
					"waf/README.md",
					"waf/api.md",
					"waf/configuration.md",
					"waf/gotchas.md",
					"waf/patterns.md",
				].map(reference),
			)
		).join("\n");

		expect(waf).toContain("cf.waf.score le 20");
		expect(waf).toContain("`1` (almost certainly malicious)");
		expect(waf).toContain("`99`");
		expect(waf).toContain("`100` means unscored");
		expect(waf).not.toMatch(/cf\.waf\.score(?:\.(?:sqli|xss|rce))?\s+gt\b/);
		for (const line of waf
			.split("\n")
			.filter((value) => /cf\.waf\.score\s+ge\b/.test(value))) {
			expect(line).toContain("managed_challenge");
			expect(line).toContain("cf.waf.score le 50");
		}
	});

	it("documents implicit Queue acknowledgement and retries DLQ failures", async () => {
		const [readme, api, patterns, gotchas] = await Promise.all([
			reference("queues/README.md"),
			reference("queues/api.md"),
			reference("queues/patterns.md"),
			reference("queues/gotchas.md"),
		]);
		const queueDocs = [readme, api, patterns, gotchas].join("\n");
		const dlqPattern = patterns
			.split("## Dead Letter Queue Pattern")[1]
			?.split("## Priority Queues")[0];

		expect(queueDocs).toContain(
			"successful handler return implicitly acknowledges",
		);
		expect(api).toContain("First per-message call wins");
		expect(api).not.toContain("last call wins");
		expect(api).not.toContain("No action = automatic retry");
		expect(dlqPattern).toContain("msg.retry({ delaySeconds: 60 })");
	});

	it("keeps Sandbox tenants separate and user input out of shell syntax", async () => {
		const [readme, api, patterns, gotchas] = await Promise.all([
			reference("sandbox/README.md"),
			reference("sandbox/api.md"),
			reference("sandbox/patterns.md"),
			reference("sandbox/gotchas.md"),
		]);
		const sandboxDocs = [readme, api, patterns, gotchas].join("\n");

		expect(patterns).toContain("authenticateRequest(request, env)");
		expect(patterns).toContain("tenantId: string");
		expect(patterns).toContain(
			"tenantSandboxId(principal.tenantId, principal.userId)",
		);
		expect(patterns).toContain(
			"sandbox.writeFile('/workspace/user_code.py', code)",
		);
		expect(patterns).toContain('"$GIT_BRANCH"');
		expect(sandboxDocs).toContain("not a tenant security boundary");
		expect(sandboxDocs).not.toContain("X-User-ID");
		expect(sandboxDocs).not.toContain("env.GITHUB_TOKEN");
		expect(sandboxDocs).not.toContain("GIT_TOKEN: token");
		expect(sandboxDocs).not.toMatch(
			/sandbox\.exec\(`[^`]*\$\{(?:repo|branch|userCode|code)\}/,
		);
		expect(sandboxDocs).not.toMatch(/https:\/\/\$\{[^}]*TOKEN[^}]*\}@/);
	});

	it("requires application auth, authorization, and quotas before minting TURN credentials", async () => {
		const [configuration, api, patterns] = await Promise.all([
			reference("turn/configuration.md"),
			reference("turn/api.md"),
			reference("turn/patterns.md"),
		]);
		const turn = `${configuration}\n${api}\n${patterns}`;

		expect(configuration).toContain("authenticateRequest(request, env)");
		expect(configuration).toContain("authorizeTurn(principal, env)");
		expect(configuration).toContain("consumeTurnQuota(principal, env)");
		expect(turn).toContain("credentials/generate-ice-servers");
		expect(turn).not.toMatch(/credentials\/generate(?:[`'"\s]|$)/);
		expect(configuration).toContain("url.pathname === '/api/turn-credentials'");
		expect(patterns).toContain(
			"fetch('/api/turn-credentials', { method: 'POST' })",
		);
		expect(turn).not.toContain("includes(':53')");
		expect(api).toContain("iceServers: Array<{");
		expect(configuration).toContain("'Cache-Control': 'no-store'");
		expect(configuration).not.toContain(
			"const authHeader = request.headers.get('Authorization')",
		);
	});

	it("keeps RealtimeKit meeting roles under server policy", async () => {
		const [readme, realtimeKit] = await Promise.all([
			reference("realtimekit/README.md"),
			reference("realtimekit/patterns.md"),
		]);

		expect(realtimeKit).toContain("authenticateRequest(request, env)");
		expect(realtimeKit).toContain(
			"authorizeMeetingAccess(principal, input.meetingId, env)",
		);
		expect(realtimeKit).toContain("PRESET_BY_ROLE[authorization.role]");
		expect(realtimeKit).toContain("custom_participant_id: principal.userId");
		expect(realtimeKit).toContain("{ data?: { token?: string } }");
		expect(realtimeKit).toContain("{ authToken: data.data.token }");
		expect(readme).toContain('"data": { "token": "..." }');
		expect(readme).not.toContain("Returns: { authToken }");
		expect(realtimeKit).toContain("'Cache-Control': 'no-store'");
		expect(realtimeKit).not.toContain("result?.authToken");
		expect(realtimeKit).not.toMatch(
			/const\s*\{[^}]*presetName[^}]*\}\s*=\s*await request\.json/,
		);
	});

	it("never treats a Bearer prefix as verified identity", async () => {
		const [frameworks, patterns] = await Promise.all([
			reference("workers/frameworks.md"),
			reference("workers/patterns.md"),
		]);
		const workerDocs = `${frameworks}\n${patterns}`;

		expect(workerDocs).not.toMatch(/startsWith\(['"]Bearer /);
		expect(frameworks).toContain("verifyAccessToken");
		expect(patterns).toContain("verifyAccessToken");
		expect(workerDocs).toContain("issuer");
		expect(workerDocs).toContain("audience");
		expect(workerDocs).toContain("revocation");
	});

	it("does not make personalized responses publicly cacheable", async () => {
		const cache = await reference("cache-reserve/patterns.md");

		expect(cache).toContain("isExplicitStaticAsset(url)");
		expect(cache).toContain("request.headers.has('Authorization')");
		expect(cache).toContain("request.headers.has('Cookie')");
		expect(cache).toContain("headers.has('Set-Cookie')");
		expect(cache).toContain("private|no-store|no-cache");
		expect(cache).not.toMatch(/headers\.delete\(['"]Set-Cookie['"]\)/);
	});

	it("keeps credentials out of output, URLs, pipelines, and argv", async () => {
		const documents = await markdownDocuments();
		const credentialDocs = documents
			.map((document) => document.content)
			.join("\n");

		expect(credentialDocs).toContain("--header @/secure/bearer-auth-header");
		expect(credentialDocs).toContain(
			"--header @/secure/cloudflare-global-auth-headers",
		);
		expect(credentialDocs).toContain("--data-binary @/secure/");
		expect(credentialDocs).toContain(
			"mode-`0600` file provisioned directly by",
		);
		expect(credentialDocs).not.toMatch(
			/(?:-H|--header)(?:=|\s+)["'][^"'\n]*Bearer\s/i,
		);
		expect(credentialDocs).not.toMatch(
			/(?:-H|--header)(?:=|\s+)["'][^"'\n]*(?:X-Auth-Key|cf-aig-authorization)/i,
		);
		expect(credentialDocs).not.toMatch(
			/(?:-H|--header)(?:=|\s+)(?!@\/secure\/)[^\n]*(?:Authorization\s*:\s*Bearer|X-Auth-Key|cf-aig-authorization)/i,
		);
		expect(credentialDocs).not.toMatch(
			/curl[^\n]*(?:\s-v\b|--verbose\b|--trace(?:-ascii)?\b)/i,
		);
		expect(credentialDocs).not.toMatch(
			/echo\s+["']?\$(?:\{)?[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY)/i,
		);
		expect(credentialDocs).not.toMatch(
			/(?:printf|printenv|Write-Host)[^\n]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY|API_KEY)/i,
		);
		expect(credentialDocs).not.toMatch(
			/(?:echo|cat)[^\n|]*\|[^\n]*wrangler[^\n]*(?:secret|secrets-store)/i,
		);
		expect(credentialDocs).not.toMatch(
			/https?:\/\/[^\s`"']*\$\{?[^\s}`"']*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY)[^\s}`"']*\}?@/i,
		);
		expect(credentialDocs).not.toMatch(
			/http\.extraHeader=[^\n]*\$[A-Z_]*TOKEN/i,
		);
		expect(credentialDocs).not.toMatch(
			/--(?:password|origin-password|access-client-secret|token|catalog-token|secret-access-key|access-key-id|connection-string|value|new-value)(?:=|\s+)(?:\$\{?|<[^>]+>|\{[^}]+\}|["'][^"'\n]+["'])/i,
		);
		expect(credentialDocs).not.toMatch(/cloudflared[^\n]*\s--token\s/i);
		expect(credentialDocs).not.toMatch(
			/cloudflared\s+service\s+install\s+<(?:API_)?TOKEN>/i,
		);
		expect(credentialDocs).not.toMatch(
			/wrangler[^\n]*(?:secret|secrets-store)[^\n]*(?:--value|--new-value)/i,
		);
		expect(credentialDocs).not.toMatch(
			/pulumi\s+config\s+set\s+--secret\s+\S+\s+(?:\$\{?|<[^>]+>|["'][^"'\n]+["'])/i,
		);
		expect(credentialDocs).not.toMatch(
			/(?:-d|--data|--data-binary)\s+["'][^\n]*(?:"|')(?:token|secret|password|private_key|secret_access_key)(?:"|')\s*:/i,
		);
		expect(credentialDocs).not.toMatch(
			/^\s*export\s+[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY|API_KEY)\s*=/im,
		);
		expect(credentialDocs).not.toMatch(
			/output\s+["'][^"']*(?:token|secret|password|private[_-]?key)[^"']*["']/i,
		);
		expect(credentialDocs).not.toMatch(
			/console\.(?:log|debug|info|warn|error)\(\s*(?:bindings|env|process\.env)\.[A-Z_]*(?:TOKEN|SECRET|PASSWORD|KEY)\s*\)/i,
		);
		expect(credentialDocs).not.toMatch(
			/console\.(?:log|debug|info|warn|error)\([^,\n]*,\s*(?:bindings|env|process\.env)\.[A-Z_]*(?:TOKEN|SECRET|PASSWORD|KEY)\s*\)/i,
		);
		expect(credentialDocs).not.toMatch(
			/Response\.json\([^\n]*(?:ctx\.)?(?:bindings|env|process\.env)\.[A-Z_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY|API_KEY)\b/i,
		);
		expect(credentialDocs).not.toMatch(
			/["'](?:secret[-_]token|token\d{3,}|password\d{3,})["']/i,
		);

		const wholeEnvironmentResponses = documents.flatMap((document) =>
			document.content
				.split("\n")
				.filter((line) =>
					/Response\.json\(\s*(?:ctx\.)?(?:bindings|env|process\.env)\s*\)/i.test(
						line,
					),
				)
				.map((line) => ({ line, path: document.relativePath })),
		);
		expect(wholeEnvironmentResponses).toEqual([
			{
				line: "**❌ Exposing env:** `return Response.json(env)` - exposes all bindings  ",
				path: "references/bindings/gotchas.md",
			},
		]);

		const directCredentialLogs = documents.flatMap((document) =>
			document.content
				.split("\n")
				.filter((line) =>
					/(?:console\.(?:log|debug|info|warn|error)\(\s*|console\.(?:log|debug|info|warn|error)\([^)]*,\s*)(?:token|secret|password|credential|apiKey|privateKey)\b/i.test(
						line,
					),
				)
				.map((line) => ({ line, path: document.relativePath })),
		);
		// Turnstile response tokens are public-client, single-use, five-minute
		// challenge values. They are intentionally outside the long-lived-secret
		// rule; no other credential-like value may be logged.
		expect(
			directCredentialLogs.every((match) =>
				match.path.startsWith("references/turnstile/"),
			),
		).toBe(true);

		const illustrativePlaceholders = documents.flatMap((document) =>
			document.content
				.split("\n")
				.filter((line) => {
					const quotedCredentialLiteral =
						/(?!["']?secret[_-]?name["']?\s*[:=])["']?[A-Za-z0-9_]*(?:api[_-]?token|api[_-]?key|secret|password|private[_-]?key|access[_-]?key|jwk)[A-Za-z0-9_]*["']?\s*(?::|={1,3}|!={1,2})\s*["'](?!(?:string|undefined|null|missing|set)["'])[A-Za-z0-9][^"'\n]*["']/i.test(
							line,
						);
					const dotenvCredentialLiteral =
						/^\s*(?:export\s+)?(?=[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY|API_KEY|JWK))[A-Z][A-Z0-9_]*\s*=\s*(?![$<{])(?:["'][^"'\n]+["']|\S+)/.test(
							line,
						) && !/^\s*[A-Z][A-Z0-9_]*_FILE\s*=/.test(line);
					return quotedCredentialLiteral || dotenvCredentialLiteral;
				})
				.map((line) => `${document.relativePath}: ${line.trim()}`),
		);
		expect(illustrativePlaceholders).toEqual([
			'references/bindings/patterns.md: { "vars": { "API_KEY": "sk_live_abc123" } }',
			"references/bindings/patterns.md: **❌ Hardcoding credentials:** `const apiKey = 'sk_live_abc123'`",
			'references/pages-functions/configuration.md: SECRET_KEY="my-secret-value"',
			"references/turnstile/gotchas.md: TURNSTILE_SECRET=your_secret_here",
		]);

		const stream = await reference("stream/configuration.md");
		expect(stream).toContain("response logging disabled");
		expect(stream).not.toContain("/stream/keys");
		expect(stream).not.toContain("/stream/webhook");
	});

	it("pins the patched skill as a local source with an exact folder hash", async () => {
		const lock = JSON.parse(
			await readFile(join(repositoryRoot, "skills-lock.json"), "utf8"),
		);
		const cloudflare = lock.skills?.cloudflare;

		expect(cloudflare).toMatchObject({
			source: ".agents/skills/cloudflare",
			sourceType: "local",
			skillPath: "SKILL.md",
		});
		expect(cloudflare.computedHash).toBe(await skillHash());
	});
});
