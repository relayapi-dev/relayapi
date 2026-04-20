import type { AutomationDetail } from "./types";

export const TRIGGER_UI_DISPLAY_KEY = "__ui_display_triggers";
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

export function triggerDisplayRows(
	automation: Pick<AutomationDetail, "trigger_config" | "trigger_type">,
): string[] {
	const config = triggerConfigRecord(automation.trigger_config);
	const rows = config[TRIGGER_UI_DISPLAY_KEY];
	if (Array.isArray(rows)) {
		const normalized = rows
			.map((entry) => (typeof entry === "string" ? entry.trim() : ""))
			.filter(Boolean);
		if (normalized.length > 0) return normalized;
	}
	return [defaultTriggerLabel(automation.trigger_type, 1)];
}

export function withTriggerDisplayRows(
	configValue: unknown,
	rows: string[],
): Record<string, unknown> | undefined {
	const config = triggerConfigRecord(configValue);
	const normalized = rows.map((row) => row.trim()).filter(Boolean);
	if (normalized.length > 1 || normalized[0] !== undefined) {
		config[TRIGGER_UI_DISPLAY_KEY] = normalized;
	} else {
		delete config[TRIGGER_UI_DISPLAY_KEY];
	}
	return Object.keys(config).length > 0 ? config : undefined;
}

export function triggerCanvasPosition(
	automation: Pick<AutomationDetail, "trigger_config">,
): TriggerCanvasPosition | null {
	const config = triggerConfigRecord(automation.trigger_config);
	const value = config[TRIGGER_UI_POSITION_KEY];
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const x = (value as Record<string, unknown>).x;
	const y = (value as Record<string, unknown>).y;
	return typeof x === "number" && typeof y === "number" ? { x, y } : null;
}

export function withTriggerCanvasPosition(
	configValue: unknown,
	position: TriggerCanvasPosition,
): Record<string, unknown> | undefined {
	const config = triggerConfigRecord(configValue);
	config[TRIGGER_UI_POSITION_KEY] = position;
	return Object.keys(config).length > 0 ? config : undefined;
}
