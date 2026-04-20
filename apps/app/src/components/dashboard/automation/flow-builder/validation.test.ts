import { describe, expect, it } from "bun:test";
import { validateGraph } from "./validation";
import type { AutomationSchema } from "./types";

const baseSchema: AutomationSchema = {
	triggers: [
		{
			type: "instagram_comment",
			channel: "instagram",
			config_schema: {
				type: "object",
				properties: {},
				required: [],
			},
			output_labels: ["next"],
		},
	],
	nodes: [
		{
			type: "message_text",
			category: "content",
			fields_schema: {
				type: "object",
				properties: {
					text: { type: "string" },
					recipient_mode: {
						type: "string",
						enum: ["enrolled_contact", "custom_identifier"],
						default: "enrolled_contact",
					},
				},
				required: ["text", "recipient_mode"],
			},
			output_labels: ["next"],
		},
	],
	templates: [],
	merge_tags: [],
};

describe("validateGraph", () => {
	it("does not fail defaulted required node fields", () => {
		const issues = validateGraph(
			{
				triggers: [
					{
						id: "tr_1",
						type: "instagram_comment",
						account_id: "acc_123",
						config: {},
						filters: {},
						label: "Trigger #1",
						order_index: 0,
					},
				],
				nodes: [
					{
						key: "send_dm",
						type: "message_text",
						text: "hello",
					},
				],
				edges: [{ from: "trigger", to: "send_dm" }],
			},
			baseSchema,
		);

		expect(
			issues.some((issue) =>
				issue.message.includes('missing required field "recipient_mode"'),
			),
		).toBe(false);
	});

	it("still fails required fields that do not have defaults", () => {
		const issues = validateGraph(
			{
				triggers: [
					{
						id: "tr_1",
						type: "instagram_comment",
						account_id: "acc_123",
						config: {},
						filters: {},
						label: "Trigger #1",
						order_index: 0,
					},
				],
				nodes: [
					{
						key: "send_dm",
						type: "message_text",
					},
				],
				edges: [{ from: "trigger", to: "send_dm" }],
			},
			baseSchema,
		);

		expect(
			issues.some((issue) =>
				issue.message.includes('missing required field "text"'),
			),
		).toBe(true);
	});
});
