// delete_contact form.
//
// A single acknowledge-checkbox with a big red warning banner. The
// `confirm` field is a literal `true` on the wire; clearing this checkbox
// puts the action in an invalid state (validateAction will flag it).

import { AlertTriangle } from "lucide-react";
import type { DeleteContactAction } from "../types";
import { FormShell } from "./shared";

type Props = {
	action: DeleteContactAction;
	onChange(next: DeleteContactAction): void;
	error?: string | null;
};

export function DeleteContactForm({ action, onChange, error }: Props) {
	return (
		<FormShell>
			<div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
				<div className="flex items-start gap-3">
					<AlertTriangle className="mt-0.5 size-4 text-destructive" />
					<div className="flex-1">
						<div className="text-[13px] font-semibold text-destructive">
							This cannot be undone.
						</div>
						<p className="mt-1 text-[11px] text-[#475569]">
							The contact record, conversation history, and subscription data
							will be permanently deleted from your workspace when this action
							fires.
						</p>
					</div>
				</div>
				<label className="mt-3 flex items-center gap-2 text-[12px] font-medium text-[#353a44]">
					<input
						type="checkbox"
						checked={action.confirm === true}
						onChange={(e) => {
							// confirm is a literal `true`; clearing the checkbox puts the
							// action in an invalid state until the user reconfirms. We
							// express that by writing `false as unknown as true` — the
							// validator will flag it.
							const next = e.target.checked;
							onChange({
								...action,
								confirm: next as unknown as true,
							});
						}}
						className="h-4 w-4 rounded border-[#cdd5e1]"
					/>
					I understand this permanently deletes the contact.
				</label>
				{error ? (
					<p className="mt-1 text-[11px] text-destructive">{error}</p>
				) : null}
			</div>
		</FormShell>
	);
}
