// Fallback editor for unknown action types.
//
// Shown when the catalog has loaded but doesn't include `action.type` — the
// likely cause is a server version that knows about a type this build
// doesn't. We render a read-only JSON blob so the row keeps whatever the
// server originally saved (and lets the operator pick a known type if they
// want to replace it).

import { AlertTriangle } from "lucide-react";
import type { Action } from "./types";

interface Props {
	action: Action;
	onChange(next: Action): void;
	knownTypes: string[];
}

export function AutomationControlsUnknownHint({ action }: Props) {
	return (
		<div className="rounded-xl border border-amber-300 bg-amber-50 p-3">
			<div className="flex items-start gap-2">
				<AlertTriangle className="mt-0.5 size-3.5 text-amber-600" />
				<div className="flex-1">
					<div className="text-[12px] font-semibold text-amber-800">
						Unknown action type: {action.type}
					</div>
					<p className="mt-1 text-[11px] text-amber-700">
						The server recognises this action but the builder in this browser
						doesn't yet. Your flow keeps the action untouched; update the
						dashboard to get an editor for it, or replace the action with a
						known type using the ⋯ menu.
					</p>
				</div>
			</div>
			<pre className="mt-3 max-h-[200px] overflow-auto rounded border border-amber-200 bg-white p-2 font-mono text-[11px] text-[#334155]">
{JSON.stringify(action, null, 2)}
			</pre>
		</div>
	);
}
