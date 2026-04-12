import { Hash, Plus, Smile, Trash2, X } from "lucide-react";
import * as Popover from "@radix-ui/react-popover";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
	countCharsForPlatform,
	PLATFORM_CHAR_LIMITS,
} from "@/lib/platform-char-limits";
import { platformLabels } from "@/lib/platform-maps";

// ── Emoji data (compact set covering common use) ──

const EMOJI_CATEGORIES: { label: string; emojis: string[] }[] = [
	{
		label: "Smileys",
		emojis: [
			"😀","😃","😄","😁","😆","😅","🤣","😂","🙂","😊",
			"😇","🥰","😍","🤩","😘","😋","😛","🤔","🤗","🤫",
			"😶","😏","😌","😔","😢","😭","😤","🤯","😱","🥳",
		],
	},
	{
		label: "People",
		emojis: [
			"👋","🤚","🖐️","✋","👌","🤌","✌️","🤞","🤟","🤘",
			"👍","👎","👏","🙌","🤝","🙏","💪","🧠","👀","👁️",
			"❤️","🧡","💛","💚","💙","💜","🖤","🤍","💯","💥",
		],
	},
	{
		label: "Nature",
		emojis: [
			"🌞","🌙","⭐","🌟","✨","⚡","🔥","🌈","☀️","🌤️",
			"🌿","🍀","🌸","🌺","🌻","🌹","🌳","🍃","🐶","🐱",
			"🦋","🐝","🌊","💧","🍂","🌾","🐾","🦄","🕊️","🐬",
		],
	},
	{
		label: "Food",
		emojis: [
			"🍕","🍔","🌮","🍜","🍣","🍩","🍰","🎂","☕","🍷",
			"🍻","🥂","🧋","🍿","🍦","🍫","🥑","🍓","🍎","🍉",
		],
	},
	{
		label: "Activities",
		emojis: [
			"⚽","🏀","🎯","🎮","🎲","🎭","🎨","🎵","🎸","🎬",
			"📸","🏆","🥇","🎪","🎢","🏄","🚴","⛷️","🏋️","🧘",
		],
	},
	{
		label: "Travel",
		emojis: [
			"🚀","✈️","🗺️","🏔️","🏖️","🌍","🗽","🏰","🎡","🚂",
			"🚗","⛵","🛳️","🏠","🏙️","🌅","🌄","🗿","⛩️","🏝️",
		],
	},
	{
		label: "Objects",
		emojis: [
			"💡","📱","💻","⌨️","📧","📌","📎","✏️","📝","📊",
			"📈","🔔","🔑","🎁","🏷️","💰","💎","🛡️","⏰","📅",
			"🔗","🧩","🎯","⚙️","🔧","📦","🚩","🏁","✅","❌",
		],
	},
];

// ── Hashtag group persistence ──

interface HashtagGroup {
	name: string;
	tags: string[];
}

const STORAGE_KEY = "relay_hashtag_groups";

function loadGroups(): HashtagGroup[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? JSON.parse(raw) : [];
	} catch {
		return [];
	}
}

function saveGroups(groups: HashtagGroup[]) {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
}

// ── Emoji Picker Popover ──

export function EmojiPicker({ onInsert }: { onInsert: (emoji: string) => void }) {
	const [open, setOpen] = useState(false);
	const [activeCategory, setActiveCategory] = useState(0);

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<button
					type="button"
					className="flex items-center justify-center size-7 rounded-md hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors"
					title="Emoji"
				>
					<Smile className="size-4" />
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					side="top"
					align="start"
					sideOffset={6}
					className="z-50 w-72 rounded-lg border border-border bg-popover shadow-lg animate-in fade-in-0 zoom-in-95"
				>
					{/* Category tabs */}
					<div className="flex border-b border-border px-1 pt-1 gap-0.5 overflow-x-auto">
						{EMOJI_CATEGORIES.map((cat, i) => (
							<button
								key={cat.label}
								type="button"
								onClick={() => setActiveCategory(i)}
								className={cn(
									"px-2 py-1.5 text-[11px] font-medium rounded-t-md transition-colors whitespace-nowrap",
									activeCategory === i
										? "bg-accent text-foreground"
										: "text-muted-foreground hover:text-foreground hover:bg-accent/30",
								)}
							>
								{cat.label}
							</button>
						))}
					</div>
					{/* Emoji grid */}
					<div className="grid grid-cols-8 gap-0.5 p-2 max-h-48 overflow-y-auto">
						{(EMOJI_CATEGORIES[activeCategory]?.emojis ?? []).map((emoji) => (
							<button
								key={emoji}
								type="button"
								onClick={() => {
									onInsert(emoji);
								}}
								className="flex items-center justify-center size-8 rounded hover:bg-accent/50 text-lg transition-colors"
							>
								{emoji}
							</button>
						))}
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

// ── Hashtag Manager Popover ──

function HashtagManager({ onInsert }: { onInsert: (text: string) => void }) {
	const [open, setOpen] = useState(false);
	const [groups, setGroups] = useState<HashtagGroup[]>(loadGroups);
	const [creating, setCreating] = useState(false);
	const [newName, setNewName] = useState("");
	const [newTags, setNewTags] = useState("");
	const nameRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (creating) nameRef.current?.focus();
	}, [creating]);

	const handleCreate = () => {
		const name = newName.trim();
		const tags = newTags
			.split(/[,\s]+/)
			.map((t) => (t.startsWith("#") ? t : `#${t}`))
			.filter((t) => t.length > 1);
		if (!name || tags.length === 0) return;
		const updated = [...groups, { name, tags }];
		setGroups(updated);
		saveGroups(updated);
		setCreating(false);
		setNewName("");
		setNewTags("");
	};

	const handleDelete = (index: number) => {
		const updated = groups.filter((_, i) => i !== index);
		setGroups(updated);
		saveGroups(updated);
	};

	const handleInsert = (group: HashtagGroup) => {
		onInsert(group.tags.join(" "));
	};

	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<button
					type="button"
					className="flex items-center justify-center size-7 rounded-md hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors"
					title="Hashtags"
				>
					<Hash className="size-4" />
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					side="top"
					align="start"
					sideOffset={6}
					className="z-50 w-72 rounded-lg border border-border bg-popover shadow-lg animate-in fade-in-0 zoom-in-95"
				>
					<div className="px-3 py-2 border-b border-border flex items-center justify-between">
						<span className="text-xs font-medium">Hashtag Groups</span>
						{!creating && (
							<button
								type="button"
								onClick={() => setCreating(true)}
								className="flex items-center gap-1 text-[11px] text-primary hover:underline"
							>
								<Plus className="size-3" />
								New
							</button>
						)}
					</div>

					<div className="max-h-56 overflow-y-auto">
						{creating && (
							<div className="p-3 border-b border-border space-y-2">
								<input
									ref={nameRef}
									value={newName}
									onChange={(e) => setNewName(e.target.value)}
									placeholder="Group name"
									className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
									onKeyDown={(e) => {
										if (e.key === "Escape") setCreating(false);
									}}
								/>
								<input
									value={newTags}
									onChange={(e) => setNewTags(e.target.value)}
									placeholder="hashtags (comma separated)"
									className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											e.preventDefault();
											handleCreate();
										}
										if (e.key === "Escape") setCreating(false);
									}}
								/>
								<div className="flex gap-1.5">
									<button
										type="button"
										onClick={handleCreate}
										className="flex-1 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
									>
										Save
									</button>
									<button
										type="button"
										onClick={() => {
											setCreating(false);
											setNewName("");
											setNewTags("");
										}}
										className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent/30"
									>
										Cancel
									</button>
								</div>
							</div>
						)}

						{groups.length === 0 && !creating ? (
							<div className="p-4 text-center text-xs text-muted-foreground">
								No hashtag groups yet. Create one to get started.
							</div>
						) : (
							groups.map((group, i) => (
								<div
									key={i}
									className="flex items-center gap-2 px-3 py-2 border-b border-border last:border-0 hover:bg-accent/20 group"
								>
									<div className="flex-1 min-w-0">
										<p className="text-xs font-medium truncate">
											{group.name}
										</p>
										<p className="text-[10px] text-muted-foreground truncate">
											{group.tags.join(" ")}
										</p>
									</div>
									<button
										type="button"
										onClick={() => handleInsert(group)}
										className="shrink-0 rounded-md bg-accent/50 px-2 py-0.5 text-[10px] font-medium hover:bg-accent transition-colors"
									>
										Insert
									</button>
									<button
										type="button"
										onClick={() => handleDelete(i)}
										className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive transition-all"
									>
										<Trash2 className="size-3" />
									</button>
								</div>
							))
						)}
					</div>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

// ── Character Count Badges ──

function CharBadges({
	content,
	activePlatforms,
	activePlatform,
}: {
	content: string;
	activePlatforms: Set<string>;
	activePlatform: string;
}) {
	if (activePlatforms.size === 0) return null;

	const badges: { platform: string; count: number; limit: number }[] = [];
	for (const p of activePlatforms) {
		const limit = PLATFORM_CHAR_LIMITS[p];
		if (!limit) continue;
		badges.push({
			platform: p,
			count: content ? countCharsForPlatform(content, p) : 0,
			limit: limit.maxChars,
		});
	}

	if (badges.length === 0) return null;

	// Sort: active platform first
	badges.sort((a, b) => {
		if (a.platform === activePlatform) return -1;
		if (b.platform === activePlatform) return 1;
		return 0;
	});

	return (
		<div className="flex items-center gap-1.5 ml-auto">
			{badges.map(({ platform, count, limit }) => {
				const ratio = count / limit;
				const isActive = platform === activePlatform;
				return (
					<span
						key={platform}
						title={`${platformLabels[platform] || platform}: ${count}/${limit}`}
						className={cn(
							"inline-flex items-center rounded-full px-1.5 py-0.5 font-mono tabular-nums transition-colors",
							isActive ? "text-[11px]" : "text-[10px]",
							ratio > 1
								? "bg-destructive/15 text-destructive font-medium"
								: ratio > 0.9
									? "bg-amber-500/15 text-amber-600"
									: "bg-accent/50 text-muted-foreground",
						)}
					>
						{limit - count}
					</span>
				);
			})}
		</div>
	);
}

// ── Exported Toolbar ──

interface EditorToolbarProps {
	content: string;
	activePlatforms: Set<string>;
	activePlatform: string;
	onInsertText: (text: string) => void;
}

export function EditorToolbar({
	content,
	activePlatforms,
	activePlatform,
	onInsertText,
}: EditorToolbarProps) {
	return (
		<div className="flex items-center gap-0.5 px-1">
			<EmojiPicker onInsert={onInsertText} />
			<HashtagManager onInsert={onInsertText} />
			<CharBadges
				content={content}
				activePlatforms={activePlatforms}
				activePlatform={activePlatform}
			/>
		</div>
	);
}
