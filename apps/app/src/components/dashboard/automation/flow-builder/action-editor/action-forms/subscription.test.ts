import { describe, expect, it } from "bun:test";
import {
	type SubscriptionListPickerRow,
	subscriptionListsForWorkspace,
} from "./subscription";

const lists: SubscriptionListPickerRow[] = [
	{
		id: "list_org",
		name: "Organization audience",
		channel: "instagram",
		workspace_id: null,
	},
	{
		id: "list_a",
		name: "Workspace A audience",
		channel: "whatsapp",
		workspace_id: "ws_a",
	},
	{
		id: "list_b",
		name: "Workspace B audience",
		channel: "telegram",
		workspace_id: "ws_b",
	},
];

describe("subscription list picker scope", () => {
	it("offers only lists in the automation workspace", () => {
		expect(
			subscriptionListsForWorkspace(lists, "ws_a").map((list) => list.id),
		).toEqual(["list_a"]);
	});

	it("offers only organization-scoped lists for an organization automation", () => {
		expect(
			subscriptionListsForWorkspace(lists, null).map((list) => list.id),
		).toEqual(["list_org"]);
	});
});
