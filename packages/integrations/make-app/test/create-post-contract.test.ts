import { describe, expect, it } from "bun:test";

type MakeParameter = {
	name: string;
	type: string;
	help?: string;
	advanced?: boolean;
	spec?: {
		spec?: Array<{
			name: string;
			options?: Array<{ label: string; value: string }>;
		}>;
	};
};

const createPost = (await Bun.file(
	new URL("../modules/actions/create-post.json", import.meta.url),
).json()) as {
	body?: string;
	parameters: MakeParameter[];
};

describe("Make Create Post contract", () => {
	it("forwards all declared parameters, including target_options", () => {
		expect(createPost.body).toBe("{{parameters}}");
		const targetOptions = createPost.parameters.find(
			(parameter) => parameter.name === "target_options",
		);

		expect(targetOptions).toMatchObject({ type: "json", advanced: true });
		expect(targetOptions?.help).toContain('"whatsapp"');
		expect(targetOptions?.help).toContain('"snapchat"');
		expect(targetOptions?.help).toContain('"tiktok"');
	});

	it("exposes every API media type, including document and audio", () => {
		const media = createPost.parameters.find(
			(parameter) => parameter.name === "media",
		);
		const typeField = media?.spec?.spec?.find((field) => field.name === "type");
		const mediaFieldNames = media?.spec?.spec?.map((field) => field.name);

		expect(typeField?.options?.map((option) => option.value)).toEqual([
			"image",
			"video",
			"gif",
			"document",
			"audio",
		]);
		expect(mediaFieldNames).toEqual([
			"url",
			"type",
			"mime_type",
			"alt_text",
			"width",
			"height",
			"duration_ms",
		]);
	});

	it("documents workspace targets with the runtime ws_ prefix", () => {
		const targets = createPost.parameters.find(
			(parameter) => parameter.name === "targets",
		);

		expect(targets?.help).toContain("ws_*");
		expect(targets?.help).not.toContain("grp_*");
	});
});
