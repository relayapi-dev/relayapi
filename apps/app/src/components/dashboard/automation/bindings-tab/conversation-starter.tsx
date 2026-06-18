// Conversation Starter binding tab — Plan 3 Unit C3, Task T4.
//
// Facebook-only. Stubbed for v1 — storage + UI ships here, platform push via
// Messenger Profile API's `ice_breakers` field lands in v1.1 (see spec §6.4).
//
// Thin wrapper over the shared binding-editors registry + StubbedBindingShell.
// The starter editor, config parsing, and copy now live in ./binding-editors.

import { BINDING_CONFIG_EDITORS } from "./binding-editors";
import { StubbedBindingShell } from "./stubbed-shell";

interface Props {
	socialAccountId: string;
}

const ED = BINDING_CONFIG_EDITORS.conversation_starter;

export function ConversationStarterTab({ socialAccountId }: Props) {
	const renderEditor = ED.renderEditor;
	if (!renderEditor) return null;
	return (
		<StubbedBindingShell
			socialAccountId={socialAccountId}
			channel="facebook"
			bindingType="conversation_starter"
			title={ED.title}
			subtitle={ED.subtitle}
			bannerCopy={ED.bannerCopy ?? ""}
			emptyConfig={ED.emptyConfig}
			parseConfig={ED.parseConfig}
			validateConfig={ED.validateConfig}
			renderEditor={renderEditor}
		/>
	);
}
