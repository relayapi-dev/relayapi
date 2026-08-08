import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { erasureHolds, member, organizationPrincipals } from "@relayapi/db";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { ErrorResponse } from "../schemas/common";
import { ErasureHoldSummaryListResponse } from "../schemas/privacy";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const ActiveHoldQuery = z.object({
	workspace_id: z.string().min(1).optional(),
});

export function roleIncludesOwner(role: string | null): boolean {
	return (
		role
			?.split(",")
			.map((value) => value.trim())
			.includes("owner") ?? false
	);
}

export function visibleWorkspaceHoldIds(
	requestedWorkspaceId: string | undefined,
	workspaceScope: "all" | string[],
): string[] | null {
	if (requestedWorkspaceId !== undefined) return [requestedWorkspaceId];
	return workspaceScope === "all" ? null : workspaceScope;
}

const listActiveErasureHolds = createRoute({
	operationId: "listActiveErasureHolds",
	method: "get",
	path: "/erasure-holds",
	tags: ["Privacy"],
	summary: "Read active erasure-hold state for the current organization",
	description:
		"Organization owners may read only the non-sensitive reason summary. Encrypted evidence and legal-authority details are never returned.",
	security: [{ Bearer: [] }],
	request: { query: ActiveHoldQuery },
	responses: {
		200: {
			description: "Active hold summaries",
			content: {
				"application/json": { schema: ErasureHoldSummaryListResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "Organization owner required",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listActiveErasureHolds, async (c) => {
	const organizationId = c.get("orgId");
	const principalId = c.get("principalId");
	if (c.get("principalType") !== "dashboard_user" || !principalId) {
		return c.json(
			{
				error: {
					code: "FORBIDDEN",
					message: "Organization owner access is required",
				},
			},
			403,
		);
	}

	const db = c.get("db");
	const [actor] = await db
		.select({ role: member.role })
		.from(organizationPrincipals)
		.innerJoin(
			member,
			and(
				eq(member.id, organizationPrincipals.memberId),
				eq(member.organizationId, organizationPrincipals.organizationId),
			),
		)
		.where(
			and(
				eq(organizationPrincipals.id, principalId),
				eq(organizationPrincipals.organizationId, organizationId),
				eq(organizationPrincipals.kind, "member"),
				eq(organizationPrincipals.lifecycleStatus, "active"),
			),
		)
		.limit(1);
	if (!roleIncludesOwner(actor?.role ?? null)) {
		return c.json(
			{
				error: {
					code: "FORBIDDEN",
					message: "Organization owner access is required",
				},
			},
			403,
		);
	}

	const { workspace_id: requestedWorkspaceId } = c.req.valid("query");
	const workspaceScope = c.get("workspaceScope");
	const visibleWorkspaceIds = visibleWorkspaceHoldIds(
		requestedWorkspaceId,
		workspaceScope,
	);
	const targetPredicate =
		visibleWorkspaceIds === null
			? eq(erasureHolds.organizationTombstoneId, organizationId)
			: or(
					and(
						eq(erasureHolds.subjectKind, "organization"),
						eq(erasureHolds.subjectId, organizationId),
					),
					...(visibleWorkspaceIds.length > 0
						? [
								and(
									eq(erasureHolds.subjectKind, "workspace"),
									inArray(erasureHolds.subjectId, visibleWorkspaceIds),
								),
							]
						: []),
				);
	const rows = await db
		.select({
			id: erasureHolds.id,
			subjectKind: erasureHolds.subjectKind,
			subjectId: erasureHolds.subjectId,
			reasonCode: erasureHolds.reasonCode,
			reasonSummary: erasureHolds.reasonSummary,
			placedAt: erasureHolds.placedAt,
		})
		.from(erasureHolds)
		.where(
			and(
				isNull(erasureHolds.releasedAt),
				eq(erasureHolds.organizationTombstoneId, organizationId),
				targetPredicate,
			),
		)
		.orderBy(asc(erasureHolds.placedAt), asc(erasureHolds.id));

	return c.json(
		{
			held: rows.length > 0,
			holds: rows.map((row) => ({
				id: row.id,
				subject_kind: row.subjectKind,
				subject_id: row.subjectId,
				reason_code: row.reasonCode,
				reason_summary: row.reasonSummary,
				placed_at: row.placedAt.toISOString(),
			})),
		},
		200,
	);
});

export default app;
