// apps/api/src/services/automations/actions/types.ts
//
// Shared types for action-group side-effect handlers. Each handler takes a
// single discriminated-union `Action` and the current `RunContext`, applies
// its effect, and returns. Errors throw — the action_group node decides
// abort-or-continue based on `action.on_error`.

import type { Action } from "../../../schemas/automation-actions";
import type { RunContext } from "../types";

export type ActionHandler<A extends Action = Action> = (
	action: A,
	ctx: RunContext,
) => Promise<void>;

// Registry values are handlers for specific Action subtypes. `never` is the
// broadest assignable parameter type (contravariance), so any concrete
// ActionHandler<SpecificAction> is assignable here. dispatchAction casts back
// to ActionHandler<Action> before invoking.
export type ActionRegistry = Record<string, ActionHandler<never>>;
