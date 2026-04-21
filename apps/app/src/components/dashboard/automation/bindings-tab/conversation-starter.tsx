// Conversation Starter binding tab — Plan 3 Unit C3, Task T4.
//
// Facebook-only. Stubbed for v1 — storage + UI ships here, platform push via
// Messenger Profile API's `ice_breakers` field lands in v1.1 (see spec §6.4).
//
// Config shape (spec §6.5): { starters: [{ label, payload }] } (max 4).

import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { StubbedBindingShell } from "./stubbed-shell";
import {
	STARTER_LABEL_MAX,
	STARTER_MAX_ITEMS,
	validateConversationStarters,
	type ConversationStarter,
} from "./types";

interface Props {
	socialAccountId: string;
}

interface Config {
	starters: ConversationStarter[];
}

const EMPTY_CONFIG: Config = { starters: [] };

function parseConfig(raw: unknown): Config {
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

export function ConversationStarterTab({ socialAccountId }: Props) {
	const validate = useCallback(
		(cfg: Config) => validateConversationStarters(cfg.starters),
		[],
	);

	return (
		<StubbedBindingShell<Config>
			socialAccountId={socialAccountId}
			channel="facebook"
			bindingType="conversation_starter"
			title="Conversation Starter"
			subtitle="Prompts new Messenger contacts can tap when starting a conversation with your Page."
			bannerCopy="Starters are stored here today. Meta's Messenger Profile API will push them to the platform in v1.1."
			emptyConfig={EMPTY_CONFIG}
			parseConfig={parseConfig}
			validateConfig={validate}
			renderEditor={(cfg, setCfg) => (
				<StarterEditor
					starters={cfg.starters}
					setStarters={(starters) => setCfg({ starters })}
				/>
			)}
		/>
	);
}

interface StarterEditorProps {
	starters: ConversationStarter[];
	setStarters: (next: ConversationStarter[]) => void;
}

function StarterEditor({ starters, setStarters }: StarterEditorProps) {
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
