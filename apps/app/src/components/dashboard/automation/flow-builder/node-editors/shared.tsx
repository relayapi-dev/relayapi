// Shared primitives for node-config editors.
//
// Re-exports the action-editor form primitives (so node editors look identical
// to action sub-forms) and adds a couple of small helpers used across kinds.

import type { ReactNode } from "react";
import {
	Field,
	FormShell,
	INPUT_CLS,
} from "../action-editor/action-forms/shared";

export { Field, FormShell, INPUT_CLS };

/** Parse an `<input type="number">` string into a number or `undefined`. */
export function numberOrUndefined(raw: string): number | undefined {
	if (raw.trim() === "") return undefined;
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

/** A labelled checkbox row, used for boolean config flags. */
export function CheckboxRow({
	label,
	description,
	checked,
	onChange,
}: {
	label: string;
	description?: string;
	checked: boolean;
	onChange: (next: boolean) => void;
}) {
	return (
		<label className="flex cursor-pointer items-start gap-2.5">
			<input
				type="checkbox"
				checked={checked}
				onChange={(e) => onChange(e.target.checked)}
				className="mt-0.5 size-4 rounded border-[#d9dde6] accent-[#353a44] focus:ring-[#e6e9ef]"
			/>
			<span className="min-w-0">
				<span className="block text-[12px] font-medium text-[#353a44]">
					{label}
				</span>
				{description ? (
					<span className="mt-0.5 block text-[10px] text-[#94a3b8]">
						{description}
					</span>
				) : null}
			</span>
		</label>
	);
}

/** Collapsible "Advanced" section for rarely-touched config fields. */
export function AdvancedDisclosure({ children }: { children: ReactNode }) {
	return (
		<details className="group rounded-xl border border-[#e6e9ef] bg-white px-3 py-2">
			<summary className="cursor-pointer select-none text-[11px] font-semibold uppercase tracking-[0.12em] text-[#8b92a0] outline-none">
				Advanced
			</summary>
			<div className="mt-3 space-y-3">{children}</div>
		</details>
	);
}
