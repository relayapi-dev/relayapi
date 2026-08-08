/**
 * Short.io short link provider.
 *
 * Official docs:
 * - Create: https://developers.short.io/reference/post_links
 * - Delete: https://developers.short.io/reference/delete_links-link-id
 * - Read-only probe: https://developers.short.io/reference/get_api-domains
 * - Statistics by stored idString:
 *   https://developers.short.io/reference/postlinklinkid
 */
import { fetchWithTimeout } from "../../lib/fetch-timeout";
import type {
	ProviderAnalyticsTarget,
	ShortIoProviderRef,
	ShortLinkProvider,
} from "./types";

const SHORT_IO_API = "https://api.short.io";
const SHORT_IO_STATS_API = "https://statistics.short.io";

export const shortIoProvider: ShortLinkProvider = {
	providerType: "short_io",
	shortLinkDomain: "short.io",

	async shorten(apiKey, domain, url, intentId, providerMutation) {
		if (!domain) {
			throw new Error("Short.io requires a custom domain");
		}

		const request = () =>
			fetchWithTimeout(`${SHORT_IO_API}/links`, {
				method: "POST",
				headers: {
					Authorization: apiKey,
					"Content-Type": "application/json",
				},
				// Short.io otherwise reuses an existing link for the same destination.
				// RelayAPI must own the object it later deletes during erasure, so each
				// durable intent requests a dedicated provider object.
				body: JSON.stringify({
					originalURL: url,
					domain,
					allowDuplicates: true,
				}),
				timeout: 5_000,
			});
		const res = providerMutation
			? await providerMutation.track("short_io.short_link.create", request)
			: await request();
		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Short.io API error (${res.status}): ${text}`);
		}

		const data = (await res.json()) as {
			shortURL?: string;
			idString?: string;
			DomainId?: number;
		};
		if (!data.idString || !Number.isInteger(data.DomainId)) {
			throw new Error("Short.io API returned an incomplete link identity");
		}
		return {
			// URL validation belongs to the lifecycle after provider identity is
			// retained, so an incomplete response cannot orphan a deletable link.
			shortUrl: data.shortURL ?? "",
			providerRef: {
				provider: "short_io",
				intentId,
				idString: data.idString,
				domainId: data.DomainId as number,
			},
		};
	},

	async probeCredential(apiKey) {
		const res = await fetchWithTimeout(`${SHORT_IO_API}/api/domains?limit=1`, {
			headers: { Authorization: apiKey },
			timeout: 5_000,
		});
		if (!res.ok) {
			throw new Error(`Short.io credential probe failed (${res.status})`);
		}
	},

	async deleteLink(apiKey, providerRef) {
		if (providerRef.provider !== "short_io") {
			return {
				kind: "unknown",
				reason: "short_io_provider_reference_mismatch",
			};
		}
		const ref = providerRef as ShortIoProviderRef;
		if (!ref.idString) {
			return {
				kind: "unknown",
				reason: "short_io_provider_identity_missing",
			};
		}
		const res = await fetchWithTimeout(
			`${SHORT_IO_API}/links/${encodeURIComponent(ref.idString)}`,
			{
				method: "DELETE",
				headers: { Authorization: apiKey },
				timeout: 5_000,
			},
		);
		if (res.status === 200 || res.status === 404) return { kind: "deleted" };
		if (res.status >= 400 && res.status < 500) {
			return {
				kind: "unsupported",
				reason: `short_io_delete_rejected_${res.status}`,
			};
		}
		return {
			kind: "unknown",
			reason: `short_io_delete_ambiguous_${res.status}`,
		};
	},

	async getClickCount(apiKey, target) {
		const counts = await this.getClickCounts(apiKey, [target]);
		return counts.get(target.key) ?? 0;
	},

	async getClickCounts(apiKey, targets) {
		const result = new Map<string, number>();
		const tasks = targets.map(async (target: ProviderAnalyticsTarget) => {
			try {
				if (target.providerRef.provider !== "short_io") return;
				const idString = target.providerRef.idString;
				if (!idString) return;
				const statsRes = await fetchWithTimeout(
					`${SHORT_IO_STATS_API}/statistics/link/${encodeURIComponent(idString)}`,
					{
						method: "POST",
						headers: {
							Authorization: apiKey,
							"Content-Type": "application/json",
						},
						// The endpoint defaults to last30. Cached click_count is a
						// lifetime total, so request the documented total period.
						body: JSON.stringify({ period: "total", skipTops: true }),
						timeout: 5_000,
					},
				);
				if (statsRes.ok) {
					const stats = (await statsRes.json()) as {
						totalClicks?: number;
						total_clicks?: number;
						clicks?: number;
					};
					result.set(
						target.key,
						stats.totalClicks ?? stats.total_clicks ?? stats.clicks ?? 0,
					);
				}
			} catch {
				// A missing entry is retried by the durable poller.
			}
		});
		await Promise.allSettled(tasks);
		return result;
	},
};
