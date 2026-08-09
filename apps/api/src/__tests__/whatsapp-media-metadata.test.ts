import { describe, expect, it } from "bun:test";
import { API_VERSIONS } from "../config/api-versions";
import { fetchWhatsAppMediaMetadata } from "../services/whatsapp-media-metadata";

describe("fetchWhatsAppMediaMetadata", () => {
	it("requests tenant-bound metadata and parses Meta's string file size", async () => {
		let requestedUrl = "";
		let requestedInit: RequestInit | undefined;
		const result = await fetchWhatsAppMediaMetadata(
			"media_123",
			"phone_456",
			"secret-token",
			async (url, init) => {
				requestedUrl = String(url);
				requestedInit = init;
				return Response.json({
					messaging_product: "whatsapp",
					id: "media_123",
					file_size: "303833",
					mime_type: "image/jpeg",
					url: "https://lookaside.fbsbx.com/short-lived",
				});
			},
		);

		expect(requestedUrl).toBe(
			`https://graph.facebook.com/${API_VERSIONS.meta_graph}/media_123?phone_number_id=phone_456`,
		);
		expect(new Headers(requestedInit?.headers).get("authorization")).toBe(
			"Bearer secret-token",
		);
		expect(result).toEqual({
			sizeBytes: 303_833,
			mimeType: "image/jpeg",
		});
		expect(result).not.toHaveProperty("url");
	});

	it("fails closed on mismatched media metadata", async () => {
		expect(
			fetchWhatsAppMediaMetadata(
				"expected",
				"phone_456",
				"secret-token",
				async () =>
					Response.json({
						messaging_product: "whatsapp",
						id: "different",
						file_size: "10",
					}),
			),
		).rejects.toThrow("did not match");
	});

	it("rejects invalid, negative, and unsafe file sizes", async () => {
		for (const fileSize of ["nope", -1, Number.MAX_SAFE_INTEGER + 1]) {
			expect(
				fetchWhatsAppMediaMetadata(
					"media_123",
					"phone_456",
					"secret-token",
					async () =>
						Response.json({
							messaging_product: "whatsapp",
							id: "media_123",
							file_size: fileSize,
						}),
				),
			).rejects.toThrow("invalid file_size");
		}
	});

	it("bounds provider error handling without reflecting response secrets", async () => {
		expect(
			fetchWhatsAppMediaMetadata(
				"media_123",
				"phone_456",
				"secret-token",
				async () => new Response("provider secret", { status: 403 }),
			),
		).rejects.toThrow("HTTP 403");
	});
});
