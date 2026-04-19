import type { APIRoute } from "astro";
import { requireClient, handleSdkError } from "@/lib/api-utils";

const DISPATCH = {
	"comment-to-dm": "commentToDm",
	"welcome-dm": "welcomeDm",
	"keyword-reply": "keywordReply",
	"follow-to-dm": "followToDm",
	giveaway: "giveaway",
} as const;

type TemplateId = keyof typeof DISPATCH;

export const POST: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;
	try {
		const template = ctx.params.template as TemplateId;
		const method = DISPATCH[template];
		if (!method) {
			return Response.json(
				{ error: { code: "unknown_template", message: `Unknown template '${template}'` } },
				{ status: 400 },
			);
		}
		const body = await ctx.request.json();
		const templates = client.automations.templates as unknown as Record<
			string,
			(input: unknown) => Promise<unknown>
		>;
		const data = await templates[method]!(body);
		return Response.json(data, { status: 201 });
	} catch (e) {
		return handleSdkError(e);
	}
};
