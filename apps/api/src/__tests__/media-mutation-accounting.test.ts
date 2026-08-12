import { describe, expect, it } from "bun:test";

function section(source: string, start: string, end: string): string {
	const from = source.indexOf(start);
	const to = source.indexOf(end, from + start.length);
	expect(from).toBeGreaterThan(-1);
	expect(to).toBeGreaterThan(from);
	return source.slice(from, to);
}

describe("media mutation accounting", () => {
	it("marks audited no-effect media outcomes as K=0", async () => {
		const source = await Bun.file(
			new URL("../routes/media.ts", import.meta.url),
		).text();
		const upload = section(
			source,
			"app.openapi(uploadMedia",
			"app.openapi(presignMedia",
		);
		const presign = section(
			source,
			"app.openapi(presignMedia",
			"app.openapi(getMedia",
		);
		const deletion = section(
			source,
			"app.openapi(deleteMedia",
			"app.openapi(confirmMedia",
		);
		const confirm = section(
			source,
			"app.openapi(confirmMedia",
			"export default app",
		);

		expect(upload.match(/markMediaMutationNotApplied\(c\)/g)).toHaveLength(4);
		expect(presign.match(/markMediaMutationNotApplied\(c\)/g)).toHaveLength(3);
		expect(deletion.match(/markMediaMutationNotApplied\(c\)/g)).toHaveLength(3);
		expect(confirm.match(/markMediaMutationNotApplied\(c\)/g)).toHaveLength(6);
		expect(confirm).toContain("reading an already-ready upload is K=0");

		const rejectedStoredObject = section(
			confirm,
			"if (!validation.ok)",
			'if (intent.status === "pending")',
		);
		expect(rejectedStoredObject).toContain("retireRejectedMediaUpload");
		expect(rejectedStoredObject).not.toContain("markMediaMutationNotApplied");
	});
});
