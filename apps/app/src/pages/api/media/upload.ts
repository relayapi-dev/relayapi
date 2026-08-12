import type { APIRoute } from "astro";
import { handleSdkError, requireClient } from "@/lib/api-utils";

const MAX_PROXY_UPLOAD_BYTES = 50 * 1024 * 1024;

export const POST: APIRoute = async (ctx) => {
	const client = await requireClient(ctx);
	if (client instanceof Response) return client;

	const filename = ctx.url.searchParams.get("filename");
	const workspaceId = ctx.url.searchParams.get("workspace_id") || undefined;
	if (!filename) {
		return Response.json(
			{
				error: {
					code: "BAD_REQUEST",
					message: "Missing filename query parameter",
				},
			},
			{ status: 400 },
		);
	}

	try {
		const contentType =
			ctx.request.headers.get("content-type") || "application/octet-stream";
		const declaredLength = ctx.request.headers.get("content-length");
		if (declaredLength && /^\d+$/.test(declaredLength)) {
			const bytes = Number(declaredLength);
			if (Number.isSafeInteger(bytes) && bytes > MAX_PROXY_UPLOAD_BYTES) {
				return Response.json(
					{
						error: {
							code: "FILE_TOO_LARGE",
							message: "Max upload size is 50MB",
						},
					},
					{ status: 413 },
				);
			}
		}
		if (!ctx.request.body) {
			return Response.json(
				{ error: { code: "BAD_REQUEST", message: "Request body is empty" } },
				{ status: 400 },
			);
		}

		// Browser uploads normally go straight to presigned R2. Keep this fallback
		// streaming so the app Worker never holds a second copy of the file.
		const data = await client.media.upload(
			ctx.request.body,
			{ filename, content_type: contentType, workspace_id: workspaceId },
			{ headers: { "Content-Type": contentType }, maxRetries: 0 },
		);
		return Response.json(data, { status: 201 });
	} catch (e) {
		return handleSdkError(e);
	}
};
