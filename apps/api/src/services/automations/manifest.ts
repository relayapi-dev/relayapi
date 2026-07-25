// apps/api/src/services/automations/manifest.ts
//
// Runtime handler registry for the 12-node automation vocabulary.
// See spec §8.4: adding a node kind = implementing NodeHandler + registering.
import { actionGroupHandler } from "./nodes/action-group";
import { conditionHandler } from "./nodes/condition";
import { delayHandler } from "./nodes/delay";
import { endHandler } from "./nodes/end";
import { gotoHandler } from "./nodes/goto";
import { httpRequestHandler } from "./nodes/http-request";
import { inputHandler } from "./nodes/input";
import { messageHandler } from "./nodes/message";
import { randomizerHandler } from "./nodes/randomizer";
import { socialProfileCheckHandler } from "./nodes/social-profile-check";
import { startAutomationHandler } from "./nodes/start-automation";
import { waitEventHandler } from "./nodes/wait-event";
import type { NodeHandler } from "./types";

export const handlers: Record<string, NodeHandler> = {
	message: messageHandler,
	input: inputHandler,
	delay: delayHandler,
	condition: conditionHandler,
	randomizer: randomizerHandler,
	social_profile_check: socialProfileCheckHandler,
	action_group: actionGroupHandler,
	http_request: httpRequestHandler,
	start_automation: startAutomationHandler,
	wait_event: waitEventHandler,
	goto: gotoHandler,
	end: endHandler,
};

export function getHandler(kind: string): NodeHandler | null {
	return handlers[kind] ?? null;
}
