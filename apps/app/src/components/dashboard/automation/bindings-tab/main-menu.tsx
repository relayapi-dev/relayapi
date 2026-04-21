// Main Menu binding tab — Plan 3 Unit C3, Task T3.
//
// Available on FB + IG only (see spec §6.4). Stubbed for v1 — storage + UI
// ships here, platform push via Messenger Profile API lands in v1.1.
//
// Config shape (spec §6.5):
//   { items: [{ label, action: "postback" | "url", payload, sub_items? }] }
//   - max 3 top-level items
//   - max 3 levels of nesting
//   - label <= 30 chars

import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { StubbedBindingShell } from "./stubbed-shell";
import {
	MAIN_MENU_LABEL_MAX,
	MAIN_MENU_MAX_DEPTH,
	MAIN_MENU_MAX_TOP_LEVEL_ITEMS,
	validateMainMenuItems,
	type MainMenuItem,
} from "./types";

interface Props {
	socialAccountId: string;
	channel: "facebook" | "instagram";
}

interface Config {
	items: MainMenuItem[];
}

const EMPTY_CONFIG: Config = { items: [] };

function parseConfig(raw: unknown): Config {
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

export function MainMenuTab({ socialAccountId, channel }: Props) {
	const validate = useCallback(
		(cfg: Config) => validateMainMenuItems(cfg.items),
		[],
	);

	return (
		<StubbedBindingShell<Config>
			socialAccountId={socialAccountId}
			channel={channel}
			bindingType="main_menu"
			title="Main Menu"
			subtitle="Persistent menu pinned to every conversation. Customers can tap items to trigger the linked automation."
			bannerCopy="Each menu item's payload will trigger a matching keyword entrypoint on your linked automation. Platform push to Meta's Messenger Profile API ships in v1.1."
			emptyConfig={EMPTY_CONFIG}
			parseConfig={parseConfig}
			validateConfig={validate}
			renderEditor={(cfg, setCfg) => (
				<MenuEditor items={cfg.items} setItems={(items) => setCfg({ items })} />
			)}
		/>
	);
}

// ---------------------------------------------------------------------------
// Nested-item editor
// ---------------------------------------------------------------------------

interface MenuEditorProps {
	items: MainMenuItem[];
	setItems: (items: MainMenuItem[]) => void;
}

function MenuEditor({ items, setItems }: MenuEditorProps) {
	const addItem = useCallback(() => {
		setItems([
			...items,
			{ label: "", action: "postback", payload: "" },
		]);
	}, [items, setItems]);

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
					No menu items yet. Add up to {MAIN_MENU_MAX_TOP_LEVEL_ITEMS}
					.
				</p>
			) : (
				<div className="space-y-2">
					{items.map((item, idx) => (
						<ItemEditor
							key={idx}
							item={item}
							depth={1}
							onChange={(next) => {
								const copy = [...items];
								copy[idx] = next;
								setItems(copy);
							}}
							onRemove={() =>
								setItems(items.filter((_, i) => i !== idx))
							}
						/>
					))}
				</div>
			)}
		</div>
	);
}

interface ItemEditorProps {
	item: MainMenuItem;
	depth: number;
	onChange: (next: MainMenuItem) => void;
	onRemove: () => void;
}

function ItemEditor({ item, depth, onChange, onRemove }: ItemEditorProps) {
	const subItems = useMemo(() => item.sub_items ?? [], [item.sub_items]);
	const canNest = depth < MAIN_MENU_MAX_DEPTH;

	const update = (patch: Partial<MainMenuItem>) => onChange({ ...item, ...patch });

	const addSubItem = () => {
		update({
			sub_items: [
				...subItems,
				{ label: "", action: "postback", payload: "" },
			],
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
					<label className="text-[10px] text-muted-foreground">
						Action
					</label>
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
					placeholder={
						item.action === "url" ? "https://example.com" : "MENU_SHOP"
					}
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
						<ItemEditor
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
