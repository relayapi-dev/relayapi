// apps/api/src/services/automations/templates/index.ts
//
// Template dispatcher for the new automation system. Each template expands a
// small set of high-level fields into a graph + entrypoint set that the caller
// (POST /v1/automations) persists. See spec §7 for the template catalog.

import type { Graph } from "../../../schemas/automation-graph";
import { buildBlank } from "./blank";
import { buildCommentToDm } from "./comment-to-dm";
import { buildFaqBot } from "./faq-bot";
import { buildFollowerGrowth } from "./follower-growth";
import { buildFollowToDm } from "./follow-to-dm";
import { buildLeadCapture } from "./lead-capture";
import { buildStoryLeads } from "./story-leads";
import { buildWelcomeFlow } from "./welcome-flow";

export type TemplateKind =
	| "blank"
	| "welcome_flow"
	| "faq_bot"
	| "lead_capture"
	| "comment_to_dm"
	| "story_leads"
	| "follower_growth"
	| "follow_to_dm";

export type TemplateEntrypoint = {
	kind: string;
	config: Record<string, unknown>;
	socialAccountId?: string | null;
	filters?: Record<string, unknown> | null;
	allowReentry?: boolean;
	reentryCooldownMin?: number;
	priority?: number;
};

export type TemplateBuildInput = {
	kind: TemplateKind;
	channel: string;
	config: Record<string, any>;
	socialAccountId?: string;
};

export type TemplateBuildOutput = {
	graph: Graph;
	entrypoints: TemplateEntrypoint[];
	name: string;
	description?: string;
};

export type TemplateBuilder = (input: TemplateBuildInput) => TemplateBuildOutput;

const TEMPLATE_BUILDERS: Record<TemplateKind, TemplateBuilder> = {
	blank: buildBlank,
	welcome_flow: buildWelcomeFlow,
	faq_bot: buildFaqBot,
	lead_capture: buildLeadCapture,
	comment_to_dm: buildCommentToDm,
	story_leads: buildStoryLeads,
	follower_growth: buildFollowerGrowth,
	follow_to_dm: buildFollowToDm,
};

export function buildGraphFromTemplate(
	input: TemplateBuildInput,
): TemplateBuildOutput {
	const builder = TEMPLATE_BUILDERS[input.kind];
	if (!builder) throw new Error(`unknown template kind: ${input.kind}`);
	return builder(input);
}

export function listTemplateKinds(): TemplateKind[] {
	return Object.keys(TEMPLATE_BUILDERS) as TemplateKind[];
}
