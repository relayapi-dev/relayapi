import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	assertHttpsRedirect,
	assertSecurityHeaders,
} from "./verify-production-edge";

describe("production edge verification", () => {
	it("accepts only same-host HTTPS redirects", () => {
		const expected = new URL("http://relayapi.dev/app?next=1");
		expect(() =>
			assertHttpsRedirect(
				new Response(null, {
					status: 301,
					headers: { location: "https://relayapi.dev/app?next=1" },
				}),
				expected,
			),
		).not.toThrow();
		expect(() =>
			assertHttpsRedirect(
				new Response(null, {
					status: 301,
					headers: { location: "https://example.com/app?next=1" },
				}),
				expected,
			),
		).toThrow("unexpected URL");
		for (const location of [
			"https://relayapi.dev:444/app?next=1",
			"https://user:password@relayapi.dev/app?next=1",
			"https://relayapi.dev/app?next=1#fragment",
		]) {
			expect(() =>
				assertHttpsRedirect(
					new Response(null, {
						status: 308,
						headers: { location },
					}),
					expected,
				),
			).toThrow("unexpected URL");
		}
	});

	it("requires the browser security policy and hides framework identity", () => {
		const headers = {
			"strict-transport-security": "max-age=31536000; includeSubDomains",
			"x-content-type-options": "nosniff",
			"referrer-policy": "strict-origin-when-cross-origin",
			"content-security-policy":
				"default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
			"permissions-policy": "camera=(), microphone=(), geolocation=()",
		};
		expect(() =>
			assertSecurityHeaders(new Response("ok", { status: 200, headers }), {
				httpsUrl: "https://relayapi.dev/app",
				requireBrowserPolicy: true,
			}),
		).not.toThrow();
		expect(() =>
			assertSecurityHeaders(
				new Response("ok", {
					status: 200,
					headers: { ...headers, "x-powered-by": "Next.js" },
				}),
				{
					httpsUrl: "https://docs.relayapi.dev/",
					requireBrowserPolicy: true,
				},
			),
		).toThrow("x-powered-by");
		expect(() =>
			assertSecurityHeaders(
				new Response("ok", {
					status: 200,
					headers: {
						...headers,
						"strict-transport-security": "max-age=0; includeSubDomains",
					},
				}),
				{
					httpsUrl: "https://relayapi.dev/app",
					requireBrowserPolicy: true,
				},
			),
		).toThrow("strict-transport-security");
	});

	it("gates every production deploy on protected refs and edge verification", () => {
		for (const name of ["api", "app", "docs"]) {
			const workflow = readFileSync(
				resolve(import.meta.dir, `../.github/workflows/deploy-${name}.yml`),
				"utf8",
			);
			expect(workflow).toContain("github.ref_protected");
			expect(workflow).toMatch(
				/verify-production-edge\.ts|edge:verify-production/,
			);
			expect(workflow).toContain("--keep-vars --strict");
			expect(workflow).toContain("GITHUB_RUN_ID");
			expect(workflow).toContain("GITHUB_RUN_ATTEMPT");
			expect(workflow).toContain('versions view "$active_version" --json');
			expect(workflow).toContain("deploy_attempt.outputs.exit_code");
			expect(workflow).not.toContain(
				"steps.deploy_worker.outcome == 'success'",
			);
		}
		for (const name of ["app", "docs"]) {
			const workflow = readFileSync(
				resolve(import.meta.dir, `../.github/workflows/deploy-${name}.yml`),
				"utf8",
			);
			expect(workflow).toContain(
				`verify-cloudflare-worker-deployment.ts ${name}`,
			);
			expect(workflow).toContain("EXPECTED_WORKER_VERSION_ID");
		}
	});

	it("keeps generated Docs pages within the Worker resource budget", () => {
		const workflow = readFileSync(
			resolve(import.meta.dir, "../.github/workflows/deploy-docs.yml"),
			"utf8",
		);

		expect(workflow).toContain("Enforce API reference cache budget");
		expect(workflow).toContain('largest_kib" -gt 4096');
		expect(workflow).toContain("Concurrent API reference smoke failed");
		expect(workflow).toContain("Worker exceeded resource limits|Error 1102");
	});

	it("gates every npm release on a protected main branch", () => {
		for (const name of ["sdk", "mcp-server", "cli"]) {
			const workflow = readFileSync(
				resolve(import.meta.dir, `../.github/workflows/publish-${name}.yml`),
				"utf8",
			);
			expect(workflow).toContain("github.ref == 'refs/heads/main'");
			expect(workflow).toContain("github.ref_protected");
		}
	});
});
