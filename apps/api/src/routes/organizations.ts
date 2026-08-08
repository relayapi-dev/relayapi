import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { assertKvPrivacyStoreKey, user } from "@relayapi/db";
import { eq } from "drizzle-orm";
import { lockCredentialMutationAuthorityInTransaction } from "../lib/credential-mutation-authority";
import { markMutationInputNotApplied } from "../middleware/mutation-validation";
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
	principalType: "dashboard_user" | "service";
	callerOrganizationId: string;
	targetOrganizationId: string;
	membershipRole: string | null;
	globalRole: string | null;
}): boolean {
	if (input.principalType !== "dashboard_user") return false;
	if (
		(input.globalRole ?? "").split(",").some((role) => role.trim() === "admin")
	) {
		return true;
	}
	return (
		input.callerOrganizationId === input.targetOrganizationId &&
		(input.membershipRole ?? "")
			.split(",")
			.some((role) => role.trim() === "owner")
	);
}

class TenantDeletionAuthorizationError extends Error {
	constructor(
		readonly status: 401 | 403,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "TenantDeletionAuthorizationError";
	}
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
	const principalType = c.get("principalType");
	const principalUserId = c.get("principalUserId");
	const { id: targetOrganizationId } = c.req.valid("param");
	const db = c.get("db");
	if (principalType !== "dashboard_user" || !principalUserId) {
		markMutationInputNotApplied(c);
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
			{
				organizationIds: [callerOrganizationId],
				async lockActorUser(tx) {
					const [actor] = await tx
						.select({ id: user.id })
						.from(user)
						.where(eq(user.id, principalUserId))
						.for("share")
						.limit(1);
					if (!actor) {
						throw new TenantDeletionAuthorizationError(
							401,
							"CREDENTIAL_NO_LONGER_AUTHORIZED",
							"The issuing credential is no longer authorized.",
						);
					}
				},
				async authorize(tx) {
					const authority = await lockCredentialMutationAuthorityInTransaction(
						c,
						{ requireAllWorkspaceScope: true },
						tx,
					);
					if (!authority.ok) {
						throw new TenantDeletionAuthorizationError(
							authority.status,
							authority.code,
							authority.message,
						);
					}
					if (
						!authority.value.userId ||
						!canRequestTenantDeletion({
							principalType: authority.value.principalType,
							callerOrganizationId: authority.value.organizationId,
							targetOrganizationId,
							membershipRole: authority.value.memberRole,
							globalRole: authority.value.globalRole,
						})
					) {
						throw new TenantDeletionAuthorizationError(
							403,
							"FORBIDDEN",
							"Only an organization owner or system administrator can delete this organization.",
						);
					}
					return authority.value.userId;
				},
			},
			async (pending) => {
				await Promise.all([
					c.env.KV.delete(`queue-schedule:${targetOrganizationId}`),
					c.env.KV.delete(`org-settings:${targetOrganizationId}`),
					c.env.KV.delete(`org-summary:${targetOrganizationId}`),
					...pending.apiKeyHashes.map((hash) =>
						c.env.KV.delete(`apikey:${hash}`),
					),
					...pending.dashboardPrincipalIds.map((userId) =>
						c.env.KV.delete(`dashboard-key:${targetOrganizationId}:${userId}`),
					),
					...pending.workspaceIds.map((workspaceId) =>
						c.env.KV.delete(
							workspaceValidKvKey(targetOrganizationId, workspaceId),
						),
					),
					...pending.accountCacheKeys.map((key) =>
						c.env.KV.delete(
							assertKvPrivacyStoreKey(
								[
									"kv:platform-account",
									"kv:ig-sender-id",
									"kv:sync-dedup",
									"kv:inbox-posts",
								],
								key,
							),
						),
					),
				]);
			},
		);
		return c.json({ status: result.status }, 202);
	} catch (error) {
		if (error instanceof TenantDeletionAuthorizationError) {
			markMutationInputNotApplied(c);
			return c.json(
				{ error: { code: error.code, message: error.message } },
				error.status,
			);
		}
		if (error instanceof TenantDeletionNotFoundError) {
			markMutationInputNotApplied(c);
			return c.json(
				{ error: { code: "NOT_FOUND", message: "Organization not found" } },
				404,
			);
		}
		throw error;
	}
});

export default app;
