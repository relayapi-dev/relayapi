import { describe, expect, test } from "bun:test";
import {
	didDocumentUrl,
	pdsFromDidDocument,
} from "../services/bluesky-identity";

describe("Bluesky identity/PDS resolution", () => {
	test("constructs did:plc and did:web document URLs", () => {
		expect(didDocumentUrl("did:plc:ewvi7nxzyoun6zhxrhs64oiz")).toBe(
			"https://plc.directory/did%3Aplc%3Aewvi7nxzyoun6zhxrhs64oiz",
		);
		expect(didDocumentUrl("did:web:example.com")).toBe(
			"https://example.com/.well-known/did.json",
		);
		expect(didDocumentUrl("did:web:example.com:users:alice")).toBe(
			"https://example.com/users/alice/did.json",
		);
	});

	test("requires bidirectional handle verification and the PDS service", () => {
		const did = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
		expect(
			pdsFromDidDocument(did, "alice.example", {
				id: did,
				alsoKnownAs: ["at://alice.example"],
				service: [
					{
						id: `${did}#atproto_pds`,
						type: "AtprotoPersonalDataServer",
						serviceEndpoint: "https://pds.example/",
					},
				],
			}),
		).toBe("https://pds.example");
		expect(() =>
			pdsFromDidDocument(did, "mallory.example", {
				id: did,
				alsoKnownAs: ["at://alice.example"],
				service: [],
			}),
		).toThrow("does not claim");
	});

	test("rejects a PDS URL that could carry credentials elsewhere", () => {
		const did = "did:plc:ewvi7nxzyoun6zhxrhs64oiz";
		expect(() =>
			pdsFromDidDocument(did, "alice.example", {
				id: did,
				alsoKnownAs: ["at://alice.example"],
				service: [
					{
						id: "#atproto_pds",
						type: "AtprotoPersonalDataServer",
						serviceEndpoint: "https://user:pass@evil.example/",
					},
				],
			}),
		).toThrow("public HTTPS origin");
	});
});
