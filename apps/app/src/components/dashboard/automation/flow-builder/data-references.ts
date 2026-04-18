import type { AutomationDetail } from "./types";

export interface DataReference {
	key: string;
	label: string;
	token: string;
	description?: string;
}

export interface DataReferenceGroup {
	key: string;
	label: string;
	description?: string;
	refs: DataReference[];
}

function token(path: string) {
	return `{{${path}}}`;
}

function dedupeRefs(refs: DataReference[]): DataReference[] {
	const seen = new Set<string>();
	return refs.filter((ref) => {
		if (seen.has(ref.key)) return false;
		seen.add(ref.key);
		return true;
	});
}

function triggerRefs(triggerType: string): DataReference[] {
	if (triggerType.endsWith("_comment")) {
		return [
			{
				key: "state.author.id",
				label: "Author ID",
				token: token("state.author.id"),
			},
			{
				key: "state.author.name",
				label: "Author name",
				token: token("state.author.name"),
			},
			{
				key: "state.comment_id",
				label: "Comment ID",
				token: token("state.comment_id"),
			},
			{
				key: "state.comment_text",
				label: "Comment text",
				token: token("state.comment_text"),
			},
			{
				key: "state.post_id",
				label: "Post ID",
				token: token("state.post_id"),
			},
		];
	}
	if (
		triggerType.endsWith("_dm") ||
		triggerType.endsWith("_message") ||
		triggerType === "sms_received"
	) {
		return [
			{
				key: "state.author.id",
				label: "Sender ID",
				token: token("state.author.id"),
			},
			{
				key: "state.author.name",
				label: "Sender name",
				token: token("state.author.name"),
			},
			{
				key: "state.text",
				label: "Inbound text",
				token: token("state.text"),
			},
			{
				key: "state.message_id",
				label: "Message ID",
				token: token("state.message_id"),
			},
			{
				key: "state.conversation_id",
				label: "Conversation ID",
				token: token("state.conversation_id"),
			},
		];
	}
	if (triggerType === "external_api" || triggerType === "manual") {
		return [
			{
				key: "state",
				label: "Initial payload",
				token: token("state.your_key"),
				description: "Manual/API enrollments expose their payload under state.*",
			},
		];
	}
	return [];
}

function nodeDerivedRefs(automation: Pick<AutomationDetail, "nodes">): DataReference[] {
	const refs: DataReference[] = [
		{
			key: "state.last_message_id",
			label: "Last outbound message ID",
			token: token("state.last_message_id"),
		},
	];
	for (const node of automation.nodes) {
		if (typeof node.field === "string" && node.field.trim()) {
			if (node.type.startsWith("user_input_")) {
				refs.push({
					key: `state.${node.field}`,
					label: `${node.field} (captured input)`,
					token: token(`state.${node.field}`),
				});
			}
			if (node.type === "field_set") {
				refs.push({
					key: `contact.${node.field}`,
					label: `${node.field} (contact field)`,
					token: token(`contact.${node.field}`),
				});
			}
		}
		if (typeof node.save_response_to_field === "string" && node.save_response_to_field.trim()) {
			refs.push({
				key: `state.${node.save_response_to_field}`,
				label: `${node.save_response_to_field} (HTTP response)`,
				token: token(`state.${node.save_response_to_field}`),
			});
		}
	}
	refs.push({
		key: "state.split_test_variant",
		label: "Split-test variant",
		token: token("state.split_test_variant"),
	});
	return dedupeRefs(refs);
}

export function buildDataReferenceGroups(
	automation: Pick<AutomationDetail, "trigger_type" | "nodes">,
): DataReferenceGroup[] {
	const groups: DataReferenceGroup[] = [
		{
			key: "contact",
			label: "Contact",
			description: "Resolved from the enrolled contact record.",
			refs: [
				{ key: "first_name", label: "First name", token: token("first_name") },
				{ key: "last_name", label: "Last name", token: token("last_name") },
				{ key: "full_name", label: "Full name", token: token("full_name") },
				{ key: "email", label: "Email", token: token("email") },
				{ key: "phone", label: "Phone", token: token("phone") },
				{ key: "contact.id", label: "Contact ID", token: token("contact.id") },
			],
		},
	];

	const triggerGroup = triggerRefs(automation.trigger_type);
	if (triggerGroup.length > 0) {
		groups.push({
			key: "trigger",
			label: "Trigger data",
			description: "Fields captured from the event that started the automation.",
			refs: triggerGroup,
		});
	}

	const runtimeRefs = nodeDerivedRefs(automation);
	if (runtimeRefs.length > 0) {
		groups.push({
			key: "runtime",
			label: "Captured state",
			description: "Values saved by earlier steps in this automation.",
			refs: runtimeRefs,
		});
	}

	return groups;
}
