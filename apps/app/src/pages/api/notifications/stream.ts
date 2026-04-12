import type { APIRoute } from "astro";
import { notifications, eq } from "@relayapi/db";
import { and, desc, gt, count } from "drizzle-orm";

const POLL_INTERVAL = 5_000; // 5 seconds
const MAX_DURATION = 30 * 60 * 1_000; // 30 minutes

export const GET: APIRoute = async (context) => {
	const user = context.locals.user;
	if (!user) {
		return new Response("Unauthorized", { status: 401 });
	}

	const userId = (user as any).id as string;
	const db = context.locals.db;

	let lastCheck = new Date();
	const startTime = Date.now();
	let cancelled = false;
	let keepaliveTimer: ReturnType<typeof setInterval>;
	let pollTimer: ReturnType<typeof setTimeout>;

	const stream = new ReadableStream({
		async start(controller) {
			const encoder = new TextEncoder();

			const send = (event: string, data: unknown): boolean => {
				try {
					controller.enqueue(
						encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
					);
					return true;
				} catch {
					cancelled = true;
					return false;
				}
			};

			// Send initial unread count
			try {
				const [result] = await db
					.select({ count: count() })
					.from(notifications)
					.where(
						and(
							eq(notifications.userId, userId),
							eq(notifications.read, false),
						),
					);
				send("count", { count: result?.count ?? 0 });
			} catch {
				// Ignore initial count errors
			}

			// Poll for new notifications
			const poll = async () => {
				if (cancelled || Date.now() - startTime > MAX_DURATION) {
					try { controller.close(); } catch {}
					clearInterval(keepaliveTimer);
					return;
				}

				try {
					// Fetch new notifications + unread count in parallel (2→1 round-trip)
					const [newNotifs, [countResult]] = await Promise.all([
						db.select().from(notifications).where(and(eq(notifications.userId, userId), gt(notifications.createdAt, lastCheck))).orderBy(desc(notifications.createdAt)).limit(10),
						db.select({ count: count() }).from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.read, false))),
					]);

					if (newNotifs.length > 0) {
						for (const notif of newNotifs) {
							if (!send("notification", notif)) return;
						}
						lastCheck = newNotifs[0]!.createdAt;
					}

					if (!send("count", { count: countResult?.count ?? 0 })) return;
				} catch (err) {
					console.error("[SSE] Poll error:", err);
				}

				if (!cancelled) {
					pollTimer = setTimeout(poll, POLL_INTERVAL);
				}
			};

			if (!cancelled) {
				pollTimer = setTimeout(poll, POLL_INTERVAL);
			}

			// Send keepalive comment every 30s to prevent proxy timeouts
			keepaliveTimer = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(": keepalive\n\n"));
				} catch {
					cancelled = true;
					clearInterval(keepaliveTimer);
				}
			}, 30_000);
		},

		cancel() {
			cancelled = true;
			clearTimeout(pollTimer);
			clearInterval(keepaliveTimer);
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
};
