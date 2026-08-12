import { createMiddleware } from "hono/factory";
import { toolJobOwnsUsageReservation } from "../services/tool-jobs";
import {
	finalizeMutationUsage,
	reserveDailyToolUsage,
} from "../services/usage-meter";
import type { Env, Variables } from "../types";

export function secondsUntilNextUtcDay(now = new Date()): number {
	const nextUtcDay = Date.UTC(
		now.getUTCFullYear(),
		now.getUTCMonth(),
		now.getUTCDate() + 1,
	);
	return Math.max(1, Math.ceil((nextUtcDay - now.getTime()) / 1000));
}

/**
 * PostgreSQL-backed per-org daily quota for cost-bearing tool endpoints.
 * The route either transfers the reservation to a durable tool job or leaves
 * it request-owned. Provider-boundary and terminal accounting live exclusively
 * in that job's Queue lifecycle.
 */
export const toolRateLimitMiddleware = createMiddleware<{
	Bindings: Env;
	Variables: Variables;
}>(async (c, next) => {
	const orgId = c.get("orgId");
	const cachedLimit = c.get("dailyToolLimit");
	const now = new Date();
	const decision = await reserveDailyToolUsage(c.get("db"), {
		organizationId: orgId,
		idempotencyKey: `tool:${crypto.randomUUID()}`,
		units: 1,
		cachedLimit,
		source: "tool",
		now,
	});
	if (decision.selfHealed) {
		c.executionCtx.waitUntil(c.env.KV.delete(`apikey:${c.get("keyHash")}`));
	}

	if (!decision.ok) {
		c.header("Retry-After", String(secondsUntilNextUtcDay(now)));
		return c.json(
			{
				error: {
					code: "DAILY_TOOL_LIMIT",
					message: `Daily tool limit reached (${decision.includedUnits}/day). Upgrade your plan or contact support for higher limits.`,
				},
			},
			429,
		);
	}

	c.set("toolUsageDisposition", "unowned");
	c.set("toolUsageReservation", decision.reservation);
	const ownershipTransferred = async (): Promise<boolean> =>
		c.get("toolUsageDisposition") === "deferred" ||
		(await toolJobOwnsUsageReservation(
			c.get("db"),
			decision.reservation.id,
			decision.reservation.organizationId,
		));
	try {
		await next();
		if (await ownershipTransferred()) return;
		await finalizeMutationUsage(c.get("db"), decision.reservation, {
			commit: false,
			reason: "pre_boundary",
			responseStatus: c.res.status,
		});
	} catch (error) {
		if (await ownershipTransferred()) throw error;
		await finalizeMutationUsage(c.get("db"), decision.reservation, {
			commit: false,
			reason: "pre_boundary",
			responseStatus: 500,
		});
		throw error;
	}
});
