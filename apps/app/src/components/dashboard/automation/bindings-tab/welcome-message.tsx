// Welcome Message binding tab — Plan 3 Unit C3, Task T2.
//
// Thin wrapper around `SimpleAutomationBindingTab`. "Welcome message" fires
// only on the contact's first-ever inbound message on the channel — see spec
// §6.6 step 8.

import { SimpleAutomationBindingTab } from "./simple-binding-tab";
import type { BindingChannel } from "./types";

interface Props {
	socialAccountId: string;
	channel: BindingChannel;
}

export function WelcomeMessageTab({ socialAccountId, channel }: Props) {
	return (
		<SimpleAutomationBindingTab
			socialAccountId={socialAccountId}
			channel={channel}
			bindingType="welcome_message"
			title="Welcome Message"
			subtitle="Runs on the contact's first-ever inbound message to this account."
		/>
	);
}
