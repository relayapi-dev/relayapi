// Fallback panel for unknown or unavailable legacy action types.
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
						Unavailable action type: {action.type}
					</div>
					<p className="mt-1 text-[11px] text-amber-700">
						The production runtime does not offer this action. Your flow keeps
						the legacy payload untouched so you can replace or remove it using
						the ⋯ menu.
					</p>
				</div>
			</div>
			<pre className="mt-3 max-h-[200px] overflow-auto rounded border border-amber-200 bg-white p-2 font-mono text-[11px] text-[#334155]">
				{JSON.stringify(action, null, 2)}
			</pre>
		</div>
	);
}
