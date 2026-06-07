// Shared binding config editors + per-type descriptors.
//
// Single source of truth for the config UI, validation, and copy of each
// binding type. Consumed by BOTH surfaces:
//   - the per-account Connections tabs (account fixed, pick an automation), and
//   - the canvas binding detail panel (automation fixed, pick an account).
//
// The rich menu / starter / ice-breaker editors used to live inside the
// per-type tab files; they were lifted here so the canvas can mount the exact
// same UI without duplicating it. The tab files are now thin wrappers over
// this registry.

import { ChevronDown, ChevronRight, ChevronUp, Plus, Trash2 } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
	ICE_BREAKER_MAX_ITEMS,
	ICE_BREAKER_QUESTION_MAX,
	MAIN_MENU_LABEL_MAX,
	MAIN_MENU_MAX_DEPTH,
	MAIN_MENU_MAX_TOP_LEVEL_ITEMS,
	STARTER_LABEL_MAX,
	STARTER_MAX_ITEMS,
	validateConversationStarters,
	validateIceBreakers,
	validateMainMenuItems,
	type BindingType,
	type ConversationStarter,
	type IceBreakerQuestion,
	type MainMenuItem,
} from "./types";

// ---------------------------------------------------------------------------
// Config shapes + parsers (moved verbatim from the per-type tab files)
// ---------------------------------------------------------------------------

export interface MainMenuConfig {
	items: MainMenuItem[];
}

export function parseMainMenuConfig(raw: unknown): MainMenuConfig {
	if (!raw || typeof raw !== "object") return { items: [] };
	const r = raw as { items?: unknown };
	if (!Array.isArray(r.items)) return { items: [] };
	return {
		items: r.items.filter(
			(i): i is MainMenuItem =>
				!!i &&
				typeof i === "object" &&
				typeof (i as MainMenuItem).label === "string",
		),
	};
}

export interface ConversationStarterConfig {
	starters: ConversationStarter[];
}

export function parseConversationStarterConfig(
	raw: unknown,
): ConversationStarterConfig {
	if (!raw || typeof raw !== "object") return { starters: [] };
	const r = raw as { starters?: unknown };
	if (!Array.isArray(r.starters)) return { starters: [] };
	return {
		starters: r.starters.filter(
			(s): s is ConversationStarter =>
				!!s &&
				typeof s === "object" &&
				typeof (s as ConversationStarter).label === "string",
		),
	};
}

export interface IceBreakerConfig {
	questions: IceBreakerQuestion[];
}

export function parseIceBreakerConfig(raw: unknown): IceBreakerConfig {
	if (!raw || typeof raw !== "object") return { questions: [] };
	const r = raw as { questions?: unknown };
	if (!Array.isArray(r.questions)) return { questions: [] };
	return {
		questions: r.questions.filter(
			(q): q is IceBreakerQuestion =>
				!!q &&
				typeof q === "object" &&
				typeof (q as IceBreakerQuestion).question === "string",
		),
	};
}

// ---------------------------------------------------------------------------
// Main-menu editor (nested item tree)
// ---------------------------------------------------------------------------

interface MenuEditorProps {
	items: MainMenuItem[];
	setItems: (items: MainMenuItem[]) => void;
}

export function MainMenuEditor({ items, setItems }: MenuEditorProps) {
	const addItem = () => {
		setItems([...items, { label: "", action: "postback", payload: "" }]);
	};

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<label className="text-[11px] font-medium text-muted-foreground">
					Menu items ({items.length}/{MAIN_MENU_MAX_TOP_LEVEL_ITEMS})
				</label>
				<Button
					type="button"
					size="sm"
					variant="outline"
					className="h-7 gap-1 text-xs"
					disabled={items.length >= MAIN_MENU_MAX_TOP_LEVEL_ITEMS}
					onClick={addItem}
				>
					<Plus className="size-3" />
					Add item
				</Button>
			</div>

			{items.length === 0 ? (
				<p className="rounded-md border border-dashed border-border bg-background/50 px-3 py-4 text-center text-[11px] text-muted-foreground">
					No menu items yet. Add up to {MAIN_MENU_MAX_TOP_LEVEL_ITEMS}.
				</p>
			) : (
				<div className="space-y-2">
					{items.map((item, idx) => (
						<MenuItemEditor
							key={idx}
							item={item}
							depth={1}
							onChange={(next) => {
								const copy = [...items];
								copy[idx] = next;
								setItems(copy);
							}}
							onRemove={() => setItems(items.filter((_, i) => i !== idx))}
						/>
					))}
				</div>
			)}
		</div>
	);
}

interface MenuItemEditorProps {
	item: MainMenuItem;
	depth: number;
	onChange: (next: MainMenuItem) => void;
	onRemove: () => void;
}

function MenuItemEditor({ item, depth, onChange, onRemove }: MenuItemEditorProps) {
	const subItems = useMemo(() => item.sub_items ?? [], [item.sub_items]);
	const canNest = depth < MAIN_MENU_MAX_DEPTH;

	const update = (patch: Partial<MainMenuItem>) => onChange({ ...item, ...patch });

	const addSubItem = () => {
		update({
			sub_items: [...subItems, { label: "", action: "postback", payload: "" }],
		});
	};

	return (
		<div
			className="rounded-md border border-border bg-background/70 p-2.5 space-y-2"
			style={{ marginLeft: depth > 1 ? `${(depth - 1) * 12}px` : undefined }}
		>
			<div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
				{subItems.length > 0 ? (
					<ChevronDown className="size-3" />
				) : (
					<ChevronRight className="size-3" />
				)}
				Level {depth}
				<button
					type="button"
					onClick={onRemove}
					className="ml-auto text-muted-foreground hover:text-destructive"
					title="Remove item"
				>
					<Trash2 className="size-3" />
				</button>
			</div>

			<div className="grid grid-cols-2 gap-2">
				<div>
					<label className="text-[10px] text-muted-foreground">
						Label (max {MAIN_MENU_LABEL_MAX})
					</label>
					<input
						type="text"
						value={item.label}
						maxLength={MAIN_MENU_LABEL_MAX}
						onChange={(e) => update({ label: e.target.value })}
						placeholder="e.g. Shop now"
						className="mt-0.5 h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
					/>
				</div>
				<div>
					<label className="text-[10px] text-muted-foreground">Action</label>
					<select
						value={item.action}
						onChange={(e) =>
							update({ action: e.target.value as "postback" | "url" })
						}
						className="mt-0.5 h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
					>
						<option value="postback">Postback (trigger automation)</option>
						<option value="url">URL (open link)</option>
					</select>
				</div>
			</div>

			<div>
				<label className="text-[10px] text-muted-foreground">
					{item.action === "url" ? "URL" : "Payload"}
				</label>
				<input
					type="text"
					value={item.payload}
					onChange={(e) => update({ payload: e.target.value })}
					placeholder={item.action === "url" ? "https://example.com" : "MENU_SHOP"}
					className="mt-0.5 h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
				/>
			</div>

			{canNest && (
				<div className="mt-1 space-y-1.5">
					<div className="flex items-center justify-between">
						<label className="text-[10px] text-muted-foreground">
							Sub-items ({subItems.length})
						</label>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							className="h-6 gap-1 px-1.5 text-[10px]"
							onClick={addSubItem}
						>
							<Plus className="size-3" />
							Add sub-item
						</Button>
					</div>
					{subItems.map((child, idx) => (
						<MenuItemEditor
							key={idx}
							item={child}
							depth={depth + 1}
							onChange={(next) => {
								const copy = [...subItems];
								copy[idx] = next;
								update({ sub_items: copy });
							}}
							onRemove={() => {
								const copy = subItems.filter((_, i) => i !== idx);
								update({ sub_items: copy.length ? copy : undefined });
							}}
						/>
					))}
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Conversation-starter editor (flat list, reorderable)
// ---------------------------------------------------------------------------

interface StarterEditorProps {
	starters: ConversationStarter[];
	setStarters: (next: ConversationStarter[]) => void;
}

export function ConversationStarterEditor({
	starters,
	setStarters,
}: StarterEditorProps) {
	const move = (idx: number, dir: -1 | 1) => {
		const next = [...starters];
		const swap = idx + dir;
		if (swap < 0 || swap >= next.length) return;
		[next[idx], next[swap]] = [next[swap]!, next[idx]!];
		setStarters(next);
	};

	const update = (idx: number, patch: Partial<ConversationStarter>) => {
		const next = [...starters];
		next[idx] = { ...next[idx]!, ...patch };
		setStarters(next);
	};

	const add = () => {
		setStarters([...starters, { label: "", payload: "" }]);
	};

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<label className="text-[11px] font-medium text-muted-foreground">
					Starters ({starters.length}/{STARTER_MAX_ITEMS})
				</label>
				<Button
					type="button"
					size="sm"
					variant="outline"
					className="h-7 gap-1 text-xs"
					disabled={starters.length >= STARTER_MAX_ITEMS}
					onClick={add}
				>
					<Plus className="size-3" />
					Add starter
				</Button>
			</div>

			{starters.length === 0 ? (
				<p className="rounded-md border border-dashed border-border bg-background/50 px-3 py-4 text-center text-[11px] text-muted-foreground">
					No starters yet. Add up to {STARTER_MAX_ITEMS}.
				</p>
			) : (
				<div className="space-y-2">
					{starters.map((s, idx) => (
						<div
							key={idx}
							className="rounded-md border border-border bg-background/70 p-2.5 space-y-2"
						>
							<div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
								<span>#{idx + 1}</span>
								<button
									type="button"
									disabled={idx === 0}
									onClick={() => move(idx, -1)}
									className="ml-auto text-muted-foreground hover:text-foreground disabled:opacity-40"
									title="Move up"
								>
									<ChevronUp className="size-3" />
								</button>
								<button
									type="button"
									disabled={idx === starters.length - 1}
									onClick={() => move(idx, 1)}
									className="text-muted-foreground hover:text-foreground disabled:opacity-40"
									title="Move down"
								>
									<ChevronDown className="size-3" />
								</button>
								<button
									type="button"
									onClick={() =>
										setStarters(starters.filter((_, i) => i !== idx))
									}
									className="text-muted-foreground hover:text-destructive"
									title="Remove starter"
								>
									<Trash2 className="size-3" />
								</button>
							</div>
							<div>
								<label className="text-[10px] text-muted-foreground">
									Label (max {STARTER_LABEL_MAX})
								</label>
								<input
									type="text"
									value={s.label}
									maxLength={STARTER_LABEL_MAX}
									onChange={(e) => update(idx, { label: e.target.value })}
									placeholder="e.g. Talk to support"
									className="mt-0.5 h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
								/>
							</div>
							<div>
								<label className="text-[10px] text-muted-foreground">
									Payload
								</label>
								<input
									type="text"
									value={s.payload}
									onChange={(e) => update(idx, { payload: e.target.value })}
									placeholder="e.g. SUPPORT"
									className="mt-0.5 h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
								/>
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Ice-breaker editor (flat list, reorderable)
// ---------------------------------------------------------------------------

interface IceBreakerEditorProps {
	questions: IceBreakerQuestion[];
	setQuestions: (next: IceBreakerQuestion[]) => void;
}

export function IceBreakerEditor({
	questions,
	setQuestions,
}: IceBreakerEditorProps) {
	const move = (idx: number, dir: -1 | 1) => {
		const next = [...questions];
		const swap = idx + dir;
		if (swap < 0 || swap >= next.length) return;
		[next[idx], next[swap]] = [next[swap]!, next[idx]!];
		setQuestions(next);
	};

	const update = (idx: number, patch: Partial<IceBreakerQuestion>) => {
		const next = [...questions];
		next[idx] = { ...next[idx]!, ...patch };
		setQuestions(next);
	};

	const add = () => {
		setQuestions([...questions, { question: "", payload: "" }]);
	};

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<label className="text-[11px] font-medium text-muted-foreground">
					Questions ({questions.length}/{ICE_BREAKER_MAX_ITEMS})
				</label>
				<Button
					type="button"
					size="sm"
					variant="outline"
					className="h-7 gap-1 text-xs"
					disabled={questions.length >= ICE_BREAKER_MAX_ITEMS}
					onClick={add}
				>
					<Plus className="size-3" />
					Add question
				</Button>
			</div>

			{questions.length === 0 ? (
				<p className="rounded-md border border-dashed border-border bg-background/50 px-3 py-4 text-center text-[11px] text-muted-foreground">
					No ice-breakers yet. Add up to {ICE_BREAKER_MAX_ITEMS}.
				</p>
			) : (
				<div className="space-y-2">
					{questions.map((q, idx) => (
						<div
							key={idx}
							className="rounded-md border border-border bg-background/70 p-2.5 space-y-2"
						>
							<div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
								<span>#{idx + 1}</span>
								<button
									type="button"
									disabled={idx === 0}
									onClick={() => move(idx, -1)}
									className="ml-auto text-muted-foreground hover:text-foreground disabled:opacity-40"
									title="Move up"
								>
									<ChevronUp className="size-3" />
								</button>
								<button
									type="button"
									disabled={idx === questions.length - 1}
									onClick={() => move(idx, 1)}
									className="text-muted-foreground hover:text-foreground disabled:opacity-40"
									title="Move down"
								>
									<ChevronDown className="size-3" />
								</button>
								<button
									type="button"
									onClick={() =>
										setQuestions(questions.filter((_, i) => i !== idx))
									}
									className="text-muted-foreground hover:text-destructive"
									title="Remove question"
								>
									<Trash2 className="size-3" />
								</button>
							</div>
							<div>
								<label className="text-[10px] text-muted-foreground">
									Question (max {ICE_BREAKER_QUESTION_MAX})
								</label>
								<input
									type="text"
									value={q.question}
									maxLength={ICE_BREAKER_QUESTION_MAX}
									onChange={(e) => update(idx, { question: e.target.value })}
									placeholder="e.g. What brought you here?"
									className="mt-0.5 h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
								/>
							</div>
							<div>
								<label className="text-[10px] text-muted-foreground">
									Payload
								</label>
								<input
									type="text"
									value={q.payload}
									onChange={(e) => update(idx, { payload: e.target.value })}
									placeholder="e.g. SUPPORT_INQUIRY"
									className="mt-0.5 h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
								/>
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Per-type descriptor registry — the single source of truth both surfaces use.
// `renderEditor` is undefined for the config-less live types (default_reply,
// welcome_message).
// ---------------------------------------------------------------------------

export interface BindingConfigDescriptor {
	bindingType: BindingType;
	title: string;
	subtitle: string;
	/** Stubbed (menu-surface) types show a "Platform sync in v1.1" banner. */
	stubbed: boolean;
	bannerCopy?: string;
	// Configs are loosely-typed JSON; `any` keeps the registry uniform while the
	// per-type editor components stay strictly typed internally.
	// biome-ignore lint/suspicious/noExplicitAny: heterogeneous per-type config
	emptyConfig: any;
	// biome-ignore lint/suspicious/noExplicitAny: heterogeneous per-type config
	parseConfig: (raw: unknown) => any;
	// biome-ignore lint/suspicious/noExplicitAny: heterogeneous per-type config
	validateConfig: (config: any) => string | null;
	renderEditor?: (
		// biome-ignore lint/suspicious/noExplicitAny: heterogeneous per-type config
		config: any,
		// biome-ignore lint/suspicious/noExplicitAny: heterogeneous per-type config
		setConfig: (next: any) => void,
	) => ReactNode;
}

export const BINDING_CONFIG_EDITORS: Record<BindingType, BindingConfigDescriptor> =
	{
		default_reply: {
			bindingType: "default_reply",
			title: "Default Reply",
			subtitle: "Runs when no other entrypoint matches this inbound DM.",
			stubbed: false,
			emptyConfig: {},
			parseConfig: () => ({}),
			validateConfig: () => null,
		},
		welcome_message: {
			bindingType: "welcome_message",
			title: "Welcome Message",
			subtitle:
				"Runs on the contact's first-ever inbound message to this account.",
			stubbed: false,
			emptyConfig: {},
			parseConfig: () => ({}),
			validateConfig: () => null,
		},
		main_menu: {
			bindingType: "main_menu",
			title: "Main Menu",
			subtitle:
				"Persistent menu pinned to every conversation. Customers can tap items to trigger the linked automation.",
			stubbed: true,
			bannerCopy:
				"Each menu item's payload will trigger a matching keyword entrypoint on your linked automation. Platform push to Meta's Messenger Profile API ships in v1.1.",
			emptyConfig: { items: [] } satisfies MainMenuConfig,
			parseConfig: parseMainMenuConfig,
			validateConfig: (config: MainMenuConfig) =>
				validateMainMenuItems(config.items),
			renderEditor: (config: MainMenuConfig, setConfig) => (
				<MainMenuEditor
					items={config.items}
					setItems={(items) => setConfig({ items })}
				/>
			),
		},
		conversation_starter: {
			bindingType: "conversation_starter",
			title: "Conversation Starter",
			subtitle:
				"Prompts new Messenger contacts can tap when starting a conversation with your Page.",
			stubbed: true,
			bannerCopy:
				"Starters are stored here today. Meta's Messenger Profile API will push them to the platform in v1.1.",
			emptyConfig: { starters: [] } satisfies ConversationStarterConfig,
			parseConfig: parseConversationStarterConfig,
			validateConfig: (config: ConversationStarterConfig) =>
				validateConversationStarters(config.starters),
			renderEditor: (config: ConversationStarterConfig, setConfig) => (
				<ConversationStarterEditor
					starters={config.starters}
					setStarters={(starters) => setConfig({ starters })}
				/>
			),
		},
		ice_breaker: {
			bindingType: "ice_breaker",
			title: "Ice Breaker",
			subtitle:
				"Predefined questions WhatsApp contacts can tap to start a conversation.",
			stubbed: true,
			bannerCopy:
				"Ice-breaker questions are stored here today. Platform push via WhatsApp Business API ships in v1.1.",
			emptyConfig: { questions: [] } satisfies IceBreakerConfig,
			parseConfig: parseIceBreakerConfig,
			validateConfig: (config: IceBreakerConfig) =>
				validateIceBreakers(config.questions),
			renderEditor: (config: IceBreakerConfig, setConfig) => (
				<IceBreakerEditor
					questions={config.questions}
					setQuestions={(questions) => setConfig({ questions })}
				/>
			),
		},
	};
