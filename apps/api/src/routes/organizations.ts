import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { apikey, member, user } from "@relayapi/db";
import { and, eq } from "drizzle-orm";
import {
	requireAllWorkspaceScopeMiddleware,
	requireWriteAccessMiddleware,
} from "../middleware/permissions";
import { workspaceValidKvKey } from "../middleware/workspace-validation";
import { ErrorResponse, IdParam } from "../schemas/common";
import { OrganizationDeletionResponse } from "../schemas/organizations";
import {
	requestTenantDeletion,
	TenantDeletionNotFoundError,
} from "../services/tenant-deletion";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

app.use("*", requireWriteAccessMiddleware);
app.use("*", requireAllWorkspaceScopeMiddleware);

export function canRequestTenantDeletion(input: {
	callerOrganizationId: string;
	targetOrganizationId: string;
	membershipRole: string | null;
	globalRole: string | null;
}): boolean {
	if (input.globalRole === "admin") return true;
	return (
		input.callerOrganizationId === input.targetOrganizationId &&
		(input.membershipRole ?? "")
			.split(",")
			.some((role) => role.trim() === "owner")
	);
}

const deleteOrganization = createRoute({
	operationId: "deleteOrganization",
	method: "delete",
	path: "/{id}",
	tags: ["Organizations"],
	summary: "Delete an organization",
	description:
		"Atomically tombstones the tenant, revokes local access, stops operational work, and schedules durable provider and object-storage cleanup.",
	security: [{ Bearer: [] }],
	request: { params: IdParam },
	responses: {
		202: {
			description: "Organization deletion accepted",
			content: {
				"application/json": { schema: OrganizationDeletionResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description:
				"Only an organization owner or system administrator may delete",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Organization not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteOrganization, async (c) => {
	const callerOrganizationId = c.get("orgId");
	const keyId = c.get("keyId");
	const { id: targetOrganizationId } = c.req.valid("param");
	const db = c.get("db");

	// One indexed lookup binds the API credential to its principal and resolves
	// both target-tenant ownership and the separate system-admin capability.
	const [actor] = await db
		.select({
			userId: apikey.referenceId,
			globalRole: user.role,
			membershipRole: member.role,
		})
		.from(apikey)
		.leftJoin(user, eq(user.id, apikey.referenceId))
		.leftJoin(
			member,
			and(
				eq(member.userId, apikey.referenceId),
				eq(member.organizationId, targetOrganizationId),
			),
		)
		.where(
			and(
				eq(apikey.id, keyId),
				eq(apikey.organizationId, callerOrganizationId),
			),
		)
		.limit(1);

	if (
		!actor?.userId ||
		!canRequestTenantDeletion({
			callerOrganizationId,
			targetOrganizationId,
			membershipRole: actor.membershipRole,
			globalRole: actor.globalRole,
		})
	) {
		return c.json(
			{
				error: {
					code: "FORBIDDEN",
					message:
						"Only an organization owner or system administrator can delete this organization.",
				},
			},
			403,
		);
	}

	try {
		const result = await requestTenantDeletion(
			db,
			targetOrganizationId,
			actor.userId,
		);
		const invalidations = [
			c.env.KV.delete(`queue-schedule:${targetOrganizationId}`),
			c.env.KV.delete(`org-settings:${targetOrganizationId}`),
			...result.apiKeyHashes.map((hash) => c.env.KV.delete(`apikey:${hash}`)),
			...result.dashboardPrincipalIds.map((userId) =>
				c.env.KV.delete(`dashboard-key:${targetOrganizationId}:${userId}`),
			),
			...result.workspaceIds.map((workspaceId) =>
				c.env.KV.delete(workspaceValidKvKey(targetOrganizationId, workspaceId)),
			),
			...result.accountCacheKeys.map((key) => c.env.KV.delete(key)),
		];
		const invalidationResults = await Promise.allSettled(invalidations);
		const failedInvalidations = invalidationResults.filter(
			(item) => item.status === "rejected",
		);
		if (failedInvalidations.length > 0) {
			console.error("Tenant deletion KV invalidation failed", {
				organizationId: targetOrganizationId,
				failed: failedInvalidations.length,
			});
		}
		return c.json({ status: result.status }, 202);
	} catch (error) {
		if (error instanceof TenantDeletionNotFoundError) {
			return c.json(
				{ error: { code: "NOT_FOUND", message: "Organization not found" } },
				404,
			);
		}
		throw error;
	}
});

export default app;
