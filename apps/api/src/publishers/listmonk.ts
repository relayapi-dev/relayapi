import { isBlockedUrlWithDns } from "../lib/ssrf-guard";
import { classifyPublishError, type Publisher, type PublishRequest, type PublishResult } from "./types";

/**
 * ListMonk publisher.
 * Creates and sends a campaign via a self-hosted ListMonk instance.
 * Basic auth credentials in access_token (base64), instance URL in metadata.
 *
 * ListMonk API:
 * Docs: https://listmonk.app/docs/apis/campaigns/
 */

function wrapInHtml(text: string): string {
	return text
		.split("\n\n")
		.map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
		.join("");
}

export const listmonkPublisher: Publisher = {
	platform: "listmonk",

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const authToken = request.account.access_token; // base64(user:pass)
			const metadata = request.account.metadata ?? undefined;
			const instanceUrl = (metadata?.instance_url as string) ?? "";

			if (!authToken || !instanceUrl) {
				throw new Error("CONTENT_ERROR: ListMonk credentials and instance URL are required.");
			}

			if (await isBlockedUrlWithDns(instanceUrl)) {
				throw new Error("CONTENT_ERROR: ListMonk instance URL points to a blocked address.");
			}

			const authHeader = `Basic ${authToken}`;
			const opts = request.target_options;

			const subject = (opts.subject as string) ??
				(request.content?.split("\n")[0]?.slice(0, 100) || "Newsletter Update");
			const contentHtml = (opts.content_html as string) ??
				wrapInHtml(request.content ?? "");
			const listId = opts.list_id as number | undefined;
			const templateId = opts.template_id as number | undefined;

			// Find a list if not specified
			let targetListIds: number[] = listId ? [listId] : [];
			if (targetListIds.length === 0) {
				// ListMonk API: Get Lists
				// Docs: https://listmonk.app/docs/apis/lists/
				const listsRes = await fetch(`${instanceUrl}/api/lists?per_page=1`, {
					headers: { Authorization: authHeader },
					redirect: "error",
				});
				if (listsRes.ok) {
					const lists = (await listsRes.json()) as {
						data?: { results?: Array<{ id: number }> };
					};
					const firstList = lists.data?.results?.[0]?.id;
					if (firstList) targetListIds = [firstList];
				}
			}

			if (targetListIds.length === 0) {
				throw new Error("CONTENT_ERROR: No ListMonk list found. Create one or specify list_id.");
			}

			// Step 1: Create a campaign
			// Docs: https://listmonk.app/docs/apis/campaigns/#post-apicampaigns
			const body: Record<string, unknown> = {
				name: subject,
				subject,
				body: contentHtml,
				content_type: "html",
				type: "regular",
				lists: targetListIds,
			};

			if (templateId) {
				body.template_id = templateId;
			}

			const fromEmail = opts.from_email as string | undefined;
			if (fromEmail) {
				body.from_email = fromEmail;
			}

			const altBody = opts.alt_body as string | undefined;
			if (altBody) {
				body.altbody = altBody;
			}

			const tags = opts.tags as string[] | undefined;
			if (tags && tags.length > 0) {
				body.tags = tags;
			}

			const headers = opts.headers as Record<string, string> | undefined;
			if (headers) {
				body.headers = Object.entries(headers).map(([k, v]) => ({ key: k, value: v }));
			}

			const createRes = await fetch(`${instanceUrl}/api/campaigns`, {
				method: "POST",
				headers: {
					Authorization: authHeader,
					"Content-Type": "application/json",
				},
				redirect: "error",
				body: JSON.stringify(body),
			});

			if (!createRes.ok) {
				const err = await createRes.json().catch(() => ({}));
				const detail = (err as any)?.message ?? createRes.statusText;

				if (createRes.status === 401) {
					throw new Error(`TOKEN_EXPIRED: ListMonk credentials invalid: ${detail}`);
				}
				throw new Error(`ListMonk create campaign failed (${createRes.status}): ${detail}`);
			}

			const created = (await createRes.json()) as {
				data?: { id?: number; uuid?: string };
			};
			const campaignId = created.data?.id;
			if (!campaignId) {
				throw new Error("ListMonk: No campaign ID returned");
			}

			// Step 2: Start or schedule the campaign
			// Docs: https://listmonk.app/docs/apis/campaigns/#put-apicampaignscampaign_idstatus
			const sendAt = opts.send_at as string | undefined;
			const targetStatus = sendAt ? "scheduled" : "running";
			const statusRes = await fetch(
				`${instanceUrl}/api/campaigns/${campaignId}/status`,
				{
					method: "PUT",
					headers: {
						Authorization: authHeader,
						"Content-Type": "application/json",
					},
					redirect: "error",
					body: JSON.stringify({
						status: targetStatus,
						...(sendAt ? { send_at: sendAt } : {}),
					}),
				},
			);

			if (!statusRes.ok) {
				const err = await statusRes.json().catch(() => ({}));
				throw new Error(`ListMonk start campaign failed: ${(err as any)?.message ?? statusRes.statusText}`);
			}

			return {
				success: true,
				platform_post_id: String(campaignId),
				platform_url: `${instanceUrl}/campaigns/${campaignId}`,
			};
		} catch (err) {
			return classifyPublishError(err);
		}
	},
};
