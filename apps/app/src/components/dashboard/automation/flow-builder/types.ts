export type AutomationStatus = "draft" | "active" | "paused" | "archived";

export interface AutomationNodeSpec {
	type: string;
	key: string;
	notes?: string;
	canvas_x?: number;
	canvas_y?: number;
	[field: string]: unknown;
}

export interface AutomationEdgeSpec {
	from: string;
	to: string;
	label?: string;
	order?: number;
	condition_expr?: unknown;
}

export interface AutomationTriggerSpec {
	id: string;
	type: string;
	account_id: string | null;
	config: Record<string, unknown>;
	filters: Record<string, unknown>;
	label: string;
	order_index: number;
}

export interface AutomationDetail {
	id: string;
	name: string;
	description?: string | null;
	channel: string;
	status: AutomationStatus;
	triggers: AutomationTriggerSpec[];
	nodes: AutomationNodeSpec[];
	edges: AutomationEdgeSpec[];
	workspace_id?: string | null;
	published_version?: number | null;
	draft_version?: number | null;
	created_at: string;
	updated_at: string;
}

export interface SchemaNodeDef {
	type: string;
	description?: string;
	category: string;
	fields_schema: Record<string, unknown>;
	output_labels: string[];
}

export interface SchemaTriggerDef {
	type: string;
	description?: string;
	channel: string;
	tier?: string;
	transport?: string;
	config_schema: Record<string, unknown>;
	output_labels: string[];
}

export interface AutomationSchema {
	triggers: SchemaTriggerDef[];
	nodes: SchemaNodeDef[];
	templates: Array<{
		id: string;
		name: string;
		description?: string;
		input_schema: Record<string, unknown>;
	}>;
	merge_tags: string[];
}
