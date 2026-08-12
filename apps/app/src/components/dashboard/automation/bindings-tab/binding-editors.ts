import type { BindingType } from "./types";

export interface BindingDescriptor {
	bindingType: BindingType;
	title: string;
	subtitle: string;
}

/** Copy shared by the per-account tabs and the automation canvas. */
export const BINDING_CONFIG_EDITORS: Record<BindingType, BindingDescriptor> = {
	default_reply: {
		bindingType: "default_reply",
		title: "Default Reply",
		subtitle: "Runs when no other entrypoint matches this inbound DM.",
	},
	welcome_message: {
		bindingType: "welcome_message",
		title: "Welcome Message",
		subtitle:
			"Runs on the contact's first-ever inbound message to this account.",
	},
	get_started: {
		bindingType: "get_started",
		title: "Get Started",
		subtitle: "Starts an automation when a person opens the Messenger thread.",
	},
	main_menu: {
		bindingType: "main_menu",
		title: "Main Menu",
		subtitle:
			"Publishes persistent postback or website actions in the chat menu.",
	},
	ice_breaker: {
		bindingType: "ice_breaker",
		title: "Ice Breakers",
		subtitle: "Publishes up to four starter questions in Instagram Direct.",
	},
};
