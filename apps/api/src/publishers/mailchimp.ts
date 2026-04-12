import { classifyPublishError, type Publisher, type PublishRequest, type PublishResult } from "./types";

/**
 * Mailchimp publisher.
 * Creates and sends a campaign via the Mailchimp Marketing API.
 * API key in access_token, datacenter in metadata.
 *
 * Mailchimp Marketing API:
 * Docs: https://mailchimp.com/developer/marketing/api/
 */

function wrapInHtml(text: string): string {
	return text
		.split("\n\n")
		.map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
		.join("");
}

export const mailchimpPublisher: Publisher = {
	platform: "mailchimp",

	async publish(request: PublishRequest): Promise<PublishResult> {
		try {
			const apiKey = request.account.access_token;
			const metadata = request.account.metadata ?? undefined;
			const datacenter = (metadata?.datacenter as string) ?? apiKey?.split("-").pop();

			if (!apiKey || !datacenter) {
				throw new Error("CONTENT_ERROR: Mailchimp API key is required.");
			}

			const baseUrl = `https://${datacenter}.api.mailchimp.com/3.0`;
			const authHeader = `Basic ${btoa(`relayapi:${apiKey}`)}`;

			const opts = request.target_options;
			const subject = (opts.subject as string) ??
				(request.content?.split("\n")[0]?.slice(0, 100) || "Newsletter Update");
			const previewText = (opts.preview_text as string) ?? "";
			const listId = opts.list_id as string | undefined;
			const contentHtml = (opts.content_html as string) ??
				wrapInHtml(request.content ?? "");

			// Step 1: Find a list if not specified
			let targetListId = listId;
			if (!targetListId) {
				// Mailchimp API: Get Lists
				// Docs: https://mailchimp.com/developer/marketing/api/lists/get-lists-info/
				const listsRes = await fetch(`${baseUrl}/lists?count=1`, {
					headers: { Authorization: authHeader },
				});
				if (listsRes.ok) {
					const lists = (await listsRes.json()) as { lists?: Array<{ id: string }> };
					targetListId = lists.lists?.[0]?.id;
				}
			}

			if (!targetListId) {
				throw new Error("CONTENT_ERROR: No Mailchimp audience/list found. Create one or specify list_id.");
			}

			const replyTo = (opts.from_email as string) ?? (opts.reply_to as string);
			if (!replyTo) {
				throw new Error("CONTENT_ERROR: from_email is required for Mailchimp campaigns. Set it in target_options.");
			}

			// Step 2: Create a campaign
			// Docs: https://mailchimp.com/developer/marketing/api/campaigns/add-campaign/
			const campaignRes = await fetch(`${baseUrl}/campaigns`, {
				method: "POST",
				headers: {
					Authorization: authHeader,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					type: "regular",
					recipients: { list_id: targetListId },
					settings: {
						subject_line: subject,
						preview_text: previewText,
						from_name: (opts.from_name as string) ?? "Newsletter",
						reply_to: replyTo,
					},
				}),
			});

			if (!campaignRes.ok) {
				const err = await campaignRes.json().catch(() => ({}));
				const detail = (err as any)?.detail ?? (err as any)?.title ?? campaignRes.statusText;

				if (campaignRes.status === 401) {
					throw new Error(`TOKEN_EXPIRED: Mailchimp API key invalid: ${detail}`);
				}
				if (campaignRes.status === 429) {
					throw new Error(`RATE_LIMITED: ${detail}`);
				}
				throw new Error(`Mailchimp create campaign failed (${campaignRes.status}): ${detail}`);
			}

			const campaign = (await campaignRes.json()) as {
				id?: string;
				archive_url?: string;
			};
			const campaignId = campaign.id;
			if (!campaignId) {
				throw new Error("Mailchimp: No campaign ID returned");
			}

			// Step 3: Set campaign content
			// Docs: https://mailchimp.com/developer/marketing/api/campaign-content/set-campaign-content/
			const contentRes = await fetch(
				`${baseUrl}/campaigns/${campaignId}/content`,
				{
					method: "PUT",
					headers: {
						Authorization: authHeader,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ html: contentHtml }),
				},
			);

			if (!contentRes.ok) {
				const err = await contentRes.json().catch(() => ({}));
				throw new Error(`Mailchimp set content failed: ${(err as any)?.detail ?? contentRes.statusText}`);
			}

			// Step 4: Send or schedule the campaign
			const scheduleTime = opts.schedule_time as string | undefined;
			if (scheduleTime) {
				// Mailchimp API: Schedule Campaign
				// Docs: https://mailchimp.com/developer/marketing/api/campaigns/schedule-campaign/
				const scheduleRes = await fetch(
					`${baseUrl}/campaigns/${campaignId}/actions/schedule`,
					{
						method: "POST",
						headers: {
							Authorization: authHeader,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({ schedule_time: scheduleTime }),
					},
				);

				if (!scheduleRes.ok) {
					const err = await scheduleRes.json().catch(() => ({}));
					throw new Error(`Mailchimp schedule failed: ${(err as any)?.detail ?? scheduleRes.statusText}`);
				}
			} else {
				// Docs: https://mailchimp.com/developer/marketing/api/campaigns/send-campaign/
				const sendRes = await fetch(
					`${baseUrl}/campaigns/${campaignId}/actions/send`,
					{
						method: "POST",
						headers: { Authorization: authHeader },
					},
				);

				if (!sendRes.ok) {
					const err = await sendRes.json().catch(() => ({}));
					throw new Error(`Mailchimp send failed: ${(err as any)?.detail ?? sendRes.statusText}`);
				}
			}

			return {
				success: true,
				platform_post_id: campaignId,
				platform_url: campaign.archive_url,
			};
		} catch (err) {
			return classifyPublishError(err);
		}
	},
};
