// reply_to_comment form.

import {
	MergeTagPicker,
	useMergeTagInput,
} from "../../message-composer/merge-tag-picker";
import type { ReplyToCommentAction } from "../types";
import { Field, FormShell } from "./shared";

type Props = {
	action: ReplyToCommentAction;
	onChange(next: ReplyToCommentAction): void;
	error?: string | null;
};

export function ReplyToCommentForm({ action, onChange, error }: Props) {
	const merge = useMergeTagInput<HTMLTextAreaElement>(action.text, (next) =>
		onChange({ ...action, text: next }),
	);

	return (
		<FormShell>
			<Field
				label="Reply text"
				required
				description="Posts a public reply on the triggering comment. Merge tags supported."
				error={error}
				right={<MergeTagPicker onPick={merge.insertAtCursor} />}
			>
				<textarea
					ref={merge.inputRef}
					value={action.text}
					onChange={(e) => onChange({ ...action, text: e.target.value })}
					rows={4}
					placeholder="Thanks for commenting!"
					className="w-full resize-y rounded-xl border border-[#d9dde6] bg-white px-3 py-2 text-[13px] outline-none focus:border-[#8ab4ff]"
				/>
			</Field>
		</FormShell>
	);
}
