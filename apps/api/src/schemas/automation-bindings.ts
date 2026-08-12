import { z } from "@hono/zod-openapi";
import { AUTOMATION_BINDING_TYPES } from "@relayapi/db";

export const DefaultReplyConfig = z.object({}).strict();
export const WelcomeMessageConfig = z.object({}).strict();

export const GetStartedConfig = z
	.object({ payload: z.string().min(1).max(1_000) })
	.strict();

export const MainMenuItemSchema = z.discriminatedUnion("action", [
	z
		.object({
			label: z.string().min(1).max(30),
			action: z.literal("postback"),
			payload: z.string().min(1).max(1_000),
		})
		.strict(),
	z
		.object({
			label: z.string().min(1).max(30),
			action: z.literal("url"),
			url: z.string().url().max(2_000),
		})
		.strict(),
]);

export const MainMenuConfig = z
	.object({
		items: z.array(MainMenuItemSchema).min(1).max(20),
		composer_input_disabled: z.boolean().default(false),
	})
	.strict();

export const IceBreakerConfig = z
	.object({
		questions: z
			.array(
				z
					.object({
						question: z.string().min(1).max(80),
						payload: z.string().min(1).max(1_000),
					})
					.strict(),
			)
			.min(1)
			.max(4),
	})
	.strict();

export const BindingTypeSchema = z.enum(AUTOMATION_BINDING_TYPES);
export type BindingType = z.infer<typeof BindingTypeSchema>;

export const BindingConfigByType = {
	default_reply: DefaultReplyConfig,
	welcome_message: WelcomeMessageConfig,
	get_started: GetStartedConfig,
	main_menu: MainMenuConfig,
	ice_breaker: IceBreakerConfig,
} satisfies Record<BindingType, z.ZodSchema>;

export const BindingCreateSchema = z
	.object({
		social_account_id: z.string(),
		channel: z.enum(["instagram", "facebook", "whatsapp", "telegram"]),
		binding_type: BindingTypeSchema,
		automation_id: z.string(),
		config: z.record(z.string(), z.any()).default({}),
		workspace_id: z.string().optional(),
	})
	.strict();

export const BindingUpdateSchema = z
	.object({
		automation_id: z.string().min(1).optional(),
		config: z.record(z.string(), z.any()).optional(),
		status: z.enum(["active", "paused"]).optional(),
	})
	.strict()
	.refine(
		(value) => Object.keys(value).length > 0,
		"At least one binding property is required",
	);

export function isProviderBindingType(type: string): boolean {
	return (
		type === "get_started" || type === "main_menu" || type === "ice_breaker"
	);
}

export function isBindingTypeSupportedOnChannel(
	type: string,
	channel: string,
): boolean {
	if (type === "get_started") return channel === "facebook";
	if (type === "ice_breaker") return channel === "instagram";
	if (type === "main_menu")
		return channel === "facebook" || channel === "instagram";
	return true;
}

export function getBindingConfigChannelError(
	type: string,
	channel: string,
	config: Record<string, unknown>,
): string | null {
	if (
		type === "main_menu" &&
		channel === "instagram" &&
		config.composer_input_disabled === true
	) {
		return "Instagram persistent menus do not support disabling the message composer";
	}
	return null;
}
