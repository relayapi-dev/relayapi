import { refreshAccountToken } from "../services/token-refresh";
import type { Env } from "../types";

interface TokenRefreshMessage {
	type: string;
	account_id: string;
}

export async function consumeTokenRefreshQueue(
	batch: MessageBatch<TokenRefreshMessage>,
	env: Env,
): Promise<void> {
	for (const message of batch.messages) {
		const body = message.body;
		if (body.type !== "refresh_token") {
			message.ack();
			continue;
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
	}
}
