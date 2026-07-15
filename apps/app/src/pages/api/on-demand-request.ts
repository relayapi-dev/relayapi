import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { Resend } from "resend";

/** Escape HTML-significant characters to prevent markup injection into the email. */
function escapeHtml(value: unknown): string {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export const POST: APIRoute = async (context) => {
	// AUTH: require an authenticated dashboard user so anonymous callers can't
	// drive the support mailbox.
	if (!context.locals.user) {
		return Response.json(
			{ error: { message: "Unauthorized" } },
			{ status: 401 },
		);
	}
	const organizationId =
		typeof context.locals.organization?.id === "string"
			? context.locals.organization.id
			: null;
	if (!organizationId) {
		return Response.json(
			{ error: { message: "Active organization membership required" } },
			{ status: 403 },
		);
	}

	try {
		const body = await context.request.json();
		const { platform, name, email, message } = body;

		if (!email || !platform) {
			return Response.json(
				{ error: { message: "Email and platform are required" } },
				{ status: 400 },
			);
		}

		const cfEnv: Cloudflare.Env = env;
		const requestedIdempotencyKey = context.request.headers
			.get("Idempotency-Key")
			?.trim();
		const emailId =
			requestedIdempotencyKey &&
			/^[A-Za-z0-9._:-]{1,200}$/.test(requestedIdempotencyKey)
				? `on-demand:${organizationId}:${requestedIdempotencyKey}`
				: crypto.randomUUID();

		const html = `
			<h2>New On-Demand Platform Request</h2>
			<p><strong>Platform:</strong> ${escapeHtml(platform)}</p>
			<p><strong>Name:</strong> ${name ? escapeHtml(name) : "Not provided"}</p>
			<p><strong>Email:</strong> ${escapeHtml(email)}</p>
			<p><strong>Message:</strong> ${message ? escapeHtml(message) : "No message"}</p>
			<hr />
			<p style="color: #666; font-size: 12px;">
				Sent from the RelayAPI dashboard connections page.
				${context.locals.user ? `User: ${escapeHtml(context.locals.user.email)}` : ""}
			</p>
		`;

		const emailMessage = {
			id: emailId,
			organization_id: organizationId,
			to: "support@relayapi.dev",
			subject: `[On-Demand] ${platform} platform request from ${email}`,
			html,
			from: "RelayAPI <notifications@relayapi.dev>",
		};

		const queue = cfEnv.EMAIL_QUEUE;

		if (queue) {
			await queue.send(emailMessage);
		} else if (cfEnv.RESEND_API_KEY) {
			const resend = new Resend(cfEnv.RESEND_API_KEY);
			const { error } = await resend.emails.send(
				{
					to: emailMessage.to,
					subject: emailMessage.subject,
					html: emailMessage.html,
					from: emailMessage.from,
				},
				{ idempotencyKey: emailMessage.id },
			);
			if (error) {
				throw new Error(
					`On-demand email provider rejected request: ${error.name}`,
				);
			}
		} else {
			return Response.json(
				{ error: { message: "Email service not configured" } },
				{ status: 500 },
			);
		}

		return Response.json({ success: true });
	} catch (e) {
		console.error("Failed to send on-demand request:", e);
		return Response.json(
			{ error: { message: "Failed to send request" } },
			{ status: 500 },
		);
	}
};
