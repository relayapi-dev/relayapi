// Ice Breaker binding tab — Plan 3 Unit C3, Task T5.
//
// WhatsApp-only. Stubbed for v1 — storage + UI ships here, platform push via
// the WhatsApp Business API lands in v1.1 (see spec §6.4).
//
// Config shape (spec §6.5): { questions: [{ question, payload }] }.
// Enforce max 4 questions + question length <= 80 chars.

import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import { StubbedBindingShell } from "./stubbed-shell";
import {
	ICE_BREAKER_MAX_ITEMS,
	ICE_BREAKER_QUESTION_MAX,
	validateIceBreakers,
	type IceBreakerQuestion,
} from "./types";

interface Props {
	socialAccountId: string;
}

interface Config {
	questions: IceBreakerQuestion[];
}

const EMPTY_CONFIG: Config = { questions: [] };

function parseConfig(raw: unknown): Config {
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

export function IceBreakerTab({ socialAccountId }: Props) {
	const validate = useCallback(
		(cfg: Config) => validateIceBreakers(cfg.questions),
		[],
	);

	return (
		<StubbedBindingShell<Config>
			socialAccountId={socialAccountId}
			channel="whatsapp"
			bindingType="ice_breaker"
			title="Ice Breaker"
			subtitle="Predefined questions WhatsApp contacts can tap to start a conversation."
			bannerCopy="Ice-breaker questions are stored here today. Platform push via WhatsApp Business API ships in v1.1."
			emptyConfig={EMPTY_CONFIG}
			parseConfig={parseConfig}
			validateConfig={validate}
			renderEditor={(cfg, setCfg) => (
				<IceBreakerEditor
					questions={cfg.questions}
					setQuestions={(questions) => setCfg({ questions })}
				/>
			)}
		/>
	);
}

interface EditorProps {
	questions: IceBreakerQuestion[];
	setQuestions: (next: IceBreakerQuestion[]) => void;
}

function IceBreakerEditor({ questions, setQuestions }: EditorProps) {
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
