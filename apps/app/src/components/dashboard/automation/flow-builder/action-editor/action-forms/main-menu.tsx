import {
	type ProviderConfig,
	ProviderConfigEditor,
} from "../../../bindings-tab/provider-binding-tab";
import type { ChangeMainMenuAction, MainMenuPayload } from "../types";

export function ChangeMainMenuForm({
	action,
	onChange,
	errors,
}: {
	action: ChangeMainMenuAction;
	onChange(next: ChangeMainMenuAction): void;
	errors: Record<string, string>;
}) {
	const update = (next: ProviderConfig) => {
		if (!("items" in next)) return;
		onChange({ ...action, menu_payload: next as MainMenuPayload });
	};

	return (
		<div className="space-y-3">
			<div className="rounded-md border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-[11px] text-muted-foreground">
				This sets a Messenger menu for the current Facebook contact. The
				account-level menu remains unchanged.
			</div>
			<ProviderConfigEditor
				type="main_menu"
				channel="facebook"
				config={action.menu_payload}
				onChange={update}
				disabled={false}
			/>
			{Object.values(errors)[0] ? (
				<p className="text-[11px] text-destructive">
					{Object.values(errors)[0]}
				</p>
			) : null}
		</div>
	);
}
