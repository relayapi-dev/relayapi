// Default Reply binding tab — Plan 3 Unit C3, Task T2.
//
// Thin wrapper around `SimpleAutomationBindingTab` that carries the
// binding_type + copy for this surface. "Default reply" fires when the inbox
// processor finds no matching entrypoint for an inbound DM — see spec §6.6
// step 7. Copy is sourced from the shared binding-editors registry.

import { BINDING_CONFIG_EDITORS } from "./binding-editors";
import { SimpleAutomationBindingTab } from "./simple-binding-tab";
import type { BindingChannel } from "./types";

interface Props {
	socialAccountId: string;
	channel: BindingChannel;
}

const ED = BINDING_CONFIG_EDITORS.default_reply;

export function DefaultReplyTab({ socialAccountId, channel }: Props) {
	return (
		<SimpleAutomationBindingTab
			socialAccountId={socialAccountId}
			channel={channel}
			bindingType="default_reply"
			title={ED.title}
			subtitle={ED.subtitle}
		/>
	);
}
