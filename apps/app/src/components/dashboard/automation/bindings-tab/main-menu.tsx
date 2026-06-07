// Main Menu binding tab — Plan 3 Unit C3, Task T3.
//
// Available on FB + IG only (see spec §6.4). Stubbed for v1 — storage + UI
// ships here, platform push via Messenger Profile API lands in v1.1.
//
// Thin wrapper over the shared binding-editors registry + StubbedBindingShell.
// The menu editor, config parsing, and copy now live in ./binding-editors so
// the automation canvas can reuse the exact same UI.

import { BINDING_CONFIG_EDITORS } from "./binding-editors";
import { StubbedBindingShell } from "./stubbed-shell";

interface Props {
	socialAccountId: string;
	channel: "facebook" | "instagram";
}

const ED = BINDING_CONFIG_EDITORS.main_menu;

export function MainMenuTab({ socialAccountId, channel }: Props) {
	return (
		<StubbedBindingShell
			socialAccountId={socialAccountId}
			channel={channel}
			bindingType="main_menu"
			title={ED.title}
			subtitle={ED.subtitle}
			bannerCopy={ED.bannerCopy ?? ""}
			emptyConfig={ED.emptyConfig}
			parseConfig={ED.parseConfig}
			validateConfig={ED.validateConfig}
			renderEditor={ED.renderEditor!}
		/>
	);
}
