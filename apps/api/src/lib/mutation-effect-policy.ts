export type MutationEffectCoveragePolicy =
	| "incomplete"
	| "postgres_complete"
	| "tracked_complete";

interface MutationEffectRoutePolicy {
	method: string;
	path: RegExp;
}

/**
 * Closed allowlist of mutation routes whose complete customer-visible effect is
 * represented by writes through the request-scoped Drizzle instance. Routes
 * that own a provider, queue, R2, or independently-created durable mutation
 * must remain absent and therefore fail closed as `incomplete`. Read-only
 * provider probes and independently-created read clients do not own mutation
 * truth and are allowed when the request's final effect is request-Postgres.
 */
const POSTGRES_COMPLETE_ROUTES: readonly MutationEffectRoutePolicy[] = [
	// Contacts
	{ method: "POST", path: /^\/v1\/contacts\/?$/ },
	{ method: "PATCH", path: /^\/v1\/contacts\/[^/]+\/?$/ },
	{ method: "DELETE", path: /^\/v1\/contacts\/[^/]+\/?$/ },
	{ method: "POST", path: /^\/v1\/contacts\/[^/]+\/consents\/?$/ },
	{ method: "POST", path: /^\/v1\/contacts\/[^/]+\/channels\/?$/ },
	{
		method: "DELETE",
		path: /^\/v1\/contacts\/[^/]+\/channels\/[^/]+\/?$/,
	},
	{
		method: "PUT",
		path: /^\/v1\/contacts\/[^/]+\/segments\/[^/]+\/?$/,
	},
	{
		method: "DELETE",
		path: /^\/v1\/contacts\/[^/]+\/segments\/[^/]+\/?$/,
	},
	{ method: "POST", path: /^\/v1\/contacts\/bulk\/?$/ },
	{ method: "POST", path: /^\/v1\/contacts\/bulk-operations\/?$/ },
	{ method: "POST", path: /^\/v1\/contacts\/[^/]+\/merge\/?$/ },
	{
		method: "PUT",
		path: /^\/v1\/contacts\/[^/]+\/fields\/[^/]+\/?$/,
	},
	{
		method: "DELETE",
		path: /^\/v1\/contacts\/[^/]+\/fields\/[^/]+\/?$/,
	},

	// Organization-shared tags
	{ method: "POST", path: /^\/v1\/tags\/?$/ },
	{ method: "PATCH", path: /^\/v1\/tags\/[^/]+\/?$/ },
	{ method: "DELETE", path: /^\/v1\/tags\/[^/]+\/?$/ },

	// Organization-shared content templates
	{ method: "POST", path: /^\/v1\/content-templates\/?$/ },
	{ method: "PATCH", path: /^\/v1\/content-templates\/[^/]+\/?$/ },
	{ method: "DELETE", path: /^\/v1\/content-templates\/[^/]+\/?$/ },

	// Organization-shared custom-field definitions
	{ method: "POST", path: /^\/v1\/custom-fields\/?$/ },
	{ method: "PATCH", path: /^\/v1\/custom-fields\/[^/]+\/?$/ },
	{ method: "DELETE", path: /^\/v1\/custom-fields\/[^/]+\/?$/ },

	// Segment definitions and graph replacement are request-side PostgreSQL
	// mutations. A validation/not-found response before their first write is
	// therefore exact K=0, while a graph persisted with validation errors is K=1.
	{ method: "POST", path: /^\/v1\/segments\/?$/ },
	{ method: "PATCH", path: /^\/v1\/segments\/[^/]+\/?$/ },
	{ method: "DELETE", path: /^\/v1\/segments\/[^/]+\/?$/ },
	{ method: "PUT", path: /^\/v1\/automations\/[^/]+\/graph\/?$/ },

	// WhatsApp bulk send commits a scheduled broadcast and its recipients in
	// PostgreSQL; provider delivery happens later under the broadcast processor.
	{ method: "POST", path: /^\/v1\/whatsapp\/bulk-send\/?$/ },

	// Organization-owned definition and membership CRUD. These handlers have no
	// provider, Queue, R2, or independently-created database effect on success.
	{ method: "POST", path: /^\/v1\/idea-groups\/?$/ },
	{ method: "PATCH", path: /^\/v1\/idea-groups\/[^/]+\/?$/ },
	{ method: "DELETE", path: /^\/v1\/idea-groups\/[^/]+\/?$/ },
	{ method: "POST", path: /^\/v1\/qr-codes\/?$/ },
	{ method: "PATCH", path: /^\/v1\/qr-codes\/[^/]+\/?$/ },
	{ method: "DELETE", path: /^\/v1\/qr-codes\/[^/]+\/?$/ },
	{ method: "POST", path: /^\/v1\/signatures\/?$/ },
	{ method: "PATCH", path: /^\/v1\/signatures\/[^/]+\/?$/ },
	{ method: "DELETE", path: /^\/v1\/signatures\/[^/]+\/?$/ },
	{
		method: "POST",
		path: /^\/v1\/signatures\/[^/]+\/set-default\/?$/,
	},
	{ method: "POST", path: /^\/v1\/subscription-lists\/?$/ },
	{ method: "PATCH", path: /^\/v1\/subscription-lists\/[^/]+\/?$/ },
	{ method: "DELETE", path: /^\/v1\/subscription-lists\/[^/]+\/?$/ },
	{
		method: "POST",
		path: /^\/v1\/subscription-lists\/[^/]+\/members\/?$/,
	},
	{
		method: "DELETE",
		path: /^\/v1\/subscription-lists\/[^/]+\/members\/[^/]+\/?$/,
	},

	// AI definitions and ingestion requests persist PostgreSQL authority for
	// later processing. Provider-executing /respond and /search stay incomplete.
	{ method: "POST", path: /^\/v1\/ai-agents\/?$/ },
	{ method: "PATCH", path: /^\/v1\/ai-agents\/[^/]+\/?$/ },
	{ method: "DELETE", path: /^\/v1\/ai-agents\/[^/]+\/?$/ },
	{ method: "POST", path: /^\/v1\/ai-knowledge\/?$/ },
	{ method: "PATCH", path: /^\/v1\/ai-knowledge\/[^/]+\/?$/ },
	{ method: "DELETE", path: /^\/v1\/ai-knowledge\/[^/]+\/?$/ },
	{
		method: "POST",
		path: /^\/v1\/ai-knowledge\/[^/]+\/documents\/?$/,
	},
	{
		method: "DELETE",
		path: /^\/v1\/ai-knowledge\/[^/]+\/documents\/[^/]+\/?$/,
	},
	{
		method: "POST",
		path: /^\/v1\/ai-knowledge\/[^/]+\/documents\/[^/]+\/retry\/?$/,
	},

	// Idea/media deletion remains incomplete because it crosses R2. The listed
	// idea mutations and comment operations are entirely PostgreSQL-owned.
	{ method: "POST", path: /^\/v1\/ideas\/?$/ },
	{ method: "PATCH", path: /^\/v1\/ideas\/[^/]+\/?$/ },
	{ method: "POST", path: /^\/v1\/ideas\/[^/]+\/move\/?$/ },
	{ method: "POST", path: /^\/v1\/ideas\/[^/]+\/convert\/?$/ },
	{ method: "POST", path: /^\/v1\/ideas\/[^/]+\/comments\/?$/ },
	{
		method: "PATCH",
		path: /^\/v1\/ideas\/[^/]+\/comments\/[^/]+\/?$/,
	},
	{
		method: "DELETE",
		path: /^\/v1\/ideas\/[^/]+\/comments\/[^/]+\/?$/,
	},

	// Additional audited request-PostgreSQL route families. Read-only provider
	// probes and cache invalidations do not own customer-visible mutation truth;
	// provider-executing sibling routes remain outside this allowlist.
	{ method: "POST", path: /^\/v1\/ref-urls\/?$/ },
	{ method: "PATCH", path: /^\/v1\/ref-urls\/[^/]+\/?$/ },
	{ method: "DELETE", path: /^\/v1\/ref-urls\/[^/]+\/?$/ },
	{ method: "POST", path: /^\/v1\/ref-urls\/[^/]+\/click\/?$/ },
	{ method: "POST", path: /^\/v1\/landing-pages\/?$/ },
	{ method: "PATCH", path: /^\/v1\/landing-pages\/[^/]+\/?$/ },
	{ method: "DELETE", path: /^\/v1\/landing-pages\/[^/]+\/?$/ },
	{ method: "POST", path: /^\/v1\/auto-post-rules\/?$/ },
	{ method: "PATCH", path: /^\/v1\/auto-post-rules\/[^/]+\/?$/ },
	{ method: "DELETE", path: /^\/v1\/auto-post-rules\/[^/]+\/?$/ },
	{
		method: "POST",
		path: /^\/v1\/auto-post-rules\/[^/]+\/(?:activate|pause)\/?$/,
	},
	{ method: "POST", path: /^\/v1\/automations\/?$/ },
	{ method: "PATCH", path: /^\/v1\/automations\/[^/]+\/?$/ },
	{ method: "DELETE", path: /^\/v1\/automations\/[^/]+\/?$/ },
	{
		method: "POST",
		path: /^\/v1\/automations\/[^/]+\/(?:activate|pause|resume|archive|unarchive)\/?$/,
	},
	{
		method: "POST",
		path: /^\/v1\/automations\/[^/]+\/entrypoints\/?$/,
	},
	{
		method: "PATCH",
		path: /^\/v1\/automation-entrypoints\/[^/]+\/?$/,
	},
	{
		method: "DELETE",
		path: /^\/v1\/automation-entrypoints\/[^/]+\/?$/,
	},
	{
		method: "POST",
		path: /^\/v1\/automation-entrypoints\/[^/]+\/rotate-secret\/?$/,
	},
	{
		method: "POST",
		path: /^\/v1\/automation-runs\/[^/]+\/stop\/?$/,
	},
	{
		method: "POST",
		path: /^\/v1\/contacts\/[^/]+\/automation-pause\/?$/,
	},
	{
		method: "PATCH",
		path: /^\/v1\/inbox\/conversations\/[^/]+\/?$/,
	},
	{
		method: "POST",
		path: /^\/v1\/inbox\/conversations\/[^/]+\/notes\/?$/,
	},
	{ method: "PATCH", path: /^\/v1\/inbox\/notes\/[^/]+\/?$/ },
	{ method: "DELETE", path: /^\/v1\/inbox\/notes\/[^/]+\/?$/ },
	{ method: "POST", path: /^\/v1\/inbox\/bulk\/?$/ },
	{
		method: "PUT",
		path: /^\/v1\/posts\/[^/]+\/tags\/[^/]+\/?$/,
	},
	{
		method: "DELETE",
		path: /^\/v1\/posts\/[^/]+\/tags\/[^/]+\/?$/,
	},
	{ method: "PATCH", path: /^\/v1\/posts\/[^/]+\/notes\/?$/ },
	{ method: "PUT", path: /^\/v1\/posts\/[^/]+\/recycling\/?$/ },
	{ method: "DELETE", path: /^\/v1\/posts\/[^/]+\/recycling\/?$/ },
	{ method: "POST", path: /^\/v1\/invite\/tokens\/?$/ },
	{ method: "DELETE", path: /^\/v1\/invite\/tokens\/[^/]+\/?$/ },
	{ method: "POST", path: /^\/v1\/threads\/?$/ },
	{ method: "DELETE", path: /^\/v1\/threads\/[^/]+\/?$/ },
	{ method: "POST", path: /^\/v1\/workspaces\/?$/ },
	{ method: "PATCH", path: /^\/v1\/workspaces\/[^/]+\/?$/ },
	{
		method: "POST",
		path: /^\/v1\/workspaces\/[^/]+\/(?:archive|restore)\/?$/,
	},
	{ method: "DELETE", path: /^\/v1\/workspaces\/[^/]+\/?$/ },
	{ method: "PATCH", path: /^\/v1\/org-settings\/?$/ },
	{ method: "POST", path: /^\/v1\/queue\/slots\/?$/ },
	{ method: "PUT", path: /^\/v1\/queue\/slots\/?$/ },
	{ method: "DELETE", path: /^\/v1\/queue\/slots\/?$/ },
	{ method: "POST", path: /^\/v1\/api-keys\/?$/ },
	{ method: "DELETE", path: /^\/v1\/api-keys\/[^/]+\/?$/ },
	{ method: "PUT", path: /^\/v1\/short-links\/config\/?$/ },
	{ method: "PATCH", path: /^\/v1\/accounts\/[^/]+\/?$/ },
	{ method: "DELETE", path: /^\/v1\/cross-post-actions\/[^/]+\/?$/ },
	{ method: "PUT", path: /^\/v1\/byos\/?$/ },
	{ method: "DELETE", path: /^\/v1\/byos\/?$/ },

	// Broadcast request-side mutations. Provider delivery is owned by the
	// cron-driven processor after the request commits its PostgreSQL intent.
	{ method: "POST", path: /^\/v1\/broadcasts\/?$/ },
	{ method: "PATCH", path: /^\/v1\/broadcasts\/[^/]+\/?$/ },
	{ method: "DELETE", path: /^\/v1\/broadcasts\/[^/]+\/?$/ },
	{ method: "POST", path: /^\/v1\/broadcasts\/[^/]+\/recipients\/?$/ },
	{ method: "POST", path: /^\/v1\/broadcasts\/[^/]+\/send\/?$/ },
	{ method: "POST", path: /^\/v1\/broadcasts\/[^/]+\/schedule\/?$/ },
	{ method: "POST", path: /^\/v1\/broadcasts\/[^/]+\/cancel\/?$/ },

	// Webhook definition/secret mutations are PostgreSQL-owned. Deliberately do
	// not include POST /v1/webhooks/test, which crosses an external HTTP boundary.
	{ method: "POST", path: /^\/v1\/webhooks\/?$/ },
	{ method: "PATCH", path: /^\/v1\/webhooks\/[^/]+\/?$/ },
	{ method: "DELETE", path: /^\/v1\/webhooks\/[^/]+\/?$/ },
	{
		method: "POST",
		path: /^\/v1\/webhooks\/[^/]+\/rotate-secret\/?$/,
	},
];

/**
 * Closed allowlist of routes whose provider mutations use the approved
 * request-local boundary wrapper. Reads may remain unwrapped; every mutating
 * provider call and request-path independent durable effect must be tracked.
 */
const TRACKED_COMPLETE_ROUTES: readonly MutationEffectRoutePolicy[] = [
	// Automation binding CRUD commits its binding-row authority before the
	// recoverable queue accelerator. Manual enrollment commits the run before
	// inline graph/provider execution. Idea-group reorder owns explicit outcomes
	// around its raw-SQL transaction, including unknown on a rejected commit ack.
	// This complete coverage also releases schema-validation failures as K=0.
	{ method: "POST", path: /^\/v1\/automation-bindings\/?$/ },
	{ method: "PATCH", path: /^\/v1\/automation-bindings\/[^/]+\/?$/ },
	{ method: "DELETE", path: /^\/v1\/automation-bindings\/[^/]+\/?$/ },
	{ method: "POST", path: /^\/v1\/automations\/[^/]+\/enroll\/?$/ },
	{ method: "POST", path: /^\/v1\/idea-groups\/reorder\/?$/ },

	// Twitter engagement endpoints have one final provider mutation apiece.
	{ method: "POST", path: /^\/v1\/twitter\/retweet\/?$/ },
	{ method: "DELETE", path: /^\/v1\/twitter\/retweet\/?$/ },
	{ method: "POST", path: /^\/v1\/twitter\/bookmark\/?$/ },
	{ method: "DELETE", path: /^\/v1\/twitter\/bookmark\/?$/ },
	{ method: "POST", path: /^\/v1\/twitter\/follow\/?$/ },
	{ method: "DELETE", path: /^\/v1\/twitter\/follow\/?$/ },

	// Inbox provider mutations use a request-scoped aggregate. Acknowledged
	// provider success is K=1, all definitive rejections/no-op preflights are
	// K=0, and transport/transient outcomes remain parked.
	{
		method: "POST",
		path: /^\/v1\/inbox\/conversations\/[^/]+\/messages\/?$/,
	},
	{
		method: "POST",
		path: /^\/v1\/inbox\/conversations\/[^/]+\/typing\/?$/,
	},
	{
		method: "POST",
		path: /^\/v1\/inbox\/conversations\/[^/]+\/messages\/[^/]+\/reactions\/?$/,
	},
	{
		method: "DELETE",
		path: /^\/v1\/inbox\/conversations\/[^/]+\/messages\/[^/]+\/reactions\/?$/,
	},
	{
		method: "DELETE",
		path: /^\/v1\/inbox\/conversations\/[^/]+\/messages\/[^/]+\/?$/,
	},

	{ method: "POST", path: /^\/v1\/whatsapp\/templates\/?$/ },
	{ method: "DELETE", path: /^\/v1\/whatsapp\/templates\/[^/]+\/?$/ },
	{ method: "PUT", path: /^\/v1\/whatsapp\/business-profile\/?$/ },
	{
		method: "POST",
		path: /^\/v1\/whatsapp\/business-profile\/display-name\/?$/,
	},
	{
		method: "POST",
		path: /^\/v1\/whatsapp\/business-profile\/photo\/?$/,
	},
	{ method: "POST", path: /^\/v1\/whatsapp\/flows\/?$/ },
	{ method: "PATCH", path: /^\/v1\/whatsapp\/flows\/[^/]+\/?$/ },
	{ method: "DELETE", path: /^\/v1\/whatsapp\/flows\/[^/]+\/?$/ },
	{
		method: "POST",
		path: /^\/v1\/whatsapp\/flows\/[^/]+\/(?:publish|deprecate)\/?$/,
	},
	{
		method: "PUT",
		path: /^\/v1\/whatsapp\/flows\/[^/]+\/json\/?$/,
	},
	{ method: "POST", path: /^\/v1\/whatsapp\/flows\/send\/?$/ },
];

/** Return complete coverage only for an exact audited method/path pair. */
export function getMutationEffectCoveragePolicy(
	method: string,
	path: string,
): MutationEffectCoveragePolicy {
	const normalizedMethod = method.toUpperCase();
	if (
		POSTGRES_COMPLETE_ROUTES.some(
			(route) => route.method === normalizedMethod && route.path.test(path),
		)
	) {
		return "postgres_complete";
	}
	return TRACKED_COMPLETE_ROUTES.some(
		(route) => route.method === normalizedMethod && route.path.test(path),
	)
		? "tracked_complete"
		: "incomplete";
}
