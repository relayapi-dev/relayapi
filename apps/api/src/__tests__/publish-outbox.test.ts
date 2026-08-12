import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	notificationOutboxRow,
	postCompletionOutboxRow,
	publishOutboxRow,
	publishQueueMessage,
} from "../services/publish-outbox";

describe("publish outbox Queue handoff", () => {
	it("persists the next thread position and its Queue delay", () => {
		const row = publishOutboxRow({
			organizationId: "org_1",
			threadGroupId: "thread_1",
			threadPosition: 3,
			queueDelaySeconds: 90,
			operationId: "thread:thread_1:position:3:attempt:1",
		});

		expect(row.payload).toEqual({
			type: "publish_thread",
			thread_group_id: "thread_1",
			org_id: "org_1",
			position: 3,
			_queue_delay_seconds: 90,
		});
	});

	it("turns the durable delay into Queue metadata without leaking it", () => {
		const message = publishQueueMessage({
			id: "outbox_1",
			organizationId: "org_1",
			payload: {
				type: "publish_thread",
				position: 2,
				_queue_delay_seconds: 90.2,
			},
		});

		expect(message.delaySeconds).toBe(91);
		expect(message.body).toEqual({
			type: "publish_outbox",
			outbox_id: "outbox_1",
			org_id: "org_1",
		});
	});

	it("caps delayed thread delivery at the Queue 24-hour limit", () => {
		const message = publishQueueMessage({
			id: "outbox_2",
			organizationId: "org_1",
			payload: { _queue_delay_seconds: 100_000 },
		});

		expect(message.delaySeconds).toBe(86_400);
	});

	it("persists a stable notification job without synchronous delivery", () => {
		const row = notificationOutboxRow({
			organizationId: "org_1",
			userId: "user_1",
			type: "post_published",
			title: "Post published successfully",
			body: "Your post was published to bluesky",
			data: { postId: "post_1" },
			occurrenceId: "post:post_1:publish:lease_1:published",
		});

		expect(row.operationId).toBe(
			"notification:post:post_1:publish:lease_1:published:user_1",
		);
		expect(row.kind).toBe("notification");
		expect(row.payload).toEqual({
			type: "send_notification",
			org_id: "org_1",
			user_id: "user_1",
			notification_type: "post_published",
			title: "Post published successfully",
			body: "Your post was published to bluesky",
			data: { postId: "post_1" },
			occurrence_id: "post:post_1:publish:lease_1:published",
		});
		expect(
			publishQueueMessage({
				id: "outbox_notification_1",
				organizationId: "org_1",
				payload: row.payload,
			}).body,
		).toEqual({
			type: "publish_outbox",
			outbox_id: "outbox_notification_1",
			org_id: "org_1",
		});
	});

	it("coalesces notification and streak work into one durable completion job", () => {
		const occurredAt = new Date("2026-07-13T12:00:00.000Z");
		const row = postCompletionOutboxRow({
			postId: "post_1",
			organizationId: "org_1",
			userId: "user_1",
			status: "partial",
			occurrenceId: "post:post_1:publish:lease_1:partial",
			platforms: ["twitter", "bluesky", "twitter"],
			occurredAt,
		});

		expect(row?.kind).toBe("post_completion");
		expect(row?.payload).toEqual({
			type: "post_completion_effects",
			post_id: "post_1",
			org_id: "org_1",
			status: "partial",
			occurred_at: occurredAt.toISOString(),
			occurrence_id: "post:post_1:publish:lease_1:partial",
			update_streak: true,
			notification: {
				user_id: "user_1",
				notification_type: "post_failed",
				title: "Post partially published",
				body: "Your post was only partially published to bluesky, twitter",
				data: {
					postId: "post_1",
					status: "partial",
					platforms: ["bluesky", "twitter"],
				},
			},
		});
	});

	it("retains streak intent even when a post has no notification principal", () => {
		const success = postCompletionOutboxRow({
			postId: "post_2",
			organizationId: "org_1",
			userId: null,
			status: "published",
			occurrenceId: "post:post_2:publish:lease_2:published",
			platforms: ["bluesky"],
			occurredAt: new Date("2026-07-13T12:00:00.000Z"),
		});
		const failedWithoutPrincipal = postCompletionOutboxRow({
			postId: "post_3",
			organizationId: "org_1",
			userId: null,
			status: "failed",
			occurrenceId: "post:post_3:publish:lease_3:failed",
			platforms: ["bluesky"],
			occurredAt: new Date("2026-07-13T12:00:00.000Z"),
		});

		expect(success?.payload).toMatchObject({
			update_streak: true,
			notification: null,
		});
		expect(failedWithoutPrincipal).toBeNull();
	});

	it("fences completion and rollback to the exact dispatch claim", () => {
		const source = readFileSync(
			new URL("../services/publish-outbox.ts", import.meta.url),
			"utf8",
		);
		const completion = source.slice(
			source.indexOf("const completedAt"),
			source.indexOf("} catch (error)"),
		);
		const rollback = source.slice(source.indexOf("} catch (error)"));
		for (const section of [completion, rollback]) {
			expect(section).toContain('eq(publishOutbox.status, "dispatching")');
			expect(section).toContain("eq(publishOutbox.claimedAt, now)");
		}
	});
});
