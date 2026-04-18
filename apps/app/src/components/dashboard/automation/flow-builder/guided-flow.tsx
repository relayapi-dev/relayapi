import { useMemo, useState } from "react";
import {
	AlertCircle,
	Bot,
	Box,
	ChevronDown,
	Clock,
	CornerDownRight,
	GitBranch,
	Globe,
	Keyboard,
	MessageSquare,
	Plus,
	Send,
	Shuffle,
	StopCircle,
	Tag,
	Trash2,
	Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
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

const CATEGORY_ACCENT: Record<string, { bg: string; text: string }> = {
	content: {
		bg: "bg-sky-50 dark:bg-sky-500/10",
		text: "text-sky-700 dark:text-sky-400",
	},
	input: {
		bg: "bg-violet-50 dark:bg-violet-500/10",
		text: "text-violet-700 dark:text-violet-400",
	},
	logic: {
		bg: "bg-amber-50 dark:bg-amber-500/10",
		text: "text-amber-700 dark:text-amber-400",
	},
	ops: {
		bg: "bg-neutral-100 dark:bg-neutral-500/15",
		text: "text-neutral-700 dark:text-neutral-300",
	},
	ai: {
		bg: "bg-fuchsia-50 dark:bg-fuchsia-500/10",
		text: "text-fuchsia-700 dark:text-fuchsia-400",
	},
	action: {
		bg: "bg-teal-50 dark:bg-teal-500/10",
		text: "text-teal-700 dark:text-teal-400",
	},
	platform_send: {
		bg: "bg-indigo-50 dark:bg-indigo-500/10",
		text: "text-indigo-700 dark:text-indigo-400",
	},
	flow: {
		bg: "bg-neutral-100 dark:bg-neutral-500/15",
		text: "text-neutral-700 dark:text-neutral-300",
	},
};

const TRIGGER_ACCENT = {
	bg: "bg-emerald-50 dark:bg-emerald-500/10",
	text: "text-emerald-700 dark:text-emerald-400",
};

function resolveIcon(nodeType: string, category: string) {
	if (nodeType === "goto") return CornerDownRight;
	if (nodeType === "end") return StopCircle;
	if (nodeType === "http_request") return Globe;
	if (nodeType === "randomizer" || nodeType === "split") return Shuffle;
	return CATEGORY_ICON[category] ?? Box;
}

function nodeSummary(spec: AutomationNodeSpec): string | undefined {
	if (typeof spec.text === "string") return spec.text as string;
	if (typeof spec.prompt === "string") return spec.prompt as string;
	if (typeof spec.when === "string") return spec.when as string;
	if (typeof spec.url === "string") return spec.url as string;
	if (typeof spec.tag === "string") return spec.tag as string;
	if (typeof spec.field === "string") return spec.field as string;
	if (typeof spec.target_node_key === "string")
		return `→ ${spec.target_node_key}`;
	if (typeof spec.duration_minutes === "number")
		return `${spec.duration_minutes} min`;
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
		() => new Map(automation.nodes.map((n) => [n.key, n])),
		[automation.nodes],
	);
	const schemaByType = useMemo(
		() => new Map(schema.nodes.map((n) => [n.type, n])),
		[schema.nodes],
	);
	const childrenByKey = useMemo(() => {
		const map = new Map<string, ChildLink[]>();
		for (const e of automation.edges) {
			const list = map.get(e.from) ?? [];
			list.push({ label: e.label ?? "next", target: e.to });
			map.set(e.from, list);
		}
		for (const list of map.values()) list.sort((a, b) => a.label.localeCompare(b.label));
		return map;
	}, [automation.edges]);

	// Sequential step numbering (trigger = 1, then each node in DFS order).
	// Zapier shows "1. Catch Hook", "2. Filter conditions", ... — we mirror that.
	const stepNumber = useMemo(() => {
		const map = new Map<string, number>();
		map.set("trigger", 1);
		let i = 2;
		const visited = new Set<string>(["trigger"]);
		const walk = (key: string) => {
			for (const c of childrenByKey.get(key) ?? []) {
				if (visited.has(c.target)) continue;
				visited.add(c.target);
				map.set(c.target, i++);
				walk(c.target);
			}
		};
		walk("trigger");
		return map;
	}, [childrenByKey]);

	// Detect orphaned nodes (no incoming edge and key !== 'trigger'). Rendered
	// at the bottom so the user can re-attach them.
	const orphans = useMemo(() => {
		const seen = new Set<string>(["trigger"]);
		const walk = (key: string) => {
			if (seen.has(key) && key !== "trigger") return;
			seen.add(key);
			for (const c of childrenByKey.get(key) ?? []) walk(c.target);
		};
		walk("trigger");
		return automation.nodes.filter((n) => !seen.has(n.key));
	}, [automation.nodes, childrenByKey]);

	return (
		<div className="h-full overflow-y-auto bg-muted/40">
			<div className="mx-auto max-w-xl px-6 py-10 space-y-0">
				<TriggerCard
					automation={automation}
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
							{orphans.map((n) => (
								<StepCard
									key={n.key}
									node={n}
									def={schemaByType.get(n.type) ?? null}
									selected={selectedKey === n.key}
									hasError={errorKeys.has(n.key)}
									onClick={() => onSelect(n.key)}
									onDelete={
										readOnly ? undefined : () => onDeleteNode(n.key)
									}
								/>
							))}
						</div>
					</div>
				)}
			</div>
		</div>
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
	automationChannel: string;
	readOnly?: boolean;
	visited: Set<string>;
	depth: number;
	stepNumber: Map<string, number>;
}) {
	const children = childrenByKey.get(parentKey) ?? [];

	// Single linear edge → render the next node inline
	if (children.length === 1 && !visited.has(children[0]!.target)) {
		const child = children[0]!;
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
					automationChannel={automationChannel}
					readOnly={readOnly}
					visited={nextVisited}
					depth={depth}
					stepNumber={stepNumber}
				/>
			</>
		);
	}

	// Multiple branches → render a split section. Each branch is its own chain.
	if (children.length > 1) {
		return (
			<>
				<Connector label="branches" />
				<div className="grid gap-3 md:grid-cols-2">
					{children.map((c) => (
						<BranchColumn
							key={`${c.label}->${c.target}`}
							branchLabel={c.label}
							parentKey={parentKey}
							firstChildKey={c.target}
							childrenByKey={childrenByKey}
							nodesByKey={nodesByKey}
							schemaByType={schemaByType}
							errorKeys={errorKeys}
							selectedKey={selectedKey}
							onSelect={onSelect}
							onInsertAfter={onInsertAfter}
							onDeleteNode={onDeleteNode}
							schema={schema}
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

	// No children (or only cycle targets) → show add-step button
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
	automationChannel,
	readOnly,
	visited,
	depth,
	stepNumber,
}: {
	branchLabel: string;
	parentKey: string;
	firstChildKey: string;
	childrenByKey: Map<string, ChildLink[]>;
	nodesByKey: Map<string, AutomationNodeSpec>;
	schemaByType: Map<string, SchemaNodeDef>;
	errorKeys: Set<string>;
	selectedKey: string | null;
	onSelect: (key: string | null) => void;
	onInsertAfter: (parentKey: string, label: string, nodeType: string) => void;
	onDeleteNode: (key: string) => void;
	schema: AutomationSchema;
	automationChannel: string;
	readOnly?: boolean;
	visited: Set<string>;
	depth: number;
	stepNumber: Map<string, number>;
}) {
	const node = nodesByKey.get(firstChildKey);
	const branchVisited = new Set(visited);
	if (node) branchVisited.add(firstChildKey);
	return (
		<div className="rounded-md border border-dashed border-border bg-background/60 px-3 py-3">
			<div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">
				{branchLabel}
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
	selected,
	onClick,
}: {
	automation: AutomationDetail;
	selected: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"w-full rounded-xl border border-border bg-card px-4 py-3.5 text-left shadow-sm transition-all hover:shadow-md hover:border-foreground/20",
				selected &&
					"border-emerald-500/60 ring-2 ring-emerald-500/20 shadow-md",
			)}
		>
			<div className="flex items-center justify-between gap-2">
				<span
					className={cn(
						"inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold uppercase tracking-wide",
						TRIGGER_ACCENT.bg,
						TRIGGER_ACCENT.text,
					)}
				>
					<Zap className="size-3.5" />
					Trigger
				</span>
				<span className="text-[11px] text-muted-foreground capitalize">
					{automation.channel}
				</span>
			</div>
			<div className="mt-2.5 text-[15px] font-medium leading-tight">
				<span className="text-muted-foreground mr-1.5">1.</span>
				{automation.trigger_type.replace(/_/g, " ")}
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
	return (
		<div className="group relative">
			<button
				type="button"
				onClick={onClick}
				className={cn(
					"w-full rounded-xl border border-border bg-card px-4 py-3.5 text-left shadow-sm transition-all hover:shadow-md hover:border-foreground/20",
					selected && "border-foreground/30 ring-2 ring-ring/30 shadow-md",
					hasError &&
						"border-destructive/50 ring-2 ring-destructive/20 hover:border-destructive/60",
				)}
			>
				<div className="flex items-center justify-between gap-2">
					<span
						className={cn(
							"inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold uppercase tracking-wide",
							accent.bg,
							accent.text,
						)}
					>
						<Icon className="size-3.5" />
						{node.type.replace(/_/g, " ")}
					</span>
					{hasError && (
						<span className="inline-flex items-center gap-1 text-[11px] font-medium text-destructive">
							<AlertCircle className="size-3" />
							error
						</span>
					)}
				</div>
				<div className="mt-2.5 text-[15px] font-medium leading-tight truncate">
					{index !== undefined && (
						<span className="text-muted-foreground mr-1.5">{index}.</span>
					)}
					{node.key}
				</div>
				{summary && (
					<div className="text-[12px] text-muted-foreground mt-1 line-clamp-2">
						{summary}
					</div>
				)}
			</button>
			{onDelete && (
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onDelete();
					}}
					className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 rounded-md p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
					aria-label="Delete step"
					title="Delete step"
				>
					<Trash2 className="size-3.5" />
				</button>
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
		for (const n of schema.nodes) {
			if (n.type === "trigger") continue;
			if (
				n.category === "platform_send" &&
				automationChannel !== "multi" &&
				!n.type.includes(automationChannel)
			) {
				continue;
			}
			const list = byCategory.get(n.category) ?? [];
			list.push(n);
			byCategory.set(n.category, list);
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
						After{" "}
						<span className="font-mono">{parentKey}</span>
						{label !== "next" && (
							<>
								{" "}on <span className="font-mono">{label}</span>
							</>
						)}
					</div>
				</div>
				<div className="py-1">
					{CATEGORY_ORDER.filter((c) => grouped.has(c)).map((category) => {
						const list = grouped.get(category) ?? [];
						const Icon = CATEGORY_ICON[category] ?? Box;
						const accent = CATEGORY_ACCENT[category] ?? CATEGORY_ACCENT.ops!;
						return (
							<div key={category}>
								<div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
									{CATEGORY_LABEL[category] ?? category}
								</div>
								<ul>
									{list.map((def) => (
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
													{def.type.replace(/_/g, " ")}
												</span>
											</button>
										</li>
									))}
								</ul>
							</div>
						);
					})}
				</div>
			</PopoverContent>
		</Popover>
	);
}
