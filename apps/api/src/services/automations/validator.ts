// apps/api/src/services/automations/validator.ts

import { ActionGroupConfigSchema } from "../../schemas/automation-actions";
import { EntrypointFilterGroupSchema } from "../../schemas/automation-entrypoints";
import {
	type Graph,
	MessageBlockSchema,
	QuickReplySchema,
} from "../../schemas/automation-graph";
import { applyDerivedPorts } from "./ports";
import { compileSafeAutomationRegex } from "./safe-regex";

export type ValidationIssue = {
	code: string;
	message: string;
	node_key?: string;
	port_key?: string;
	edge_index?: number;
};

export type ValidationResult = {
	valid: boolean;
	errors: ValidationIssue[];
	warnings: ValidationIssue[];
	canonicalGraph: Graph;
};

const ENTRY_KINDS = new Set([
	"message",
	"action_group",
	"condition",
	"http_request",
	"start_automation",
	"social_profile_check",
	"end",
]);
const LOOP_PAUSE_KINDS = new Set(["input", "delay", "wait_event"]);
const KNOWN_NODE_KINDS = new Set([
	...ENTRY_KINDS,
	...LOOP_PAUSE_KINDS,
	"randomizer",
	"goto",
]);
const WAIT_EVENT_KINDS = new Set([
	"dm_received",
	"comment_created",
	"story_reply",
	"story_mention",
	"live_comment",
	"share_to_dm",
	"ad_click",
]);
const WAIT_EVENT_CHANNELS: Record<string, readonly string[]> = {
	dm_received: ["instagram", "facebook", "whatsapp", "telegram"],
	comment_created: ["instagram", "facebook"],
	story_reply: ["instagram", "facebook"],
	story_mention: ["instagram", "facebook"],
	live_comment: ["instagram", "facebook"],
	share_to_dm: ["instagram"],
	ad_click: ["instagram", "facebook"],
};
const UNAVAILABLE_ACTION_TYPES: Record<string, string> = {};
const INPUT_TYPES = new Set([
	"text",
	"email",
	"phone",
	"number",
	"choice",
	"file",
]);
const VALUELESS_FILTER_OPS = new Set(["exists", "not_exists"]);
const LIST_FILTER_OPS = new Set(["in", "not_in"]);
const NUMERIC_FILTER_OPS = new Set(["gt", "gte", "lt", "lte"]);
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const REDACTED_HTTP_URL = "https://redacted.invalid/";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function filterGroupIsExecutable(value: unknown): boolean {
	const parsed = EntrypointFilterGroupSchema.safeParse(value);
	if (!parsed.success) return false;
	for (const predicate of [
		...(parsed.data.all ?? []),
		...(parsed.data.any ?? []),
		...(parsed.data.none ?? []),
	]) {
		if (VALUELESS_FILTER_OPS.has(predicate.op)) continue;
		if (predicate.value === undefined) return false;
		if (
			LIST_FILTER_OPS.has(predicate.op) &&
			(!Array.isArray(predicate.value) || predicate.value.length === 0)
		) {
			return false;
		}
		if (NUMERIC_FILTER_OPS.has(predicate.op)) {
			if (
				(typeof predicate.value !== "number" &&
					typeof predicate.value !== "string") ||
				String(predicate.value).trim() === "" ||
				!Number.isFinite(Number(predicate.value))
			) {
				return false;
			}
		}
	}
	return true;
}

function httpUrlIsExecutable(value: string): boolean {
	try {
		// Merge-tag values are only known at run time. Replacing them with a safe
		// token still lets validation enforce the URL shape and protocol now.
		const candidate = value.replace(/\{\{[^{}]+\}\}/g, "relayapi-value");
		const url = new URL(candidate);
		return url.protocol === "https:" || url.protocol === "http:";
	} catch {
		return false;
	}
}

export function validateGraph(
	graph: Graph,
	channel?: string,
): ValidationResult {
	const errors: ValidationIssue[] = [];
	const warnings: ValidationIssue[] = [];

	// Regenerate ports (canonical form)
	const canonical: Graph = {
		schema_version: 1,
		root_node_key: graph.root_node_key,
		nodes: graph.nodes.map(applyDerivedPorts),
		edges: graph.edges.slice(),
	};

	// 1. unique node keys
	const seen = new Set<string>();
	for (const n of canonical.nodes) {
		if (seen.has(n.key)) {
			errors.push({
				code: "duplicate_node_key",
				message: `duplicate node key "${n.key}"`,
				node_key: n.key,
			});
		}
		seen.add(n.key);
	}

	// 2. root node kind
	if (!canonical.root_node_key) {
		if (canonical.nodes.length > 0) {
			errors.push({
				code: "missing_root",
				message: "root_node_key is null but graph has nodes",
			});
		}
	} else {
		const root = canonical.nodes.find((n) => n.key === canonical.root_node_key);
		if (!root) {
			errors.push({
				code: "missing_root",
				message: `root_node_key "${canonical.root_node_key}" not found`,
			});
		} else if (!ENTRY_KINDS.has(root.kind)) {
			errors.push({
				code: "invalid_root_kind",
				message: `root node kind "${root.kind}" cannot be an entry point`,
				node_key: root.key,
			});
		}
	}

	// 2.5. Reject node configuration that the runtime cannot safely execute.
	// Input patterns use the same deliberately small subset as keyword patterns;
	// validating here prevents a persisted pattern from becoming a permanent
	// non-match at runtime.
	//
	// Retired or incomplete actions must never be activatable. Validation still
	// recognizes their string values so legacy graphs are force-paused and can
	// be repaired, even though they are absent/disabled in the public catalog.
	for (const n of canonical.nodes) {
		if (!KNOWN_NODE_KINDS.has(n.kind)) {
			errors.push({
				code: "unknown_node_kind",
				message: `unknown node kind "${n.kind}"`,
				node_key: n.key,
			});
		}
		if (n.kind === "input") {
			const config = (n.config ?? {}) as Record<string, unknown>;
			const inputType = config.input_type ?? "text";
			const timeout = config.timeout_min;
			const maxRetries = config.max_retries;
			const acceptedMimeTypes = config.accepted_mime_types;
			const maxSizeMb = config.max_size_mb;
			let invalidConfig =
				typeof config.field !== "string" ||
				config.field.trim() === "" ||
				config.field.length > 128 ||
				typeof inputType !== "string" ||
				!INPUT_TYPES.has(inputType) ||
				(timeout !== undefined &&
					(typeof timeout !== "number" ||
						!Number.isFinite(timeout) ||
						timeout <= 0)) ||
				(maxRetries !== undefined &&
					(typeof maxRetries !== "number" ||
						!Number.isInteger(maxRetries) ||
						maxRetries < 1 ||
						maxRetries > 100)) ||
				(config.skip_allowed !== undefined &&
					typeof config.skip_allowed !== "boolean") ||
				(acceptedMimeTypes !== undefined &&
					(!Array.isArray(acceptedMimeTypes) ||
						acceptedMimeTypes.length > 100 ||
						acceptedMimeTypes.some(
							(value) =>
								typeof value !== "string" ||
								value.trim() === "" ||
								value.length > 256,
						))) ||
				(maxSizeMb !== undefined &&
					(typeof maxSizeMb !== "number" ||
						!Number.isFinite(maxSizeMb) ||
						maxSizeMb <= 0));
			const validation = config?.validation;
			if (validation !== undefined && !isPlainRecord(validation)) {
				invalidConfig = true;
			} else if (isPlainRecord(validation)) {
				const pattern = validation.pattern;
				const min = validation.min;
				const max = validation.max;
				if (
					pattern !== undefined &&
					(typeof pattern !== "string" || !compileSafeAutomationRegex(pattern))
				) {
					errors.push({
						code: "invalid_input_pattern",
						message:
							"input validation.pattern must be a supported safe regular expression",
						node_key: n.key,
					});
				}
				if (
					(min !== undefined &&
						(typeof min !== "number" || !Number.isFinite(min))) ||
					(max !== undefined &&
						(typeof max !== "number" || !Number.isFinite(max))) ||
					(typeof min === "number" && typeof max === "number" && min > max)
				) {
					invalidConfig = true;
				}
			}

			if (inputType === "choice") {
				const choices = config.choices;
				const tokenOwners = new Map<string, number>();
				if (
					!Array.isArray(choices) ||
					choices.length === 0 ||
					choices.length > 100
				) {
					invalidConfig = true;
				} else {
					for (const [choiceIndex, choice] of choices.entries()) {
						if (!isPlainRecord(choice)) {
							invalidConfig = true;
							continue;
						}
						const { value, label, match } = choice;
						if (
							typeof value !== "string" ||
							value.trim() === "" ||
							value.length > 256 ||
							typeof label !== "string" ||
							label.trim() === "" ||
							label.length > 256 ||
							(match !== undefined &&
								(!Array.isArray(match) ||
									match.some(
										(token) =>
											typeof token !== "string" ||
											token.trim() === "" ||
											token.length > 256,
									)))
						) {
							invalidConfig = true;
							continue;
						}
						for (const token of [
							value,
							label,
							...(Array.isArray(match) ? match : []),
						]) {
							const normalized = token.trim().toLowerCase();
							const owner = tokenOwners.get(normalized);
							if (owner !== undefined && owner !== choiceIndex) {
								invalidConfig = true;
							}
							tokenOwners.set(normalized, choiceIndex);
						}
					}
				}
			}

			if (invalidConfig) {
				errors.push({
					code: "invalid_input_config",
					message:
						"input requires a valid field, type, limits, retry count, and unambiguous choices",
					node_key: n.key,
				});
			}
		}

		if (n.kind === "message") {
			const config = (n.config ?? {}) as Record<string, unknown>;
			const blocks = Array.isArray(config.blocks) ? config.blocks : [];
			const quickReplies = Array.isArray(config.quick_replies)
				? config.quick_replies
				: [];
			const blocksResult = MessageBlockSchema.array().max(20).safeParse(blocks);
			const repliesResult = QuickReplySchema.array()
				.max(13)
				.safeParse(quickReplies);
			if (!blocksResult.success || !repliesResult.success) {
				errors.push({
					code: "invalid_message_config",
					message: "message blocks or quick replies are invalid",
					node_key: n.key,
				});
			}
			if (blocksResult.success && repliesResult.success) {
				const blockIds = new Set<string>();
				const cardIds = new Set<string>();
				const buttonIds = new Set<string>();
				const quickReplyIds = new Set<string>();
				let invalidContent = false;
				const addUnique = (set: Set<string>, value: string) => {
					const normalized = value.trim();
					if (normalized === "" || set.has(normalized)) invalidContent = true;
					set.add(normalized);
				};
				const inspectButtons = (
					buttons:
						| Array<{
								id: string;
								type: "branch" | "url" | "call" | "share";
								label: string;
								url?: string;
								phone?: string;
						  }>
						| undefined,
				) => {
					for (const button of buttons ?? []) {
						addUnique(buttonIds, button.id);
						if (
							button.label.trim() === "" ||
							(button.type === "url" && !button.url?.trim()) ||
							(button.type === "call" && !button.phone?.trim())
						) {
							invalidContent = true;
						}
					}
				};

				for (const block of blocksResult.data) {
					addUnique(blockIds, block.id);
					switch (block.type) {
						case "text":
							if (block.text.trim() === "") invalidContent = true;
							inspectButtons(block.buttons);
							break;
						case "image":
						case "video":
						case "audio":
						case "file":
							if (block.media_ref.trim() === "") invalidContent = true;
							break;
						case "card":
							if (block.title.trim() === "") invalidContent = true;
							inspectButtons(block.buttons);
							break;
						case "gallery":
							for (const card of block.cards) {
								addUnique(cardIds, card.id);
								if (card.title.trim() === "") invalidContent = true;
								inspectButtons(card.buttons);
							}
							break;
						case "delay":
							break;
					}
				}
				for (const reply of repliesResult.data) {
					addUnique(quickReplyIds, reply.id);
					if (reply.label.trim() === "") invalidContent = true;
				}
				if (invalidContent) {
					errors.push({
						code: "invalid_message_content",
						message:
							"message IDs must be non-empty and unique, and visible content/action targets must be configured",
						node_key: n.key,
					});
				}
			}
			const delivery = config.delivery;
			const waitForReply = config.wait_for_reply;
			const timeout = config.no_response_timeout_min;
			const typingSeconds = config.typing_indicator_seconds;
			const hasInteractive =
				quickReplies.length > 0 ||
				blocks.some((rawBlock) => {
					if (!rawBlock || typeof rawBlock !== "object") return false;
					const block = rawBlock as Record<string, unknown>;
					const buttonGroups: unknown[] = [block.buttons];
					if (Array.isArray(block.cards)) {
						buttonGroups.push(
							...block.cards.map((card) =>
								card && typeof card === "object"
									? (card as Record<string, unknown>).buttons
									: undefined,
							),
						);
					}
					return buttonGroups.some(
						(group) =>
							Array.isArray(group) &&
							group.some(
								(button) =>
									button &&
									typeof button === "object" &&
									(button as Record<string, unknown>).type === "branch",
							),
					);
				});
			if (
				(delivery !== undefined &&
					delivery !== "direct" &&
					delivery !== "comment_private_reply") ||
				(waitForReply !== undefined && typeof waitForReply !== "boolean") ||
				(timeout !== undefined &&
					(typeof timeout !== "number" ||
						!Number.isFinite(timeout) ||
						timeout <= 0)) ||
				(typingSeconds !== undefined &&
					(typeof typingSeconds !== "number" ||
						!Number.isFinite(typingSeconds) ||
						typingSeconds < 0 ||
						typingSeconds > 5)) ||
				(timeout !== undefined && waitForReply !== true && !hasInteractive)
			) {
				errors.push({
					code: "invalid_message_settings",
					message:
						"message delivery, wait, timeout, or typing-indicator settings are invalid",
					node_key: n.key,
				});
			}
			if (config.delivery === "comment_private_reply") {
				const block = blocks[0] as Record<string, unknown> | undefined;
				if (
					(channel && channel !== "instagram" && channel !== "facebook") ||
					blocks.length !== 1 ||
					block?.type !== "text" ||
					(Array.isArray(block?.buttons) && block.buttons.length > 0) ||
					quickReplies.length > 0 ||
					waitForReply === true ||
					timeout !== undefined
				) {
					errors.push({
						code: "invalid_private_reply_config",
						message:
							"comment private replies require Instagram/Facebook and one button-free text block",
						node_key: n.key,
					});
				}
			}
		}

		if (n.kind === "delay") {
			const config = (n.config ?? {}) as Record<string, unknown>;
			const units = [
				["seconds", 1_000],
				["minutes", 60_000],
				["hours", 3_600_000],
				["days", 86_400_000],
			] as const;
			let durationMs = 0;
			let invalidDuration = false;
			for (const [key, multiplier] of units) {
				const value = config[key];
				if (value === undefined) continue;
				if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
					invalidDuration = true;
					continue;
				}
				durationMs += value * multiplier;
			}
			if (
				invalidDuration ||
				!Number.isFinite(durationMs) ||
				durationMs < 1_000
			) {
				errors.push({
					code: "invalid_delay_config",
					message:
						"delay units must be finite non-negative numbers totaling at least one second",
					node_key: n.key,
				});
			}
		}

		if (n.kind === "wait_event") {
			const config = (n.config ?? {}) as Record<string, unknown>;
			const kinds = Array.isArray(config.event_kinds) ? config.event_kinds : [];
			if (
				kinds.length === 0 ||
				kinds.some(
					(kind) => typeof kind !== "string" || !WAIT_EVENT_KINDS.has(kind),
				) ||
				new Set(kinds).size !== kinds.length ||
				(config.timeout_min !== undefined &&
					(typeof config.timeout_min !== "number" ||
						!Number.isFinite(config.timeout_min) ||
						config.timeout_min <= 0))
			) {
				errors.push({
					code: "invalid_wait_event_config",
					message:
						"wait_event requires supported event_kinds and an optional positive timeout_min",
					node_key: n.key,
				});
			}
			if (
				channel &&
				kinds.some(
					(kind) =>
						typeof kind === "string" &&
						WAIT_EVENT_CHANNELS[kind] !== undefined &&
						!WAIT_EVENT_CHANNELS[kind].includes(channel),
				)
			) {
				errors.push({
					code: "unsupported_wait_event_channel",
					message: "wait_event contains an event unavailable on this channel",
					node_key: n.key,
				});
			}
		}

		if (n.kind === "condition") {
			const predicates = (n.config as Record<string, unknown> | undefined)
				?.predicates;
			if (predicates !== undefined && !filterGroupIsExecutable(predicates)) {
				errors.push({
					code: "invalid_condition_config",
					message:
						"condition predicates require supported operators and executable values",
					node_key: n.key,
				});
			}
		}

		if (n.kind === "social_profile_check") {
			const field = (n.config as Record<string, unknown> | undefined)?.field;
			if (field !== undefined && field !== "is_user_follow_business") {
				errors.push({
					code: "invalid_social_profile_check_config",
					message: "social_profile_check supports only is_user_follow_business",
					node_key: n.key,
				});
			}
			if (channel && channel !== "instagram") {
				errors.push({
					code: "unsupported_node_channel",
					message: "social_profile_check is available only on Instagram",
					node_key: n.key,
				});
			}
		}

		if (n.kind === "start_automation") {
			const config = (n.config ?? {}) as Record<string, unknown>;
			if (
				typeof config.target_automation_id !== "string" ||
				config.target_automation_id.trim() === "" ||
				config.target_automation_id.length > 256 ||
				(config.pass_context !== undefined &&
					typeof config.pass_context !== "boolean") ||
				(config.entrypoint_id !== undefined &&
					(typeof config.entrypoint_id !== "string" ||
						config.entrypoint_id.trim() === "" ||
						config.entrypoint_id.length > 256))
			) {
				errors.push({
					code: "invalid_start_automation_config",
					message:
						"start_automation requires a target automation and valid optional settings",
					node_key: n.key,
				});
			}
		}

		if (n.kind === "http_request") {
			const config = (n.config ?? {}) as Record<string, unknown>;
			const url = config.url;
			const secretRef = config.secret_ref;
			const headers = config.headers;
			const configuredHeaders = config.configured_headers;
			const timeout = config.timeout_ms;
			const responseKey = config.response_key;
			const hasExecutableUrl =
				typeof url === "string" &&
				url.length <= 16_384 &&
				(url === REDACTED_HTTP_URL
					? typeof secretRef === "string" && secretRef.trim() !== ""
					: httpUrlIsExecutable(url));
			const headersValid =
				headers === undefined ||
				(isPlainRecord(headers) &&
					Object.entries(headers).every(
						([name, value]) =>
							name.trim() !== "" &&
							name.length <= 256 &&
							typeof value === "string",
					));
			if (
				!hasExecutableUrl ||
				(config.method !== undefined &&
					(typeof config.method !== "string" ||
						!HTTP_METHODS.has(config.method))) ||
				!headersValid ||
				(config.body !== undefined && typeof config.body !== "string") ||
				(timeout !== undefined &&
					(typeof timeout !== "number" ||
						!Number.isFinite(timeout) ||
						timeout < 1 ||
						timeout > 30_000)) ||
				(responseKey !== undefined &&
					(typeof responseKey !== "string" ||
						!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(responseKey))) ||
				(secretRef !== undefined &&
					(typeof secretRef !== "string" || secretRef.trim() === "")) ||
				(config.credentials_configured !== undefined &&
					typeof config.credentials_configured !== "boolean") ||
				(config.body_configured !== undefined &&
					typeof config.body_configured !== "boolean") ||
				(config.clear_credentials !== undefined &&
					typeof config.clear_credentials !== "boolean") ||
				config.clear_credentials === true ||
				(configuredHeaders !== undefined &&
					(!Array.isArray(configuredHeaders) ||
						configuredHeaders.some(
							(name) => typeof name !== "string" || name.trim() === "",
						)))
			) {
				errors.push({
					code: "invalid_http_request_config",
					message:
						"http_request requires a stored HTTP(S) URL and valid method, headers, timeout, and response key",
					node_key: n.key,
				});
			}
		}

		if (n.kind === "end") {
			const reason = (n.config as Record<string, unknown> | undefined)?.reason;
			if (
				reason !== undefined &&
				(typeof reason !== "string" || reason.length > 256)
			) {
				errors.push({
					code: "invalid_end_config",
					message: "end reason must be a string of at most 256 characters",
					node_key: n.key,
				});
			}
		}

		if (n.kind === "randomizer") {
			const variants = Array.isArray(
				(n.config as Record<string, unknown> | undefined)?.variants,
			)
				? ((n.config as { variants: unknown[] }).variants as unknown[])
				: [];
			const keys = new Set<string>();
			const invalid =
				variants.length < 2 ||
				variants.length > 100 ||
				variants.some((variant) => {
					if (!variant || typeof variant !== "object") return true;
					const item = variant as { key?: unknown; weight?: unknown };
					if (
						typeof item.key !== "string" ||
						item.key.trim().length === 0 ||
						item.key.length > 128 ||
						typeof item.weight !== "number" ||
						!Number.isFinite(item.weight) ||
						item.weight <= 0 ||
						keys.has(item.key.trim())
					) {
						return true;
					}
					keys.add(item.key.trim());
					return false;
				});
			if (invalid) {
				errors.push({
					code: "invalid_randomizer_config",
					message:
						"randomizer requires at least two uniquely keyed positive-weight variants",
					node_key: n.key,
				});
			}
		}

		if (n.kind !== "action_group") continue;
		const actions = Array.isArray(
			(n.config as Record<string, unknown> | null | undefined)?.actions,
		)
			? ((n.config as { actions: unknown[] }).actions as unknown[])
			: [];
		if (actions.length > 0) {
			const parsedActions = ActionGroupConfigSchema.safeParse(n.config ?? {});
			if (!parsedActions.success) {
				errors.push({
					code: "invalid_action_config",
					message:
						parsedActions.error.issues[0]?.message ?? "invalid action config",
					node_key: n.key,
				});
				continue;
			}
		}
		for (const raw of actions) {
			if (!raw || typeof raw !== "object") continue;
			const action = raw as { type?: unknown };
			if (typeof action.type !== "string") continue;
			const msg = UNAVAILABLE_ACTION_TYPES[action.type];
			if (msg) {
				errors.push({
					code: "action_unavailable",
					message: msg,
					node_key: n.key,
				});
			}
			if (
				action.type === "change_main_menu" &&
				channel &&
				channel !== "facebook"
			) {
				errors.push({
					code: "unsupported_action_channel",
					message: "change_main_menu is available only on Facebook Messenger",
					node_key: n.key,
				});
			}
		}
	}

	// 3. edge references (node + port existence)
	const nodeByKey = new Map(canonical.nodes.map((n) => [n.key, n]));
	for (const node of canonical.nodes) {
		if (node.kind !== "goto") continue;
		const target = (node.config as { target_node_key?: unknown })
			?.target_node_key;
		if (typeof target !== "string" || !nodeByKey.has(target)) {
			errors.push({
				code: "goto_missing_target",
				message: `goto node "${node.key}" must reference an existing target_node_key`,
				node_key: node.key,
			});
		}
	}
	for (let i = 0; i < canonical.edges.length; i++) {
		const e = canonical.edges[i];
		if (!e) continue;
		const from = nodeByKey.get(e.from_node);
		const to = nodeByKey.get(e.to_node);
		if (!from) {
			errors.push({
				code: "edge_missing_from_node",
				message: `edge[${i}] from_node "${e.from_node}" missing`,
				edge_index: i,
			});
			continue;
		}
		if (!to) {
			errors.push({
				code: "edge_missing_to_node",
				message: `edge[${i}] to_node "${e.to_node}" missing`,
				edge_index: i,
			});
			continue;
		}
		if (
			!from.ports.some((p) => p.key === e.from_port && p.direction === "output")
		) {
			errors.push({
				code: "edge_missing_from_port",
				message: `edge[${i}] from_port "${e.from_port}" does not exist on node "${from.key}"`,
				edge_index: i,
				node_key: from.key,
				port_key: e.from_port,
			});
		}
		if (!to.ports.some((p) => p.key === e.to_port && p.direction === "input")) {
			errors.push({
				code: "edge_missing_to_port",
				message: `edge[${i}] to_port "${e.to_port}" does not exist on node "${to.key}"`,
				edge_index: i,
				node_key: to.key,
				port_key: e.to_port,
			});
		}
	}

	// 4. orphan nodes (non-root with no incoming edges) — WARNING, not error.
	//
	// A node with no incoming edge is unreachable, not invalid: the runner starts
	// at `root_node_key` and only ever follows edges (see runner.ts — runLoop
	// seeds `currentNodeKey: rootKey`), so an orphan node simply never executes.
	// Treating this as a fatal error meant every freshly-added-but-not-yet-wired
	// node force-paused the active automation and bounced the save with a 422 —
	// making incremental canvas editing impossible. It mirrors the symmetric
	// `port_no_outgoing_edge` case below, which is already a warning.
	const incoming = new Set<string>();
	for (const e of canonical.edges) incoming.add(e.to_node);
	for (const node of canonical.nodes) {
		if (node.kind !== "goto") continue;
		const target = (node.config as { target_node_key?: unknown })
			?.target_node_key;
		if (typeof target === "string") incoming.add(target);
	}
	for (const n of canonical.nodes) {
		if (n.key === canonical.root_node_key) continue;
		if (!incoming.has(n.key)) {
			warnings.push({
				code: "orphan_node",
				message: `node "${n.key}" has no incoming edge`,
				node_key: n.key,
			});
		}
	}

	// 5. cycle without a pause point
	const cycles = findCycles(canonical);
	for (const cycle of cycles) {
		const hasPause = cycle.some((key) => {
			const n = nodeByKey.get(key);
			return n ? LOOP_PAUSE_KINDS.has(n.kind) : false;
		});
		if (!hasPause) {
			errors.push({
				code: "cycle_without_pause",
				message: `cycle without input/delay/wait-event pause point: ${cycle.join(" → ")}`,
				node_key: cycle[0],
			});
		}
	}

	// 6. warnings: orphan output ports with no outgoing edge
	const outgoing = new Map<string, Set<string>>();
	for (const e of canonical.edges) {
		let ports = outgoing.get(e.from_node);
		if (!ports) {
			ports = new Set();
			outgoing.set(e.from_node, ports);
		}
		ports.add(e.from_port);
	}
	for (const n of canonical.nodes) {
		for (const p of n.ports) {
			if (p.direction !== "output") continue;
			if (!outgoing.get(n.key)?.has(p.key)) {
				warnings.push({
					code: "port_no_outgoing_edge",
					message: `node "${n.key}" port "${p.key}" has no outgoing edge`,
					node_key: n.key,
					port_key: p.key,
				});
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
		canonicalGraph: canonical,
	};
}

function findCycles(graph: Graph): string[][] {
	const adj = new Map<string, string[]>();
	for (const e of graph.edges) {
		let targets = adj.get(e.from_node);
		if (!targets) {
			targets = [];
			adj.set(e.from_node, targets);
		}
		targets.push(e.to_node);
	}
	for (const node of graph.nodes) {
		if (node.kind !== "goto") continue;
		const target = (node.config as { target_node_key?: unknown })
			?.target_node_key;
		if (typeof target !== "string") continue;
		let targets = adj.get(node.key);
		if (!targets) {
			targets = [];
			adj.set(node.key, targets);
		}
		targets.push(target);
	}
	const cycles: string[][] = [];
	const color = new Map<string, 0 | 1 | 2>(); // 0=unvisited, 1=in-stack, 2=done
	const stack: string[] = [];
	const dfs = (u: string) => {
		color.set(u, 1);
		stack.push(u);
		for (const v of adj.get(u) ?? []) {
			const c = color.get(v) ?? 0;
			if (c === 1) {
				const startIdx = stack.indexOf(v);
				if (startIdx >= 0) cycles.push(stack.slice(startIdx));
			} else if (c === 0) dfs(v);
		}
		stack.pop();
		color.set(u, 2);
	};
	for (const n of graph.nodes) if ((color.get(n.key) ?? 0) === 0) dfs(n.key);
	return cycles;
}
