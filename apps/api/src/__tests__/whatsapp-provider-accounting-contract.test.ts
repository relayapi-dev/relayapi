import { describe, expect, it } from "bun:test";

async function routeSource(name: string): Promise<string> {
	return Bun.file(new URL(`../routes/${name}`, import.meta.url)).text();
}

describe("WhatsApp provider mutation accounting contracts", () => {
	it("uses the canonical transient-provider rejection classifier for phone mutations", async () => {
		const source = await routeSource("whatsapp-phone-provisioning.ts");

		expect(source).toContain(
			'import { isDefinitiveProviderMutationRejection } from "../lib/mutation-provider-boundary";',
		);
		expect(source).toContain(
			"isDefinitiveProviderMutationRejection(response.status)",
		);
		expect(source).not.toContain("function isKnownMetaRejection");
	});

	it("does not regress an ambiguous flow upload when Meta returns validation details", async () => {
		const source = await routeSource("whatsapp.ts");
		const upload = source.slice(
			source.indexOf("app.openapi(uploadFlowJson"),
			source.indexOf("app.openapi(sendFlowMessage"),
		);

		expect(upload).toContain("trackSingleUnitProviderMutation(");
		expect(upload).not.toContain("setAuthoritativeOutcome");
		expect(upload).toContain(
			"const validationErrors = parsed?.error?.error_data?.validation_errors;",
		);
	});

	it("reports validation errors from an acknowledged flow JSON update as K=1 success data", async () => {
		const source = await routeSource("whatsapp.ts");
		const upload = source.slice(
			source.indexOf("app.openapi(uploadFlowJson"),
			source.indexOf("app.openapi(sendFlowMessage"),
		);

		expect(upload).toContain("success: parsed?.success ?? true");
		expect(upload).toContain("parsed?.validation_errors");
		expect(
			upload.indexOf("const responseBody = await res.text();"),
		).toBeLessThan(upload.indexOf("if (!res.ok)"));
	});
});
