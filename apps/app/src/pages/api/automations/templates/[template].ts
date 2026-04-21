import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

// Legacy template surface — the v2 automation system inlines template
// expansion into the create endpoint. Map the old URL slug to the new
// `template.kind` discriminator and proxy through `client.automations.create`.
const LEGACY_TO_KIND: Record<string, string> = {
	"comment-to-dm": "comment_to_dm",
	"welcome-dm": "welcome_flow",
	"welcome-message": "welcome_flow",
	"default-reply": "welcome_flow",
	"keyword-reply": "faq_bot",
	"follow-to-dm": "follow_to_dm",
	giveaway: "comment_to_dm",
};

export const POST: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const template = ctx.params.template as string;
		const kind = LEGACY_TO_KIND[template];
		if (!kind) {
			return Response.json(
				{
					error: {
						code: "unknown_template",
						message: `Unknown template '${template}'`,
					},
				},
				{ status: 400 },
			);
		}
		const body = (await ctx.request.json()) as Record<string, unknown>;
		const channel = (body.channel as string | undefined) ?? "instagram";
		const data = await client.automations.create({
			name: (body.name as string) ?? `From ${template}`,
			description: body.description as string | undefined,
			workspace_id: body.workspace_id as string | undefined,
			channel: channel as never,
			template: { kind, config: body as Record<string, unknown> },
		});
		return Response.json(data, { status: 201 });
	} catch (e) {
		return handleSdkError(e);
	}
};
