// apps/api/src/services/automations/actions/change-main-menu.ts
//
// change_main_menu — v1.1 stub. Requires platform-menu sync infrastructure
// (persistent menu for Messenger / IG bot menus / WhatsApp catalogue) that
// isn't in place yet. The action is surfaced in the builder UI as "disabled"
// so operators see it exists; dispatching it always throws.

import type { Action } from "../../../schemas/automation-actions";
import type { ActionHandler, ActionRegistry } from "./types";

type ChangeMainMenuAction = Extract<Action, { type: "change_main_menu" }>;

const changeMainMenu: ActionHandler<ChangeMainMenuAction> = async () => {
	throw new Error("change_main_menu requires v1.1 platform sync");
};

export const changeMainMenuHandlers: ActionRegistry = {
	change_main_menu: changeMainMenu,
};
