import { createDb } from "@relayapi/db";
import type { Env } from "../types";
import {
	reconcileExpiredAutomationNodeExecutions,
	reconcileExternalEventWaits,
} from "./automations/runner";

export async function reconcileAutomationWaits(env: Env): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const result = await reconcileExternalEventWaits(
		db,
		env as unknown as Record<string, unknown>,
	);
	const nodeExecutions = await reconcileExpiredAutomationNodeExecutions(db);
	if (result.resumed > 0) {
		console.info(
			JSON.stringify({ event: "automation_waits_reconciled", ...result }),
		);
	}
	if (nodeExecutions.queued > 0) {
		console.info(
			JSON.stringify({
				event: "automation_node_executions_requeued",
				...nodeExecutions,
			}),
		);
	}
}
