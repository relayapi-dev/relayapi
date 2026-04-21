import { z } from "@hono/zod-openapi";

export const PortDirectionSchema = z.enum(["input", "output"]);

export const PortSchema = z.object({
  key: z.string(),
  direction: PortDirectionSchema,
  role: z.string().optional(),         // default / success / error / branch / interactive / timeout / invalid / skip
  label: z.string().optional(),
});

// Block types (inside message.config.blocks)
export const BlockButtonSchema = z.object({
  id: z.string(),
  type: z.enum(["branch", "url", "call", "share"]),
  label: z.string().max(80),
  url: z.string().url().optional(),
  phone: z.string().optional(),
});

export const TextBlockSchema = z.object({
  id: z.string(),
  type: z.literal("text"),
  text: z.string(),
  buttons: z.array(BlockButtonSchema).max(3).optional(),
});

export const ImageBlockSchema = z.object({
  id: z.string(),
  type: z.literal("image"),
  media_ref: z.string(),
  caption: z.string().optional(),
});

export const VideoBlockSchema = z.object({
  id: z.string(),
  type: z.literal("video"),
  media_ref: z.string(),
  caption: z.string().optional(),
});

export const AudioBlockSchema = z.object({
  id: z.string(),
  type: z.literal("audio"),
  media_ref: z.string(),
});

export const FileBlockSchema = z.object({
  id: z.string(),
  type: z.literal("file"),
  media_ref: z.string(),
});

export const CardBlockSchema = z.object({
  id: z.string(),
  type: z.literal("card"),
  media_ref: z.string().optional(),
  title: z.string().max(80),
  subtitle: z.string().max(80).optional(),
  buttons: z.array(BlockButtonSchema).max(3).optional(),
});

export const GalleryBlockSchema = z.object({
  id: z.string(),
  type: z.literal("gallery"),
  cards: z.array(CardBlockSchema).min(1).max(10),
});

export const DelayBlockSchema = z.object({
  id: z.string(),
  type: z.literal("delay"),
  seconds: z.number().min(0.5).max(10),
});

export const MessageBlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ImageBlockSchema,
  VideoBlockSchema,
  AudioBlockSchema,
  FileBlockSchema,
  CardBlockSchema,
  GalleryBlockSchema,
  DelayBlockSchema,
]);

export const QuickReplySchema = z.object({
  id: z.string(),
  label: z.string().max(20),
  icon: z.string().optional(),
});

// Per-kind config schemas (imported at dispatch; use z.any() at the base level)
export const NodeBaseSchema = z.object({
  key: z.string().min(1),
  kind: z.string(),
  title: z.string().optional(),
  canvas_x: z.number().optional(),
  canvas_y: z.number().optional(),
  config: z.record(z.string(), z.any()).default({}),
  ports: z.array(PortSchema).default([]),
  ui_state: z.record(z.string(), z.any()).optional(),
});

export const EdgeSchema = z.object({
  from_node: z.string(),
  from_port: z.string(),
  to_node: z.string(),
  to_port: z.string(),
  order_index: z.number().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

export const GraphSchema = z.object({
  schema_version: z.literal(1),
  root_node_key: z.string().nullable(),
  nodes: z.array(NodeBaseSchema),
  edges: z.array(EdgeSchema),
});

export type Graph = z.infer<typeof GraphSchema>;
export type GraphNode = z.infer<typeof NodeBaseSchema>;
export type GraphEdge = z.infer<typeof EdgeSchema>;
export type Port = z.infer<typeof PortSchema>;
export type MessageBlock = z.infer<typeof MessageBlockSchema>;
export type QuickReply = z.infer<typeof QuickReplySchema>;
