import { z } from "@hono/zod-openapi";

export const DefaultReplyConfig = z.object({}).passthrough();
export const WelcomeMessageConfig = z.object({}).passthrough();

export const ConversationStarterConfig = z.object({
  starters: z.array(z.object({
    label: z.string().max(30),
    payload: z.string().max(200),
  })).max(4),
});

export const MainMenuItemSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    label: z.string().max(30),
    action: z.enum(["postback", "url"]),
    payload: z.string(),
    sub_items: z.array(MainMenuItemSchema).max(5).optional(),
  })
);

export const MainMenuConfig = z.object({
  items: z.array(MainMenuItemSchema).max(3),
});

export const IceBreakerConfig = z.object({
  questions: z.array(z.object({
    question: z.string().max(80),
    payload: z.string(),
  })).max(4),
});

export const BindingConfigByType: Record<string, z.ZodSchema> = {
  default_reply: DefaultReplyConfig,
  welcome_message: WelcomeMessageConfig,
  conversation_starter: ConversationStarterConfig,
  main_menu: MainMenuConfig,
  ice_breaker: IceBreakerConfig,
};

export const BindingCreateSchema = z.object({
  social_account_id: z.string(),
  channel: z.enum(["instagram", "facebook", "whatsapp", "telegram", "tiktok"]),
  binding_type: z.enum(["default_reply", "welcome_message", "conversation_starter", "main_menu", "ice_breaker"]),
  automation_id: z.string(),
  config: z.record(z.string(), z.any()).default({}),
  workspace_id: z.string().optional(),
});

export const BindingUpdateSchema = BindingCreateSchema.partial().extend({
  status: z.enum(["active", "paused", "pending_sync", "sync_failed"]).optional(),
});
