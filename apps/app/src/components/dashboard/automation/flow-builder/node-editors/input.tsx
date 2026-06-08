// Input ("Wait for Reply") node editor.
//
// Mirrors `apps/api/src/services/automations/nodes/input.ts`:
//   field (req) · input_type · choices · validation · timeout_min ·
//   max_retries · skip_allowed
// Captured value is stored at ctx.context[field]; downstream nodes read it as
// `state.<field>`.

import { Plus, Trash2 } from "lucide-react";
import {
	AdvancedDisclosure,
	CheckboxRow,
	Field,
	FormShell,
	INPUT_CLS,
	numberOrUndefined,
} from "./shared";

const INPUT_TYPES = [
	"text",
	"email",
	"phone",
	"number",
	"choice",
	"file",
] as const;
type InputType = (typeof INPUT_TYPES)[number];

interface Choice {
	value: string;
	label: string;
	match?: string[];
}

interface InputConfig {
	field?: string;
	input_type?: InputType;
	choices?: Choice[];
	validation?: { pattern?: string; min?: number; max?: number };
	timeout_min?: number;
	max_retries?: number;
	skip_allowed?: boolean;
}

export function InputEditor({
	config,
	onChange,
}: {
	config: Record<string, unknown>;
	onChange: (next: Record<string, unknown>) => void;
}) {
	const cfg = config as InputConfig;
	const patch = (p: Partial<InputConfig>) => onChange({ ...config, ...p });

	const inputType = cfg.input_type ?? "text";
	const choices = cfg.choices ?? [];
	const validation = cfg.validation ?? {};

	const patchValidation = (
		p: Partial<NonNullable<InputConfig["validation"]>>,
	) => {
		const next = { ...validation, ...p };
		for (const k of Object.keys(next) as (keyof typeof next)[]) {
			if (next[k] === undefined || next[k] === "") delete next[k];
		}
		patch({ validation: Object.keys(next).length ? next : undefined });
	};

	const patchChoice = (idx: number, p: Partial<Choice>) => {
		const next = choices.slice();
		next[idx] = { ...next[idx]!, ...p };
		patch({ choices: next });
	};

	return (
		<FormShell>
			<Field
				label="Capture field"
				required
				description="Where the reply is stored. Read it downstream as `state.<field>`."
			>
				<input
					type="text"
					value={cfg.field ?? ""}
					onChange={(e) => patch({ field: e.target.value })}
					placeholder="e.g. email, shoe_size"
					className={INPUT_CLS}
				/>
			</Field>

			<Field label="Expected input">
				<select
					value={inputType}
					onChange={(e) => patch({ input_type: e.target.value as InputType })}
					className={INPUT_CLS}
				>
					{INPUT_TYPES.map((t) => (
						<option key={t} value={t}>
							{t.charAt(0).toUpperCase() + t.slice(1)}
						</option>
					))}
				</select>
			</Field>

			{inputType === "choice" ? (
				<Field
					label="Choices"
					description="Value is stored; match keywords (comma-separated) map a reply to this choice."
				>
					<div className="space-y-2">
						{choices.map((choice, idx) => (
							<div
								key={idx}
								className="space-y-1.5 rounded-lg border border-[#e6e9ef] bg-[#fbfcfe] p-2"
							>
								<div className="flex items-center gap-1.5">
									<input
										type="text"
										value={choice.label}
										onChange={(e) => patchChoice(idx, { label: e.target.value })}
										placeholder="Label"
										className="h-9 flex-1 rounded-lg border border-[#d9dde6] bg-white px-2 text-[12px]"
									/>
									<input
										type="text"
										value={choice.value}
										onChange={(e) => patchChoice(idx, { value: e.target.value })}
										placeholder="Value"
										className="h-9 flex-1 rounded-lg border border-[#d9dde6] bg-white px-2 text-[12px]"
									/>
									<button
										type="button"
										onClick={() =>
											patch({ choices: choices.filter((_, i) => i !== idx) })
										}
										className="rounded p-1 text-[#94a3b8] hover:bg-[#fde8e8] hover:text-destructive"
										aria-label="Remove choice"
									>
										<Trash2 className="size-3.5" />
									</button>
								</div>
								<input
									type="text"
									value={(choice.match ?? []).join(", ")}
									onChange={(e) =>
										patchChoice(idx, {
											match: e.target.value
												.split(",")
												.map((s) => s.trim())
												.filter(Boolean),
										})
									}
									placeholder="Match keywords (optional): yes, yeah, y"
									className="h-9 w-full rounded-lg border border-[#d9dde6] bg-white px-2 text-[12px]"
								/>
							</div>
						))}
						<button
							type="button"
							onClick={() =>
								patch({ choices: [...choices, { value: "", label: "" }] })
							}
							className="flex h-8 w-full items-center justify-center gap-1 rounded-md border border-dashed border-[#d9dde6] text-[11px] text-[#475569] hover:bg-[#f5f8fc]"
						>
							<Plus className="size-3" />
							Add choice
						</button>
					</div>
				</Field>
			) : null}

			<CheckboxRow
				label="Allow skip"
				description='A "skip" reply routes through the skip port instead of capturing.'
				checked={cfg.skip_allowed ?? false}
				onChange={(skip_allowed) => patch({ skip_allowed })}
			/>

			<AdvancedDisclosure>
				<Field
					label="Timeout (minutes)"
					description="If unanswered within this window, routes through the timeout port."
				>
					<input
						type="number"
						min={1}
						value={cfg.timeout_min ?? ""}
						onChange={(e) =>
							patch({ timeout_min: numberOrUndefined(e.target.value) })
						}
						placeholder="No timeout"
						className={INPUT_CLS}
					/>
				</Field>
				<Field
					label="Max retries"
					description="On invalid input, re-prompt up to this many times before the invalid port."
				>
					<input
						type="number"
						min={0}
						value={cfg.max_retries ?? ""}
						onChange={(e) =>
							patch({ max_retries: numberOrUndefined(e.target.value) })
						}
						placeholder="0"
						className={INPUT_CLS}
					/>
				</Field>
				{inputType === "number" ? (
					<div className="grid grid-cols-2 gap-2">
						<Field label="Min">
							<input
								type="number"
								value={validation.min ?? ""}
								onChange={(e) =>
									patchValidation({ min: numberOrUndefined(e.target.value) })
								}
								className={INPUT_CLS}
							/>
						</Field>
						<Field label="Max">
							<input
								type="number"
								value={validation.max ?? ""}
								onChange={(e) =>
									patchValidation({ max: numberOrUndefined(e.target.value) })
								}
								className={INPUT_CLS}
							/>
						</Field>
					</div>
				) : (
					<Field
						label="Validation pattern"
						description="Optional regular expression the reply must match."
					>
						<input
							type="text"
							value={validation.pattern ?? ""}
							onChange={(e) =>
								patchValidation({ pattern: e.target.value || undefined })
							}
							placeholder="^[A-Z]{3}$"
							className={INPUT_CLS}
						/>
					</Field>
				)}
			</AdvancedDisclosure>
		</FormShell>
	);
}
