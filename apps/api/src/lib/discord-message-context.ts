export const DISCORD_THREAD_CONTEXT_EFFECT = "discord_thread_context";

const DISCORD_SNOWFLAKE = /^\d{17,20}$/;

export function isDiscordSnowflake(value: unknown): value is string {
	return typeof value === "string" && DISCORD_SNOWFLAKE.test(value.trim());
}

export type DiscordThreadContext = {
	required: boolean;
	threadId?: string;
};

/**
 * Resolve only the provider-confirmed thread marker written by the Discord
 * publisher. A present but incomplete marker remains `required` so edits fail
 * closed instead of accidentally targeting the parent webhook channel.
 */
export function discordThreadContextFromEffects(
	effects: unknown,
): DiscordThreadContext {
	if (!Array.isArray(effects)) return { required: false };
	const marker = effects.find(
		(effect) =>
			!!effect &&
			typeof effect === "object" &&
			(effect as Record<string, unknown>).name ===
				DISCORD_THREAD_CONTEXT_EFFECT,
	) as Record<string, unknown> | undefined;
	if (!marker) return { required: false };
	return marker.status === "succeeded" && isDiscordSnowflake(marker.provider_id)
		? { required: true, threadId: marker.provider_id.trim() }
		: { required: true };
}
