import { SOCIAL_PLATFORM_IDS } from "./domain-contracts";
import {
	GOVERNANCE_REVIEW_EXPIRES_AT,
	GOVERNANCE_REVIEWED_AT,
	validateGovernanceReview,
} from "./governance-review";

export type ExternalProviderDataClass =
	| "account_credential"
	| "billing_identifier"
	| "contact_address"
	| "email_content"
	| "embedding_vector"
	| "knowledge_content"
	| "media_bytes"
	| "message_content"
	| "network_metadata"
	| "operational_metadata"
	| "public_content_url"
	| "social_identifier"
	| "transcript";

export type ExternalProviderPersistenceBoundary =
	| "provider_contract"
	| "provider_object"
	| "operator_service"
	| "customer_owned";

export type ExternalProviderResidencyControl =
	| "provider_contract"
	| "cloudflare_account_policy"
	| "operator_selected"
	| "customer_selected"
	| "social_platform_controlled";

export interface ExternalProviderEvidence {
	readonly sourcePath: string;
	readonly marker: string;
}

/**
 * The registry intentionally does not invent a legal duty or remote deletion
 * deadline. `retentionBoundary` names who controls persistence; `remoteAction`
 * names the product/operator action that remains possible.
 */
export interface ExternalProviderRetentionContract {
	readonly id: string;
	readonly provider: string;
	readonly capabilities: readonly string[];
	readonly dataClasses: readonly ExternalProviderDataClass[];
	readonly localAuthorities: readonly string[];
	readonly persistenceBoundary: ExternalProviderPersistenceBoundary;
	readonly residencyControl: ExternalProviderResidencyControl;
	readonly credentialAction: string;
	readonly remoteAction: string;
	readonly retentionBoundary: string;
	readonly legalHoldTreatment: "provider_policy_only";
	/** Static hosts contacted by production transports. Dynamic/customer hosts use source evidence. */
	readonly egressHosts: readonly string[];
	readonly owner: string;
	readonly reviewedAt: string;
	readonly reviewExpiresAt: string;
	readonly evidence: readonly ExternalProviderEvidence[];
}

type ExternalProviderRetentionDefinition = Omit<
	ExternalProviderRetentionContract,
	"reviewExpiresAt"
>;

const REVIEWED_AT = GOVERNANCE_REVIEWED_AT;
const REVIEW_EXPIRES_AT = GOVERNANCE_REVIEW_EXPIRES_AT;
const DATA_GOVERNANCE_OWNER = "data-governance";

const SOCIAL_EGRESS_HOSTS = {
	twitter: ["api.x.com", "x.com"],
	instagram: ["api.instagram.com", "www.instagram.com", "graph.instagram.com"],
	facebook: ["graph.facebook.com", "www.facebook.com"],
	linkedin: ["api.linkedin.com", "www.linkedin.com"],
	tiktok: ["open.tiktokapis.com", "www.tiktok.com"],
	youtube: [
		"accounts.google.com",
		"oauth2.googleapis.com",
		"www.googleapis.com",
		"youtubeanalytics.googleapis.com",
		"pubsubhubbub.appspot.com",
	],
	pinterest: ["api.pinterest.com", "www.pinterest.com"],
	reddit: ["oauth.reddit.com", "www.reddit.com"],
	bluesky: ["bsky.social", "public.api.bsky.app", "video.bsky.app"],
	threads: ["graph.threads.net", "threads.net", "www.threads.net"],
	telegram: ["api.telegram.org"],
	snapchat: [
		"accounts.snapchat.com",
		"adsapi.snapchat.com",
		"businessapi.snapchat.com",
	],
	googlebusiness: [
		"accounts.google.com",
		"oauth2.googleapis.com",
		"businessprofileperformance.googleapis.com",
		"mybusiness.googleapis.com",
		"mybusinessaccountmanagement.googleapis.com",
	],
	whatsapp: ["graph.facebook.com"],
	mastodon: ["mastodon.social"],
	discord: ["discord.com"],
	sms: ["api.twilio.com"],
	beehiiv: ["api.beehiiv.com"],
	convertkit: ["api.kit.com"],
	mailchimp: [],
	listmonk: [],
	slack: ["hooks.slack.com", "hooks.slack-gov.com"],
} as const satisfies Record<
	(typeof SOCIAL_PLATFORM_IDS)[number],
	readonly string[]
>;

const SOCIAL_DYNAMIC_EGRESS_EVIDENCE: Partial<
	Record<
		(typeof SOCIAL_PLATFORM_IDS)[number],
		readonly ExternalProviderEvidence[]
	>
> = {
	mastodon: [
		{
			sourcePath: "apps/api/src/config/oauth.ts",
			marker: "config.requiresPublicEndpointValidation",
		},
		{
			sourcePath: "apps/api/src/services/mastodon-oauth.ts",
			marker: "fetchPublicUrl(registrationUrl",
		},
		{
			sourcePath: "apps/api/src/routes/posts.ts",
			marker: 'case "mastodon"',
		},
	],
	telegram: [
		{
			sourcePath: "apps/api/src/routes/posts.ts",
			marker: 'case "telegram"',
		},
	],
	discord: [
		{
			sourcePath: "apps/api/src/routes/posts.ts",
			marker: 'case "discord"',
		},
	],
	listmonk: [
		{
			sourcePath: "apps/api/src/routes/accounts.ts",
			marker: "listmonkApiUrl(account.platformAccountId",
		},
		{
			sourcePath: "apps/api/src/routes/connect.ts",
			marker: 'listmonkApiUrl(cleanUrl, "/api/settings")',
		},
	],
	whatsapp: [
		{
			sourcePath: "apps/api/src/services/whatsapp-admin-provider.ts",
			marker: "export async function createWhatsAppGroup",
		},
		{
			sourcePath: "apps/api/src/services/whatsapp-identity.ts",
			marker: "export async function persistWhatsAppIdentityAlias",
		},
	],
};

const SOCIAL_PROVIDER_CONTRACTS =
	SOCIAL_PLATFORM_IDS.map<ExternalProviderRetentionDefinition>((platform) => ({
		id: `social:${platform}`,
		provider: platform,
		capabilities: [
			"Connected-account publish, read, and supported inbox operations",
			...(platform === "whatsapp"
				? ["WhatsApp group administration and identity alias resolution"]
				: []),
		],
		dataClasses: [
			"account_credential",
			"media_bytes",
			"message_content",
			"operational_metadata",
			"social_identifier",
		],
		localAuthorities: [
			"public.social_accounts",
			"public.posts",
			"public.post_targets",
			"public.external_posts",
			"public.inbox_conversations",
			"public.inbox_messages",
			"public.social_mutation_operations",
			...(platform === "whatsapp"
				? ["public.whatsapp_groups", "public.whatsapp_identity_aliases"]
				: []),
		],
		persistenceBoundary:
			platform === "listmonk" ? "customer_owned" : "provider_object",
		residencyControl:
			platform === "listmonk"
				? "customer_selected"
				: "social_platform_controlled",
		credentialAction:
			"Revoke or shred the connected-account credential independently of evidence retention.",
		remoteAction:
			"Delete or unpublish through the provider when the feature and provider API expose that action; otherwise revoke access and surface the provider limitation to the operator.",
		retentionBoundary:
			"No RelayAPI-guaranteed remote deadline; the connected platform or customer-operated Listmonk instance controls its own records.",
		legalHoldTreatment: "provider_policy_only",
		egressHosts: SOCIAL_EGRESS_HOSTS[platform],
		owner: DATA_GOVERNANCE_OWNER,
		reviewedAt: REVIEWED_AT,
		evidence: [
			{
				sourcePath: "packages/db/src/domain-contracts.ts",
				marker: `"${platform}"`,
			},
			{
				sourcePath: "apps/api/src/publishers/index.ts",
				marker: "publishers",
			},
			{
				sourcePath: "apps/api/src/services/social-mutation-operations.ts",
				marker: "export async function runSocialMutation",
			},
			...(SOCIAL_DYNAMIC_EGRESS_EVIDENCE[platform] ?? []),
		],
	}));

const INFRASTRUCTURE_PROVIDER_CONTRACTS = [
	{
		id: "workers-ai",
		provider: "Cloudflare Workers AI",
		capabilities: ["Inbox AI generation", "knowledge-document conversion"],
		dataClasses: [
			"knowledge_content",
			"message_content",
			"operational_metadata",
		],
		localAuthorities: [
			"public.ai_knowledge_documents",
			"public.inbox_messages",
		],
		persistenceBoundary: "provider_contract",
		residencyControl: "cloudflare_account_policy",
		credentialAction:
			"Remove the Workers AI binding or account authorization; no tenant credential is stored.",
		remoteAction:
			"Delete RelayAPI's local source and generated content; any provider-side processing record follows the Cloudflare account contract.",
		retentionBoundary:
			"Cloudflare account policy controls provider-side processing records; RelayAPI does not claim a shorter remote deadline.",
		legalHoldTreatment: "provider_policy_only",
		egressHosts: [],
		owner: DATA_GOVERNANCE_OWNER,
		reviewedAt: REVIEWED_AT,
		evidence: [
			{
				sourcePath: "apps/api/src/services/ai-knowledge.ts",
				marker: "env.AI.toMarkdown",
			},
			{
				sourcePath: "apps/api/src/routes/inbox-ai.ts",
				marker: "env.AI",
			},
		],
	},
	{
		id: "openai-embeddings",
		provider: "OpenAI",
		capabilities: ["Knowledge-base embedding generation"],
		dataClasses: [
			"embedding_vector",
			"knowledge_content",
			"operational_metadata",
		],
		localAuthorities: [
			"public.ai_knowledge_documents",
			"public.ai_knowledge_chunks",
		],
		persistenceBoundary: "provider_contract",
		residencyControl: "provider_contract",
		credentialAction: "Revoke the operator-owned OpenAI API key.",
		remoteAction:
			"Delete local knowledge content and vectors; provider-side request records follow the operator's OpenAI API contract.",
		retentionBoundary:
			"OpenAI API contract controls provider-side request records; RelayAPI does not claim a remote erasure deadline.",
		legalHoldTreatment: "provider_policy_only",
		egressHosts: ["api.openai.com"],
		owner: DATA_GOVERNANCE_OWNER,
		reviewedAt: REVIEWED_AT,
		evidence: [
			{
				sourcePath: "apps/api/src/services/ai-knowledge.ts",
				marker: "OPENAI_EMBEDDINGS_URL",
			},
		],
	},
	{
		id: "cloudflare-media-transforms",
		provider: "Cloudflare Images and Media Transformations",
		capabilities: ["Image thumbnails", "video poster-frame extraction"],
		dataClasses: ["media_bytes", "operational_metadata"],
		localAuthorities: [
			"public.media",
			"R2 media and thumbnail object locators",
		],
		persistenceBoundary: "provider_contract",
		residencyControl: "cloudflare_account_policy",
		credentialAction:
			"Remove the account bindings; no tenant transform credential is stored.",
		remoteAction:
			"Delete the authoritative source and generated R2 objects; provider processing/cache records follow the Cloudflare account contract.",
		retentionBoundary:
			"Cloudflare account policy controls transform processing/cache records.",
		legalHoldTreatment: "provider_policy_only",
		egressHosts: [],
		owner: DATA_GOVERNANCE_OWNER,
		reviewedAt: REVIEWED_AT,
		evidence: [
			{
				sourcePath: "apps/api/src/lib/thumbnails.ts",
				marker: "env.IMAGES.input",
			},
			{
				sourcePath: "apps/api/src/lib/thumbnails.ts",
				marker: "env.MEDIA.input",
			},
		],
	},
	{
		id: "advanced-ad-reports",
		provider: "TikTok, X, and LinkedIn advertising APIs",
		capabilities: [
			"Asynchronous advertising-report submission, polling, bounded download, and normalization",
		],
		dataClasses: [
			"operational_metadata",
			"public_content_url",
			"social_identifier",
		],
		localAuthorities: [
			"public.ad_connections",
			"public.ad_accounts",
			"public.ad_report_jobs",
			"public.ad_report_rows",
			"R2 AD_REPORT_BUCKET object locators",
		],
		persistenceBoundary: "provider_object",
		residencyControl: "provider_contract",
		credentialAction:
			"Revoke the dedicated encrypted advertising connection independently of local report retention.",
		remoteAction:
			"Stop polling and remove RelayAPI's private artifact and normalized rows; provider-side report jobs and logs remain governed by each advertising platform.",
		retentionBoundary:
			"RelayAPI deletes private result bytes and normalized rows after seven days and terminal local job metadata after 90 days; no shorter provider-side deadline is claimed.",
		legalHoldTreatment: "provider_policy_only",
		egressHosts: [
			"business-api.tiktok.com",
			"ads-api.x.com",
			"api.linkedin.com",
		],
		owner: DATA_GOVERNANCE_OWNER,
		reviewedAt: REVIEWED_AT,
		evidence: [
			{
				sourcePath: "apps/api/src/services/ad-advanced-reports.ts",
				marker: "getAdvancedAdReportAdapter",
			},
			{
				sourcePath: "apps/api/src/services/ad-report-jobs.ts",
				marker: "fetchPublicUrl(downloadUrl",
			},
			{
				sourcePath: "apps/api/src/services/ad-report-artifact-cleanup.ts",
				marker: "export function expectedAdReportObjectKey",
			},
			{
				sourcePath: "apps/api/src/services/tenant-deletion.ts",
				marker: "processTenantExternalResources",
			},
			{
				sourcePath: "apps/api/src/services/workspace-erasure.ts",
				marker: "deleteExactAdReportArtifacts",
			},
		],
	},
	{
		id: "email",
		provider: "Resend",
		capabilities: ["Transactional email delivery"],
		dataClasses: ["contact_address", "email_content", "operational_metadata"],
		localAuthorities: ["public.email_deliveries"],
		persistenceBoundary: "provider_object",
		residencyControl: "provider_contract",
		credentialAction: "Revoke the Resend API key independently of any hold.",
		remoteAction:
			"Redact RelayAPI's encrypted envelope on schedule and use the provider account/API for any supported provider-side deletion.",
		retentionBoundary:
			"Resend contract controls delivered-message and provider-log retention; RelayAPI's local envelope clock does not shorten it.",
		legalHoldTreatment: "provider_policy_only",
		egressHosts: ["api.resend.com"],
		owner: DATA_GOVERNANCE_OWNER,
		reviewedAt: REVIEWED_AT,
		evidence: [
			{
				sourcePath: "apps/api/src/lib/email-queue/consumer.ts",
				marker: "new Resend",
			},
		],
	},
	{
		id: "downloader",
		provider: "Operator-configured downloader service",
		capabilities: ["Public media download metadata", "YouTube transcripts"],
		dataClasses: ["public_content_url", "transcript", "operational_metadata"],
		localAuthorities: ["public.tool_jobs"],
		persistenceBoundary: "operator_service",
		residencyControl: "operator_selected",
		credentialAction: "Rotate or remove the internal downloader service key.",
		remoteAction:
			"RelayAPI shreds encrypted tool-job inputs/results on schedule; the operator must apply the same or shorter log/cache policy to the downloader service.",
		retentionBoundary:
			"Operator service runbook controls remote logs and caches; no remote deadline is inferred from RelayAPI's one-hour job TTL.",
		legalHoldTreatment: "provider_policy_only",
		egressHosts: [],
		owner: DATA_GOVERNANCE_OWNER,
		reviewedAt: REVIEWED_AT,
		evidence: [
			{
				sourcePath: "apps/api/src/services/tool-service.ts",
				marker: "DOWNLOADER_SERVICE_URL",
			},
		],
	},
	{
		id: "stripe",
		provider: "Stripe",
		capabilities: ["Hosted checkout", "subscriptions", "invoices", "payments"],
		dataClasses: [
			"billing_identifier",
			"contact_address",
			"operational_metadata",
		],
		localAuthorities: [
			"public.organization_subscriptions",
			"public.invoices",
			"public.financial_retention_receipts",
		],
		persistenceBoundary: "provider_object",
		residencyControl: "provider_contract",
		credentialAction: "Revoke Stripe credentials and webhook secrets on exit.",
		remoteAction:
			"Delete or minimize provider customer metadata where supported and appropriate; do not claim deletion of records the operator must retain.",
		retentionBoundary:
			"Stripe and operator financial policies control provider objects; RelayAPI retains only its separately justified minimized receipts.",
		legalHoldTreatment: "provider_policy_only",
		egressHosts: ["api.stripe.com"],
		owner: DATA_GOVERNANCE_OWNER,
		reviewedAt: REVIEWED_AT,
		evidence: [
			{
				sourcePath: "apps/api/src/services/stripe.ts",
				marker: "new StripeCtor",
			},
		],
	},
	{
		id: "byos",
		provider: "Customer-selected S3-compatible storage",
		capabilities: ["Customer-owned media object storage"],
		dataClasses: ["account_credential", "media_bytes", "operational_metadata"],
		localAuthorities: [
			"public.storage_locations",
			"public.storage_credentials",
			"public.media",
		],
		persistenceBoundary: "customer_owned",
		residencyControl: "customer_selected",
		credentialAction:
			"Keep each encrypted credential version only while an object is pinned to it or cleanup remains unresolved; shred it after that exact authority drains.",
		remoteAction:
			"Delete exact keys and tenant prefixes through their immutable historical location and credential version; unresolved failures remain durable operator work.",
		retentionBoundary:
			"Customer storage lifecycle and account policy control residual versions, backups, and provider logs.",
		legalHoldTreatment: "provider_policy_only",
		egressHosts: [],
		owner: DATA_GOVERNANCE_OWNER,
		reviewedAt: REVIEWED_AT,
		evidence: [
			{
				sourcePath: "apps/api/src/services/storage-locator.ts",
				marker: 'provider: "byos"',
			},
		],
	},
	{
		id: "shortener:dub",
		provider: "Dub",
		capabilities: ["External short-link creation, analytics, and cleanup"],
		dataClasses: ["public_content_url", "operational_metadata"],
		localAuthorities: [
			"public.short_links",
			"public.short_link_configs",
			"public.short_link_credentials",
			"public.external_subject_cleanup_jobs",
		],
		persistenceBoundary: "provider_object",
		residencyControl: "provider_contract",
		credentialAction: "Revoke or rotate the tenant-provided Dub API key.",
		remoteAction:
			"Delete or reconcile an addressable link by RelayAPI's durable externalId; ambiguous outcomes remain operator-visible.",
		retentionBoundary:
			"Dub controls provider-side analytics and logs; RelayAPI does not claim that deleting a link removes provider backups or logs.",
		legalHoldTreatment: "provider_policy_only",
		egressHosts: ["api.dub.co"],
		owner: DATA_GOVERNANCE_OWNER,
		reviewedAt: REVIEWED_AT,
		evidence: [
			{
				sourcePath: "apps/api/src/services/short-link-providers/dub.ts",
				marker: "DUB_API",
			},
		],
	},
	{
		id: "shortener:short_io",
		provider: "Short.io",
		capabilities: ["External short-link creation, analytics, and deletion"],
		dataClasses: ["public_content_url", "operational_metadata"],
		localAuthorities: [
			"public.short_links",
			"public.short_link_configs",
			"public.short_link_credentials",
			"public.external_subject_cleanup_jobs",
		],
		persistenceBoundary: "provider_object",
		residencyControl: "provider_contract",
		credentialAction: "Revoke or rotate the tenant-provided Short.io API key.",
		remoteAction:
			"Delete the provider link by its persisted idString; ambiguous deletion outcomes remain operator-visible.",
		retentionBoundary:
			"Short.io controls provider-side analytics and logs; RelayAPI does not infer deletion of backups or provider logs.",
		legalHoldTreatment: "provider_policy_only",
		egressHosts: ["api.short.io", "statistics.short.io"],
		owner: DATA_GOVERNANCE_OWNER,
		reviewedAt: REVIEWED_AT,
		evidence: [
			{
				sourcePath: "apps/api/src/services/short-link-providers/short-io.ts",
				marker: "SHORT_IO_API",
			},
		],
	},
	{
		id: "shortener:bitly",
		provider: "Bitly",
		capabilities: [
			"External short-link creation, analytics, and bounded cleanup",
		],
		dataClasses: ["public_content_url", "operational_metadata"],
		localAuthorities: [
			"public.short_links",
			"public.short_link_configs",
			"public.short_link_credentials",
			"public.external_subject_cleanup_jobs",
		],
		persistenceBoundary: "provider_object",
		residencyControl: "provider_contract",
		credentialAction: "Revoke or rotate the tenant-provided Bitly API key.",
		remoteAction:
			"Delete an unedited hash bitlink; edited or custom links are honestly routed to operator review unless the provider supports neutralization.",
		retentionBoundary:
			"Bitly controls provider-side analytics and logs; an unsupported cleanup result is not represented as deletion.",
		legalHoldTreatment: "provider_policy_only",
		egressHosts: ["api-ssl.bitly.com"],
		owner: DATA_GOVERNANCE_OWNER,
		reviewedAt: REVIEWED_AT,
		evidence: [
			{
				sourcePath: "apps/api/src/services/short-link-providers/bitly.ts",
				marker: "BITLY_API",
			},
		],
	},
	{
		id: "telnyx",
		provider: "Telnyx",
		capabilities: ["WhatsApp phone-number search, purchase, and release"],
		dataClasses: [
			"account_credential",
			"contact_address",
			"operational_metadata",
			"social_identifier",
		],
		localAuthorities: [
			"public.whatsapp_phone_numbers",
			"public.whatsapp_phone_provisioning_operations",
			"public.whatsapp_phone_release_operations",
		],
		persistenceBoundary: "provider_object",
		residencyControl: "provider_contract",
		credentialAction: "Revoke or rotate the operator-owned Telnyx API key.",
		remoteAction:
			"Release purchased numbers through the provider lifecycle; unresolved outcomes remain fenced operator work.",
		retentionBoundary:
			"Telnyx controls its account, number, and provider-log retention; local phone evidence follows RelayAPI's independent clocks.",
		legalHoldTreatment: "provider_policy_only",
		egressHosts: ["api.telnyx.com"],
		owner: DATA_GOVERNANCE_OWNER,
		reviewedAt: REVIEWED_AT,
		evidence: [
			{
				sourcePath: "apps/api/src/services/telnyx.ts",
				marker: "TELNYX_API",
			},
		],
	},
	{
		id: "dns-safety",
		provider: "Google DNS and Cloudflare DNS over HTTPS",
		capabilities: ["SSRF-safe public-host resolution"],
		dataClasses: ["network_metadata", "public_content_url"],
		localAuthorities: ["request-scoped SSRF validation only"],
		persistenceBoundary: "provider_contract",
		residencyControl: "provider_contract",
		credentialAction:
			"Remove the configured DNS-over-HTTPS transports; no tenant credential is stored.",
		remoteAction:
			"No provider object is created; remove local request state and rely on resolver contracts for query-log retention.",
		retentionBoundary:
			"Resolver contracts control DNS query logs; RelayAPI keeps no persistent DNS-response cache.",
		legalHoldTreatment: "provider_policy_only",
		egressHosts: ["dns.google", "cloudflare-dns.com"],
		owner: DATA_GOVERNANCE_OWNER,
		reviewedAt: REVIEWED_AT,
		evidence: [
			{
				sourcePath: "apps/api/src/lib/ssrf-guard.ts",
				marker: "DOH_ENDPOINTS",
			},
		],
	},
	{
		id: "customer-selected-egress",
		provider: "Customer-selected HTTPS destinations",
		capabilities: [
			"Customer webhooks",
			"automation HTTP/webhook actions",
			"RSS ingestion",
			"public knowledge, preview, and avatar fetches",
		],
		dataClasses: [
			"knowledge_content",
			"media_bytes",
			"message_content",
			"operational_metadata",
			"public_content_url",
		],
		localAuthorities: [
			"public.webhook_endpoints",
			"public.webhook_deliveries",
			"public.automation_effects",
			"public.auto_post_rules",
			"public.ai_knowledge_documents",
			"public.social_accounts",
			"R2 avatar object locators",
		],
		persistenceBoundary: "customer_owned",
		residencyControl: "customer_selected",
		credentialAction:
			"Shred or rotate customer webhook and automation secrets independently of evidence retention.",
		remoteAction:
			"Stop future egress and delete local payloads; the customer-selected destination controls its received copy and logs.",
		retentionBoundary:
			"RelayAPI cannot promise deletion from arbitrary customer-selected destinations; it records the boundary and minimizes local payloads.",
		legalHoldTreatment: "provider_policy_only",
		egressHosts: [],
		owner: DATA_GOVERNANCE_OWNER,
		reviewedAt: REVIEWED_AT,
		evidence: [
			{
				sourcePath: "apps/api/src/services/webhook-delivery.ts",
				marker: "fetchWithTimeout(endpoint.url",
			},
			{
				sourcePath: "apps/api/src/services/automations/nodes/http-request.ts",
				marker: "fetchPublicUrl(url",
			},
			{
				sourcePath: "apps/api/src/services/automations/actions/webhook.ts",
				marker: "fetchPublicUrl(url",
			},
			{
				sourcePath: "apps/api/src/services/feed-parser.ts",
				marker: "fetchPublicUrl(url",
			},
			{
				sourcePath: "apps/api/src/services/ai-knowledge.ts",
				marker: "fetchPublicUrl(document.sourceUrl",
			},
			{
				sourcePath: "apps/api/src/services/external-post-sync/previews.ts",
				marker: "fetchPublicUrl(source.url",
			},
			{
				sourcePath: "apps/api/src/services/publisher-runner.ts",
				marker: "fetchPublicUrl(url",
			},
			{
				sourcePath: "apps/api/src/services/avatar-store.ts",
				marker: "fetchPublicUrl(sourceUrl",
			},
		],
	},
] as const satisfies readonly ExternalProviderRetentionDefinition[];

export const EXTERNAL_PROVIDER_RETENTION_CONTRACTS: readonly ExternalProviderRetentionContract[] =
	[...SOCIAL_PROVIDER_CONTRACTS, ...INFRASTRUCTURE_PROVIDER_CONTRACTS].map(
		(contract) => ({
			...contract,
			reviewExpiresAt: REVIEW_EXPIRES_AT,
		}),
	);

export function validateExternalProviderRetentionRegistry(
	contracts: readonly ExternalProviderRetentionContract[] = EXTERNAL_PROVIDER_RETENTION_CONTRACTS,
): string[] {
	const failures: string[] = [];
	const seen = new Set<string>();
	for (const contract of contracts) {
		if (seen.has(contract.id))
			failures.push(`Duplicate provider id: ${contract.id}`);
		seen.add(contract.id);
		if (contract.capabilities.length === 0) {
			failures.push(`${contract.id} has no capability`);
		}
		if (contract.dataClasses.length === 0) {
			failures.push(`${contract.id} has no data class`);
		}
		if (contract.localAuthorities.length === 0) {
			failures.push(`${contract.id} has no local authority`);
		}
		if (contract.evidence.length === 0) {
			failures.push(`${contract.id} has no source evidence`);
		}
		for (const field of [
			"credentialAction",
			"remoteAction",
			"retentionBoundary",
			"owner",
			"reviewedAt",
			"reviewExpiresAt",
		] as const) {
			if (contract[field].trim().length === 0) {
				failures.push(`${contract.id} has an empty ${field}`);
			}
		}
		failures.push(...validateGovernanceReview(contract.id, contract));
	}
	return failures;
}
