// HTTP Request node editor.
//
// Mirrors `apps/api/src/services/automations/nodes/http-request.ts`:
//   url (req) · method (default POST) · headers · body · timeout_ms · response_key
// URL / headers / body are merge-tag resolved at runtime (applyMergeTags).

import { Plus, Trash2 } from "lucide-react";
import { useMemo } from "react";
import {
	MergeTagPicker,
	useMergeTagInput,
} from "../message-composer/merge-tag-picker";
import {
	AdvancedDisclosure,
	Field,
	FormShell,
	INPUT_CLS,
	numberOrUndefined,
} from "./shared";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type Method = (typeof METHODS)[number];

interface HttpRequestConfig {
	url?: string;
	method?: Method;
	headers?: Record<string, string>;
	body?: string;
	timeout_ms?: number;
	response_key?: string;
}

export function HttpRequestEditor({
	config,
	onChange,
}: {
	config: Record<string, unknown>;
	onChange: (next: Record<string, unknown>) => void;
}) {
	const cfg = config as HttpRequestConfig;
	const patch = (p: Partial<HttpRequestConfig>) =>
		onChange({ ...config, ...p });

	const bodyMerge = useMergeTagInput<HTMLTextAreaElement>(
		cfg.body ?? "",
		(next) => patch({ body: next || undefined }),
	);

	const headerRows = useMemo(
		() => Object.entries(cfg.headers ?? {}),
		[cfg.headers],
	);
	const writeHeaders = (entries: [string, string][]) =>
		patch({ headers: Object.fromEntries(entries) });

	const responseKey = cfg.response_key?.trim() || "last_http_response";

	return (
		<FormShell>
			<Field label="URL" required>
				<input
					type="url"
					value={cfg.url ?? ""}
					onChange={(e) => patch({ url: e.target.value })}
					placeholder="https://api.example.com/endpoint"
					className={INPUT_CLS}
				/>
			</Field>

			<Field label="Method" required>
				<select
					value={cfg.method ?? "POST"}
					onChange={(e) => patch({ method: e.target.value as Method })}
					className={INPUT_CLS}
				>
					{METHODS.map((m) => (
						<option key={m} value={m}>
							{m}
						</option>
					))}
				</select>
			</Field>

			<Field
				label="Headers"
				description="Key-value pairs sent with the request. Merge tags supported in values."
			>
				<div className="space-y-1.5">
					{headerRows.map(([k, v], idx) => (
						// Bare index key: stable while typing a header name (a
						// content-based key would remount the row each keystroke and
						// drop focus). Rows are fully controlled and deleted via the
						// trash button, so index reuse on delete is safe.
						<div key={idx} className="flex items-center gap-1.5">
							<input
								type="text"
								value={k}
								onChange={(e) => {
									const entries = headerRows.slice();
									entries[idx] = [e.target.value, v];
									writeHeaders(entries);
								}}
								placeholder="Header"
								className="h-9 flex-1 rounded-lg border border-[#d9dde6] bg-white px-2 text-[12px]"
							/>
							<input
								type="text"
								value={v}
								onChange={(e) => {
									const entries = headerRows.slice();
									entries[idx] = [k, e.target.value];
									writeHeaders(entries);
								}}
								placeholder="Value"
								className="h-9 flex-1 rounded-lg border border-[#d9dde6] bg-white px-2 text-[12px]"
							/>
							<button
								type="button"
								onClick={() => {
									const entries = headerRows.slice();
									entries.splice(idx, 1);
									writeHeaders(entries);
								}}
								className="rounded p-1 text-[#94a3b8] hover:bg-[#fde8e8] hover:text-destructive"
								aria-label="Remove header"
							>
								<Trash2 className="size-3.5" />
							</button>
						</div>
					))}
					<button
						type="button"
						onClick={() => writeHeaders([...headerRows, ["", ""]])}
						className="flex h-8 w-full items-center justify-center gap-1 rounded-md border border-dashed border-[#d9dde6] text-[11px] text-[#475569] hover:bg-[#f5f8fc]"
					>
						<Plus className="size-3" />
						Add header
					</button>
				</div>
			</Field>

			<Field
				label="Body"
				description="Optional — merge tags supported."
				right={<MergeTagPicker onPick={bodyMerge.insertAtCursor} />}
			>
				<textarea
					ref={bodyMerge.inputRef}
					value={cfg.body ?? ""}
					onChange={(e) => patch({ body: e.target.value || undefined })}
					rows={4}
					placeholder='{"event": "reply", "name": "{{contact.first_name}}"}'
					className="w-full resize-y rounded-xl border border-[#d9dde6] bg-white px-3 py-2 font-mono text-[12px] outline-none focus:border-[#8ab4ff]"
				/>
			</Field>

			<AdvancedDisclosure>
				<Field label="Timeout (ms)" description="Defaults to 15000 ms.">
					<input
						type="number"
						min={1}
						value={cfg.timeout_ms ?? ""}
						onChange={(e) =>
							patch({ timeout_ms: numberOrUndefined(e.target.value) })
						}
						placeholder="15000"
						className={INPUT_CLS}
					/>
				</Field>
				<Field
					label="Response key"
					description={`Where the response is stored. Downstream nodes read it as \`state.${responseKey}\`.`}
				>
					<input
						type="text"
						value={cfg.response_key ?? ""}
						onChange={(e) =>
							patch({ response_key: e.target.value || undefined })
						}
						placeholder="last_http_response"
						className={INPUT_CLS}
					/>
				</Field>
			</AdvancedDisclosure>
		</FormShell>
	);
}
