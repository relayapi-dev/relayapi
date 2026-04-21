// webhook_out form.
//
// URL + method + headers (key-value editor) + body (merge-tag aware) + auth.

import { Plus, Trash2 } from "lucide-react";
import { useMemo } from "react";
import {
	MergeTagPicker,
	useMergeTagInput,
} from "../../message-composer/merge-tag-picker";
import type {
	WebhookAuth,
	WebhookAuthMode,
	WebhookMethod,
	WebhookOutAction,
} from "../types";
import { Field, FormShell, INPUT_CLS } from "./shared";

const METHODS: WebhookMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const AUTH_MODES: { key: WebhookAuthMode; label: string }[] = [
	{ key: "none", label: "None" },
	{ key: "bearer", label: "Bearer token" },
	{ key: "basic", label: "Basic auth" },
	{ key: "hmac", label: "HMAC signature" },
];

type Props = {
	action: WebhookOutAction;
	onChange(next: WebhookOutAction): void;
	errors?: Record<string, string>;
};

export function WebhookOutForm({ action, onChange, errors }: Props) {
	const bodyMerge = useMergeTagInput<HTMLTextAreaElement>(
		action.body ?? "",
		(next) => onChange({ ...action, body: next || undefined }),
	);

	const headerRows = useMemo(
		() => Object.entries(action.headers ?? {}),
		[action.headers],
	);

	const updateHeaderKey = (idx: number, nextKey: string) => {
		const entries = headerRows.slice();
		const current = entries[idx];
		if (!current) return;
		entries[idx] = [nextKey, current[1]];
		onChange({ ...action, headers: Object.fromEntries(entries) });
	};
	const updateHeaderValue = (idx: number, nextVal: string) => {
		const entries = headerRows.slice();
		const current = entries[idx];
		if (!current) return;
		entries[idx] = [current[0], nextVal];
		onChange({ ...action, headers: Object.fromEntries(entries) });
	};
	const removeHeader = (idx: number) => {
		const entries = headerRows.slice();
		entries.splice(idx, 1);
		onChange({ ...action, headers: Object.fromEntries(entries) });
	};
	const addHeader = () => {
		const entries = headerRows.slice();
		entries.push(["", ""]);
		onChange({ ...action, headers: Object.fromEntries(entries) });
	};

	const updateAuth = (patch: Partial<WebhookAuth>) => {
		onChange({ ...action, auth: { ...action.auth, ...patch } });
	};

	return (
		<FormShell>
			<Field label="URL" required error={errors?.url}>
				<input
					type="url"
					value={action.url}
					onChange={(e) => onChange({ ...action, url: e.target.value })}
					placeholder="https://example.com/webhook"
					className={INPUT_CLS}
				/>
			</Field>

			<Field label="Method" required>
				<select
					value={action.method}
					onChange={(e) =>
						onChange({ ...action, method: e.target.value as WebhookMethod })
					}
					className={INPUT_CLS}
				>
					{METHODS.map((m) => (
						<option key={m} value={m}>
							{m}
						</option>
					))}
				</select>
			</Field>

			<Field label="Headers" description="Key-value pairs sent with the request.">
				<div className="space-y-1.5">
					{headerRows.map(([k, v], idx) => (
						<div
							key={`${idx}-${k}`}
							className="flex items-center gap-1.5"
						>
							<input
								type="text"
								value={k}
								onChange={(e) => updateHeaderKey(idx, e.target.value)}
								placeholder="Header"
								className="h-9 flex-1 rounded-lg border border-[#d9dde6] bg-white px-2 text-[12px]"
							/>
							<input
								type="text"
								value={v}
								onChange={(e) => updateHeaderValue(idx, e.target.value)}
								placeholder="Value"
								className="h-9 flex-1 rounded-lg border border-[#d9dde6] bg-white px-2 text-[12px]"
							/>
							<button
								type="button"
								onClick={() => removeHeader(idx)}
								className="rounded p-1 text-[#94a3b8] hover:bg-[#fde8e8] hover:text-destructive"
								aria-label="Remove header"
							>
								<Trash2 className="size-3.5" />
							</button>
						</div>
					))}
					<button
						type="button"
						onClick={addHeader}
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
					value={action.body ?? ""}
					onChange={(e) =>
						onChange({ ...action, body: e.target.value || undefined })
					}
					rows={4}
					placeholder='{"event": "tagged", "tag": "{{contact.first_name}}"}'
					className="w-full resize-y rounded-xl border border-[#d9dde6] bg-white px-3 py-2 font-mono text-[12px] outline-none focus:border-[#8ab4ff]"
				/>
			</Field>

			<Field label="Authentication">
				<select
					value={action.auth.mode}
					onChange={(e) =>
						updateAuth({
							mode: e.target.value as WebhookAuthMode,
							token: undefined,
							username: undefined,
							password: undefined,
							secret: undefined,
						})
					}
					className={INPUT_CLS}
				>
					{AUTH_MODES.map((m) => (
						<option key={m.key} value={m.key}>
							{m.label}
						</option>
					))}
				</select>
			</Field>

			{action.auth.mode === "bearer" ? (
				<Field label="Bearer token" required error={errors?.["auth.token"]}>
					<input
						type="text"
						value={action.auth.token ?? ""}
						onChange={(e) => updateAuth({ token: e.target.value })}
						placeholder="token_..."
						className={INPUT_CLS}
					/>
				</Field>
			) : null}

			{action.auth.mode === "basic" ? (
				<>
					<Field label="Username" required error={errors?.auth}>
						<input
							type="text"
							value={action.auth.username ?? ""}
							onChange={(e) => updateAuth({ username: e.target.value })}
							className={INPUT_CLS}
						/>
					</Field>
					<Field label="Password" required>
						<input
							type="password"
							value={action.auth.password ?? ""}
							onChange={(e) => updateAuth({ password: e.target.value })}
							className={INPUT_CLS}
						/>
					</Field>
				</>
			) : null}

			{action.auth.mode === "hmac" ? (
				<Field
					label="HMAC secret"
					required
					description="Used to sign the request body as `X-Relay-Signature`."
					error={errors?.["auth.secret"]}
				>
					<input
						type="text"
						value={action.auth.secret ?? ""}
						onChange={(e) => updateAuth({ secret: e.target.value })}
						className={INPUT_CLS}
					/>
				</Field>
			) : null}
		</FormShell>
	);
}
