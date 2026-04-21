// Shared form primitives for action-editor sub-forms.
//
// Keeps the 11 per-type forms visually consistent and reduces boilerplate
// while still letting each form declare exactly the fields it needs.

import type { ReactNode } from "react";
import { INPUT_CLS } from "../../field-styles";

interface FieldProps {
	label: string;
	htmlFor?: string;
	description?: string;
	required?: boolean;
	error?: string | null;
	right?: ReactNode;
	children: ReactNode;
}

export function Field({
	label,
	htmlFor,
	description,
	required,
	error,
	right,
	children,
}: FieldProps) {
	return (
		<div>
			<div className="mb-1 flex items-end justify-between gap-2">
				<label
					htmlFor={htmlFor}
					className="block text-[11px] font-medium text-[#7e8695]"
				>
					{label}
					{required ? <span className="text-destructive"> *</span> : null}
				</label>
				{right ? <div className="flex items-center gap-1">{right}</div> : null}
			</div>
			{children}
			{description ? (
				<p className="mt-0.5 text-[10px] text-[#94a3b8]">{description}</p>
			) : null}
			{error ? (
				<p className="mt-1 text-[11px] text-destructive">{error}</p>
			) : null}
		</div>
	);
}

export { INPUT_CLS };

export function FormShell({ children }: { children: ReactNode }) {
	return <div className="space-y-3">{children}</div>;
}
