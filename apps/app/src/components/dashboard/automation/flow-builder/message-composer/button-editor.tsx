// Inline button editor (Plan 2 — Unit B3, Task N3).
//
// Renders an editor row for a single `BlockButton` attached to a text or
// card block. Changes to the button are passed back to the parent so the
// full block array can be rebuilt.

import { Trash2 } from "lucide-react";
import { INPUT_CLS } from "../field-styles";
import type { BlockButton, BlockButtonType } from "./types";

const BUTTON_TYPES: Array<{ value: BlockButtonType; label: string; hint: string }> =
	[
		{
			value: "branch",
			label: "Branch",
			hint: "Creates a port on the message node",
		},
		{
			value: "url",
			label: "URL",
			hint: "Opens an external link — no port",
		},
		{
			value: "call",
			label: "Call",
			hint: "Dials a phone number — no port",
		},
		{
			value: "share",
			label: "Share",
			hint: "Forwards the message — no port",
		},
	];

function typeHint(type: BlockButtonType): string {
	return BUTTON_TYPES.find((t) => t.value === type)?.hint ?? "";
}

interface Props {
	button: BlockButton;
	onChange(next: BlockButton): void;
	onRemove(): void;
	channelSupportsButtons: boolean;
}

export function ButtonEditor({
	button,
	onChange,
	onRemove,
	channelSupportsButtons,
}: Props) {
	const portPreview =
		button.type === "branch" ? `button.${button.id}` : undefined;

	return (
		<div className="rounded-lg border border-[#e6e9ef] bg-[#fbfcfe] p-3 space-y-2">
			<div className="flex items-center justify-between gap-2">
				<div className="text-[11px] font-medium text-[#475569]">Button</div>
				<button
					type="button"
					onClick={onRemove}
					className="text-[#94a3b8] hover:text-destructive"
					aria-label="Remove button"
				>
					<Trash2 className="size-3.5" />
				</button>
			</div>

			<div>
				<label className="mb-1 block text-[10px] font-medium text-[#64748b]">
					Label
				</label>
				<input
					type="text"
					value={button.label}
					onChange={(e) =>
						onChange({ ...button, label: e.target.value.slice(0, 80) })
					}
					maxLength={80}
					className={INPUT_CLS}
					placeholder="What the user sees"
				/>
				<p className="mt-0.5 text-[10px] text-[#94a3b8]">
					{button.label.length}/80
				</p>
			</div>

			<div>
				<label className="mb-1 block text-[10px] font-medium text-[#64748b]">
					Type
				</label>
				<select
					value={button.type}
					onChange={(e) =>
						onChange({
							...button,
							type: e.target.value as BlockButtonType,
							// Drop type-specific fields when switching type to avoid
							// stale URLs / phone numbers travelling with a branch button.
							url:
								e.target.value === "url" ? (button.url ?? "") : undefined,
							phone:
								e.target.value === "call" ? (button.phone ?? "") : undefined,
						})
					}
					className="h-9 w-full rounded-lg border border-[#d9dde6] bg-white px-2 text-[12px]"
				>
					{BUTTON_TYPES.map((t) => (
						<option key={t.value} value={t.value}>
							{t.label}
						</option>
					))}
				</select>
				<p className="mt-0.5 text-[10px] text-[#94a3b8]">
					{typeHint(button.type)}
				</p>
			</div>

			{button.type === "url" ? (
				<div>
					<label className="mb-1 block text-[10px] font-medium text-[#64748b]">
						URL
					</label>
					<input
						type="url"
						value={button.url ?? ""}
						onChange={(e) => onChange({ ...button, url: e.target.value })}
						className={INPUT_CLS}
						placeholder="https://example.com"
					/>
				</div>
			) : null}

			{button.type === "call" ? (
				<div>
					<label className="mb-1 block text-[10px] font-medium text-[#64748b]">
						Phone number
					</label>
					<input
						type="tel"
						value={button.phone ?? ""}
						onChange={(e) => onChange({ ...button, phone: e.target.value })}
						className={INPUT_CLS}
						placeholder="+1 555 123 4567"
					/>
				</div>
			) : null}

			{portPreview ? (
				<div className="flex items-center gap-1.5 rounded-md bg-[#f3eeff] px-2 py-1 text-[10px] text-[#6b46c1]">
					<span className="font-semibold">Connect&nbsp;→</span>
					<span className="font-mono">{portPreview}</span>
				</div>
			) : null}

			{!channelSupportsButtons ? (
				<div className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[10px] text-amber-700">
					Buttons are not supported on this channel — this button will be
					skipped at send time.
				</div>
			) : null}
		</div>
	);
}
