import { describe, expect, it } from "bun:test";
import { mergeRefreshedContactContext } from "../services/automations/context-refresh";

describe("automation resume context refresh", () => {
	it("refreshes contact-derived values without clobbering durable run state", () => {
		const refreshed = mergeRefreshedContactContext(
			{
				contact: { name: "Old name" },
				tags: ["old"],
				fields: { tier: "old" },
				trigger: { kind: "comment" },
				last_input_value: "captured",
				state: { step: 3 },
				_triggering_social_account_id: "acc_1",
			},
			{
				contact: { name: "New name", segment_ids: ["seg_2"] },
				tags: ["current"],
				fields: { tier: "pro" },
			},
		);

		expect(refreshed).toEqual({
			contact: { name: "New name", segment_ids: ["seg_2"] },
			tags: ["current"],
			fields: { tier: "pro" },
			trigger: { kind: "comment" },
			last_input_value: "captured",
			state: { step: 3 },
			_triggering_social_account_id: "acc_1",
		});
	});

	it("clears deleted contact-derived data", () => {
		expect(
			mergeRefreshedContactContext(
				{ contact: { name: "Deleted" }, tags: ["stale"], fields: { a: "b" } },
				{ contact: null, tags: [], fields: {} },
			),
		).toEqual({ contact: null, tags: [], fields: {} });
	});
});
