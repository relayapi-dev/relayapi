import { useMemo, useState } from "react";
import {
	AlertCircle,
	ArrowRight,
	Bot,
	Box,
	ChevronDown,
	Clock,
	CornerDownRight,
	GitBranch,
	Globe,
	Keyboard,
	MessageSquare,
	MoreHorizontal,
	Plus,
	Send,
	Shuffle,
	StopCircle,
	Tag,
	Zap,
} from "lucide-react";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { resolveNodeOutputLabels, resolveSourceOutputLabels } from "./output-labels";
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
	action: "Actions",
	ops: "Ops",
	platform_send: "Platform sends",
	flow: "Flow control",
};

const CATEGORY_ICON: Record<string, typeof Box> = {
	content: MessageSquare,
	input: Keyboard,
	logic: GitBranch,
	ops: Clock,
	ai: Bot,
	action: Tag,
	platform_send: Send,
	flow: CornerDownRight,
};

const CATEGORY_ACCENT: Record<string, { bg: string; text: string; border: string }> = {
	content: {
		bg: "bg-sky-50 dark:bg-sky-500/10",
		text: "text-sky-700 dark:text-sky-400",
		border: "border-sky-200/80 dark:border-sky-500/20",
	},
	input: {
		bg: "bg-violet-50 dark:bg-violet-500/10",
		text: "text-violet-700 dark:text-violet-400",
		border: "border-violet-200/80 dark:border-violet-500/20",
	},
	logic: {
		bg: "bg-amber-50 dark:bg-amber-500/10",
		text: "text-amber-700 dark:text-amber-400",
		border: "border-amber-200/80 dark:border-amber-500/20",
	},
	ops: {
		bg: "bg-neutral-100 dark:bg-neutral-500/15",
		text: "text-neutral-700 dark:text-neutral-300",
		border: "border-neutral-200/80 dark:border-neutral-500/20",
	},
	ai: {
		bg: "bg-fuchsia-50 dark:bg-fuchsia-500/10",
		text: "text-fuchsia-700 dark:text-fuchsia-400",
		border: "border-fuchsia-200/80 dark:border-fuchsia-500/20",
	},
	action: {
		bg: "bg-teal-50 dark:bg-teal-500/10",
		text: "text-teal-700 dark:text-teal-400",
		border: "border-teal-200/80 dark:border-teal-500/20",
	},
	platform_send: {
		bg: "bg-indigo-50 dark:bg-indigo-500/10",
		text: "text-indigo-700 dark:text-indigo-400",
		border: "border-indigo-200/80 dark:border-indigo-500/20",
	},
	flow: {
		bg: "bg-neutral-100 dark:bg-neutral-500/15",
		text: "text-neutral-700 dark:text-neutral-300",
		border: "border-neutral-200/80 dark:border-neutral-500/20",
	},
};

const TRIGGER_ACCENT = {
	bg: "bg-emerald-50 dark:bg-emerald-500/10",
	text: "text-emerald-700 dark:text-emerald-400",
	border: "border-emerald-200/80 dark:border-emerald-500/20",
};

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
	message_text: "Send text message",
	message_media: "Send media message",
	message_file: "Send file",
	condition: "Condition",
	smart_delay: "Delay",
	randomizer: "Randomizer",
	http_request: "HTTP request",
	goto: "Go to step",
	end: "End automation",
	tag_add: "Add tag",
	tag_remove: "Remove tag",
	field_set: "Set field",
	field_clear: "Clear field",
};

const TRIGGER_OPERATION_OVERRIDES: Record<string, string> = {
	instagram_comment: "New comment",
	facebook_comment: "New comment",
	instagram_dm: "New direct message",
	facebook_dm: "New message",
	whatsapp_message: "New WhatsApp message",
	telegram_message: "New Telegram message",
	sms_received: "New SMS",
	manual: "Manual start",
	external_api: "External API event",
};

function titleize(value: string): string {
	return value
		.split("_")
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function resolveIcon(nodeType: string, category: string) {
	if (nodeType === "goto") return CornerDownRight;
	if (nodeType === "end") return StopCircle;
	if (nodeType === "http_request") return Globe;
	if (nodeType === "randomizer" || nodeType === "split") return Shuffle;
	return CATEGORY_ICON[category] ?? Box;
}

function describeNodePresentation(nodeType: string, category: string) {
	const [prefix, ...rest] = nodeType.split("_");
	if (NODE_OPERATION_OVERRIDES[nodeType]) {
		const app =
			nodeType.startsWith("message_")
				? "Messaging"
				: nodeType.startsWith("user_input_")
					? "Input"
					: category === "logic"
						? "Logic"
						: category === "action"
							? "Contacts"
							: category === "ops"
								? "Operations"
								: titleize(category);
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
		return { app: "Input", operation: `Collect ${titleize(nodeType.slice(11))}` };
	}
	return {
		app:
			category === "logic"
				? "Logic"
				: category === "action"
					? "Contacts"
					: category === "ops"
						? "Operations"
						: titleize(category),
		operation: titleize(nodeType),
	};
}

function nodeSummary(spec: AutomationNodeSpec): string | undefined {
	if (typeof spec.text === "string") return spec.text as string;
	if (typeof spec.prompt === "string") return spec.prompt as string;
	if (typeof spec.when === "string") return spec.when as string;
	if (typeof spec.url === "string") return spec.url as string;
	if (typeof spec.tag === "string") return spec.tag as string;
	if (typeof spec.field === "string") return spec.field as string;
	if (typeof spec.target_node_key === "string") {
		return `Go to ${spec.target_node_key}`;
	}
	if (typeof spec.duration_minutes === "number") {
		return `${spec.duration_minutes} min`;
	}
	return undefined;
}

interface ChildLink {
	label: string;
	target: string;
}

interface Props {
	automation: AutomationDetail;
	schema: AutomationSchema;
	errorKeys: Set<string>;
	selectedKey: string | null;
	onSelect: (key: string | null) => void;
	onInsertAfter: (parentKey: string, label: string, nodeType: string) => void;
	onDeleteNode: (key: string) => void;
	readOnly?: boolean;
}

export function GuidedFlow({
	automation,
	schema,
	errorKeys,
	selectedKey,
	onSelect,
	onInsertAfter,
	onDeleteNode,
	readOnly,
}: Props) {
	const nodesByKey = useMemo(
		() => new Map(automation.nodes.map((node) => [node.key, node])),
		[automation.nodes],
	);
	const schemaByType = useMemo(
		() => new Map(schema.nodes.map((node) => [node.type, node])),
		[schema.nodes],
	);
	const childrenByKey = useMemo(() => {
		const map = new Map<string, ChildLink[]>();
		for (const edge of automation.edges) {
			const list = map.get(edge.from) ?? [];
			list.push({ label: edge.label ?? "next", target: edge.to });
			map.set(edge.from, list);
		}
		for (const list of map.values()) {
			list.sort((a, b) => a.label.localeCompare(b.label));
		}
		return map;
	}, [automation.edges]);

	const stepNumber = useMemo(() => {
		const map = new Map<string, number>();
		map.set("trigger", 1);
		let index = 2;
		const visited = new Set<string>(["trigger"]);
		const walk = (key: string) => {
			for (const child of childrenByKey.get(key) ?? []) {
				if (visited.has(child.target)) continue;
				visited.add(child.target);
				map.set(child.target, index++);
				walk(child.target);
			}
		};
		walk("trigger");
		return map;
	}, [childrenByKey]);

	const orphans = useMemo(() => {
		const seen = new Set<string>(["trigger"]);
		const walk = (key: string) => {
			if (seen.has(key) && key !== "trigger") return;
			seen.add(key);
			for (const child of childrenByKey.get(key) ?? []) {
				walk(child.target);
			}
		};
		walk("trigger");
		return automation.nodes.filter((node) => !seen.has(node.key));
	}, [automation.nodes, childrenByKey]);

	return (
		<ScrollArea className="h-full bg-muted/40">
			<div className="mx-auto max-w-2xl px-6 py-10 space-y-0">
				<TriggerCard
					automation={automation}
					hasError={errorKeys.has("trigger")}
					selected={selectedKey === "trigger"}
					onClick={() => onSelect("trigger")}
				/>
				<ChainRenderer
					parentKey="trigger"
					childrenByKey={childrenByKey}
					nodesByKey={nodesByKey}
					schemaByType={schemaByType}
					errorKeys={errorKeys}
					selectedKey={selectedKey}
					onSelect={onSelect}
					onInsertAfter={onInsertAfter}
					onDeleteNode={onDeleteNode}
					schema={schema}
					automationTriggerType={automation.trigger_type}
					automationChannel={automation.channel}
					readOnly={readOnly}
					visited={new Set(["trigger"])}
					depth={0}
					stepNumber={stepNumber}
				/>

				{orphans.length > 0 && (
					<div className="mt-10 pt-6 border-t border-border">
						<p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">
							Unreachable nodes
						</p>
						<div className="space-y-2">
							{orphans.map((node) => (
								<StepCard
									key={node.key}
									node={node}
									def={schemaByType.get(node.type) ?? null}
									selected={selectedKey === node.key}
									hasError={errorKeys.has(node.key)}
									onClick={() => onSelect(node.key)}
									onDelete={readOnly ? undefined : () => onDeleteNode(node.key)}
								/>
							))}
						</div>
					</div>
				)}
			</div>
		</ScrollArea>
	);
}

function ChainRenderer({
	parentKey,
	parentEdgeLabel,
	childrenByKey,
	nodesByKey,
	schemaByType,
	errorKeys,
	selectedKey,
	onSelect,
	onInsertAfter,
	onDeleteNode,
	schema,
	automationTriggerType,
	automationChannel,
	readOnly,
	visited,
	depth,
	stepNumber,
}: {
	parentKey: string;
	parentEdgeLabel?: string;
	childrenByKey: Map<string, ChildLink[]>;
	nodesByKey: Map<string, AutomationNodeSpec>;
	schemaByType: Map<string, SchemaNodeDef>;
	errorKeys: Set<string>;
	selectedKey: string | null;
	onSelect: (key: string | null) => void;
	onInsertAfter: (parentKey: string, label: string, nodeType: string) => void;
	onDeleteNode: (key: string) => void;
	schema: AutomationSchema;
	automationTriggerType: string;
	automationChannel: string;
	readOnly?: boolean;
	visited: Set<string>;
	depth: number;
	stepNumber: Map<string, number>;
}) {
	const children = childrenByKey.get(parentKey) ?? [];
	const visibleChildren = children.filter((child) => !visited.has(child.target));
	const expectedOutputs =
		resolveSourceOutputLabels(
			parentKey,
			nodesByKey,
			schemaByType,
			schema.triggers.find((trigger) => trigger.type === automationTriggerType) ?? null,
		);

	if (expectedOutputs.length > 1) {
		const branchLabels = Array.from(
			new Set([...expectedOutputs, ...visibleChildren.map((child) => child.label)]),
		);
		return (
			<>
				<Connector label="branches" />
				<div
					className={cn(
						"grid gap-3",
						branchLabels.length >= 3 ? "md:grid-cols-2 xl:grid-cols-3" : "md:grid-cols-2",
					)}
				>
					{branchLabels.map((label) => {
						const child = visibleChildren.find((entry) => entry.label === label);
						return (
							<BranchColumn
								key={`${parentKey}:${label}`}
								branchLabel={label}
								parentKey={parentKey}
								firstChildKey={child?.target}
								childrenByKey={childrenByKey}
								nodesByKey={nodesByKey}
								schemaByType={schemaByType}
								errorKeys={errorKeys}
								selectedKey={selectedKey}
								onSelect={onSelect}
								onInsertAfter={onInsertAfter}
								onDeleteNode={onDeleteNode}
								schema={schema}
								automationTriggerType={automationTriggerType}
								automationChannel={automationChannel}
								readOnly={readOnly}
								visited={visited}
								depth={depth + 1}
								stepNumber={stepNumber}
							/>
						);
					})}
				</div>
			</>
		);
	}

	if (visibleChildren.length === 1) {
		const child = visibleChildren[0]!;
		const node = nodesByKey.get(child.target);
		if (!node) return null;
		const nextVisited = new Set(visited);
		nextVisited.add(child.target);
		return (
			<>
				<Connector label={child.label === "next" ? undefined : child.label} />
				{!readOnly && (
					<>
						<AddStepButton
							parentKey={parentKey}
							label={child.label}
							schema={schema}
							automationChannel={automationChannel}
							onInsert={onInsertAfter}
							tone="inline"
						/>
						<Connector />
					</>
				)}
				<StepCard
					node={node}
					def={schemaByType.get(node.type) ?? null}
					index={stepNumber.get(node.key)}
					selected={selectedKey === node.key}
					hasError={errorKeys.has(node.key)}
					onClick={() => onSelect(node.key)}
					onDelete={readOnly ? undefined : () => onDeleteNode(node.key)}
				/>
				<ChainRenderer
					parentKey={node.key}
					childrenByKey={childrenByKey}
					nodesByKey={nodesByKey}
					schemaByType={schemaByType}
					errorKeys={errorKeys}
					selectedKey={selectedKey}
					onSelect={onSelect}
					onInsertAfter={onInsertAfter}
					onDeleteNode={onDeleteNode}
					schema={schema}
					automationTriggerType={automationTriggerType}
					automationChannel={automationChannel}
					readOnly={readOnly}
					visited={nextVisited}
					depth={depth}
					stepNumber={stepNumber}
				/>
			</>
		);
	}

	if (visibleChildren.length > 1) {
		return (
			<>
				<Connector label="branches" />
				<div className="grid gap-3 md:grid-cols-2">
					{visibleChildren.map((child) => (
						<BranchColumn
							key={`${child.label}->${child.target}`}
							branchLabel={child.label}
							parentKey={parentKey}
							firstChildKey={child.target}
							childrenByKey={childrenByKey}
							nodesByKey={nodesByKey}
							schemaByType={schemaByType}
							errorKeys={errorKeys}
							selectedKey={selectedKey}
							onSelect={onSelect}
							onInsertAfter={onInsertAfter}
							onDeleteNode={onDeleteNode}
							schema={schema}
							automationTriggerType={automationTriggerType}
							automationChannel={automationChannel}
							readOnly={readOnly}
							visited={visited}
							depth={depth + 1}
							stepNumber={stepNumber}
						/>
					))}
				</div>
			</>
		);
	}

	if (!readOnly) {
		const addLabel = parentEdgeLabel ?? "next";
		return (
			<>
				<Connector />
				<AddStepButton
					parentKey={parentKey}
					label={addLabel}
					schema={schema}
					automationChannel={automationChannel}
					onInsert={onInsertAfter}
					tone="end"
				/>
			</>
		);
	}

	return null;
}

function BranchColumn({
	branchLabel,
	parentKey,
	firstChildKey,
	childrenByKey,
	nodesByKey,
	schemaByType,
	errorKeys,
	selectedKey,
	onSelect,
	onInsertAfter,
	onDeleteNode,
	schema,
	automationTriggerType,
	automationChannel,
	readOnly,
	visited,
	depth,
	stepNumber,
}: {
	branchLabel: string;
	parentKey: string;
	firstChildKey?: string;
	childrenByKey: Map<string, ChildLink[]>;
	nodesByKey: Map<string, AutomationNodeSpec>;
	schemaByType: Map<string, SchemaNodeDef>;
	errorKeys: Set<string>;
	selectedKey: string | null;
	onSelect: (key: string | null) => void;
	onInsertAfter: (parentKey: string, label: string, nodeType: string) => void;
	onDeleteNode: (key: string) => void;
	schema: AutomationSchema;
	automationTriggerType: string;
	automationChannel: string;
	readOnly?: boolean;
	visited: Set<string>;
	depth: number;
	stepNumber: Map<string, number>;
}) {
	const node = firstChildKey ? nodesByKey.get(firstChildKey) : undefined;
	const branchVisited = new Set(visited);
	if (node) branchVisited.add(firstChildKey!);
	return (
		<div className="rounded-xl border border-dashed border-border bg-background/70 px-3 py-3">
			<div className="mb-2 flex items-center justify-between gap-2">
				<div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
					{branchLabel}
				</div>
				<span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
					Output
				</span>
			</div>
			{!node && !readOnly && (
				<AddStepButton
					parentKey={parentKey}
					label={branchLabel}
					schema={schema}
					automationChannel={automationChannel}
					onInsert={onInsertAfter}
					tone="end"
				/>
			)}
			{node && (
				<>
					<StepCard
						node={node}
						def={schemaByType.get(node.type) ?? null}
						index={stepNumber.get(node.key)}
						selected={selectedKey === node.key}
						hasError={errorKeys.has(node.key)}
						onClick={() => onSelect(node.key)}
						onDelete={readOnly ? undefined : () => onDeleteNode(node.key)}
					/>
					<ChainRenderer
						parentKey={node.key}
						childrenByKey={childrenByKey}
						nodesByKey={nodesByKey}
						schemaByType={schemaByType}
						errorKeys={errorKeys}
						selectedKey={selectedKey}
						onSelect={onSelect}
						onInsertAfter={onInsertAfter}
						onDeleteNode={onDeleteNode}
						schema={schema}
						automationTriggerType={automationTriggerType}
						automationChannel={automationChannel}
						readOnly={readOnly}
						visited={branchVisited}
						depth={depth}
						stepNumber={stepNumber}
					/>
				</>
			)}
		</div>
	);
}

function Connector({ label }: { label?: string }) {
	return (
		<div className="flex flex-col items-center py-1">
			<div className="w-px h-4 bg-border" />
			{label && (
				<span className="my-0.5 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
					{label}
				</span>
			)}
			<div className="w-px h-4 bg-border" />
		</div>
	);
}

function TriggerCard({
	automation,
	hasError,
	selected,
	onClick,
}: {
	automation: AutomationDetail;
	hasError: boolean;
	selected: boolean;
	onClick: () => void;
}) {
	const channelLabel =
		PLATFORM_LABELS[automation.channel] ?? titleize(automation.channel);
	const operation =
		TRIGGER_OPERATION_OVERRIDES[automation.trigger_type] ??
		titleize(
			automation.trigger_type.replace(
				new RegExp(`^${automation.channel}_`),
				"",
			),
		);

	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"w-full rounded-2xl border border-border/80 bg-card px-4 py-4 text-left shadow-sm transition-all hover:shadow-md hover:border-foreground/20",
				selected &&
					"border-emerald-500/60 ring-2 ring-emerald-500/20 shadow-md",
				hasError &&
					"border-destructive/50 ring-2 ring-destructive/20 hover:border-destructive/60",
			)}
		>
			<div className="flex items-start gap-3">
				<div
					className={cn(
						"mt-0.5 flex size-10 items-center justify-center rounded-xl border",
						TRIGGER_ACCENT.bg,
						TRIGGER_ACCENT.text,
						TRIGGER_ACCENT.border,
					)}
				>
					<Zap className="size-4" />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex items-center justify-between gap-2">
						<div className="text-[11px] font-medium text-muted-foreground">
							{channelLabel}
						</div>
						<div className="flex items-center gap-1.5">
							{hasError && (
								<span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
									<AlertCircle className="size-3" />
									Error
								</span>
							)}
							<span
								className={cn(
									"inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold uppercase tracking-wide",
									TRIGGER_ACCENT.bg,
									TRIGGER_ACCENT.text,
								)}
							>
								Trigger
							</span>
						</div>
					</div>
					<div className="mt-1 text-[15px] font-semibold leading-tight">
						<span className="text-muted-foreground mr-1.5">1.</span>
						{operation}
					</div>
					<div className="mt-1 text-[11px] text-muted-foreground font-mono">
						{automation.trigger_type}
					</div>
				</div>
			</div>
		</button>
	);
}

function StepCard({
	node,
	def,
	index,
	selected,
	hasError,
	onClick,
	onDelete,
}: {
	node: AutomationNodeSpec;
	def: SchemaNodeDef | null;
	index?: number;
	selected: boolean;
	hasError: boolean;
	onClick: () => void;
	onDelete?: () => void;
}) {
	const category = def?.category ?? "ops";
	const Icon = resolveIcon(node.type, category);
	const accent = CATEGORY_ACCENT[category] ?? CATEGORY_ACCENT.ops!;
	const summary = nodeSummary(node);
	const outputs = resolveNodeOutputLabels(node, def);
	const presentation = describeNodePresentation(node.type, category);

	return (
		<div
			className={cn(
				"relative rounded-2xl border border-border/80 bg-card shadow-sm transition-all hover:shadow-md hover:border-foreground/20",
				selected && "border-foreground/30 ring-2 ring-ring/30 shadow-md",
				hasError &&
					"border-destructive/50 ring-2 ring-destructive/20 hover:border-destructive/60",
			)}
		>
			<button
				type="button"
				onClick={onClick}
				className="w-full px-4 py-4 pr-12 text-left"
			>
				<div className="flex items-start gap-3">
					<div
						className={cn(
							"mt-0.5 flex size-10 items-center justify-center rounded-xl border",
							accent.bg,
							accent.text,
							accent.border,
						)}
					>
						<Icon className="size-4" />
					</div>
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2">
							<div className="text-[11px] font-medium text-muted-foreground">
								{presentation.app}
							</div>
							{hasError && (
								<span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
									<AlertCircle className="size-3" />
									Error
								</span>
							)}
						</div>
						<div className="mt-1 text-[15px] font-semibold leading-tight truncate">
							{index !== undefined && (
								<span className="text-muted-foreground mr-1.5">{index}.</span>
							)}
							{presentation.operation}
						</div>
						<div className="mt-1 text-[11px] text-muted-foreground font-mono truncate">
							{node.key}
						</div>
						{summary && (
							<div className="mt-2 text-[12px] text-muted-foreground line-clamp-2">
								{summary}
							</div>
						)}
						{outputs.length > 1 && (
							<div className="mt-3 flex flex-wrap items-center gap-1.5">
								{outputs.map((output) => (
									<span
										key={output}
										className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
									>
										{output}
										<ArrowRight className="size-3" />
									</span>
								))}
							</div>
						)}
					</div>
				</div>
			</button>
			{onDelete && (
				<div className="absolute right-3 top-3">
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								onClick={(event) => event.stopPropagation()}
								className="rounded-md p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
								aria-label="Step actions"
							>
								<MoreHorizontal className="size-3.5" />
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-40">
							<DropdownMenuItem
								onClick={(event) => {
									event.stopPropagation();
									onDelete();
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

function AddStepButton({
	parentKey,
	label,
	schema,
	automationChannel,
	onInsert,
	tone,
}: {
	parentKey: string;
	label: string;
	schema: AutomationSchema;
	automationChannel: string;
	onInsert: (parentKey: string, label: string, nodeType: string) => void;
	tone: "inline" | "end";
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
	}, [schema, automationChannel]);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				{tone === "inline" ? (
					<button
						type="button"
						aria-label="Add step"
						title="Add step"
						className="mx-auto my-1 flex size-7 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm hover:border-foreground hover:text-foreground hover:shadow-md transition-all"
					>
						<Plus className="size-3.5" />
					</button>
				) : (
					<button
						type="button"
						className="mx-auto mt-3 flex items-center gap-2 rounded-lg border border-dashed border-border bg-background px-4 py-2 text-xs font-medium text-muted-foreground shadow-sm hover:border-foreground hover:text-foreground hover:shadow-md transition-all"
					>
						<Plus className="size-3.5" />
						Add step
						<ChevronDown className="size-3.5" />
					</button>
				)}
			</PopoverTrigger>
			<PopoverContent
				align="center"
				sideOffset={6}
				className="w-72 p-0 max-h-96 overflow-y-auto"
			>
				<div className="px-3 py-2 border-b border-border">
					<div className="text-xs font-medium">Add step</div>
					<div className="text-[10px] text-muted-foreground mt-0.5">
						After <span className="font-mono">{parentKey}</span>
						{label !== "next" && (
							<>
								{" "}on <span className="font-mono">{label}</span>
							</>
						)}
					</div>
				</div>
				<div className="py-1">
					{CATEGORY_ORDER.filter((category) => grouped.has(category)).map((category) => {
						const list = grouped.get(category) ?? [];
						return (
							<div key={category}>
								<div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
									{CATEGORY_LABEL[category] ?? category}
								</div>
								<ul>
									{list.map((def) => {
										const Icon = CATEGORY_ICON[category] ?? Box;
										const accent = CATEGORY_ACCENT[category] ?? CATEGORY_ACCENT.ops!;
										return (
											<li key={def.type}>
												<button
													type="button"
													onClick={() => {
														onInsert(parentKey, label, def.type);
														setOpen(false);
													}}
													className="w-full px-3 py-1.5 text-left text-xs hover:bg-accent/40 flex items-center gap-2"
												>
													<Icon className={cn("size-3.5", accent.text)} />
													<span className="truncate">
														{describeNodePresentation(def.type, def.category).operation}
													</span>
												</button>
											</li>
										);
									})}
								</ul>
							</div>
						);
					})}
				</div>
			</PopoverContent>
		</Popover>
	);
}
