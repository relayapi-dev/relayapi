// apps/api/src/services/automations/actions/index.ts
//
// Central registry + dispatcher for all action-group side-effect handlers.
// The `action_group` node iterates its config.actions array and calls
// `dispatchAction(action, ctx)` for each.

import type { Action } from "../../../schemas/automation-actions";
import type { RunContext } from "../types";
import { automationControlHandlers } from "./automation-controls";
import { changeMainMenuHandlers } from "./change-main-menu";
import { commentHandlers } from "./comment";
import { contactHandlers } from "./contact";
import { conversationHandlers } from "./conversation";
import { conversionHandlers } from "./conversion";
import { fieldHandlers } from "./field";
import { notifyHandlers } from "./notify";
import { segmentHandlers } from "./segment";
import { subscriptionHandlers } from "./subscription";
import { tagHandlers } from "./tag";
import type { ActionHandler, ActionRegistry } from "./types";
import { webhookHandlers } from "./webhook";

export const actionRegistry: ActionRegistry = {
	...tagHandlers,
	...fieldHandlers,
	...segmentHandlers,
	...subscriptionHandlers,
	...conversationHandlers,
	...commentHandlers,
	...notifyHandlers,
	...webhookHandlers,
	...automationControlHandlers,
	...contactHandlers,
	...conversionHandlers,
	...changeMainMenuHandlers,
};

export async function dispatchAction(
	action: Action,
	ctx: RunContext,
): Promise<void> {
	const handler = actionRegistry[action.type] as
		| ActionHandler<Action>
		| undefined;
	if (!handler) {
		throw new Error(`unknown action type: ${action.type}`);
	}
	await handler(action, ctx);
}

export type { ActionHandler, ActionRegistry };
