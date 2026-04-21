// assign_conversation / unassign_conversation / conversation_open / close /
// conversation_snooze forms.

import { useEffect, useState } from "react";
import { organization } from "@/lib/auth-client";
import type {
	AssignConversationAction,
	ConversationSnoozeAction,
} from "../types";
import { Field, FormShell, INPUT_CLS } from "./shared";

interface MemberRow {
	id: string;
	user: {
		id: string;
		name: string;
		email: string;
	};
	role: string;
}

type AssignProps = {
	action: AssignConversationAction;
	onChange(next: AssignConversationAction): void;
	error?: string | null;
};

export function AssignConversationForm({
	action,
	onChange,
	error,
}: AssignProps) {
	const [members, setMembers] = useState<MemberRow[]>([]);
	const [loading, setLoading] = useState(true);
	const [loadFailed, setLoadFailed] = useState(false);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			setLoading(true);
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
				if (!cancelled) setLoadFailed(true);
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<FormShell>
			<Field
				label="Assignee"
				required
				description="Use round-robin to rotate conversations across teammates."
				error={error}
			>
				<select
					value={action.user_id}
					onChange={(e) => onChange({ ...action, user_id: e.target.value })}
					className={INPUT_CLS}
					disabled={loading}
				>
					<option value="">Select an assignee…</option>
					<option value="round_robin">Round-robin</option>
					<option value="unassigned">Unassigned</option>
					{loadFailed ? (
						<option value="" disabled>
							— team list failed to load —
						</option>
					) : (
						members.map((m) => (
							<option key={m.user.id} value={m.user.id}>
								{m.user.name || m.user.email}
							</option>
						))
					)}
				</select>
			</Field>
			{loadFailed ? (
				<p className="text-[11px] text-amber-600">
					Couldn't load team members. Paste a user id manually if you know it.
				</p>
			) : null}
			{loadFailed ? (
				<input
					type="text"
					value={action.user_id}
					onChange={(e) => onChange({ ...action, user_id: e.target.value })}
					placeholder="user id"
					className={INPUT_CLS}
				/>
			) : null}
		</FormShell>
	);
}

type SnoozeProps = {
	action: ConversationSnoozeAction;
	onChange(next: ConversationSnoozeAction): void;
	error?: string | null;
};

export function SnoozeConversationForm({
	action,
	onChange,
	error,
}: SnoozeProps) {
	return (
		<FormShell>
			<Field
				label="Snooze duration (minutes)"
				required
				description="Reopens automatically after this delay."
				error={error}
			>
				<input
					type="number"
					min={1}
					value={Number.isFinite(action.snooze_minutes) ? action.snooze_minutes : ""}
					onChange={(e) => {
						const v = Number(e.target.value);
						onChange({
							...action,
							snooze_minutes: Number.isFinite(v) ? Math.max(1, v) : 1,
						});
					}}
					className={INPUT_CLS}
					placeholder="e.g. 60"
				/>
			</Field>
		</FormShell>
	);
}

export function NoFieldsInfo({ label }: { label: string }) {
	return (
		<div className="rounded-md border border-dashed border-[#d9dde6] bg-[#fbfcfe] px-3 py-2 text-[11px] text-[#64748b]">
			{label} — no configuration required.
		</div>
	);
}
