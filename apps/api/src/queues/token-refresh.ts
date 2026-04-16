import { mapConcurrently } from "../lib/concurrency";
import { refreshAccountToken } from "../services/token-refresh";
import type { Env } from "../types";

interface TokenRefreshMessage {
	type: string;
	account_id: string;
}

// Cap concurrency: each refresh talks to an OAuth provider. Too high risks
// platform rate limits; too low wastes the batch window.
const TOKEN_REFRESH_CONCURRENCY = 10;

export async function consumeTokenRefreshQueue(
	batch: MessageBatch<TokenRefreshMessage>,
	env: Env,
): Promise<void> {
	await mapConcurrently(
		batch.messages,
		TOKEN_REFRESH_CONCURRENCY,
		async (message) => {
			const body = message.body;
			if (body.type !== "refresh_token") {
				message.ack();
				return;
			}

			try {
				await refreshAccountToken(env, body.account_id);
				message.ack();
			} catch (err) {
				console.error(`[Token Refresh] Failed for ${body.account_id}:`, err);
				if (message.attempts >= 5) {
					console.error(
						`[Token Refresh] Max retries exceeded for ${body.account_id}, dropping`,
					);
					message.ack();
				} else {
					message.retry({ delaySeconds: 60 });
				}
			}
		},
	);
}
