import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { dailyToolLimitForPlan, PRICING } from "@relayapi/config";
import {
	apikey,
	automationScheduledJobs,
	automations,
	billingPeriods,
	type Database,
	erasureHolds,
	member,
	organization,
	organizationSubscriptions,
	usageBuckets,
	user,
} from "@relayapi/db";
import {
	and,
	count,
	desc,
	eq,
	gt,
	ilike,
	inArray,
	lte,
	or,
	sql,
} from "drizzle-orm";
import { withCredentialMutationAuthority } from "../lib/credential-mutation-authority";
import { encryptToken } from "../lib/crypto";
import {
	decodeTimestampIdCursor,
	INVALID_CURSOR_BODY,
	InvalidPaginationCursorError,
	type TimestampIdCursor,
} from "../lib/pagination-cursor";
import { markMutationInputNotApplied } from "../middleware/mutation-validation";
import {
	AdminAutomationWebhookFailureListResponse,
	AdminErasureHold,
	AdminErasureHoldCreate,
	AdminErasureHoldListResponse,
	AdminErasureHoldRelease,
	AdminErasureJobListResponse,
	AdminMutationResponse,
	AdminOperatorResolutionAction,
	AdminOperatorResolutionEvidenceListResponse,
	AdminOperatorResolutionListResponse,
	AdminOperatorResolutionRequest,
	AdminOperatorResolutionResponse,
	AdminOperatorResolutionTargetType,
	AdminOrganizationListResponse,
	AdminOrganizationUpdate,
	AdminSubscriptionListResponse,
	AdminSubscriptionUpdate,
} from "../schemas/admin";
import { ErrorResponse, IdParam } from "../schemas/common";
import { setComplimentaryPlan } from "../services/billing-periods";
import {
	listOperatorResolutionEvidence,
	listOperatorResolutionItems,
	OperatorResolutionActionNotAllowedError,
	OperatorResolutionInputError,
	OperatorResolutionNotFoundError,
	OperatorResolutionStateConflictError,
	resolveOperatorResolution,
	serializeOperatorResolutionEvidence,
} from "../services/operator-resolution";
import {
	ErasureHoldAuthorizationError,
	ErasureHoldNotFoundError,
	ErasureHoldTargetNotFoundError,
	InvalidErasureHoldInputError,
	placeErasureHold,
	releaseErasureHold,
} from "../services/privacy-retention-policy";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

/** Every non-read admin route must hold exact live actor authority to commit. */
export const FENCED_ADMIN_MUTATION_OPERATION_IDS = [
	"adminUpdateOrganization",
	"adminUpdateSubscription",
	"adminResolveOperatorResolution",
	"adminCreateErasureHold",
	"adminReleaseErasureHold",
] as const;

function requireFencedAdminUserId(authority: {
	userId: string | null;
}): string {
	if (!authority.userId) {
		throw new Error(
			"Global administrator authority is missing its user identity",
		);
	}
	return authority.userId;
}

type ErasureHoldRow = typeof erasureHolds.$inferSelect;

export function serializeErasureHold(row: ErasureHoldRow) {
	return {
		id: row.id,
		subjectKind: row.subjectKind,
		subjectId: row.subjectId,
		organizationId: row.organizationTombstoneId,
		reasonCode: row.reasonCode,
		reasonSummary: row.reasonSummary,
		legalAuthorityRef: row.legalAuthorityRef,
		placedBy: row.placedBy,
		placedAt: row.placedAt.toISOString(),
		releasedBy: row.releasedBy,
		releasedAt: row.releasedAt?.toISOString() ?? null,
		releaseReasonSummary: row.releaseReasonSummary,
		hasEvidence: row.evidenceCiphertext !== null,
		evidenceRedactedAt: row.evidenceRedactedAt?.toISOString() ?? null,
	};
}

function isUniqueViolation(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "23505"
	);
}

app.use("*", async (c, next) => {
	if (
		c.get("principalType") !== "dashboard_user" ||
		!c.get("principalUserId")
	) {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "FORBIDDEN",
					message: "System administrator access is required",
				},
			},
			403,
		);
	}
	const [actor] = await c
		.get("db")
		.select({ role: user.role })
		.from(apikey)
		.innerJoin(user, eq(user.id, apikey.referenceId))
		.where(
			and(
				eq(apikey.id, c.get("keyId")),
				eq(apikey.referenceId, c.get("principalUserId") as string),
			),
		)
		.limit(1);
	if (actor?.role !== "admin") {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "FORBIDDEN",
					message: "System administrator access is required",
				},
			},
			403,
		);
	}
	await next();
});

const AdminOrganizationListQuery = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0),
	search: z.string().trim().max(255).optional(),
});

const listOrganizations = createRoute({
	operationId: "adminListOrganizations",
	method: "get",
	path: "/organizations",
	tags: ["Admin"],
	summary: "List organizations for system administration",
	security: [{ Bearer: [] }],
	request: { query: AdminOrganizationListQuery },
	responses: {
		200: {
			description: "Organizations",
			content: {
				"application/json": { schema: AdminOrganizationListResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "System administrator required",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listOrganizations, async (c) => {
	const { limit, offset, search } = c.req.valid("query");
	const db = c.get("db");
	const conditions = [eq(organization.lifecycleStatus, "active")];
	if (search) {
		const searchCondition = or(
			ilike(organization.name, `%${search}%`),
			ilike(organization.slug, `%${search}%`),
		);
		if (searchCondition) conditions.push(searchCondition);
	}
	const where = and(...conditions);
	const [totalRows, organizations] = await Promise.all([
		db.select({ value: count() }).from(organization).where(where),
		db
			.select({
				id: organization.id,
				name: organization.name,
				slug: organization.slug,
				logo: organization.logo,
				createdAt: organization.createdAt,
			})
			.from(organization)
			.where(where)
			.orderBy(desc(organization.createdAt))
			.limit(limit)
			.offset(offset),
	]);
	if (organizations.length === 0) {
		return c.json(
			{
				organizations: [],
				total: Number(totalRows[0]?.value ?? 0),
				limit,
				offset,
			},
			200,
		);
	}

	const organizationIds = organizations.map(({ id }) => id);
	const now = new Date();
	const [memberRows, subscriptions, buckets, periods] = await Promise.all([
		db
			.select({
				organizationId: member.organizationId,
				value: count(),
			})
			.from(member)
			.where(inArray(member.organizationId, organizationIds))
			.groupBy(member.organizationId),
		db
			.select()
			.from(organizationSubscriptions)
			.where(
				inArray(organizationSubscriptions.organizationId, organizationIds),
			),
		db
			.select()
			.from(usageBuckets)
			.where(
				and(
					inArray(usageBuckets.organizationId, organizationIds),
					eq(usageBuckets.metric, "successful_mutation"),
					lte(usageBuckets.periodStart, now),
					gt(usageBuckets.periodEnd, now),
				),
			)
			.orderBy(desc(usageBuckets.periodStart)),
		db
			.select()
			.from(billingPeriods)
			.where(
				and(
					inArray(billingPeriods.organizationId, organizationIds),
					eq(billingPeriods.state, "open"),
					lte(billingPeriods.periodStart, now),
					gt(billingPeriods.periodEnd, now),
				),
			)
			.orderBy(desc(billingPeriods.periodStart)),
	]);
	const membersByOrganization = new Map(
		memberRows.map((row) => [row.organizationId, Number(row.value)]),
	);
	const subscriptionsByOrganization = new Map(
		subscriptions.map((row) => [row.organizationId, row]),
	);
	const bucketsByOrganization = new Map<string, (typeof buckets)[number]>();
	for (const bucket of buckets) {
		if (!bucketsByOrganization.has(bucket.organizationId)) {
			bucketsByOrganization.set(bucket.organizationId, bucket);
		}
	}
	const periodsByOrganization = new Map<string, (typeof periods)[number]>();
	for (const period of periods) {
		if (!periodsByOrganization.has(period.organizationId)) {
			periodsByOrganization.set(period.organizationId, period);
		}
	}

	return c.json(
		{
			organizations: organizations.map((row) => {
				const subscription = subscriptionsByOrganization.get(row.id);
				const bucket = bucketsByOrganization.get(row.id);
				const period = periodsByOrganization.get(row.id);
				const pro = subscription?.status === "active";
				return {
					...row,
					createdAt: row.createdAt.toISOString(),
					memberCount: membersByOrganization.get(row.id) ?? 0,
					plan: pro ? ("pro" as const) : ("free" as const),
					subscriptionStatus: subscription?.status ?? null,
					basePriceCents: period?.basePriceCents ?? 0,
					apiCallsUsed: bucket?.committedUnits ?? 0,
					apiCallsIncluded:
						bucket?.includedUnits ??
						(pro ? PRICING.proCallsIncluded : PRICING.freeCallsIncluded),
					aiEnabled: subscription?.aiEnabled ?? false,
					dailyToolLimit: dailyToolLimitForPlan(
						pro ? "pro" : "free",
						subscription?.dailyToolLimitOverride,
					),
					dailyToolLimitOverride: subscription?.dailyToolLimitOverride ?? null,
				};
			}),
			total: Number(totalRows[0]?.value ?? 0),
			limit,
			offset,
		},
		200,
	);
});

const updateOrganization = createRoute({
	operationId: "adminUpdateOrganization",
	method: "patch",
	path: "/organizations/{id}",
	tags: ["Admin"],
	summary: "Update an organization and its administrative entitlement",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			required: true,
			content: { "application/json": { schema: AdminOrganizationUpdate } },
		},
	},
	responses: {
		200: {
			description: "Updated",
			content: { "application/json": { schema: AdminMutationResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "System administrator required",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Organization not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateOrganization, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const now = new Date();
	const authority = await withCredentialMutationAuthority(
		c,
		{ requireGlobalAdmin: true },
		async (tx) => {
			const [target] = await tx
				.select({ id: organization.id })
				.from(organization)
				.where(
					and(
						eq(organization.id, id),
						eq(organization.lifecycleStatus, "active"),
					),
				)
				.for("update")
				.limit(1);
			if (!target) return { kind: "not_found" } as const;

			const keyHashes = await tx
				.select({ hash: apikey.key })
				.from(apikey)
				.where(eq(apikey.organizationId, id));

			if (body.name !== undefined || body.slug !== undefined) {
				await tx
					.update(organization)
					.set({
						...(body.name !== undefined ? { name: body.name } : {}),
						...(body.slug !== undefined ? { slug: body.slug } : {}),
					})
					.where(eq(organization.id, id));
			}

			if (
				body.aiEnabled !== undefined ||
				body.dailyToolLimitOverride !== undefined
			) {
				const settings = {
					...(body.aiEnabled !== undefined
						? { aiEnabled: body.aiEnabled }
						: {}),
					...(body.dailyToolLimitOverride !== undefined
						? { dailyToolLimitOverride: body.dailyToolLimitOverride }
						: {}),
				};
				await tx
					.insert(organizationSubscriptions)
					.values({ organizationId: id, ...settings, updatedAt: now })
					.onConflictDoUpdate({
						target: organizationSubscriptions.organizationId,
						set: { ...settings, updatedAt: now },
					});
			}
			if (body.plan) {
				// Drizzle's PostgresJsTransaction.transaction() is a savepoint, so the
				// billing service remains inside this outer actor-authority transaction.
				await setComplimentaryPlan(tx as unknown as Database, {
					organizationId: id,
					active: body.plan === "pro",
					effectiveAt: now,
					cycleAllowance: PRICING.proCallsIncluded,
				});
			}
			return { kind: "updated", keyHashes } as const;
		},
	);

	if (!authority.ok) {
		markMutationInputNotApplied(c);
		return c.json(
			{ error: { code: authority.code, message: authority.message } } as never,
			authority.status as never,
		);
	}
	if (authority.value.kind === "not_found") {
		markMutationInputNotApplied(c);
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Organization not found" } },
			404,
		);
	}

	// PostgreSQL and KV cannot share one atomic commit. Finish every database
	// mutation under the live actor fence, then attempt every deterministic
	// delete after commit. Any cache failure is surfaced so an operator/client
	// retry can finish the best-effort repair.
	const invalidations = await Promise.allSettled([
		c.env.KV.delete(`org-summary:${id}`),
		...authority.value.keyHashes.map(({ hash }) =>
			c.env.KV.delete(`apikey:${hash}`),
		),
	]);
	const invalidationFailure = invalidations.find(
		(result): result is PromiseRejectedResult => result.status === "rejected",
	);
	if (invalidationFailure) {
		throw invalidationFailure.reason;
	}
	return c.json({ ok: true as const }, 200);
});

const listSubscriptions = createRoute({
	operationId: "adminListSubscriptions",
	method: "get",
	path: "/subscriptions",
	tags: ["Admin"],
	summary: "List organization subscriptions",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description: "Subscriptions",
			content: {
				"application/json": { schema: AdminSubscriptionListResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "System administrator required",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listSubscriptions, async (c) => {
	const db = c.get("db");
	const subscriptions = await db
		.select({
			id: organizationSubscriptions.id,
			organizationId: organizationSubscriptions.organizationId,
			status: organizationSubscriptions.status,
			source: organizationSubscriptions.source,
			delinquentAt: organizationSubscriptions.delinquentAt,
			graceEndsAt: organizationSubscriptions.graceEndsAt,
			currentPeriodStart: organizationSubscriptions.currentPeriodStart,
			currentPeriodEnd: organizationSubscriptions.currentPeriodEnd,
			trialEndsAt: organizationSubscriptions.trialEndsAt,
			createdAt: organizationSubscriptions.createdAt,
			orgName: organization.name,
			orgSlug: organization.slug,
		})
		.from(organizationSubscriptions)
		.leftJoin(
			organization,
			eq(organizationSubscriptions.organizationId, organization.id),
		)
		.orderBy(desc(organizationSubscriptions.createdAt));
	const organizationIds = subscriptions.map((row) => row.organizationId);
	const now = new Date();
	const [buckets, periods] =
		organizationIds.length === 0
			? [[], []]
			: await Promise.all([
					db
						.select()
						.from(usageBuckets)
						.where(
							and(
								inArray(usageBuckets.organizationId, organizationIds),
								eq(usageBuckets.metric, "successful_mutation"),
								lte(usageBuckets.periodStart, now),
								gt(usageBuckets.periodEnd, now),
							),
						)
						.orderBy(desc(usageBuckets.periodStart)),
					db
						.select()
						.from(billingPeriods)
						.where(
							and(
								inArray(billingPeriods.organizationId, organizationIds),
								eq(billingPeriods.state, "open"),
								lte(billingPeriods.periodStart, now),
								gt(billingPeriods.periodEnd, now),
							),
						)
						.orderBy(desc(billingPeriods.periodStart)),
				]);
	const bucketsByOrganization = new Map<string, (typeof buckets)[number]>();
	for (const bucket of buckets) {
		if (!bucketsByOrganization.has(bucket.organizationId)) {
			bucketsByOrganization.set(bucket.organizationId, bucket);
		}
	}
	const periodsByOrganization = new Map<string, (typeof periods)[number]>();
	for (const period of periods) {
		if (!periodsByOrganization.has(period.organizationId)) {
			periodsByOrganization.set(period.organizationId, period);
		}
	}
	return c.json(
		{
			subscriptions: subscriptions.map((row) => {
				const bucket = bucketsByOrganization.get(row.organizationId);
				const period = periodsByOrganization.get(row.organizationId);
				const included =
					bucket?.includedUnits ??
					(row.status === "active"
						? PRICING.proCallsIncluded
						: PRICING.freeCallsIncluded);
				const used = bucket?.committedUnits ?? 0;
				const overage = Math.max(0, used - included);
				return {
					...row,
					basePriceCents: period?.basePriceCents ?? 0,
					delinquentAt: row.delinquentAt?.toISOString() ?? null,
					graceEndsAt: row.graceEndsAt?.toISOString() ?? null,
					currentPeriodStart: row.currentPeriodStart.toISOString(),
					currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
					trialEndsAt: row.trialEndsAt?.toISOString() ?? null,
					createdAt: row.createdAt.toISOString(),
					apiCallsUsed: used,
					apiCallsIncluded: included,
					overageCalls: overage,
					overageCostCents: Math.ceil(
						(overage * PRICING.pricePerThousandCallsCents) / 1000,
					),
				};
			}),
		},
		200,
	);
});

const updateSubscription = createRoute({
	operationId: "adminUpdateSubscription",
	method: "patch",
	path: "/subscriptions/{id}",
	tags: ["Admin"],
	summary: "Update a subscription",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			required: true,
			content: { "application/json": { schema: AdminSubscriptionUpdate } },
		},
	},
	responses: {
		200: {
			description: "Updated",
			content: { "application/json": { schema: AdminMutationResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "System administrator required",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Subscription not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Subscription state is provider-owned",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(updateSubscription, async (c) => {
	const { id } = c.req.valid("param");
	const body = c.req.valid("json");
	const authority = await withCredentialMutationAuthority(
		c,
		{ requireGlobalAdmin: true },
		async (tx) => {
			const [row] = await tx
				.select({
					organizationId: organizationSubscriptions.organizationId,
					source: organizationSubscriptions.source,
				})
				.from(organizationSubscriptions)
				.where(eq(organizationSubscriptions.id, id))
				.for("update")
				.limit(1);
			if (!row) return { kind: "not_found" } as const;
			if (
				row.source !== "complimentary" ||
				(body.status !== "active" && body.status !== "cancelled")
			) {
				return { kind: "provider_owned" } as const;
			}
			await setComplimentaryPlan(tx as unknown as Database, {
				organizationId: row.organizationId,
				active: body.status === "active",
				cycleAllowance: PRICING.proCallsIncluded,
			});
			const hashes = await tx
				.select({ hash: apikey.key })
				.from(apikey)
				.where(eq(apikey.organizationId, row.organizationId));
			return { kind: "updated", hashes } as const;
		},
	);
	if (!authority.ok) {
		markMutationInputNotApplied(c);
		return c.json(
			{ error: { code: authority.code, message: authority.message } } as never,
			authority.status as never,
		);
	}
	if (authority.value.kind === "not_found") {
		markMutationInputNotApplied(c);
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Subscription not found" } },
			404,
		);
	}
	if (authority.value.kind === "provider_owned") {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: "PROVIDER_OWNED_SUBSCRIPTION",
					message:
						"Only active/cancelled complimentary grants can be changed administratively",
				},
			},
			409,
		);
	}
	const invalidations = await Promise.allSettled(
		authority.value.hashes.map(({ hash }) => c.env.KV.delete(`apikey:${hash}`)),
	);
	const invalidationFailure = invalidations.find(
		(result): result is PromiseRejectedResult => result.status === "rejected",
	);
	if (invalidationFailure) {
		throw invalidationFailure.reason;
	}
	return c.json({ ok: true as const }, 200);
});

const AdminAutomationWebhookFailureListQuery = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).max(10_000).default(0),
	organizationId: z.string().min(1).optional(),
	status: z
		.enum(["pending", "processing", "done", "failed", "unknown"])
		.optional(),
	review: z.enum(["all", "required"]).default("required"),
});

const listAutomationWebhookFailures = createRoute({
	operationId: "adminListAutomationWebhookFailures",
	method: "get",
	path: "/automation-webhook-failures",
	tags: ["Admin"],
	summary:
		"List sanitized automation webhook rejection receipts requiring operator review",
	security: [{ Bearer: [] }],
	request: { query: AdminAutomationWebhookFailureListQuery },
	responses: {
		200: {
			description: "Sanitized durable webhook rejection receipts",
			content: {
				"application/json": {
					schema: AdminAutomationWebhookFailureListResponse,
				},
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "System administrator required",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listAutomationWebhookFailures, async (c) => {
	const { limit, offset, organizationId, status, review } =
		c.req.valid("query");
	const db = c.get("db");
	const where = and(
		eq(automationScheduledJobs.jobType, "webhook_reception_failure"),
		organizationId ? eq(automations.organizationId, organizationId) : undefined,
		status ? eq(automationScheduledJobs.status, status) : undefined,
		review === "required"
			? inArray(automationScheduledJobs.status, ["failed", "unknown"])
			: undefined,
	);
	const [totalRows, rows] = await Promise.all([
		db
			.select({ value: count() })
			.from(automationScheduledJobs)
			.innerJoin(
				automations,
				eq(automationScheduledJobs.automationId, automations.id),
			)
			.where(where),
		db
			.select({
				occurrenceId: automationScheduledJobs.occurrenceId,
				organizationId: automations.organizationId,
				automationId: automations.id,
				entrypointId: automationScheduledJobs.entrypointId,
				channel: automations.channel,
				status: automationScheduledJobs.status,
				attempts: automationScheduledJobs.attempts,
				payload: automationScheduledJobs.payload,
				error: automationScheduledJobs.error,
				createdAt: automationScheduledJobs.createdAt,
			})
			.from(automationScheduledJobs)
			.innerJoin(
				automations,
				eq(automationScheduledJobs.automationId, automations.id),
			)
			.where(where)
			.orderBy(desc(automationScheduledJobs.createdAt))
			.limit(limit)
			.offset(offset),
	]);

	return c.json(
		{
			failures: rows.flatMap((row) => {
				if (!row.entrypointId) return [];
				const payload =
					row.payload && typeof row.payload === "object"
						? (row.payload as Record<string, unknown>)
						: {};
				const requestDigest =
					typeof payload.request_digest === "string" &&
					/^[a-f0-9]{64}$/.test(payload.request_digest)
						? payload.request_digest
						: null;
				const receivedAt =
					typeof payload.received_at === "string" &&
					!Number.isNaN(Date.parse(payload.received_at))
						? new Date(payload.received_at).toISOString()
						: row.createdAt.toISOString();
				const knownReasons = new Set([
					"missing_secret",
					"missing_signature",
					"credential_unavailable",
					"invalid_timestamp",
					"stale_timestamp",
					"bad_signature",
					"bad_payload",
					"contact_lookup_failed",
					"enrollment_blocked",
					"enrollment_failed",
				]);
				const reason =
					typeof payload.reason === "string" && knownReasons.has(payload.reason)
						? (payload.reason as
								| "missing_secret"
								| "missing_signature"
								| "credential_unavailable"
								| "invalid_timestamp"
								| "stale_timestamp"
								| "bad_signature"
								| "bad_payload"
								| "contact_lookup_failed"
								| "enrollment_blocked"
								| "enrollment_failed")
						: ("invalid_payload" as const);
				return [
					{
						occurrenceId: row.occurrenceId,
						organizationId: row.organizationId,
						automationId: row.automationId,
						entrypointId: row.entrypointId,
						channel: row.channel,
						socialAccountId:
							typeof payload.social_account_id === "string"
								? payload.social_account_id
								: null,
						reason,
						requestDigest,
						receivedAt,
						status: row.status,
						attempts: row.attempts,
						error: row.error,
						manualReviewRequired:
							row.status === "failed" || row.status === "unknown",
						// Rejected input was never trusted or accepted, so there is
						// no remote/product effect to replay. Repair the entrypoint or
						// alert sink; this row is immutable evidence, not a retry UI.
						resolutionMode: "evidence_only" as const,
						createdAt: row.createdAt.toISOString(),
					},
				];
			}),
			total: Number(totalRows[0]?.value ?? 0),
			limit,
			offset,
		},
		200,
	);
});

const AdminOperatorResolutionListQuery = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).max(10_000).default(0),
	organizationId: z.string().min(1).optional(),
	targetType: AdminOperatorResolutionTargetType.optional(),
});

const listOperatorResolutions = createRoute({
	operationId: "adminListOperatorResolutions",
	method: "get",
	path: "/operator-resolutions",
	tags: ["Admin"],
	summary: "List unresolved asynchronous and erasure outcomes",
	security: [{ Bearer: [] }],
	request: { query: AdminOperatorResolutionListQuery },
	responses: {
		200: {
			description: "Sanitized unresolved items and their allowed actions",
			content: {
				"application/json": { schema: AdminOperatorResolutionListResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "System administrator required",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listOperatorResolutions, async (c) => {
	const { limit, offset, organizationId, targetType } = c.req.valid("query");
	const result = await listOperatorResolutionItems(c.get("db"), {
		limit,
		offset,
		organizationId,
		targetType,
	});
	return c.json(
		{
			items: result.items.map((item) => ({
				...item,
				detectedAt: item.detectedAt.toISOString(),
				updatedAt: item.updatedAt.toISOString(),
			})),
			total: result.total,
			limit,
			offset,
		},
		200,
	);
});

const AdminOperatorResolutionEvidenceListQuery = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(50),
	cursor: z.string().optional(),
	organizationId: z.string().min(1).max(255).optional(),
	targetType: AdminOperatorResolutionTargetType.optional(),
	targetId: z.string().min(1).max(255).optional(),
	action: AdminOperatorResolutionAction.optional(),
});

const listOperatorResolutionEvidenceRoute = createRoute({
	operationId: "adminListOperatorResolutionEvidence",
	method: "get",
	path: "/operator-resolution-evidence",
	tags: ["Admin"],
	summary: "List retained operator-resolution evidence",
	security: [{ Bearer: [] }],
	request: { query: AdminOperatorResolutionEvidenceListQuery },
	responses: {
		200: {
			description:
				"Paginated immutable decisions with sanitized typed state summaries",
			content: {
				"application/json": {
					schema: AdminOperatorResolutionEvidenceListResponse,
				},
			},
		},
		400: {
			description: "Invalid pagination cursor",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "System administrator required",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listOperatorResolutionEvidenceRoute, async (c) => {
	const {
		limit,
		cursor: rawCursor,
		organizationId,
		targetType,
		targetId,
		action,
	} = c.req.valid("query");
	let cursor: TimestampIdCursor | undefined;
	try {
		cursor = rawCursor ? decodeTimestampIdCursor(rawCursor) : undefined;
	} catch (error) {
		if (error instanceof InvalidPaginationCursorError) {
			return c.json(INVALID_CURSOR_BODY, 400);
		}
		throw error;
	}
	const result = await listOperatorResolutionEvidence(c.get("db"), {
		limit,
		encryptionKey: c.env.ENCRYPTION_KEY,
		cursor,
		organizationId,
		targetType,
		targetId,
		action,
	});
	return c.json(
		{
			evidence: result.evidence.map(serializeOperatorResolutionEvidence),
			next_cursor: result.nextCursor,
			has_more: result.hasMore,
		},
		200,
	);
});

const AdminOperatorResolutionParams = z.object({
	targetType: AdminOperatorResolutionTargetType,
	targetId: z.string().min(1).max(255),
});

const resolveOperatorResolutionRoute = createRoute({
	operationId: "adminResolveOperatorResolution",
	method: "post",
	path: "/operator-resolutions/{targetType}/{targetId}",
	tags: ["Admin"],
	summary: "Apply one lifecycle-safe operator resolution",
	security: [{ Bearer: [] }],
	request: {
		params: AdminOperatorResolutionParams,
		body: {
			required: true,
			content: {
				"application/json": { schema: AdminOperatorResolutionRequest },
			},
		},
	},
	responses: {
		200: {
			description: "Immutable operator decision evidence",
			content: {
				"application/json": { schema: AdminOperatorResolutionResponse },
			},
		},
		400: {
			description: "Invalid resolution input",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "System administrator required",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Target not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "Target changed during resolution",
			content: { "application/json": { schema: ErrorResponse } },
		},
		422: {
			description: "Action is unsafe for the current target state",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(resolveOperatorResolutionRoute, async (c) => {
	const params = c.req.valid("param");
	const body = c.req.valid("json");
	try {
		const authority = await withCredentialMutationAuthority(
			c,
			{ requireGlobalAdmin: true },
			// Every resolver branch receives this PgTransaction; its nested
			// transaction is a savepoint under the actor-authority fence.
			(tx, actor) =>
				resolveOperatorResolution(
					tx as unknown as Database,
					{
						targetType: params.targetType,
						targetId: params.targetId,
						action: body.action,
						reason: body.reason,
						actorUserId: requireFencedAdminUserId(actor),
						providerReference: body.providerReference,
					},
					c.env.ENCRYPTION_KEY,
				),
		);
		if (!authority.ok) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: { code: authority.code, message: authority.message },
				} as never,
				authority.status as never,
			);
		}
		return c.json(
			{ evidence: serializeOperatorResolutionEvidence(authority.value) },
			200,
		);
	} catch (error) {
		if (error instanceof OperatorResolutionInputError) {
			markMutationInputNotApplied(c);
			return c.json(
				{ error: { code: "BAD_REQUEST", message: error.message } },
				400,
			);
		}
		if (error instanceof OperatorResolutionNotFoundError) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: {
						code: "NOT_FOUND",
						message: "Operator-resolution target not found",
					},
				},
				404,
			);
		}
		if (error instanceof OperatorResolutionStateConflictError) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: {
						code: "STATE_CONFLICT",
						message: error.message,
					},
				},
				409,
			);
		}
		if (error instanceof OperatorResolutionActionNotAllowedError) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: {
						code: "INVALID_STATE",
						message: error.message,
					},
				},
				422,
			);
		}
		throw error;
	}
});

const AdminErasureHoldListQuery = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).default(0),
	organizationId: z.string().min(1).optional(),
	subjectKind: z.enum(["organization", "workspace"]).optional(),
	active: z.enum(["true", "false"]).default("true"),
});

const AdminErasureJobListQuery = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(50),
	offset: z.coerce.number().int().min(0).max(10_000).default(0),
	organizationId: z.string().min(1).optional(),
	status: z
		.enum([
			"pending",
			"processing",
			"tombstoned",
			"waiting_external",
			"held",
			"manual_review",
			"failed",
			"purged",
		])
		.optional(),
	aged: z.enum(["all", "true", "false"]).default("all"),
});

const listErasureJobs = createRoute({
	operationId: "adminListErasureJobs",
	method: "get",
	path: "/erasure-jobs",
	tags: ["Admin"],
	summary: "List tenant and workspace erasure jobs, holds, and aged alerts",
	security: [{ Bearer: [] }],
	request: { query: AdminErasureJobListQuery },
	responses: {
		200: {
			description: "Erasure jobs",
			content: {
				"application/json": { schema: AdminErasureJobListResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "System administrator required",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

interface AdminErasureJobRow extends Record<string, unknown> {
	kind: "organization" | "workspace";
	job_id: string;
	organization_id: string;
	workspace_id: string | null;
	status:
		| "pending"
		| "processing"
		| "tombstoned"
		| "waiting_external"
		| "held"
		| "manual_review"
		| "failed"
		| "purged";
	active_hold_id: string | null;
	requested_at: Date;
	updated_at: Date;
	aged_alerted_at: Date | null;
	completed_at: Date | null;
}

app.openapi(listErasureJobs, async (c) => {
	const { limit, offset, organizationId, status, aged } = c.req.valid("query");
	const db = c.get("db");
	const agedCutoff = new Date(Date.now() - 24 * 60 * 60 * 1_000);
	const filters = and(
		organizationId ? sql`job.organization_id = ${organizationId}` : undefined,
		status ? sql`job.status = ${status}` : undefined,
		aged === "true"
			? sql`job.requested_at < ${agedCutoff} AND job.status <> 'purged'`
			: aged === "false"
				? sql`NOT (job.requested_at < ${agedCutoff} AND job.status <> 'purged')`
				: undefined,
	);
	const where = filters ? sql`WHERE ${filters}` : sql``;
	const jobs = sql`
		WITH job AS (
			SELECT
				'organization'::text AS kind,
				organization_id AS job_id,
				organization_id,
				NULL::text AS workspace_id,
				status,
				requested_at,
				updated_at,
				aged_alerted_at,
				completed_at
			FROM public.tenant_deletion_jobs
			UNION ALL
			SELECT
				'workspace'::text AS kind,
				erasure_operation_id AS job_id,
				organization_id,
				workspace_id,
				status,
				requested_at,
				updated_at,
				aged_alerted_at,
				completed_at
			FROM public.workspace_erasure_jobs
		)
		SELECT
			job.*,
			active_hold.id AS active_hold_id
		FROM job
		LEFT JOIN LATERAL (
			SELECT hold.id
			FROM public.erasure_holds AS hold
			WHERE hold.released_at IS NULL
			  AND hold.organization_tombstone_id = job.organization_id
			  AND (
					(hold.subject_kind = 'organization'
						AND hold.subject_id = job.organization_id)
					OR (job.kind = 'workspace'
						AND hold.subject_kind = 'workspace'
						AND hold.subject_id = job.workspace_id)
			  )
			ORDER BY
				CASE WHEN hold.subject_kind = 'workspace' THEN 0 ELSE 1 END,
				hold.placed_at,
				hold.id
			LIMIT 1
		) AS active_hold ON true
		${where}
		ORDER BY job.requested_at DESC, job.kind, job.job_id
		LIMIT ${limit}
		OFFSET ${offset}
	`;
	const countJobs = sql`
		WITH job AS (
			SELECT organization_id, status, requested_at
			FROM public.tenant_deletion_jobs
			UNION ALL
			SELECT organization_id, status, requested_at
			FROM public.workspace_erasure_jobs
		)
		SELECT count(*)::integer AS value
		FROM job
		${where}
	`;
	const [rows, totalRows] = await Promise.all([
		db.execute<AdminErasureJobRow>(jobs),
		db.execute<{ value: number }>(countJobs),
	]);
	return c.json(
		{
			jobs: rows.map((row) => ({
				kind: row.kind,
				jobId: row.job_id,
				organizationId: row.organization_id,
				workspaceId: row.workspace_id,
				status: row.status,
				activeHoldId: row.active_hold_id,
				requestedAt: row.requested_at.toISOString(),
				updatedAt: row.updated_at.toISOString(),
				agedAlertedAt: row.aged_alerted_at?.toISOString() ?? null,
				completedAt: row.completed_at?.toISOString() ?? null,
			})),
			total: Number(totalRows[0]?.value ?? 0),
			limit,
			offset,
		},
		200,
	);
});

const listErasureHolds = createRoute({
	operationId: "adminListErasureHolds",
	method: "get",
	path: "/erasure-holds",
	tags: ["Admin"],
	summary: "List audited organization and workspace erasure holds",
	security: [{ Bearer: [] }],
	request: { query: AdminErasureHoldListQuery },
	responses: {
		200: {
			description: "Erasure holds",
			content: {
				"application/json": { schema: AdminErasureHoldListResponse },
			},
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "System administrator required",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(listErasureHolds, async (c) => {
	const { limit, offset, organizationId, subjectKind, active } =
		c.req.valid("query");
	const conditions = [
		...(organizationId
			? [eq(erasureHolds.organizationTombstoneId, organizationId)]
			: []),
		...(subjectKind ? [eq(erasureHolds.subjectKind, subjectKind)] : []),
		...(active === "true" ? [sql`${erasureHolds.releasedAt} IS NULL`] : []),
	];
	const where = conditions.length > 0 ? and(...conditions) : undefined;
	const db = c.get("db");
	const [totalRows, rows] = await Promise.all([
		db.select({ value: count() }).from(erasureHolds).where(where),
		db
			.select()
			.from(erasureHolds)
			.where(where)
			.orderBy(desc(erasureHolds.placedAt), desc(erasureHolds.id))
			.limit(limit)
			.offset(offset),
	]);
	return c.json(
		{
			holds: rows.map(serializeErasureHold),
			total: Number(totalRows[0]?.value ?? 0),
			limit,
			offset,
		},
		200,
	);
});

const createErasureHold = createRoute({
	operationId: "adminCreateErasureHold",
	method: "post",
	path: "/erasure-holds",
	tags: ["Admin"],
	summary: "Place an audited organization or workspace erasure hold",
	security: [{ Bearer: [] }],
	request: {
		body: {
			required: true,
			content: { "application/json": { schema: AdminErasureHoldCreate } },
		},
	},
	responses: {
		201: {
			description: "Erasure hold placed",
			content: { "application/json": { schema: AdminErasureHold } },
		},
		400: {
			description: "Invalid hold",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "System administrator required",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Target not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "An active hold already exists",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(createErasureHold, async (c) => {
	const body = c.req.valid("json");
	try {
		const evidenceCiphertext = body.evidence
			? await encryptToken(body.evidence, c.env.ENCRYPTION_KEY, {
					recordId:
						body.subjectKind === "organization"
							? body.organizationId
							: body.workspaceId,
					field: "erasure_hold_evidence",
				})
			: null;
		const authority = await withCredentialMutationAuthority(
			c,
			{ requireGlobalAdmin: true },
			(tx, actor) =>
				placeErasureHold(tx as unknown as Database, {
					target:
						body.subjectKind === "organization"
							? {
									kind: "organization",
									organizationId: body.organizationId,
								}
							: {
									kind: "workspace",
									organizationId: body.organizationId,
									workspaceId: body.workspaceId,
								},
					reasonCode: body.reasonCode,
					reasonSummary: body.reasonSummary,
					legalAuthorityRef: body.legalAuthorityRef,
					evidenceCiphertext,
					actorUserId: requireFencedAdminUserId(actor),
				}),
		);
		if (!authority.ok) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: { code: authority.code, message: authority.message },
				} as never,
				authority.status as never,
			);
		}
		return c.json(serializeErasureHold(authority.value), 201);
	} catch (error) {
		if (error instanceof ErasureHoldAuthorizationError) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: {
						code: "FORBIDDEN",
						message: "System administrator access is required",
					},
				},
				403,
			);
		}
		if (error instanceof ErasureHoldTargetNotFoundError) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: {
						code: "NOT_FOUND",
						message: "Erasure-hold target not found",
					},
				},
				404,
			);
		}
		if (error instanceof InvalidErasureHoldInputError) {
			markMutationInputNotApplied(c);
			return c.json(
				{ error: { code: "BAD_REQUEST", message: error.message } },
				400,
			);
		}
		if (isUniqueViolation(error)) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: {
						code: "CONFLICT",
						message: "An active hold already exists for this target",
					},
				},
				409,
			);
		}
		throw error;
	}
});

const releaseErasureHoldRoute = createRoute({
	operationId: "adminReleaseErasureHold",
	method: "post",
	path: "/erasure-holds/{id}/release",
	tags: ["Admin"],
	summary: "Release an active erasure hold and wake paused erasure work",
	security: [{ Bearer: [] }],
	request: {
		params: IdParam,
		body: {
			required: true,
			content: { "application/json": { schema: AdminErasureHoldRelease } },
		},
	},
	responses: {
		200: {
			description: "Erasure hold released",
			content: { "application/json": { schema: AdminErasureHold } },
		},
		400: {
			description: "Invalid release",
			content: { "application/json": { schema: ErrorResponse } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponse } },
		},
		403: {
			description: "System administrator required",
			content: { "application/json": { schema: ErrorResponse } },
		},
		404: {
			description: "Active hold not found",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(releaseErasureHoldRoute, async (c) => {
	try {
		const authority = await withCredentialMutationAuthority(
			c,
			{ requireGlobalAdmin: true },
			(tx, actor) =>
				releaseErasureHold(tx as unknown as Database, {
					holdId: c.req.valid("param").id,
					releaseReasonSummary: c.req.valid("json").releaseReasonSummary,
					actorUserId: requireFencedAdminUserId(actor),
				}),
		);
		if (!authority.ok) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: { code: authority.code, message: authority.message },
				} as never,
				authority.status as never,
			);
		}
		return c.json(serializeErasureHold(authority.value), 200);
	} catch (error) {
		if (error instanceof ErasureHoldAuthorizationError) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: {
						code: "FORBIDDEN",
						message: "System administrator access is required",
					},
				},
				403,
			);
		}
		if (error instanceof ErasureHoldNotFoundError) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: {
						code: "NOT_FOUND",
						message: "Active erasure hold not found",
					},
				},
				404,
			);
		}
		if (error instanceof InvalidErasureHoldInputError) {
			markMutationInputNotApplied(c);
			return c.json(
				{ error: { code: "BAD_REQUEST", message: error.message } },
				400,
			);
		}
		throw error;
	}
});

export default app;
