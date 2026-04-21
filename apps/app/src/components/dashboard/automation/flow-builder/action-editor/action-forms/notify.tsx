// notify_admin form.

import { useEffect, useState } from "react";
import { organization } from "@/lib/auth-client";
import {
	MergeTagPicker,
	useMergeTagInput,
} from "../../message-composer/merge-tag-picker";
import type { NotifyAdminAction } from "../types";
import { Field, FormShell, INPUT_CLS } from "./shared";

interface MemberRow {
	id: string;
	user: { id: string; name: string; email: string };
}

type Props = {
	action: NotifyAdminAction;
	onChange(next: NotifyAdminAction): void;
	errors?: Record<string, string>;
};

export function NotifyAdminForm({ action, onChange, errors }: Props) {
	const [members, setMembers] = useState<MemberRow[]>([]);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const result = await organization.listMembers();
				if (cancelled) return;
				const raw = result?.data;
				const list = Array.isArray(raw)
					? raw
					: Array.isArray((raw as { members?: unknown })?.members)
						? (raw as { members: unknown[] }).members
						: [];
				setMembers(list as MemberRow[]);
			} catch {
				// Optional — silently fall back to an empty list
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const bodyMerge = useMergeTagInput<HTMLTextAreaElement>(
		action.body,
		(next) => onChange({ ...action, body: next }),
	);
	const titleMerge = useMergeTagInput<HTMLInputElement>(
		action.title,
		(next) => onChange({ ...action, title: next }),
	);

	const selectedRecipients = new Set(action.recipient_user_ids ?? []);
	const toggleRecipient = (userId: string) => {
		const next = new Set(selectedRecipients);
		if (next.has(userId)) next.delete(userId);
		else next.add(userId);
		onChange({
			...action,
			recipient_user_ids: next.size === 0 ? undefined : Array.from(next),
		});
	};

	return (
		<FormShell>
			<Field
				label="Title"
				required
				error={errors?.title}
				right={<MergeTagPicker onPick={titleMerge.insertAtCursor} />}
			>
				<input
					ref={titleMerge.inputRef}
					type="text"
					value={action.title}
					onChange={(e) => onChange({ ...action, title: e.target.value })}
					placeholder="Notification title"
					className={INPUT_CLS}
				/>
			</Field>

			<Field
				label="Body"
				required
				description="Merge tags supported."
				error={errors?.body}
				right={<MergeTagPicker onPick={bodyMerge.insertAtCursor} />}
			>
				<textarea
					ref={bodyMerge.inputRef}
					value={action.body}
					onChange={(e) => onChange({ ...action, body: e.target.value })}
					rows={3}
					placeholder="What happened?"
					className="w-full resize-y rounded-xl border border-[#d9dde6] bg-white px-3 py-2 text-[13px] outline-none focus:border-[#8ab4ff]"
				/>
			</Field>

			<Field
				label="Link"
				description="Optional deep-link included with the notification."
			>
				<input
					type="url"
					value={action.link ?? ""}
					onChange={(e) =>
						onChange({ ...action, link: e.target.value || undefined })
					}
					placeholder="https://…"
					className={INPUT_CLS}
				/>
			</Field>

			<Field
				label="Recipients"
				description={
					members.length === 0
						? "No team members loaded — defaults to all admins."
						: "Leave empty to notify all admins."
				}
			>
				<div className="space-y-1">
					{members.map((m) => (
						<label
							key={m.user.id}
							className="flex items-center gap-2 rounded-md px-1 py-1 text-[12px] hover:bg-[#f5f8fc]"
						>
							<input
								type="checkbox"
								checked={selectedRecipients.has(m.user.id)}
								onChange={() => toggleRecipient(m.user.id)}
								className="h-4 w-4 rounded border-[#cdd5e1]"
							/>
							<span>{m.user.name || m.user.email}</span>
						</label>
					))}
				</div>
			</Field>
		</FormShell>
	);
}
