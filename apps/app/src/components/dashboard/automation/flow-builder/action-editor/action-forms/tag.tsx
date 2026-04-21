// tag_add / tag_remove form.
//
// Free-text tag-name input with suggestions from the tag list proxy
// (`/api/tags`). If the tag list fails or is empty, the input still works as
// a plain text field.

import { useEffect, useRef, useState } from "react";
import { Check, Tag as TagIcon } from "lucide-react";
import type { TagAddAction, TagRemoveAction } from "../types";
import { Field, FormShell, INPUT_CLS } from "./shared";

interface TagRow {
	id: string;
	name: string;
	color: string;
}

interface TagListResponse {
	data: TagRow[];
	has_more: boolean;
	next_cursor: string | null;
}

type Props = {
	action: TagAddAction | TagRemoveAction;
	onChange(next: TagAddAction | TagRemoveAction): void;
	error?: string | null;
};

export function TagActionForm({ action, onChange, error }: Props) {
	const [tags, setTags] = useState<TagRow[]>([]);
	const [open, setOpen] = useState(false);
	const wrapperRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch("/api/tags?limit=100");
				if (!res.ok) return;
				const body = (await res.json()) as TagListResponse;
				if (!cancelled && Array.isArray(body.data)) setTags(body.data);
			} catch {
				// ignore — fall back to free-text entry
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!open) return;
		function onDocClick(e: MouseEvent) {
			if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
		}
		document.addEventListener("mousedown", onDocClick);
		return () => document.removeEventListener("mousedown", onDocClick);
	}, [open]);

	const query = action.tag.trim().toLowerCase();
	const filtered = query
		? tags.filter((t) => t.name.toLowerCase().includes(query))
		: tags;

	return (
		<FormShell>
			<Field
				label="Tag"
				required
				description={
					action.type === "tag_add"
						? "Applied to the enrolled contact. Unknown names create a new tag on the first use."
						: "Removed from the enrolled contact. No-op if the contact doesn't have it."
				}
				error={error}
			>
				<div ref={wrapperRef} className="relative">
					<input
						type="text"
						value={action.tag}
						onChange={(e) => onChange({ ...action, tag: e.target.value })}
						onFocus={() => setOpen(true)}
						placeholder="e.g. lead, customer, vip"
						className={INPUT_CLS}
					/>
					{open && filtered.length > 0 ? (
						<div className="absolute z-20 mt-1 max-h-[220px] w-full overflow-auto rounded-lg border border-[#e6e9ef] bg-white p-1 shadow-lg">
							{filtered.slice(0, 30).map((tag) => (
								<button
									key={tag.id}
									type="button"
									onClick={() => {
										onChange({ ...action, tag: tag.name });
										setOpen(false);
									}}
									className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-[#f5f8fc]"
								>
									<TagIcon
										className="size-3"
										style={{ color: tag.color }}
									/>
									<span className="flex-1 font-medium text-[#1f2937]">
										{tag.name}
									</span>
									{tag.name === action.tag ? (
										<Check className="size-3 text-[#64748b]" />
									) : null}
								</button>
							))}
						</div>
					) : null}
				</div>
			</Field>
		</FormShell>
	);
}
