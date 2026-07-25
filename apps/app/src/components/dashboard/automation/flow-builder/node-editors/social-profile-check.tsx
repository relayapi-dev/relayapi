import { FormShell } from "./shared";

export function SocialProfileCheckEditor() {
	return (
		<FormShell>
			<div className="rounded-xl border border-[#e6e9ef] bg-[#f8f9fb] p-3">
				<p className="text-[12px] font-medium text-[#353a44]">
					Instagram follow relationship
				</p>
				<p className="mt-1 text-[11px] leading-4 text-[#7e8695]">
					Checks Meta’s live <code>is_user_follow_business</code> profile field,
					then routes to Follows, Does not follow, or Error.
				</p>
			</div>
		</FormShell>
	);
}
