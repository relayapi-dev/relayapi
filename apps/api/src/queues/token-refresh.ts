import { mapConcurrently } from "../lib/concurrency";
import {
	refreshAccountToken,
	TokenRefreshAccountUnavailableError,
	TokenRefreshUnknownError,
} from "../services/token-refresh-coordinator";
import type { Env } from "../types";
import { recordQueueFailure } from "./failures";

interface TokenRefreshMessage {
	type: string;
	account_id: string;
	organization_id: string;
}

// Cap concurrency: each refresh talks to an OAuth provider. Too high risks
// platform rate limits; too low wastes the batch window.
const TOKEN_REFRESH_CONCURRENCY = 4;

export async function consumeTokenRefreshQueue(
	batch: MessageBatch<TokenRefreshMessage>,
	env: Env,
): Promise<void> {
	await mapConcurrently(
		batch.messages,
		TOKEN_REFRESH_CONCURRENCY,
		async (message) => {
			const body = message.body as TokenRefreshMessage | null;
			if (
				body?.type !== "refresh_token" ||
				typeof body.account_id !== "string" ||
				body.account_id.length === 0 ||
				typeof body.organization_id !== "string" ||
				body.organization_id.length === 0
			) {
				await recordQueueFailure(
					env,
					batch.queue,
					message,
					"permanent_input",
					"Malformed or unsupported token refresh message",
				);
				message.ack();
				return;
			}

			try {
				await refreshAccountToken(env, body.account_id, body.organization_id);
				message.ack();
			} catch (err) {
				console.error(`[Token Refresh] Failed for ${body.account_id}:`, err);
				if (
					err instanceof TokenRefreshUnknownError ||
					err instanceof TokenRefreshAccountUnavailableError
				) {
					// The durable operation is now a manual-reconciliation barrier. A
					// Queue retry cannot safely call the provider and would only loop.
					message.ack();
					return;
				}
				message.retry({ delaySeconds: 60 });
			}
		},
	);
}
