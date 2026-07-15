import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appRoot = resolve(import.meta.dir, "../..");
const repoRoot = resolve(appRoot, "../..");

function readAppSource(relativePath: string): string {
	return readFileSync(resolve(appRoot, relativePath), "utf8");
}

describe("email queue producer contract", () => {
	it("includes an owning organization in every dashboard queue message", () => {
		for (const relativePath of [
			"src/middleware/index.ts",
			"src/pages/api/invitations/[id]/resend.ts",
			"src/pages/api/on-demand-request.ts",
		]) {
			expect(readAppSource(relativePath)).toContain("organization_id:");
		}
	});

	it("carries the invitation organization through the auth callback", () => {
		const authSource = readFileSync(
			resolve(repoRoot, "packages/auth/src/index.ts"),
			"utf8",
		);
		expect(authSource).toContain("organizationId: data.organization.id");
		expect(readAppSource("src/middleware/index.ts")).toContain(
			"organization_id: data.organizationId",
		);
	});

	it("scopes caller-supplied on-demand idempotency keys by organization", () => {
		const source = readAppSource("src/pages/api/on-demand-request.ts");
		expect(source).toContain(
			"`on-demand:${organizationId}:${requestedIdempotencyKey}`",
		);
	});
});
