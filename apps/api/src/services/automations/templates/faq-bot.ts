import type { TemplateBuildInput, TemplateBuildOutput } from "./index";

const DEFAULT_KEYWORDS: Array<{ label: string; keyword: string; reply: string }> = [
	{
		label: "hours",
		keyword: "hours",
		reply: "We are open Mon–Fri 9am–6pm, Sat 10am–4pm.",
	},
	{
		label: "price",
		keyword: "price",
		reply: "Our pricing is available at our website. I can send a link if you like!",
	},
	{
		label: "location",
		keyword: "location",
		reply: "We're located at 123 Main Street. See you soon!",
	},
];

export function buildFaqBot(input: TemplateBuildInput): TemplateBuildOutput {
	const cfgKeywords = Array.isArray(input.config?.keywords)
		? (input.config.keywords as Array<{
				label?: string;
				keyword?: string;
				reply?: string;
			}>)
		: null;
	const kws =
		cfgKeywords && cfgKeywords.length > 0
			? cfgKeywords.map((k, idx) => ({
					label: k.label ?? `topic_${idx + 1}`,
					keyword: k.keyword ?? "",
					reply: k.reply ?? "",
				}))
			: DEFAULT_KEYWORDS;

	const fallbackReply =
		typeof input.config?.fallback_reply === "string"
			? (input.config.fallback_reply as string)
			: "Sorry, I didn't catch that. Try asking about our hours, price, or location.";

	const nodes: TemplateBuildOutput["graph"]["nodes"] = [
		{
			key: "ask",
			kind: "message",
			title: "Ask a question",
			config: {
				blocks: [
					{
						id: "txt_intro",
						type: "text",
						text: "Hi {{contact.first_name}}! Ask me about our hours, price, or location.",
					},
				],
				wait_for_reply: true,
			},
			ports: [],
		},
		{
			key: "capture",
			kind: "input",
			title: "Capture question",
			config: {
				field: "faq_question",
				input_type: "text",
			},
			ports: [],
		},
	];

	const edges: TemplateBuildOutput["graph"]["edges"] = [
		{
			from_node: "ask",
			from_port: "next",
			to_node: "capture",
			to_port: "in",
		},
	];

	// Chain of conditions, one per keyword. Each condition routes true →
	// reply_<label> → done, false → next condition (or fallback).
	let prevKey = "capture";
	let prevPort = "captured";

	kws.forEach((kw, idx) => {
		const condKey = `match_${kw.label}`;
		const replyKey = `reply_${kw.label}`;

		nodes.push({
			key: condKey,
			kind: "condition",
			title: `Does it mention "${kw.keyword}"?`,
			config: {
				predicates: {
					any: [
						{
							field: "state.faq_question",
							op: "contains",
							value: kw.keyword.toLowerCase(),
						},
					],
				},
			},
			ports: [],
		});

		nodes.push({
			key: replyKey,
			kind: "message",
			title: `Reply: ${kw.label}`,
			config: {
				blocks: [{ id: `txt_${kw.label}`, type: "text", text: kw.reply }],
			},
			ports: [],
		});

		edges.push({
			from_node: prevKey,
			from_port: prevPort,
			to_node: condKey,
			to_port: "in",
		});
		edges.push({
			from_node: condKey,
			from_port: "true",
			to_node: replyKey,
			to_port: "in",
		});
		edges.push({
			from_node: replyKey,
			from_port: "next",
			to_node: "done",
			to_port: "in",
		});

		prevKey = condKey;
		prevPort = "false";
		void idx;
	});

	// Fallback leg — last condition's `false` → fallback message → done.
	nodes.push({
		key: "fallback",
		kind: "message",
		title: "Fallback reply",
		config: {
			blocks: [{ id: "txt_fallback", type: "text", text: fallbackReply }],
		},
		ports: [],
	});
	edges.push({
		from_node: prevKey,
		from_port: prevPort,
		to_node: "fallback",
		to_port: "in",
	});
	edges.push({
		from_node: "fallback",
		from_port: "next",
		to_node: "done",
		to_port: "in",
	});

	nodes.push({
		key: "done",
		kind: "end",
		title: "End",
		config: { reason: "completed" },
		ports: [],
	});

	return {
		name: "FAQ bot",
		description:
			"Answers common questions from a short keyword list. Wire an entrypoint after creating.",
		graph: {
			schema_version: 1,
			root_node_key: "ask",
			nodes,
			edges,
		},
		entrypoints: [],
	};
}
