import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { Resend } from "resend";

export const POST: APIRoute = async (context) => {
	try {
		const body = await context.request.json();
		const { platform, name, email, message } = body;

		if (!email || !platform) {
			return Response.json(
				{ error: { message: "Email and platform are required" } },
				{ status: 400 },
			);
		}

		const cfEnv = env as Record<string, any>;

		const html = `
			<h2>New On-Demand Platform Request</h2>
			<p><strong>Platform:</strong> ${platform}</p>
			<p><strong>Name:</strong> ${name || "Not provided"}</p>
			<p><strong>Email:</strong> ${email}</p>
			<p><strong>Message:</strong> ${message || "No message"}</p>
			<hr />
			<p style="color: #666; font-size: 12px;">
				Sent from the RelayAPI dashboard connections page.
				${context.locals.user ? `User: ${context.locals.user.email}` : ""}
			</p>
		`;

		const emailMessage = {
			to: "support@relayapi.dev",
			subject: `[On-Demand] ${platform} platform request from ${email}`,
			html,
			from: "RelayAPI <notifications@relayapi.dev>",
		};

		const queue = cfEnv.EMAIL_QUEUE as
			| { send(message: unknown): Promise<void> }
			| undefined;

		if (queue) {
			await queue.send(emailMessage);
		} else if (cfEnv.RESEND_API_KEY) {
			const resend = new Resend(cfEnv.RESEND_API_KEY);
			await resend.emails.send(emailMessage);
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
