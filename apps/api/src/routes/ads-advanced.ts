import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { adAccounts, adConnections, and, eq, member } from "@relayapi/db";
import type { Context } from "hono";
import { assertWorkspaceScope } from "../lib/workspace-scope";
import { markMutationInputNotApplied } from "../middleware/mutation-validation";
import {
	AdAdvancedResourceResponse,
	AdConversionEventResponse,
	AdConversionRuleResponse,
	AdLeadFormListResponse,
	AdLeadFormResponse,
	AdLeadListQuery,
	AdLeadListResponse,
	AdLeadResponse,
	AdPlanningRequest,
	AdPlanningResponse,
	AdReportJobResponse,
	AdReportResultsResponse,
	AdvancedAdAccountCapabilitiesResponse,
	AdvancedAdAccountParams,
	AdvancedAdIdParams,
	AdvancedAdListQuery,
	CreateAdCatalogBody,
	CreateAdConversionEventBody,
	CreateAdConversionRuleBody,
	CreateAdCreativeAssetBody,
	CreateAdLeadFormProjectionBody,
	CreateAdMessagingExperienceBody,
	CreateAdProductSetBody,
	CreateAdReportBody,
	PromoteAdLeadBody,
	PromoteAdLeadResponse,
} from "../schemas/ads-advanced";
import { ErrorResponse } from "../schemas/common";
import {
	AdvancedAdCapabilityError,
	type AdvancedAdFeature,
	effectiveAdvancedAdCapabilities,
	requireAdvancedAdCapability,
	serializeAdvancedAdCapabilities,
} from "../services/ad-advanced-capabilities";
import {
	type AdvancedAdResourceAuthority,
	AdvancedAdStoreError,
	createAdConversionEvent,
	createAdConversionRule,
	createAdReportJob,
	createAdvancedAdResource,
	createLeadFormProjection,
	getAdConversionRuleAuthority,
	getAdReportJob,
	getAdReportJobAuthority,
	getAdvancedAdLead,
	getAdvancedAdLeadAuthority,
	listAdReportResultRows,
	listAdvancedAdLeads,
	listLeadFormProjections,
	promoteAdvancedAdLead,
} from "../services/ad-advanced-store";
import type { AdPlatform } from "../services/ad-platforms/types";
import { dispatchAdvancedAdReportJob } from "../services/ad-report-jobs";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

type AdvancedAdPermission =
	| "view_ad_leads"
	| "manage_ad_leads"
	| "manage_ad_conversions";

interface AuthorizedAdAccount {
	id: string;
	workspaceId: string | null;
	platform: AdPlatform;
	platformAdAccountId: string;
	status: string | null;
	capabilities: unknown;
	grantedScopes: string[];
}

const IdempotencyHeaders = z.object({
	"idempotency-key": z.string().trim().min(1).max(255),
});

const ReportResultQuery = z.object({
	cursor: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(20),
});

const MutationErrors = {
	400: {
		description: "Invalid request",
		content: { "application/json": { schema: ErrorResponse } },
	},
	403: {
		description: "Permission or workspace denied",
		content: { "application/json": { schema: ErrorResponse } },
	},
	404: {
		description: "Resource not found",
		content: { "application/json": { schema: ErrorResponse } },
	},
	409: {
		description: "Idempotency or protected-identity conflict",
		content: { "application/json": { schema: ErrorResponse } },
	},
	422: {
		description: "Provider approval or implementation is unavailable",
		content: { "application/json": { schema: ErrorResponse } },
	},
} as const;

async function authorizeAdAccount(
	c: AppContext,
	id: string,
): Promise<AuthorizedAdAccount | Response> {
	const [row] = await c
		.get("db")
		.select({
			id: adAccounts.id,
			workspaceId: adAccounts.workspaceId,
			platform: adAccounts.platform,
			platformAdAccountId: adAccounts.platformAdAccountId,
			status: adAccounts.status,
			capabilities: adAccounts.capabilities,
			connectionScopes: adConnections.scopes,
		})
		.from(adAccounts)
		.leftJoin(
			adConnections,
			and(
				eq(adConnections.id, adAccounts.adConnectionId),
				eq(adConnections.organizationId, adAccounts.organizationId),
			),
		)
		.where(
			and(eq(adAccounts.id, id), eq(adAccounts.organizationId, c.get("orgId"))),
		)
		.limit(1);
	if (!row) {
		markMutationInputNotApplied(c);
		return c.json(
			{ error: { code: "NOT_FOUND", message: "Ad account not found" } },
			404,
		);
	}
	const denied = assertWorkspaceScope(c, row.workspaceId);
	if (denied) {
		markMutationInputNotApplied(c);
		return denied;
	}
	return {
		id: row.id,
		workspaceId: row.workspaceId,
		platform: row.platform,
		platformAdAccountId: row.platformAdAccountId,
		status: row.status,
		capabilities: row.capabilities,
		grantedScopes: row.connectionScopes ?? [],
	};
}

async function authorizeAdvancedResource(
	c: AppContext,
	authority: AdvancedAdResourceAuthority,
): Promise<AuthorizedAdAccount | Response> {
	const account = await authorizeAdAccount(c, authority.adAccountId);
	if (account instanceof Response) return account;
	if (
		account.workspaceId !== authority.workspaceId ||
		account.platform !== authority.platform
	) {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: { code: "NOT_FOUND", message: "Advanced ad resource not found" },
			},
			404,
		);
	}
	return account;
}

async function hasAdvancedAdPermission(
	c: AppContext,
	permission: AdvancedAdPermission,
): Promise<boolean> {
	if (c.get("principalType") === "service") {
		return c.get("permissions").includes(permission);
	}
	const userId = c.get("principalUserId");
	if (!userId) return false;
	const [membership] = await c
		.get("db")
		.select({ role: member.role })
		.from(member)
		.where(
			and(eq(member.organizationId, c.get("orgId")), eq(member.userId, userId)),
		)
		.limit(1);
	const roles = new Set(
		(membership?.role ?? "").split(",").map((role) => role.trim()),
	);
	return roles.has("owner") || roles.has("admin");
}

async function requireAdvancedAdPermission(
	c: AppContext,
	permission: AdvancedAdPermission,
): Promise<Response | undefined> {
	if (await hasAdvancedAdPermission(c, permission)) return undefined;
	markMutationInputNotApplied(c);
	return c.json(
		{
			error: {
				code: `${permission.toUpperCase()}_REQUIRED`,
				message: `This credential requires the ${permission} permission.`,
			},
		},
		403,
	);
}

function requireAccountFeature(
	account: AuthorizedAdAccount,
	feature: AdvancedAdFeature,
	options: { activeAccount?: boolean } = {},
): void {
	if (options.activeAccount && account.status !== "active") {
		throw new AdvancedAdCapabilityError(feature, {
			state: "unsupported",
			reason: "The advertising account is not active",
			requiredScopes: [],
			checkedAt: null,
		});
	}
	requireAdvancedAdCapability(
		effectiveAdvancedAdCapabilities(
			account.platform,
			account.capabilities,
			account.grantedScopes,
		),
		feature,
	);
}

function handleAdvancedAdError(c: AppContext, error: unknown): Response {
	if (error instanceof AdvancedAdCapabilityError) {
		markMutationInputNotApplied(c);
		return c.json(
			{
				error: {
					code: error.code,
					message: error.message,
					details: {
						feature: error.feature,
						required_scopes: error.capability.requiredScopes,
						required_program: error.capability.requiredProgram,
					},
				},
			},
			422,
		);
	}
	if (error instanceof AdvancedAdStoreError) {
		if (error.code !== "NOT_FOUND") markMutationInputNotApplied(c);
		const status =
			error.code === "NOT_FOUND"
				? 404
				: error.code === "INVALID_CURSOR" ||
						error.code === "LEAD_IDENTITY_REQUIRED"
					? 400
					: 409;
		return c.json(
			{ error: { code: error.code, message: error.message } },
			status,
		);
	}
	console.error("[ads-advanced] request failed", {
		event: "advanced_ad_request_failed",
		error: error instanceof Error ? error.message : String(error),
	});
	return c.json(
		{
			error: { code: "INTERNAL_ERROR", message: "Advanced ad request failed" },
		},
		500,
	);
}

const getCapabilitiesRoute = createRoute({
	operationId: "getAdvancedAdAccountCapabilities",
	method: "get",
	path: "/accounts/{ad_account_id}/advanced-capabilities",
	tags: ["Ads"],
	security: [{ Bearer: [] }],
	request: { params: AdvancedAdAccountParams },
	responses: {
		200: {
			description: "Effective implementation and account capability state",
			content: {
				"application/json": { schema: AdvancedAdAccountCapabilitiesResponse },
			},
		},
		403: MutationErrors[403],
		404: MutationErrors[404],
	},
});

app.openapi(getCapabilitiesRoute, async (c) => {
	const account = await authorizeAdAccount(
		c,
		c.req.valid("param").ad_account_id,
	);
	if (account instanceof Response) return account as never;
	return c.json(
		{
			ad_account_id: account.id,
			platform: account.platform,
			capabilities: serializeAdvancedAdCapabilities(
				effectiveAdvancedAdCapabilities(
					account.platform,
					account.capabilities,
					account.grantedScopes,
				),
			),
		} as z.infer<typeof AdvancedAdAccountCapabilitiesResponse>,
		200,
	);
});

const listLeadFormsRoute = createRoute({
	operationId: "listAdLeadForms",
	method: "get",
	path: "/lead-forms",
	tags: ["Ads"],
	security: [{ Bearer: [] }],
	request: { query: AdvancedAdListQuery },
	responses: {
		200: {
			description: "Lead-form projections",
			content: { "application/json": { schema: AdLeadFormListResponse } },
		},
		400: MutationErrors[400],
		403: MutationErrors[403],
		404: MutationErrors[404],
		422: MutationErrors[422],
	},
});

app.openapi(listLeadFormsRoute, async (c) => {
	const permission = await requireAdvancedAdPermission(c, "view_ad_leads");
	if (permission) return permission as never;
	const query = c.req.valid("query");
	const account = await authorizeAdAccount(c, query.ad_account_id);
	if (account instanceof Response) return account as never;
	try {
		requireAccountFeature(account, "lead_forms");
		return c.json(
			await listLeadFormProjections(c.get("db"), {
				organizationId: c.get("orgId"),
				adAccountId: account.id,
				cursor: query.cursor,
				limit: query.limit,
			}),
			200,
		);
	} catch (error) {
		return handleAdvancedAdError(c, error) as never;
	}
});

const createLeadFormRoute = createRoute({
	operationId: "linkAdLeadForm",
	method: "post",
	path: "/lead-forms",
	tags: ["Ads"],
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: {
				"application/json": { schema: CreateAdLeadFormProjectionBody },
			},
		},
	},
	responses: {
		201: {
			description: "Lead-form projection linked",
			content: { "application/json": { schema: AdLeadFormResponse } },
		},
		...MutationErrors,
	},
});

app.openapi(createLeadFormRoute, async (c) => {
	const permission = await requireAdvancedAdPermission(c, "manage_ad_leads");
	if (permission) return permission as never;
	const body = c.req.valid("json");
	const account = await authorizeAdAccount(c, body.ad_account_id);
	if (account instanceof Response) return account as never;
	try {
		requireAccountFeature(account, "lead_forms", { activeAccount: true });
		return c.json(
			await createLeadFormProjection(c.get("db"), {
				organizationId: c.get("orgId"),
				workspaceId: account.workspaceId,
				adAccountId: account.id,
				platform: account.platform,
				providerFormId: body.provider_form_id,
				name: body.name,
				status: body.status,
				configuration: body.configuration,
			}),
			201,
		);
	} catch (error) {
		return handleAdvancedAdError(c, error) as never;
	}
});

const listLeadsRoute = createRoute({
	operationId: "listAdLeads",
	method: "get",
	path: "/leads",
	tags: ["Ads"],
	security: [{ Bearer: [] }],
	request: { query: AdLeadListQuery },
	responses: {
		200: {
			description: "Decrypted lead inbox",
			content: { "application/json": { schema: AdLeadListResponse } },
		},
		...MutationErrors,
	},
});

app.openapi(listLeadsRoute, async (c) => {
	const permission = await requireAdvancedAdPermission(c, "view_ad_leads");
	if (permission) return permission as never;
	const query = c.req.valid("query");
	const account = await authorizeAdAccount(c, query.ad_account_id);
	if (account instanceof Response) return account as never;
	try {
		requireAccountFeature(account, "lead_inbox");
		return c.json(
			await listAdvancedAdLeads(c.get("db"), c.env.ENCRYPTION_KEY, {
				organizationId: c.get("orgId"),
				adAccountId: account.id,
				status: query.status,
				leadFormId: query.lead_form_id,
				cursor: query.cursor,
				limit: query.limit,
			}),
			200,
		);
	} catch (error) {
		return handleAdvancedAdError(c, error) as never;
	}
});

const getLeadRoute = createRoute({
	operationId: "getAdLead",
	method: "get",
	path: "/leads/{id}",
	tags: ["Ads"],
	security: [{ Bearer: [] }],
	request: { params: AdvancedAdIdParams },
	responses: {
		200: {
			description: "Decrypted lead",
			content: { "application/json": { schema: AdLeadResponse } },
		},
		403: MutationErrors[403],
		404: MutationErrors[404],
	},
});

app.openapi(getLeadRoute, async (c) => {
	const permission = await requireAdvancedAdPermission(c, "view_ad_leads");
	if (permission) return permission as never;
	try {
		const authority = await getAdvancedAdLeadAuthority(c.get("db"), {
			organizationId: c.get("orgId"),
			id: c.req.valid("param").id,
		});
		const account = await authorizeAdvancedResource(c, authority);
		if (account instanceof Response) return account as never;
		requireAccountFeature(account, "lead_inbox");
		const lead = await getAdvancedAdLead(c.get("db"), c.env.ENCRYPTION_KEY, {
			organizationId: c.get("orgId"),
			id: c.req.valid("param").id,
			adAccountId: account.id,
			workspaceId: account.workspaceId,
		});
		return c.json(lead, 200);
	} catch (error) {
		return handleAdvancedAdError(c, error) as never;
	}
});

const promoteLeadRoute = createRoute({
	operationId: "promoteAdLead",
	method: "post",
	path: "/leads/{id}/promote",
	tags: ["Ads"],
	security: [{ Bearer: [] }],
	request: {
		params: AdvancedAdIdParams,
		body: { content: { "application/json": { schema: PromoteAdLeadBody } } },
	},
	responses: {
		200: {
			description: "Lead promoted idempotently",
			content: { "application/json": { schema: PromoteAdLeadResponse } },
		},
		...MutationErrors,
	},
});

app.openapi(promoteLeadRoute, async (c) => {
	const permission = await requireAdvancedAdPermission(c, "manage_ad_leads");
	if (permission) return permission as never;
	try {
		const authority = await getAdvancedAdLeadAuthority(c.get("db"), {
			organizationId: c.get("orgId"),
			id: c.req.valid("param").id,
		});
		const account = await authorizeAdvancedResource(c, authority);
		if (account instanceof Response) return account as never;
		requireAccountFeature(account, "lead_promotion");
		const body = c.req.valid("json");
		const result = await promoteAdvancedAdLead(
			c.get("db"),
			c.env.ENCRYPTION_KEY,
			{
				organizationId: c.get("orgId"),
				leadId: c.req.valid("param").id,
				adAccountId: account.id,
				workspaceId: account.workspaceId,
				nameField: body.name_field,
				emailField: body.email_field,
				phoneField: body.phone_field,
				metadataFields: body.metadata_fields,
				tags: body.tags,
			},
		);
		return c.json({
			lead: result.lead,
			contact_id: result.contactId,
			created: result.created,
		});
	} catch (error) {
		return handleAdvancedAdError(c, error) as never;
	}
});

const createConversionRuleRoute = createRoute({
	operationId: "createAdConversionRule",
	method: "post",
	path: "/conversion-rules",
	tags: ["Ads"],
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: CreateAdConversionRuleBody } },
		},
	},
	responses: {
		201: {
			description: "Conversion rule created",
			content: { "application/json": { schema: AdConversionRuleResponse } },
		},
		...MutationErrors,
	},
});

app.openapi(createConversionRuleRoute, async (c) => {
	const permission = await requireAdvancedAdPermission(
		c,
		"manage_ad_conversions",
	);
	if (permission) return permission as never;
	const body = c.req.valid("json");
	const account = await authorizeAdAccount(c, body.ad_account_id);
	if (account instanceof Response) return account as never;
	try {
		requireAccountFeature(account, "conversions", { activeAccount: true });
		return c.json(
			await createAdConversionRule(c.get("db"), {
				organizationId: c.get("orgId"),
				workspaceId: account.workspaceId,
				adAccountId: account.id,
				platform: account.platform,
				name: body.name,
				eventName: body.event_name,
				providerDestinationId: body.provider_destination_id,
				configuration: body.configuration,
				enabled: body.enabled,
			}),
			201,
		);
	} catch (error) {
		return handleAdvancedAdError(c, error) as never;
	}
});

const createConversionEventRoute = createRoute({
	operationId: "createAdConversionEvent",
	method: "post",
	path: "/conversion-events",
	tags: ["Ads"],
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: CreateAdConversionEventBody } },
		},
	},
	responses: {
		202: {
			description: "Durable conversion event accepted",
			content: { "application/json": { schema: AdConversionEventResponse } },
		},
		...MutationErrors,
	},
});

app.openapi(createConversionEventRoute, async (c) => {
	const permission = await requireAdvancedAdPermission(
		c,
		"manage_ad_conversions",
	);
	if (permission) return permission as never;
	const body = c.req.valid("json");
	try {
		const authority = await getAdConversionRuleAuthority(c.get("db"), {
			organizationId: c.get("orgId"),
			id: body.conversion_rule_id,
		});
		const account = await authorizeAdvancedResource(c, authority);
		if (account instanceof Response) return account as never;
		requireAccountFeature(account, "conversions", { activeAccount: true });
		return c.json(
			await createAdConversionEvent(c.get("db"), c.env.ENCRYPTION_KEY, {
				organizationId: c.get("orgId"),
				conversionRuleId: body.conversion_rule_id,
				adAccountId: account.id,
				workspaceId: account.workspaceId,
				platform: account.platform,
				eventId: body.event_id,
				payload: {
					occurred_at: body.occurred_at,
					value_micros: body.value_micros,
					currency: body.currency,
					identifiers: body.identifiers,
					properties: body.properties,
				},
			}),
			202,
		);
	} catch (error) {
		return handleAdvancedAdError(c, error) as never;
	}
});

const createMessagingRoute = createRoute({
	operationId: "linkAdMessagingExperience",
	method: "post",
	path: "/messaging-experiences",
	tags: ["Ads"],
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: {
				"application/json": { schema: CreateAdMessagingExperienceBody },
			},
		},
	},
	responses: {
		201: {
			description: "Messaging experience linked",
			content: { "application/json": { schema: AdAdvancedResourceResponse } },
		},
		...MutationErrors,
	},
});

app.openapi(createMessagingRoute, async (c) => {
	const body = c.req.valid("json");
	const account = await authorizeAdAccount(c, body.ad_account_id);
	if (account instanceof Response) return account as never;
	try {
		requireAccountFeature(account, "messaging_experiences", {
			activeAccount: true,
		});
		if (body.configuration.platform !== account.platform) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: {
						code: "PLATFORM_MISMATCH",
						message:
							"Messaging configuration must match the ad account platform",
					},
				},
				400,
			) as never;
		}
		return c.json(
			await createAdvancedAdResource(c.get("db"), {
				organizationId: c.get("orgId"),
				workspaceId: account.workspaceId,
				adAccountId: account.id,
				platform: account.platform,
				kind: "messaging_experience",
				providerResourceId: body.provider_resource_id,
				name: body.name,
				configuration: body.configuration,
			}),
			201,
		);
	} catch (error) {
		return handleAdvancedAdError(c, error) as never;
	}
});

const createAssetRoute = createRoute({
	operationId: "linkAdCreativeAsset",
	method: "post",
	path: "/assets",
	tags: ["Ads"],
	security: [{ Bearer: [] }],
	request: {
		body: {
			content: { "application/json": { schema: CreateAdCreativeAssetBody } },
		},
	},
	responses: {
		201: {
			description: "Creative asset linked",
			content: { "application/json": { schema: AdAdvancedResourceResponse } },
		},
		...MutationErrors,
	},
});

app.openapi(createAssetRoute, async (c) => {
	const body = c.req.valid("json");
	const account = await authorizeAdAccount(c, body.ad_account_id);
	if (account instanceof Response) return account as never;
	try {
		requireAccountFeature(account, "creative_assets", { activeAccount: true });
		return c.json(
			await createAdvancedAdResource(c.get("db"), {
				organizationId: c.get("orgId"),
				workspaceId: account.workspaceId,
				adAccountId: account.id,
				platform: account.platform,
				kind: "creative_asset",
				providerResourceId: body.provider_resource_id,
				name: body.name,
				configuration: {
					media_id: body.media_id,
					asset_type: body.asset_type,
					...body.configuration,
				},
			}),
			201,
		);
	} catch (error) {
		return handleAdvancedAdError(c, error) as never;
	}
});

const createCatalogRoute = createRoute({
	operationId: "linkAdCatalog",
	method: "post",
	path: "/catalogs",
	tags: ["Ads"],
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: CreateAdCatalogBody } } },
	},
	responses: {
		201: {
			description: "Catalog linked",
			content: { "application/json": { schema: AdAdvancedResourceResponse } },
		},
		...MutationErrors,
	},
});

app.openapi(createCatalogRoute, async (c) => {
	const body = c.req.valid("json");
	const account = await authorizeAdAccount(c, body.ad_account_id);
	if (account instanceof Response) return account as never;
	try {
		requireAccountFeature(account, "catalogs", { activeAccount: true });
		return c.json(
			await createAdvancedAdResource(c.get("db"), {
				organizationId: c.get("orgId"),
				workspaceId: account.workspaceId,
				adAccountId: account.id,
				platform: account.platform,
				kind: "catalog",
				providerResourceId: body.provider_resource_id,
				name: body.name,
				configuration: body.configuration,
			}),
			201,
		);
	} catch (error) {
		return handleAdvancedAdError(c, error) as never;
	}
});

const createProductSetRoute = createRoute({
	operationId: "linkAdProductSet",
	method: "post",
	path: "/catalogs/{id}/product-sets",
	tags: ["Ads"],
	security: [{ Bearer: [] }],
	request: {
		params: AdvancedAdIdParams,
		body: {
			content: { "application/json": { schema: CreateAdProductSetBody } },
		},
	},
	responses: {
		201: {
			description: "Product set linked",
			content: { "application/json": { schema: AdAdvancedResourceResponse } },
		},
		...MutationErrors,
	},
});

app.openapi(createProductSetRoute, async (c) => {
	const body = c.req.valid("json");
	const account = await authorizeAdAccount(c, body.ad_account_id);
	if (account instanceof Response) return account as never;
	try {
		requireAccountFeature(account, "product_sets", { activeAccount: true });
		return c.json(
			await createAdvancedAdResource(c.get("db"), {
				organizationId: c.get("orgId"),
				workspaceId: account.workspaceId,
				adAccountId: account.id,
				platform: account.platform,
				kind: "product_set",
				providerResourceId: body.provider_resource_id,
				parentId: c.req.valid("param").id,
				name: body.name,
				configuration: { filter: body.filter },
			}),
			201,
		);
	} catch (error) {
		return handleAdvancedAdError(c, error) as never;
	}
});

const createReportRoute = createRoute({
	operationId: "createAdReport",
	method: "post",
	path: "/reports",
	tags: ["Ads"],
	security: [{ Bearer: [] }],
	request: {
		headers: IdempotencyHeaders,
		body: { content: { "application/json": { schema: CreateAdReportBody } } },
	},
	responses: {
		202: {
			description: "Durable report job accepted",
			content: { "application/json": { schema: AdReportJobResponse } },
		},
		...MutationErrors,
	},
});

app.openapi(createReportRoute, async (c) => {
	const body = c.req.valid("json");
	const account = await authorizeAdAccount(c, body.ad_account_id);
	if (account instanceof Response) return account as never;
	try {
		requireAccountFeature(account, "report_jobs", { activeAccount: true });
		if (body.request.platform !== account.platform) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: {
						code: "PLATFORM_MISMATCH",
						message: "Report request must match the ad account platform",
					},
				},
				400,
			) as never;
		}
		const report = await createAdReportJob(c.get("db"), {
			organizationId: c.get("orgId"),
			workspaceId: account.workspaceId,
			adAccountId: account.id,
			platform: account.platform,
			operationKey: c.req.valid("header")["idempotency-key"],
			request: body.request,
		});
		try {
			await dispatchAdvancedAdReportJob(c.env, {
				organizationId: c.get("orgId"),
				reportJobId: report.id,
			});
		} catch (error) {
			// PostgreSQL is the durable outbox. The minute recovery scan will repair
			// a lost initial Queue handoff without rejecting an accepted job.
			console.error(
				JSON.stringify({
					event: "advanced_ad_report_dispatch_failed",
					report_job_id: report.id,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
		}
		return c.json(report as z.infer<typeof AdReportJobResponse>, 202);
	} catch (error) {
		return handleAdvancedAdError(c, error) as never;
	}
});

const getReportRoute = createRoute({
	operationId: "getAdReport",
	method: "get",
	path: "/reports/{id}",
	tags: ["Ads"],
	security: [{ Bearer: [] }],
	request: { params: AdvancedAdIdParams },
	responses: {
		200: {
			description: "Report job",
			content: { "application/json": { schema: AdReportJobResponse } },
		},
		403: MutationErrors[403],
		404: MutationErrors[404],
	},
});

app.openapi(getReportRoute, async (c) => {
	try {
		const authority = await getAdReportJobAuthority(c.get("db"), {
			organizationId: c.get("orgId"),
			id: c.req.valid("param").id,
		});
		const account = await authorizeAdvancedResource(c, authority);
		if (account instanceof Response) return account as never;
		const report = await getAdReportJob(c.get("db"), {
			organizationId: c.get("orgId"),
			id: c.req.valid("param").id,
			adAccountId: account.id,
			workspaceId: account.workspaceId,
		});
		return c.json(report as z.infer<typeof AdReportJobResponse>, 200);
	} catch (error) {
		return handleAdvancedAdError(c, error) as never;
	}
});

const listReportResultsRoute = createRoute({
	operationId: "listAdReportResults",
	method: "get",
	path: "/reports/{id}/results",
	tags: ["Ads"],
	security: [{ Bearer: [] }],
	request: { params: AdvancedAdIdParams, query: ReportResultQuery },
	responses: {
		200: {
			description: "Normalized report rows",
			content: { "application/json": { schema: AdReportResultsResponse } },
		},
		...MutationErrors,
	},
});

app.openapi(listReportResultsRoute, async (c) => {
	try {
		const authority = await getAdReportJobAuthority(c.get("db"), {
			organizationId: c.get("orgId"),
			id: c.req.valid("param").id,
		});
		const account = await authorizeAdvancedResource(c, authority);
		if (account instanceof Response) return account as never;
		const query = c.req.valid("query");
		return c.json(
			await listAdReportResultRows(c.get("db"), {
				organizationId: c.get("orgId"),
				reportJobId: c.req.valid("param").id,
				cursor: query.cursor,
				limit: query.limit,
			}),
			200,
		);
	} catch (error) {
		return handleAdvancedAdError(c, error) as never;
	}
});

function planningRoute(kind: "forecast" | "keyword_ideas") {
	return createRoute({
		operationId:
			kind === "forecast" ? "forecastAdDelivery" : "generateAdKeywordIdeas",
		method: "post",
		path:
			kind === "forecast" ? "/planning/forecast" : "/planning/keyword-ideas",
		tags: ["Ads"],
		security: [{ Bearer: [] }],
		request: {
			body: { content: { "application/json": { schema: AdPlanningRequest } } },
		},
		responses: {
			200: {
				description: "Provider planning result",
				content: { "application/json": { schema: AdPlanningResponse } },
			},
			...MutationErrors,
		},
	});
}

const forecastRoute = planningRoute("forecast");
app.openapi(forecastRoute, async (c) => {
	const body = c.req.valid("json");
	const account = await authorizeAdAccount(c, body.ad_account_id);
	if (account instanceof Response) return account as never;
	try {
		requireAccountFeature(account, "forecasts", { activeAccount: true });
		throw new AdvancedAdCapabilityError("forecasts", {
			state: "unsupported",
			requiredScopes: [],
			checkedAt: null,
			reason: "No verified provider forecast module is enabled in this build",
		});
	} catch (error) {
		return handleAdvancedAdError(c, error) as never;
	}
});

const keywordIdeasRoute = planningRoute("keyword_ideas");
app.openapi(keywordIdeasRoute, async (c) => {
	const body = c.req.valid("json");
	const account = await authorizeAdAccount(c, body.ad_account_id);
	if (account instanceof Response) return account as never;
	try {
		requireAccountFeature(account, "keyword_ideas", { activeAccount: true });
		throw new AdvancedAdCapabilityError("keyword_ideas", {
			state: "unsupported",
			requiredScopes: [],
			checkedAt: null,
			reason:
				"No verified provider keyword-planning module is enabled in this build",
		});
	} catch (error) {
		return handleAdvancedAdError(c, error) as never;
	}
});

export default app;
