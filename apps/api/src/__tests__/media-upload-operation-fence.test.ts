import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { isR2NoSuchUploadError } from "../lib/r2-multipart";

const routeSource = readFileSync(
	new URL("../routes/media-uploads.ts", import.meta.url),
	"utf8",
);

function handlerSource(start: string, end: string): string {
	const startIndex = routeSource.indexOf(start);
	const endIndex = routeSource.indexOf(end, startIndex + start.length);
	expect(startIndex).toBeGreaterThan(-1);
	expect(endIndex).toBeGreaterThan(startIndex);
	return routeSource.slice(startIndex, endIndex);
}

function updateSegments(source: string): string[] {
	return source
		.split(".set({")
		.slice(1)
		.map((segment) => segment.slice(0, segment.indexOf(".returning")));
}

describe("media upload operation fencing", () => {
	it("recognizes only R2's exact appended NoSuchUpload error code", () => {
		expect(
			isR2NoSuchUploadError(
				new Error("The specified multipart upload does not exist. (10024)"),
			),
		).toBe(true);
		expect(isR2NoSuchUploadError(new Error("NoSuchUpload (10024)\n"))).toBe(
			true,
		);
		expect(isR2NoSuchUploadError(new Error("NoSuchUpload 10024"))).toBe(false);
		expect(isR2NoSuchUploadError(new Error("(10024): transient"))).toBe(false);
		expect(isR2NoSuchUploadError(new Error("provider failure (10043)"))).toBe(
			false,
		);
		expect(
			isR2NoSuchUploadError({
				message: "The specified multipart upload does not exist. (10024)",
			}),
		).toBe(false);
	});

	it("increments the completion fence and token-fences every terminal write", () => {
		const completion = handlerSource(
			"app.openapi(completeUpload",
			"app.openapi(abortUpload",
		);
		const updates = updateSegments(completion);
		const claim = updates.find((segment) =>
			segment.includes('status: "completing"'),
		);
		expect(claim).toBeDefined();
		expect(claim).toMatch(
			/leaseToken: sql`\$\{mediaUploadSessions\.leaseToken\} \+ 1`/,
		);
		expect(claim).toContain(
			"leaseExpiresAt: new Date(claimNow.getTime() + SESSION_OPERATION_LEASE_MS)",
		);
		expect(claim).toContain(
			"lte(mediaUploadSessions.leaseExpiresAt, claimNow)",
		);

		const terminalUpdates = updates.filter(
			(segment) =>
				segment.includes('status: "failed"') ||
				segment.includes('status: "completed"'),
		);
		expect(terminalUpdates).toHaveLength(3);
		for (const terminal of terminalUpdates) {
			expect(terminal).toContain("multipartUploadIdCiphertext: null");
			expect(terminal).toContain("leaseExpiresAt: null");
			expect(terminal).toContain(
				'eq(mediaUploadSessions.status, "completing")',
			);
			expect(terminal).toContain(
				"eq(mediaUploadSessions.leaseToken, completionLeaseToken)",
			);
		}
	});

	it("CAS-fences abort claims and only retires authority after proven abort", () => {
		const abort = handlerSource(
			"app.openapi(abortUpload",
			"app.openapi(processMedia",
		);
		const updates = updateSegments(abort);
		const claim = updates.find((segment) =>
			segment.includes('status: needsProviderAbort ? "aborting" : "aborted"'),
		);
		expect(claim).toBeDefined();
		expect(claim).toMatch(
			/leaseToken: sql`\$\{mediaUploadSessions\.leaseToken\} \+ 1`/,
		);
		expect(claim).toContain(
			"eq(mediaUploadSessions.status, loaded.session.status)",
		);
		expect(claim).toContain(
			"eq(mediaUploadSessions.leaseToken, loaded.session.leaseToken)",
		);
		expect(claim).toContain(
			"lte(mediaUploadSessions.leaseExpiresAt, abortNow)",
		);

		const providerTerminal = updates.find((segment) =>
			segment.includes('status: "aborted"'),
		);
		expect(providerTerminal).toBeDefined();
		expect(providerTerminal).toContain("multipartUploadIdCiphertext: null");
		expect(providerTerminal).toContain("leaseExpiresAt: null");
		expect(providerTerminal).toContain(
			'eq(mediaUploadSessions.status, "aborting")',
		);
		expect(providerTerminal).toContain(
			"eq(mediaUploadSessions.leaseToken, abortLeaseToken)",
		);

		expect(
			abort.match(/await headStoredObject\(c\.get\("db"\), c\.env, locator\)/g),
		).toHaveLength(2);
		expect(abort).toContain(
			"if (!completedObject && !isR2NoSuchUploadError(abortError))",
		);
		expect(abort).toContain("throw abortError");
		expect(abort.indexOf("throw abortError")).toBeLessThan(
			abort.indexOf('status: "aborted"'),
		);
	});
});
