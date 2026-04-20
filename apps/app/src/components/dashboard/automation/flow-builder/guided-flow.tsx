import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
	Bot,
	Clock3,
	CornerDownRight,
	GitBranch,
	Globe,
	Keyboard,
	MessageSquare,
	MoreHorizontal,
	Plus,
	RefreshCw,
	Send,
	StopCircle,
	Tag,
	Trash2,
	Zap,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import {
	EdgeLabelRenderer,
	Handle,
	MarkerType,
	Panel,
	Position,
	ReactFlow,
	ReactFlowProvider,
	getBezierPath,
	useNodesState,
	useReactFlow,
	type Edge,
	type EdgeProps,
	type Node,
	type NodeProps,
	type XYPosition,
} from "reactflow";
import "reactflow/dist/style.css";
import { platformIcons } from "@/lib/platform-icons";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { resolveNodeOutputLabels } from "./output-labels";
import {
	defaultTriggerLabel,
	triggerCanvasPosition,
	triggerDisplayRows,
} from "./trigger-ui";
import type {
	AutomationDetail,
	AutomationNodeSpec,
	AutomationSchema,
	SchemaNodeDef,
} from "./types";

const CATEGORY_ORDER = [
	"content",
	"input",
	"logic",
	"ai",
	"action",
	"ops",
	"platform_send",
	"flow",
];

const CATEGORY_LABEL: Record<string, string> = {
	content: "Content",
	input: "Input",
	logic: "Logic",
	ai: "AI",
	action: "Contacts",
	ops: "Operations",
	platform_send: "Send",
	flow: "Flow",
};

const TRIGGER_ID = "trigger";
const LAYER_GAP = 560;
const ROW_GAP = 220;

const PLATFORM_LABELS: Record<string, string> = {
	instagram: "Instagram",
	facebook: "Facebook",
	whatsapp: "WhatsApp",
	telegram: "Telegram",
	discord: "Discord",
	sms: "SMS",
	twitter: "X",
	bluesky: "Bluesky",
	threads: "Threads",
	youtube: "YouTube",
	linkedin: "LinkedIn",
	mastodon: "Mastodon",
	reddit: "Reddit",
	googlebusiness: "Google Business",
	beehiiv: "Beehiiv",
	kit: "Kit",
	mailchimp: "Mailchimp",
	listmonk: "Listmonk",
	pinterest: "Pinterest",
	multi: "Workflow",
};

const NODE_OPERATION_OVERRIDES: Record<string, string> = {
	message_text: "Send Message",
	message_media: "Send Media",
	message_file: "Send File",
	condition: "Condition",
	smart_delay: "Delay",
	randomizer: "Randomizer",
	http_request: "HTTP Request",
	goto: "Go To Step",
	end: "End Automation",
	tag_add: "Add Tag",
	tag_remove: "Remove Tag",
	field_set: "Set Field",
	field_clear: "Clear Field",
};

const TRIGGER_OPERATION_OVERRIDES: Record<string, string> = {
	instagram_comment: "User comments on your Post or Reel",
	instagram_dm: "User sends a message",
	instagram_story_reply: "User replies to your Story",
	instagram_story_mention: "User mentions your Story",
	facebook_comment: "User comments on your Post",
	facebook_dm: "User sends a message",
	whatsapp_message: "User sends a WhatsApp message",
	telegram_message: "User sends a Telegram message",
	sms_received: "User sends an SMS",
	manual: "Manual start",
	external_api: "External API event",
};

const TRIGGER_CATEGORY_LABELS: Record<string, string> = {
	instagram_comment: "Post or Reel Comments",
	instagram_dm: "Instagram Message",
	instagram_story_reply: "Story Reply",
	instagram_story_mention: "Story Mention",
	facebook_comment: "Post Comments",
	facebook_dm: "Facebook Message",
	whatsapp_message: "WhatsApp Message",
	telegram_message: "Telegram Message",
	sms_received: "SMS Received",
	manual: "Manual",
	external_api: "External API",
};

interface ChildLink {
	label: string;
	order: number;
	target: string;
}

interface SharedNodeData {
	automationChannel: string;
	hasError: boolean;
	highlighted: boolean;
	readOnly?: boolean;
	schema: AutomationSchema;
	onAddTriggerRow: (triggerType?: string) => void;
	onDeleteNode: (key: string) => void;
	onInsertAfter: (parentKey: string, label: string, nodeType: string) => void;
	onSelect: (key: string | null) => void;
}

interface TriggerCardData extends SharedNodeData {
	kind: "trigger";
	automation: AutomationDetail;
	connectedOutputs: string[];
}

interface StepCardData extends SharedNodeData {
	kind: "step";
	node: AutomationNodeSpec;
	def: SchemaNodeDef | null;
	connectedOutputs: string[];
}

type FlowCardData = TriggerCardData | StepCardData;

interface FlowEdgeData {
	automationChannel: string;
	edgeIndex: number;
	label: string;
	onDeleteEdge: (edgeIndex: number) => void;
	onInsertAfter: (parentKey: string, label: string, nodeType: string) => void;
	parentKey: string;
	readOnly?: boolean;
	schema: AutomationSchema;
}

interface Props {
	automation: AutomationDetail;
	schema: AutomationSchema;
	errorKeys: Set<string>;
	highlightKeys: Set<string>;
	selectedKey: string | null;
	onMoveNode?: (key: string, position: XYPosition) => void;
	onAddTriggerRow: (triggerType?: string) => void;
	onSelect: (key: string | null) => void;
	onInsertAfter: (parentKey: string, label: string, nodeType: string) => void;
	onDeleteEdge: (edgeIndex: number) => void;
	onDeleteNode: (key: string) => void;
	readOnly?: boolean;
}

function titleize(value: string): string {
	return value
		.split("_")
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

interface TriggerTypePickerProps {
	automationChannel: string;
	children: ReactNode;
	onPick: (triggerType: string) => void;
	schema: AutomationSchema;
}

export function TriggerTypePicker({
	automationChannel,
	children,
	onPick,
	schema,
}: TriggerTypePickerProps) {
	const [open, setOpen] = useState(false);
	const triggers = useMemo(
		() =>
			schema.triggers
				.filter((t) => t.channel === automationChannel)
				.sort((a, b) => a.type.localeCompare(b.type)),
		[automationChannel, schema.triggers],
	);

	const channelLabel =
		PLATFORM_LABELS[automationChannel] ?? titleize(automationChannel);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>{children}</PopoverTrigger>
			<PopoverContent
				align="center"
				sideOffset={8}
				className="w-[360px] p-0"
			>
				<div className="border-b border-border px-4 py-3">
					<div className="text-[13px] font-semibold text-foreground">
						Start automation when…
					</div>
					<div className="mt-0.5 text-[11px] text-muted-foreground">
						Specific {channelLabel} event that starts your automation.
					</div>
				</div>
				<div className="max-h-[420px] overflow-y-auto p-2">
					{triggers.length === 0 ? (
						<div className="px-3 py-4 text-center text-[12px] text-muted-foreground">
							No triggers available for {channelLabel}.
						</div>
					) : (
						triggers.map((trigger) => {
							const summary =
								TRIGGER_OPERATION_OVERRIDES[trigger.type] ??
								titleize(
									trigger.type.replace(
										new RegExp(`^${automationChannel}_`),
										"",
									),
								);
							const category =
								TRIGGER_CATEGORY_LABELS[trigger.type] ??
								titleize(
									trigger.type.replace(
										new RegExp(`^${automationChannel}_`),
										"",
									),
								);
							return (
								<button
									key={trigger.type}
									type="button"
									onClick={() => {
										onPick(trigger.type);
										setOpen(false);
									}}
									className="flex w-full items-start gap-3 rounded-xl px-2.5 py-2.5 text-left transition hover:bg-accent"
								>
									<div className="mt-0.5 shrink-0">
										{platformIconBubble(trigger.channel)}
									</div>
									<div className="min-w-0 flex-1">
										<div className="text-[12px] font-medium text-muted-foreground">
											{category}
										</div>
										<div className="mt-0.5 text-[14px] font-semibold text-foreground">
											{summary}
										</div>
									</div>
								</button>
							);
						})
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}

function presentLabel(value: string): string {
	return value === "next" ? "Next Step" : titleize(value);
}

function describeNodePresentation(
	nodeType: string,
	category: string,
	automationChannel: string,
) {
	const [prefix, ...rest] = nodeType.split("_");
	if (NODE_OPERATION_OVERRIDES[nodeType]) {
		const app = nodeType.startsWith("message_")
			? (PLATFORM_LABELS[automationChannel] ?? titleize(automationChannel))
			: nodeType.startsWith("user_input_")
				? "Input"
				: (CATEGORY_LABEL[category] ?? titleize(category));
		return { app, operation: NODE_OPERATION_OVERRIDES[nodeType]! };
	}
	if (prefix && PLATFORM_LABELS[prefix]) {
		return {
			app: PLATFORM_LABELS[prefix],
			operation: titleize(rest.join("_") || nodeType),
		};
	}
	if (nodeType.startsWith("message_")) {
		return { app: "Messaging", operation: titleize(nodeType.slice(8)) };
	}
	if (nodeType.startsWith("user_input_")) {
		return {
			app: "Input",
			operation: `Collect ${titleize(nodeType.slice(11))}`,
		};
	}
	return {
		app: CATEGORY_LABEL[category] ?? titleize(category),
		operation: titleize(nodeType),
	};
}

function nodeSummary(spec: AutomationNodeSpec): string | undefined {
	if (spec.type === "split_test" && Array.isArray(spec.variants)) {
		return `${spec.variants.length} variant${spec.variants.length === 1 ? "" : "s"} configured`;
	}
	if (spec.type === "randomizer" && Array.isArray(spec.branches)) {
		return `${spec.branches.length} branch${spec.branches.length === 1 ? "" : "es"} configured`;
	}
	if (typeof spec.text === "string" && spec.text.trim()) return spec.text;
	if (typeof spec.prompt === "string" && spec.prompt.trim()) return spec.prompt;
	if (typeof spec.when === "string" && spec.when.trim()) return spec.when;
	if (typeof spec.url === "string" && spec.url.trim()) return spec.url;
	if (typeof spec.tag === "string" && spec.tag.trim()) return spec.tag;
	if (typeof spec.field === "string" && spec.field.trim()) return spec.field;
	if (typeof spec.target_node_key === "string" && spec.target_node_key.trim()) {
		return `Go to ${spec.target_node_key}`;
	}
	if (typeof spec.duration_minutes === "number") {
		return `${spec.duration_minutes} minute${spec.duration_minutes === 1 ? "" : "s"}`;
	}
	return undefined;
}

function fallbackSummary(nodeType: string): string {
	if (nodeType.startsWith("message_")) return "Add a text";
	if (nodeType === "condition") return "Set the branching rules";
	if (nodeType === "smart_delay") return "Wait before continuing";
	if (nodeType === "http_request") return "Configure the request";
	if (nodeType === "goto") return "Choose where this flow continues";
	if (nodeType === "end") return "Stop the automation";
	return "Configure this step";
}

function buildChildrenByKey(
	edges: AutomationDetail["edges"],
): Map<string, ChildLink[]> {
	const map = new Map<string, ChildLink[]>();
	for (const edge of edges) {
		const list = map.get(edge.from) ?? [];
		list.push({
			label: edge.label ?? "next",
			order: edge.order ?? Number.MAX_SAFE_INTEGER,
			target: edge.to,
		});
		map.set(edge.from, list);
	}
	for (const list of map.values()) {
		list.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
	}
	return map;
}

function computeAutoPositions(
	automation: AutomationDetail,
	childrenByKey: Map<string, ChildLink[]>,
): Map<string, XYPosition> {
	const layers = new Map<number, string[]>();
	const seen = new Set<string>([TRIGGER_ID]);
	const queue: Array<{ depth: number; key: string }> = [
		{ depth: 0, key: TRIGGER_ID },
	];

	while (queue.length > 0) {
		const current = queue.shift()!;
		const layer = layers.get(current.depth) ?? [];
		layer.push(current.key);
		layers.set(current.depth, layer);
		for (const child of childrenByKey.get(current.key) ?? []) {
			if (seen.has(child.target)) continue;
			seen.add(child.target);
			queue.push({ depth: current.depth + 1, key: child.target });
		}
	}

	const lastDepth = Math.max(...layers.keys(), 0);
	let orphanDepth = lastDepth + 1;
	for (const node of automation.nodes) {
		if (seen.has(node.key)) continue;
		const layer = layers.get(orphanDepth) ?? [];
		layer.push(node.key);
		layers.set(orphanDepth, layer);
		orphanDepth += 1;
	}

	const positions = new Map<string, XYPosition>();
	for (const [depth, keys] of Array.from(layers.entries()).sort(
		(a, b) => a[0] - b[0],
	)) {
		const startY = -((keys.length - 1) * ROW_GAP) / 2;
		keys.forEach((key, index) => {
			positions.set(key, {
				x: depth * LAYER_GAP,
				y: startY + index * ROW_GAP,
			});
		});
	}

	return positions;
}

function resolveNodePosition(
	key: string,
	automation: AutomationDetail,
	autoPositions: Map<string, XYPosition>,
): XYPosition {
	if (key === TRIGGER_ID) {
		return (
			triggerCanvasPosition(automation) ??
			autoPositions.get(TRIGGER_ID) ?? { x: 0, y: 0 }
		);
	}
	const node = automation.nodes.find((entry) => entry.key === key);
	if (
		node &&
		typeof node.canvas_x === "number" &&
		typeof node.canvas_y === "number"
	) {
		return { x: node.canvas_x, y: node.canvas_y };
	}
	return autoPositions.get(key) ?? { x: 0, y: 0 };
}

function platformIconBubble(channel: string) {
	const palette =
		channel === "instagram"
			? "bg-[linear-gradient(135deg,#ffd776_0%,#f74a5c_48%,#7d3cff_100%)]"
			: channel === "facebook"
				? "bg-[#1877f2]"
				: channel === "whatsapp"
					? "bg-[#25d366]"
					: channel === "telegram"
						? "bg-[#27a7e7]"
						: "bg-[#7c8ca5]";
	return (
		<div
			className={cn(
				"flex size-7 items-center justify-center rounded-full text-white shadow-[0_2px_8px_rgba(15,23,42,0.15)]",
				palette,
			)}
		>
			<div className="scale-[0.8]">
				{platformIcons[channel] ?? <MessageSquare className="size-3.5" />}
			</div>
		</div>
	);
}

function categoryIcon(nodeType: string, category: string) {
	if (nodeType === "goto") return CornerDownRight;
	if (nodeType === "end") return StopCircle;
	if (nodeType === "http_request") return Globe;
	if (
		nodeType === "randomizer" ||
		nodeType === "split_test" ||
		nodeType === "condition"
	) {
		return GitBranch;
	}
	if (category === "ai") return Bot;
	if (category === "input") return Keyboard;
	if (category === "action") return Tag;
	if (category === "ops") return Clock3;
	if (category === "platform_send") return Send;
	return MessageSquare;
}

function cardShellClass({
	hasError,
	highlighted,
	kind,
	selected,
}: {
	hasError: boolean;
	highlighted: boolean;
	kind: "step" | "trigger";
	selected: boolean;
}) {
	return cn(
		"group relative overflow-visible rounded-[22px] border bg-white shadow-[0_2px_10px_rgba(34,44,66,0.08)] transition-all duration-150",
		kind === "trigger"
			? "w-[390px] border-[#e6e9ef]"
			: "w-[346px] border-[#e6e9ef]",
		kind === "step" &&
			selected &&
			"border-[#4680ff] shadow-[0_0_0_1px_rgba(70,128,255,0.3),0_3px_12px_rgba(34,44,66,0.1)]",
		kind === "trigger" &&
			selected &&
			"border-[#63d26f] shadow-[0_0_0_1px_rgba(99,210,111,0.3),0_3px_12px_rgba(34,44,66,0.1)]",
		highlighted && "ring-1 ring-[#a7d8ff]",
		hasError && "border-[#f4af4d] shadow-[0_0_0_1px_rgba(244,175,77,0.28)]",
	);
}

function AddStepMenu({
	automationChannel,
	className,
	label,
	onInsert,
	parentKey,
	schema,
	tone,
}: {
	automationChannel: string;
	className?: string;
	label: string;
	onInsert: (parentKey: string, label: string, nodeType: string) => void;
	parentKey: string;
	schema: AutomationSchema;
	tone: "edge" | "footer" | "ghost";
}) {
	const [open, setOpen] = useState(false);
	const grouped = useMemo(() => {
		const byCategory = new Map<string, SchemaNodeDef[]>();
		for (const node of schema.nodes) {
			if (node.type === "trigger") continue;
			if (
				node.category === "platform_send" &&
				automationChannel !== "multi" &&
				!node.type.includes(automationChannel)
			) {
				continue;
			}
			const list = byCategory.get(node.category) ?? [];
			list.push(node);
			byCategory.set(node.category, list);
		}
		for (const list of byCategory.values()) {
			list.sort((a, b) => a.type.localeCompare(b.type));
		}
		return byCategory;
	}, [automationChannel, schema]);

	const triggerClassName = cn(
		"nodrag nopan",
		tone === "edge" &&
			"inline-flex size-7 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:border-slate-300 hover:text-slate-800",
		tone === "footer" &&
			"inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-600 transition hover:border-slate-400 hover:bg-white hover:text-slate-900",
		tone === "ghost" &&
			"inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 transition hover:text-slate-900",
		className,
	);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button type="button" className={triggerClassName}>
					<Plus className={cn("size-3.5", tone === "ghost" && "size-3")} />
					{tone === "footer" && <span>{presentLabel(label)}</span>}
					{tone === "ghost" && <span>Add Step</span>}
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="center"
				sideOffset={8}
				className="w-72 max-h-96 overflow-y-auto p-0"
			>
				<div className="border-b border-border px-3 py-2">
					<div className="text-xs font-semibold text-foreground">Add step</div>
					<div className="mt-0.5 text-[11px] text-muted-foreground">
						Attach to {presentLabel(label)}
					</div>
				</div>
				<div className="p-2">
					{CATEGORY_ORDER.filter((category) => grouped.has(category)).map(
						(category) => (
							<div key={category} className="mb-2 last:mb-0">
								<div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
									{CATEGORY_LABEL[category] ?? titleize(category)}
								</div>
								<div className="space-y-1">
									{(grouped.get(category) ?? []).map((node) => {
										const presentation = describeNodePresentation(
											node.type,
											node.category,
											automationChannel,
										);
										return (
											<button
												key={node.type}
												type="button"
												onClick={() => {
													onInsert(parentKey, label, node.type);
													setOpen(false);
												}}
												className="flex w-full items-start justify-between rounded-xl px-2.5 py-2 text-left transition hover:bg-accent"
											>
												<div>
													<div className="text-xs font-medium text-foreground">
														{presentation.operation}
													</div>
													<div className="mt-0.5 text-[11px] text-muted-foreground">
														{presentation.app}
													</div>
												</div>
												<span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
													{presentLabel(node.type)}
												</span>
											</button>
										);
									})}
								</div>
							</div>
						),
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}

function TriggerFlowNode({ data, selected }: NodeProps<TriggerCardData>) {
	const triggerType = data.automation.trigger_type ?? "";
	const channel = data.automation.channel ?? "";
	const summary =
		TRIGGER_OPERATION_OVERRIDES[triggerType] ??
		(triggerType
			? titleize(
					channel ? triggerType.replace(new RegExp(`^${channel}_`), "") : triggerType,
				)
			: "Configure trigger");
	const rows = triggerDisplayRows(data.automation);

	return (
		<div
			className={cn(
				cardShellClass({
					selected,
					highlighted: data.highlighted,
					hasError: data.hasError,
					kind: "trigger",
				}),
				"cursor-grab active:cursor-grabbing",
			)}
			onClick={(event) => {
				if ((event.target as HTMLElement).closest("button,input,a,[role=button]")) {
					return;
				}
				data.onSelect(TRIGGER_ID);
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					data.onSelect(TRIGGER_ID);
				}
			}}
			role="button"
			tabIndex={0}
		>
			<Handle
				type="source"
				position={Position.Right}
				className="!size-[14px] !border-[3px] !border-white !bg-[#5f6b7f] !shadow-[0_1px_4px_rgba(34,44,66,0.18)]"
				style={{ right: -8, top: "calc(100% - 22px)" }}
				isConnectable={false}
			/>
			<div className="block w-full px-5 py-4 text-left">
				<div className="flex items-center gap-2 text-[18px] font-bold tracking-tight text-[#1f2633]">
					<Zap className="size-[18px] text-[#1f2633]" />
					<span>When...</span>
				</div>

				{rows.length > 0 ? (
					<div className="mt-4 space-y-3">
						{rows.map((rowLabel, index) => (
							<div
								key={`${rowLabel}-${index}`}
								className="rounded-[16px] bg-[#f4f5f8] px-4 py-3"
							>
								<div className="flex items-center gap-3">
									{platformIconBubble(channel)}
									<div className="min-w-0">
										<div className="truncate text-[13px] font-medium leading-4 text-[#8b92a0]">
											{rowLabel ||
												defaultTriggerLabel(triggerType, index + 1)}
										</div>
										<div className="mt-0.5 text-[15px] font-semibold leading-5 text-[#404552]">
											{summary}
										</div>
									</div>
								</div>
							</div>
						))}
					</div>
				) : (
					<div className="mt-4 rounded-[16px] border border-dashed border-[#d9dde6] bg-white px-4 py-5 text-center text-[13px] text-[#7e8695]">
						No triggers yet — add one below.
					</div>
				)}

				<TriggerTypePicker
					automationChannel={channel}
					onPick={(triggerType) => {
						data.onAddTriggerRow(triggerType);
						data.onSelect(TRIGGER_ID);
					}}
					schema={data.schema}
				>
					<button
						type="button"
						onClick={(event) => event.stopPropagation()}
						className="nodrag mt-4 flex h-[48px] w-full items-center justify-center rounded-[14px] border border-dashed border-[#d9dde6] text-[15px] font-semibold text-[#4680ff] transition hover:border-[#4680ff] hover:bg-[#f4f8ff]"
					>
						+ New Trigger
					</button>
				</TriggerTypePicker>

				<div className="mt-3 flex justify-end text-[13px] font-medium text-[#6f7786]">
					Then
				</div>
			</div>
		</div>
	);
}

function StepFlowNode({ data, selected }: NodeProps<StepCardData>) {
	const category = data.def?.category ?? "ops";
	const Icon = categoryIcon(data.node.type, category);
	const presentation = describeNodePresentation(
		data.node.type,
		category,
		data.automationChannel,
	);
	const summary = nodeSummary(data.node) ?? fallbackSummary(data.node.type);
	const outputs = resolveNodeOutputLabels(data.node, data.def);
	const hasNext = outputs.some((label) =>
		data.connectedOutputs.includes(label),
	);
	const isMessageNode = data.node.type.startsWith("message_");
	const nodePlatformPrefix = data.node.type.split("_")[0] ?? "";
	const nodePlatform = PLATFORM_LABELS[nodePlatformPrefix]
		? nodePlatformPrefix
		: null;
	const isPlatformNode = isMessageNode || nodePlatform !== null;
	const iconChannel = nodePlatform ?? data.automationChannel;
	const preview =
		isMessageNode && summary === fallbackSummary(data.node.type)
			? "Add a text"
			: summary;

	return (
		<div
			className={cn(
				cardShellClass({
					selected,
					highlighted: data.highlighted,
					hasError: data.hasError,
					kind: "step",
				}),
				"cursor-grab active:cursor-grabbing",
			)}
			onClick={(event) => {
				if ((event.target as HTMLElement).closest("button,input,a,[role=button]")) {
					return;
				}
				data.onSelect(data.node.key);
			}}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					data.onSelect(data.node.key);
				}
			}}
			role="button"
			tabIndex={0}
		>
			<Handle
				type="target"
				position={Position.Left}
				className="!pointer-events-none !size-3 !border-0 !bg-transparent !opacity-0"
				style={{ left: -6, top: 40 }}
				isConnectable={false}
			/>
			<Handle
				type="source"
				position={Position.Right}
				className="!size-[14px] !border-[2px] !border-[#98a6bd] !bg-white !shadow-[0_1px_4px_rgba(34,44,66,0.12)]"
				style={{ right: -7, top: "86%" }}
				isConnectable={false}
			/>

			<div className="block w-full px-5 py-4 pr-12 text-left">
				<div className="flex items-start gap-3">
					<div className="mt-1 shrink-0">
						{isPlatformNode ? (
							platformIconBubble(iconChannel)
						) : (
							<div className="flex size-7 items-center justify-center rounded-full bg-[#eef1f5] text-[#7b8598]">
								<Icon className="size-3.5" />
							</div>
						)}
					</div>
					<div className="min-w-0">
						<div className="text-[13px] leading-4 text-[#8b92a0]">
							{presentation.app}
						</div>
						<div className="mt-1 text-[17px] font-semibold leading-5 text-[#404552]">
							{presentation.operation}
						</div>
					</div>
				</div>

				<div className="mt-4 rounded-[16px] bg-[#f4f5f8] px-4 py-3">
					<div className="line-clamp-3 min-h-[26px] text-[15px] leading-[22px] text-[#404552]">
						{preview}
					</div>
				</div>

				<div className="mt-4 flex items-center justify-between text-[13px] text-[#6f7786]">
					<div className="flex flex-wrap gap-2">
						{data.hasError && (
							<span className="rounded-full bg-[#fff2dc] px-2 py-0.5 text-[11px] font-semibold text-[#b36a00]">
								Error
							</span>
						)}
						{outputs.length > 1 &&
							outputs.map((label) => (
								<span
									key={label}
									className="rounded-full bg-[#f4f5f8] px-2 py-0.5 text-[11px] text-[#7e8695]"
								>
									{presentLabel(label)}
								</span>
							))}
					</div>
					<div className="flex items-center gap-2">
						{selected && !data.readOnly && !hasNext ? (
							<AddStepMenu
								automationChannel={data.automationChannel}
								label={outputs[0] ?? "next"}
								onInsert={data.onInsertAfter}
								parentKey={data.node.key}
								schema={data.schema}
								tone="ghost"
							/>
						) : null}
						<span>Next Step</span>
					</div>
				</div>
			</div>

			{!data.readOnly && (
				<div className="absolute right-3 top-3 opacity-0 transition group-hover:opacity-100">
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								onClick={(event) => event.stopPropagation()}
								className="nodrag rounded-md p-1 text-[#98a0ae] transition hover:bg-[#f3f5f8] hover:text-[#5f6775]"
								aria-label="Step actions"
							>
								<MoreHorizontal className="size-4" />
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-40">
							<DropdownMenuItem
								onClick={(event) => {
									event.stopPropagation();
									data.onDeleteNode(data.node.key);
								}}
								className="text-destructive focus:text-destructive"
							>
								Delete step
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			)}
		</div>
	);
}

function AutomationFlowEdge({
	data,
	markerEnd,
	source,
	sourcePosition,
	sourceX,
	sourceY,
	targetPosition,
	targetX,
	targetY,
}: EdgeProps<FlowEdgeData>) {
	const [hovered, setHovered] = useState(false);
	const leaveTimerRef = useRef<number | null>(null);
	const handleEnter = () => {
		if (leaveTimerRef.current !== null) {
			window.clearTimeout(leaveTimerRef.current);
			leaveTimerRef.current = null;
		}
		setHovered(true);
	};
	const handleLeave = () => {
		if (leaveTimerRef.current !== null) {
			window.clearTimeout(leaveTimerRef.current);
		}
		leaveTimerRef.current = window.setTimeout(() => {
			setHovered(false);
			leaveTimerRef.current = null;
		}, 160);
	};
	useEffect(
		() => () => {
			if (leaveTimerRef.current !== null) {
				window.clearTimeout(leaveTimerRef.current);
			}
		},
		[],
	);

	const [path, labelX, labelY] = getBezierPath({
		sourceX,
		sourceY,
		sourcePosition,
		targetX,
		targetY,
		targetPosition,
		curvature: 0.4,
	});
	const showBranchLabel =
		data?.label && data.label !== "next" && source !== TRIGGER_ID;
	const stroke = hovered ? "#4680ff" : "#9aa7bd";
	if (!data) {
		return (
			<path
				d={path}
				fill="none"
				stroke="#9aa7bd"
				strokeWidth={2.2}
				markerEnd={markerEnd}
			/>
		);
	}

	return (
		<>
			<path
				d={path}
				fill="none"
				stroke={stroke}
				strokeWidth={2.2}
				markerEnd={markerEnd}
			/>
			<path
				d={path}
				fill="none"
				stroke="transparent"
				strokeWidth={40}
				style={{ pointerEvents: "stroke" }}
				onMouseEnter={handleEnter}
				onMouseLeave={handleLeave}
			/>
			<EdgeLabelRenderer>
				<>
					{showBranchLabel ? (
						<div
							className="pointer-events-none absolute"
							style={{
								transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY - 24}px)`,
							}}
						>
							<span className="rounded-full bg-white px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#7b8598] shadow-[0_1px_4px_rgba(34,44,66,0.08)]">
								{presentLabel(data.label)}
							</span>
						</div>
					) : null}
					{!data.readOnly ? (
						<div
							className={cn(
								"nodrag nopan absolute flex items-center gap-1 rounded-xl border border-[#e5e9f1] bg-white p-1 shadow-[0_8px_20px_rgba(34,44,66,0.12)] transition-opacity duration-150",
								hovered
									? "pointer-events-auto opacity-100"
									: "pointer-events-none opacity-0",
							)}
							style={{
								transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
							}}
							onMouseEnter={handleEnter}
							onMouseLeave={handleLeave}
						>
							<button
								type="button"
								onClick={() => data.onDeleteEdge(data.edgeIndex)}
								className="flex size-7 items-center justify-center rounded-lg text-[#f26a4b] transition hover:bg-[#fff4ef]"
								aria-label="Delete connection"
							>
								<Trash2 className="size-3.5" />
							</button>
							<AddStepMenu
								automationChannel={data.automationChannel}
								className="rounded-lg border-0 shadow-none hover:bg-[#f5f7fb]"
								label={data.label}
								onInsert={data.onInsertAfter}
								parentKey={data.parentKey}
								schema={data.schema}
								tone="edge"
							/>
						</div>
					) : null}
				</>
			</EdgeLabelRenderer>
		</>
	);
}

const nodeTypes = {
	stepCard: memo(StepFlowNode),
	triggerCard: memo(TriggerFlowNode),
};

const edgeTypes = {
	automation: memo(AutomationFlowEdge),
};

function FlowCanvasControls() {
	const reactFlow = useReactFlow();

	return (
		<Panel position="top-right" className="!right-4 !top-1/2 !-translate-y-1/2">
			<div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_14px_32px_rgba(15,23,42,0.08)]">
				<button
					type="button"
					onClick={() => reactFlow.zoomIn({ duration: 180 })}
					className="flex size-11 items-center justify-center border-b border-slate-200 text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"
					aria-label="Zoom in"
				>
					<ZoomIn className="size-4" />
				</button>
				<button
					type="button"
					onClick={() => reactFlow.zoomOut({ duration: 180 })}
					className="flex size-11 items-center justify-center border-b border-slate-200 text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"
					aria-label="Zoom out"
				>
					<ZoomOut className="size-4" />
				</button>
				<button
					type="button"
					onClick={() => reactFlow.fitView({ duration: 220, padding: 0.18 })}
					className="flex size-11 items-center justify-center text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"
					aria-label="Fit view"
				>
					<RefreshCw className="size-4" />
				</button>
			</div>
		</Panel>
	);
}

function GuidedFlowCanvas({
	automation,
	errorKeys,
	onAddTriggerRow,
	onDeleteEdge,
	highlightKeys,
	onDeleteNode,
	onInsertAfter,
	onMoveNode,
	onSelect,
	readOnly,
	schema,
	selectedKey,
}: Props) {
	const reactFlow = useReactFlow();
	const fitSignatureRef = useRef<string | null>(null);

	const schemaByType = useMemo(
		() => new Map(schema.nodes.map((node) => [node.type, node])),
		[schema.nodes],
	);
	const childrenByKey = useMemo(
		() => buildChildrenByKey(automation.edges),
		[automation.edges],
	);
	const autoPositions = useMemo(
		() => computeAutoPositions(automation, childrenByKey),
		[automation, childrenByKey],
	);

	const flowNodes = useMemo<Node<FlowCardData>[]>(() => {
		const nodes: Node<FlowCardData>[] = [
			{
				id: TRIGGER_ID,
				type: "triggerCard",
				position: resolveNodePosition(TRIGGER_ID, automation, autoPositions),
				data: {
					kind: "trigger",
					automation,
					automationChannel: automation.channel,
					connectedOutputs: (childrenByKey.get(TRIGGER_ID) ?? []).map(
						(entry) => entry.label,
					),
					hasError: errorKeys.has(TRIGGER_ID),
					highlighted: highlightKeys.has(TRIGGER_ID),
					onAddTriggerRow,
					onDeleteNode,
					onInsertAfter,
					onSelect,
					readOnly,
					schema,
				},
				draggable: !readOnly,
				selected: selectedKey === TRIGGER_ID,
				selectable: true,
			},
		];

		for (const node of automation.nodes) {
			if (node.key === TRIGGER_ID) continue;
			nodes.push({
				id: node.key,
				type: "stepCard",
				position: resolveNodePosition(node.key, automation, autoPositions),
				data: {
					kind: "step",
					automationChannel: automation.channel,
					connectedOutputs: (childrenByKey.get(node.key) ?? []).map(
						(entry) => entry.label,
					),
					def: schemaByType.get(node.type) ?? null,
					hasError: errorKeys.has(node.key),
					highlighted: highlightKeys.has(node.key),
					node,
					onAddTriggerRow,
					onDeleteNode,
					onInsertAfter,
					onSelect,
					readOnly,
					schema,
				},
				draggable: !readOnly,
				selected: selectedKey === node.key,
				selectable: true,
			});
		}

		return nodes;
	}, [
		autoPositions,
		automation,
		childrenByKey,
		errorKeys,
		highlightKeys,
		onDeleteNode,
		onAddTriggerRow,
		onInsertAfter,
		onSelect,
		readOnly,
		schema,
		schemaByType,
	]);

	const flowEdges = useMemo<Edge<FlowEdgeData>[]>(() => {
		return automation.edges.map((edge, index) => ({
			id: `${edge.from}:${edge.label ?? "next"}:${edge.to}:${index}`,
			source: edge.from,
			target: edge.to,
			type: "automation",
			data: {
				automationChannel: automation.channel,
				edgeIndex: index,
				label: edge.label ?? "next",
				onDeleteEdge,
				onInsertAfter,
				parentKey: edge.from,
				readOnly,
				schema,
			},
			markerEnd: {
				type: MarkerType.ArrowClosed,
				width: 18,
				height: 18,
				color: "#9aa7bd",
			},
			selectable: false,
		}));
	}, [
		automation.channel,
		automation.edges,
		onDeleteEdge,
		onInsertAfter,
		readOnly,
		schema,
	]);

	const [rfNodes, setRfNodes, onNodesChange] =
		useNodesState<FlowCardData>(flowNodes);
	const draggingRef = useRef(false);

	useEffect(() => {
		if (draggingRef.current) return;
		setRfNodes(flowNodes);
	}, [flowNodes, setRfNodes]);

	useEffect(() => {
		const signature = `${flowNodes.length}:${flowEdges.length}`;
		if (fitSignatureRef.current === signature) return;
		fitSignatureRef.current = signature;
		const frame = requestAnimationFrame(() => {
			reactFlow.fitView({ duration: 260, padding: 0.18 });
		});
		return () => cancelAnimationFrame(frame);
	}, [flowEdges.length, flowNodes.length, reactFlow]);

	return (
		<div className="h-full bg-[#f5f6fa]">
			<ReactFlow
				nodes={rfNodes}
				edges={flowEdges}
				onNodesChange={onNodesChange}
				nodeTypes={nodeTypes}
				edgeTypes={edgeTypes}
				onNodeClick={(_, node) => onSelect(node.id)}
				onNodeDragStart={() => {
					draggingRef.current = true;
				}}
				onNodeDragStop={(_, node) => {
					draggingRef.current = false;
					if (!onMoveNode) return;
					onMoveNode(node.id, node.position);
				}}
				onPaneClick={() => onSelect(null)}
				proOptions={{ hideAttribution: true }}
				fitView
				fitViewOptions={{ padding: 0.18 }}
				defaultEdgeOptions={{
					type: "automation",
				}}
				maxZoom={1.6}
				minZoom={0.3}
				nodesConnectable={false}
				nodesDraggable={!readOnly}
				selectNodesOnDrag={false}
				className="bg-transparent"
			>
				<FlowCanvasControls />
			</ReactFlow>
		</div>
	);
}

export function GuidedFlow(props: Props) {
	return (
		<ReactFlowProvider>
			<GuidedFlowCanvas {...props} />
		</ReactFlowProvider>
	);
}
