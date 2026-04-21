// Context viewer (Plan 3 — Unit C2, Task S3).
//
// Renders the run's `context` JSON. Keeps things simple: pretty-printed JSON
// inside a scrollable <pre>. Provides a "Copy" button that writes the raw
// JSON text to the clipboard.

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
	context: Record<string, unknown> | null;
}

export function ContextViewer({ context }: Props) {
	const [copied, setCopied] = useState(false);

	const text = (() => {
		if (context == null) return "";
		try {
			return JSON.stringify(context, null, 2);
		} catch {
			return String(context);
		}
	})();

	const handleCopy = async () => {
		if (!text) return;
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1500);
		} catch {
			// Silent — most often blocked by the browser; nothing sensible to show.
		}
	};

	if (context == null || Object.keys(context).length === 0) {
		return (
			<p className="p-4 text-center text-xs text-muted-foreground">
				Run context is empty.
			</p>
		);
	}

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center justify-between border-b border-border px-3 py-1.5">
				<div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
					Context
				</div>
				<button
					type="button"
					onClick={handleCopy}
					className={cn(
						"inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:text-foreground",
						copied && "text-emerald-600 border-emerald-500/40",
					)}
				>
					{copied ? (
						<>
							<Check className="size-3" />
							Copied
						</>
					) : (
						<>
							<Copy className="size-3" />
							Copy
						</>
					)}
				</button>
			</div>
			<pre className="flex-1 overflow-auto bg-muted/30 p-3 text-[11px] leading-[1.5]">
				<code>{text}</code>
			</pre>
		</div>
	);
}
