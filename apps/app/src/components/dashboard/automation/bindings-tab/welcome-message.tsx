// Welcome Message binding tab — Plan 3 Unit C3, Task T2.
//
// Thin wrapper around `SimpleAutomationBindingTab`. "Welcome message" fires
// only on the contact's first-ever inbound message on the channel — see spec
// §6.6 step 8. Copy is sourced from the shared binding-editors registry.

import { BINDING_CONFIG_EDITORS } from "./binding-editors";
import { SimpleAutomationBindingTab } from "./simple-binding-tab";
import type { BindingChannel } from "./types";

interface Props {
	socialAccountId: string;
	channel: BindingChannel;
}

const ED = BINDING_CONFIG_EDITORS.welcome_message;

export function WelcomeMessageTab({ socialAccountId, channel }: Props) {
	return (
		<SimpleAutomationBindingTab
			socialAccountId={socialAccountId}
			channel={channel}
			bindingType="welcome_message"
			title={ED.title}
			subtitle={ED.subtitle}
		/>
	);
}
