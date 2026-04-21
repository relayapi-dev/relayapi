// Merge-tag picker (Plan 2 — Unit B3, Task N4).
//
// Dropdown shown next to text inputs inside the composer. Triggered by the
// `@` / `{{` combobox affordance (the hook), or by clicking the "Insert tag"
// button. Groups follow spec §11.9.

import type { RefObject } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { ChevronDown, Braces } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Group {
	key: string;
	label: string;
	description?: string;
	tags: Array<{ token: string; label: string; description?: string }>;
}

const CONTACT_TAGS: Group = {
	key: "contact",
	label: "Contact",
	description: "Fields from the enrolled contact",
	tags: [
		{ token: "{{contact.first_name}}", label: "First name" },
		{ token: "{{contact.last_name}}", label: "Last name" },
		{ token: "{{contact.email}}", label: "Email" },
		{ token: "{{contact.phone}}", label: "Phone" },
		{
			token: "{{contact.custom_fields.}}",
			label: "Custom field",
			description:
				"Replace with the exact custom-field key, e.g. custom_fields.shirt_size",
		},
	],
};

const RUN_TAGS: Group = {
	key: "run",
	label: "Run",
	description: "Metadata about this automation run",
	tags: [
		{ token: "{{run.id}}", label: "Run ID" },
		{ token: "{{run.started_at}}", label: "Started at" },
	],
};

const ACCOUNT_TAGS: Group = {
	key: "account",
	label: "Account",
	description: "The social account the message is sent from",
	tags: [
		{ token: "{{account.name}}", label: "Account name" },
		{ token: "{{account.handle}}", label: "Account handle" },
	],
};

function contextGroup(customContextKey: string): Group {
	const trimmed = customContextKey.trim();
	const tags: Group["tags"] = [];
	if (trimmed) {
		tags.push({
			token: `{{context.${trimmed}}}`,
			label: `context.${trimmed}`,
			description: "Captured input / HTTP response value",
		});
	}
	return {
		key: "context",
		label: "Context",
		description: "Captured inputs and HTTP-response values from earlier steps",
		tags,
	};
}

export interface MergeTagPickerProps {
	onPick(token: string): void;
	className?: string;
	buttonLabel?: string;
}

export function MergeTagPicker({
	onPick,
	className,
	buttonLabel = "Insert tag",
}: MergeTagPickerProps) {
	const [open, setOpen] = useState(false);
	const [customContextKey, setCustomContextKey] = useState("");

	const groups = useMemo<Group[]>(
		() => [
			CONTACT_TAGS,
			contextGroup(customContextKey),
			RUN_TAGS,
			ACCOUNT_TAGS,
		],
		[customContextKey],
	);

	const pick = (token: string) => {
		onPick(token);
		// Keep open so the user can insert multiple tags without reopening.
	};

	return (
		<div className={cn("relative", className)}>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="h-7 gap-1 rounded-md border border-[#d9dde6] bg-white px-2 text-[11px] font-medium text-[#475569] hover:bg-[#f5f8fc]"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
			>
				<Braces className="size-3" />
				{buttonLabel}
				<ChevronDown className="size-3 opacity-60" />
			</Button>
			{open ? (
				<div
					className="absolute z-20 mt-1 max-h-[320px] w-[280px] overflow-auto rounded-lg border border-[#e6e9ef] bg-white p-2 shadow-lg"
					onMouseLeave={() => setOpen(false)}
				>
					<p className="px-1 pb-1.5 text-[10px] text-[#64748b]">
						Click a tag to insert it at the cursor.
					</p>
					{groups.map((group) => (
						<div key={group.key} className="mb-2 last:mb-0">
							<div className="px-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#64748b]">
								{group.label}
							</div>
							{group.key === "context" ? (
								<div className="px-1 pb-1">
									<input
										type="text"
										value={customContextKey}
										onChange={(e) => setCustomContextKey(e.target.value)}
										placeholder="context key (e.g. shirt_size)"
										className="h-7 w-full rounded border border-[#d9dde6] px-2 text-[11px] outline-none focus:border-[#8ab4ff]"
									/>
								</div>
							) : null}
							{group.tags.length === 0 ? (
								<p className="px-1 text-[10px] text-[#94a3b8]">
									Type a context key above to generate a tag.
								</p>
							) : (
								<div className="flex flex-col">
									{group.tags.map((tag) => (
										<button
											key={tag.token}
											type="button"
											onClick={() => pick(tag.token)}
											className="group flex flex-col items-start rounded px-2 py-1 text-left hover:bg-[#f5f8fc]"
											title={tag.description ?? tag.token}
										>
											<span className="font-mono text-[11px] text-[#334155]">
												{tag.token}
											</span>
											<span className="text-[10px] text-[#64748b] group-hover:text-[#475569]">
												{tag.label}
											</span>
										</button>
									))}
								</div>
							)}
						</div>
					))}
				</div>
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Hook for text inputs that want to trigger the picker via `@` or `{{`.
// Returns a set of handlers you can spread onto an <input> / <textarea>, plus
// a helper to insert tokens at the current cursor position.
// ---------------------------------------------------------------------------

export interface MergeTagInputResult<
	T extends HTMLInputElement | HTMLTextAreaElement,
> {
	inputRef: RefObject<T | null>;
	insertAtCursor(token: string): void;
}

/**
 * Helper hook: keeps a ref to a text input/textarea and exposes
 * `insertAtCursor(token)` which handles selection replacement and caret
 * positioning. Use this so every text field in the composer can present a
 * picker button that splices the token at the user's cursor.
 */
export function useMergeTagInput<
	T extends HTMLInputElement | HTMLTextAreaElement,
>(value: string, onChange: (next: string) => void): MergeTagInputResult<T> {
	const inputRef = useRef<T | null>(null);

	const insertAtCursor = useCallback(
		(token: string) => {
			const el = inputRef.current;
			const start = el?.selectionStart ?? value.length;
			const end = el?.selectionEnd ?? value.length;
			const prefix = value.slice(0, start);
			const suffix = value.slice(end);
			const next = `${prefix}${token}${suffix}`;
			onChange(next);
			requestAnimationFrame(() => {
				const target = inputRef.current;
				if (!target) return;
				const caret = prefix.length + token.length;
				target.focus();
				target.setSelectionRange(caret, caret);
			});
		},
		[value, onChange],
	);

	return { inputRef, insertAtCursor };
}
