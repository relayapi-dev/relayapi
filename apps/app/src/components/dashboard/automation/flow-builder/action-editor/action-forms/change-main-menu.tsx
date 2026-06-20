// change_main_menu form — v1.1 stub.
//
// The action is still save-able so operators can draft the flow now; when
// v1.1 lands, the schema will fill in `menu_payload` and this form will
// grow a real editor.

import { Sparkles } from "lucide-react";
import type { ChangeMainMenuAction } from "../types";
import { FormShell } from "./shared";

type Props = {
	action: ChangeMainMenuAction;
	onChange(next: ChangeMainMenuAction): void;
};

export function ChangeMainMenuForm({ action: _action, onChange: _onChange }: Props) {
	return (
		<FormShell>
			<div className="rounded-xl border border-[#e6e9ef] bg-[#f4f5f8] p-4">
				<div className="flex items-start gap-3">
					<Sparkles className="mt-0.5 size-4 text-[#353a44]" />
					<div>
						<div className="text-[13px] font-semibold text-[#353a44]">
							Coming in v1.1
						</div>
						<p className="mt-1 text-[11px] text-[#475569]">
							Main-menu editing will land in the next release alongside
							ice-breaker and conversation-starter sync. This action is
							save-able now so your flow keeps it wired up when v1.1 ships.
						</p>
					</div>
				</div>
			</div>
		</FormShell>
	);
}
