/**
 * Canonical Cloudflare KV key families and their privacy-store identities.
 *
 * Prefixes are deliberately one-to-one. A family can change its payload or
 * TTL only by changing the corresponding privacy contract, and a source audit
 * proves that every key reaching KV get/put/delete belongs to this vocabulary.
 */
export const KV_PRIVACY_KEY_PREFIX_BY_STORE_ID = {
	"kv:apikey": "apikey:",
	"kv:dashboard-key": "dashboard-key:",
	"kv:pending-oauth": "pending-oauth:",
	"kv:pending-secondary": "pending-secondary:",
	"kv:r2-presign": "r2-presign:",
	"kv:maintenance-control": "control:maintenance:",
	"kv:ad-discovery": "ad-discovery:",
	"kv:analytics-overview": "analytics-overview:",
	"kv:analytics-posts": "analytics-posts:",
	"kv:best-time": "best-time:",
	"kv:billing-invoice-discovery-cursor":
		"internal:billing:invoice-discovery-cursor:",
	"kv:ig-sender-id": "ig-sender-id:",
	"kv:inbox-comments": "inbox-comments:",
	"kv:inbox-posts": "inbox-posts:",
	"kv:msg-dedup": "msg-dedup:",
	"kv:org-settings": "org-settings:",
	"kv:org-summary": "org-summary:",
	"kv:outbound-mid": "outbound-mid:",
	"kv:platform-account": "platform-account:",
	"kv:queue-schedule": "queue-schedule:",
	"kv:short-link": "short-link:",
	"kv:sync-dedup": "sync-dedup:",
	"kv:token-refresh-notified": "token-refresh-notified:",
	"kv:usage": "usage:",
	"kv:usage-warning": "usage-warning:",
	"kv:ws-valid": "ws-valid:",
} as const;

export type KvPrivacyStoreId = keyof typeof KV_PRIVACY_KEY_PREFIX_BY_STORE_ID;

/**
 * Runtime assertion for keys whose family is selected through data flow that a
 * static source audit cannot resolve (for example, a heterogeneous invalidation
 * list). The source audit reads the closed `allowedStoreIds` argument while
 * this guard proves the actual key matches one of those prefixes.
 */
export function assertKvPrivacyStoreKey(
	allowedStoreIds: KvPrivacyStoreId | readonly KvPrivacyStoreId[],
	key: string,
): string {
	const allowed: readonly KvPrivacyStoreId[] =
		typeof allowedStoreIds === "string" ? [allowedStoreIds] : allowedStoreIds;
	if (
		allowed.some((storeId) =>
			key.startsWith(KV_PRIVACY_KEY_PREFIX_BY_STORE_ID[storeId]),
		)
	) {
		return key;
	}
	throw new Error("KV key does not match its registered privacy-store family");
}
