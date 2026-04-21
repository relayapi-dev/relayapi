// Default Reply binding tab — Plan 3 Unit C3, Task T2.
//
// Thin wrapper around `SimpleAutomationBindingTab` that carries the
// binding_type + copy for this surface. "Default reply" fires when the inbox
// processor finds no matching entrypoint for an inbound DM — see spec §6.6
// step 7.

import { SimpleAutomationBindingTab } from "./simple-binding-tab";
import type { BindingChannel } from "./types";

interface Props {
	socialAccountId: string;
	channel: BindingChannel;
}

export function DefaultReplyTab({ socialAccountId, channel }: Props) {
	return (
		<SimpleAutomationBindingTab
			socialAccountId={socialAccountId}
			channel={channel}
			bindingType="default_reply"
			title="Default Reply"
			subtitle="Runs when no other entrypoint matches this inbound DM."
		/>
	);
}
