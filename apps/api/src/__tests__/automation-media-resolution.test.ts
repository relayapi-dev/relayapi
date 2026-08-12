import { describe, expect, it } from "bun:test";
import type { Database } from "@relayapi/db";
import type { MessageBlock } from "../schemas/automation-graph";
import {
	type AutomationMediaLookupInput,
	AutomationMediaReferenceError,
	type AutomationMediaRow,
	resolveAutomationMessageMedia,
} from "../services/automations/automation-media";
import type { Env } from "../types";

function fixture<T>(value: unknown): T {
	return value as T;
}

const db = fixture<Database>({});
const env = fixture<Env>({ MEDIA_PUBLIC_HOST: "media.example.test" });
const canonicalUrl = "https://media.example.test/org_1/media/file_1/photo.png";
const signedUrl = "https://signed.example.test/photo.png?signature=fresh";

function readyRow(
	overrides: Partial<AutomationMediaRow> = {},
): AutomationMediaRow {
	return {
		id: "med_image_1",
		organizationId: "org_1",
		workspaceId: "ws_1",
		storageKey: "org_1/media/file_1/photo.png",
		url: canonicalUrl,
		status: "ready",
		deletionRequestedAt: null,
		originalDeletedAt: null,
		...overrides,
	};
}

async function replaceCanonicalWithSigned<T>(
	_database: Database,
	_environment: Env,
	value: T,
): Promise<T> {
	return JSON.parse(JSON.stringify(value).replaceAll(canonicalUrl, signedUrl));
}

function imageBlock(mediaRef: string): MessageBlock[] {
	return [{ id: "block_1", type: "image", media_ref: mediaRef }];
}

describe("automation media resolution", () => {
	it("authorizes a durable media ID and replaces it with a fresh provider URL", async () => {
		let lookup: AutomationMediaLookupInput | undefined;
		const resolved = await resolveAutomationMessageMedia(
			{
				db,
				env,
				organizationId: "org_1",
				workspaceId: "ws_1",
				blocks: imageBlock("med_image_1"),
			},
			{
				loadMediaRows: async (input) => {
					lookup = input;
					return [readyRow()];
				},
				resolveForPublish: replaceCanonicalWithSigned,
			},
		);

		expect(lookup).toMatchObject({
			organizationId: "org_1",
			workspaceId: "ws_1",
			ids: ["med_image_1"],
			storageKeys: [],
		});
		expect(resolved).toEqual(imageBlock(signedUrl));
	});

	it("allows organization-shared media in a workspace automation", async () => {
		const resolved = await resolveAutomationMessageMedia(
			{
				db,
				env,
				organizationId: "org_1",
				workspaceId: "ws_1",
				blocks: imageBlock("med_image_1"),
			},
			{
				loadMediaRows: async () => [readyRow({ workspaceId: null })],
				resolveForPublish: replaceCanonicalWithSigned,
			},
		);

		expect(resolved).toEqual(imageBlock(signedUrl));
	});

	it("allows only organization-shared media in an organization automation", async () => {
		await expect(
			resolveAutomationMessageMedia(
				{
					db,
					env,
					organizationId: "org_1",
					workspaceId: null,
					blocks: imageBlock("med_image_1"),
				},
				{ loadMediaRows: async () => [readyRow()] },
			),
		).rejects.toMatchObject({ reason: "not_available_in_scope" });

		const resolved = await resolveAutomationMessageMedia(
			{
				db,
				env,
				organizationId: "org_1",
				workspaceId: null,
				blocks: imageBlock("med_image_1"),
			},
			{
				loadMediaRows: async () => [readyRow({ workspaceId: null })],
				resolveForPublish: replaceCanonicalWithSigned,
			},
		);
		expect(resolved).toEqual(imageBlock(signedUrl));
	});

	it("accepts a canonical library URL only after resolving its current row", async () => {
		let storageKeys: string[] = [];
		const resolved = await resolveAutomationMessageMedia(
			{
				db,
				env,
				organizationId: "org_1",
				workspaceId: "ws_1",
				blocks: imageBlock(canonicalUrl),
			},
			{
				loadMediaRows: async (input) => {
					storageKeys = input.storageKeys;
					return [readyRow()];
				},
				resolveForPublish: replaceCanonicalWithSigned,
			},
		);

		expect(storageKeys).toEqual(["org_1/media/file_1/photo.png"]);
		expect(resolved).toEqual(imageBlock(signedUrl));
	});

	it("fails closed when media is missing", async () => {
		await expect(
			resolveAutomationMessageMedia(
				{
					db,
					env,
					organizationId: "org_1",
					workspaceId: "ws_1",
					blocks: imageBlock("med_missing"),
				},
				{ loadMediaRows: async () => [] },
			),
		).rejects.toMatchObject({
			name: "AutomationMediaReferenceError",
			reason: "not_available_in_scope",
		});
	});

	it("defensively rejects cross-tenant and cross-workspace rows", async () => {
		for (const row of [
			readyRow({ organizationId: "org_other" }),
			readyRow({ workspaceId: "ws_other" }),
		]) {
			await expect(
				resolveAutomationMessageMedia(
					{
						db,
						env,
						organizationId: "org_1",
						workspaceId: "ws_1",
						blocks: imageBlock("med_image_1"),
					},
					{ loadMediaRows: async () => [row] },
				),
			).rejects.toBeInstanceOf(AutomationMediaReferenceError);
		}
	});

	it("rejects rows that are deleting or whose original is gone", async () => {
		for (const row of [
			readyRow({ deletionRequestedAt: new Date() }),
			readyRow({ originalDeletedAt: new Date() }),
		]) {
			await expect(
				resolveAutomationMessageMedia(
					{
						db,
						env,
						organizationId: "org_1",
						workspaceId: "ws_1",
						blocks: imageBlock("med_image_1"),
					},
					{ loadMediaRows: async () => [row] },
				),
			).rejects.toMatchObject({ reason: "not_available_in_scope" });
		}
	});

	it("preserves explicit external HTTP(S) URLs without database or signing work", async () => {
		let called = false;
		const blocks = imageBlock("https://cdn.example.test/photo.png");
		const resolved = await resolveAutomationMessageMedia(
			{
				db,
				env,
				organizationId: "org_1",
				workspaceId: "ws_1",
				blocks,
			},
			{
				loadMediaRows: async () => {
					called = true;
					return [];
				},
				resolveForPublish: async (_database, _environment, value) => {
					called = true;
					return value;
				},
			},
		);

		expect(called).toBe(false);
		expect(resolved).toBe(blocks);
	});

	it("rejects non-URL free-form references before a lookup", async () => {
		let loaded = false;
		await expect(
			resolveAutomationMessageMedia(
				{
					db,
					env,
					organizationId: "org_1",
					workspaceId: null,
					blocks: imageBlock("not a media reference"),
				},
				{
					loadMediaRows: async () => {
						loaded = true;
						return [];
					},
				},
			),
		).rejects.toMatchObject({ reason: "invalid_reference" });
		expect(loaded).toBe(false);
	});
});
