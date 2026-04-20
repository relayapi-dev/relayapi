export const TRIGGER_UI_POSITION_KEY = "__ui_canvas_position";

export interface TriggerCanvasPosition {
	x: number;
	y: number;
}

export function triggerConfigRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? { ...(value as Record<string, unknown>) }
		: {};
}

export function defaultTriggerLabel(
	triggerType: string,
	index: number,
): string {
	const base = triggerType
		.replace(/^instagram_/, "")
		.replace(/^facebook_/, "")
		.replace(/^whatsapp_/, "")
		.replace(/^telegram_/, "");
	const normalized = base
		.split("_")
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");

	if (normalized === "Dm") return `Message #${index}`;
	if (normalized === "Story Reply") return `Story Reply #${index}`;
	if (normalized === "Story Mention") return `Story Mention #${index}`;
	if (normalized === "Comment") return `Comment Reply #${index}`;
	return `${normalized} #${index}`;
}

export function makeLocalTriggerId(): string {
	return `local_${Math.random().toString(36).slice(2, 10)}`;
}

export function triggerCanvasPosition(
	triggers: Array<{ config: Record<string, unknown> }>,
): TriggerCanvasPosition | null {
	const first = triggers[0];
	if (!first) return null;
	const value = first.config?.[TRIGGER_UI_POSITION_KEY];
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const x = (value as Record<string, unknown>).x;
	const y = (value as Record<string, unknown>).y;
	return typeof x === "number" && typeof y === "number" ? { x, y } : null;
}

export function withTriggerCanvasPosition(
	configValue: unknown,
	position: TriggerCanvasPosition,
): Record<string, unknown> {
	const config = triggerConfigRecord(configValue);
	config[TRIGGER_UI_POSITION_KEY] = position;
	return config;
}
