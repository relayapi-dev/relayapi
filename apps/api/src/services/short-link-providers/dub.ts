import {
	readProviderJson,
	readProviderText,
} from "../../lib/provider-response";
/**
 * Dub.co short link provider.
 *
 * Official docs:
 * - Create: https://dub.co/docs/api-reference/links/create
 * - Read-only credential probe: https://dub.co/docs/api-reference/links/count
 * - Retrieve analytics: https://dub.co/docs/api-reference/links/retrieve
 * - Delete: https://dub.co/docs/api-reference/links/delete
 * - Client-owned external IDs: https://dub.co/docs/concepts/links/introduction
 */
import { fetchWithTimeout } from "../../lib/fetch-timeout";
import type {
	DubProviderRef,
	ProviderAnalyticsTarget,
	ShortLinkProvider,
} from "./types";

const DUB_API = "https://api.dub.co";

export const dubProvider: ShortLinkProvider = {
	providerType: "dub",
	shortLinkDomain: "dub.sh",

	async shorten(apiKey, domain, url, intentId, providerMutation) {
		const request = () =>
			fetchWithTimeout(`${DUB_API}/links`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					url,
					externalId: intentId,
					...(domain ? { domain } : {}),
				}),
				timeout: 5_000,
			});
		const res = providerMutation
			? await providerMutation.track("dub.short_link.create", request)
			: await request();

		if (!res.ok) {
			const text = await readProviderText(res);
			throw new Error(`Dub API error (${res.status}): ${text}`);
		}

		const data = (await readProviderJson(res)) as {
			id?: string;
			externalId?: string;
			shortLink?: string;
		};
		return {
			// The lifecycle validates the URL only after it has retained this
			// recoverable identity. Dub remains addressable by externalId even if
			// the provider response is missing either returned field.
			shortUrl: data.shortLink ?? "",
			providerRef: {
				provider: "dub",
				// The request-side value is the recovery authority. Do not replace
				// it with an unexpected response echo.
				externalId: intentId,
				...(data.id ? { linkId: data.id } : {}),
			},
		};
	},

	async probeCredential(apiKey) {
		const res = await fetchWithTimeout(`${DUB_API}/links/count`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			timeout: 5_000,
		});
		if (!res.ok) {
			throw new Error(`Dub credential probe failed (${res.status})`);
		}
	},

	async deleteLink(apiKey, providerRef) {
		if (providerRef.provider !== "dub") {
			return { kind: "unknown", reason: "dub_provider_reference_mismatch" };
		}
		const ref = providerRef as DubProviderRef;
		const address = ref.externalId ? `ext_${ref.externalId}` : ref.linkId;
		if (!address) {
			return { kind: "unknown", reason: "dub_provider_identity_missing" };
		}
		const res = await fetchWithTimeout(
			`${DUB_API}/links/${encodeURIComponent(address)}`,
			{
				method: "DELETE",
				headers: { Authorization: `Bearer ${apiKey}` },
				timeout: 5_000,
			},
		);
		if (res.status === 200 || res.status === 404) return { kind: "deleted" };
		if (res.status >= 400 && res.status < 500) {
			return {
				kind: "unsupported",
				reason: `dub_delete_rejected_${res.status}`,
			};
		}
		return { kind: "unknown", reason: `dub_delete_ambiguous_${res.status}` };
	},

	async getClickCount(apiKey, target) {
		const counts = await this.getClickCounts(apiKey, [target]);
		return counts.get(target.key) ?? 0;
	},

	async getClickCounts(apiKey, targets) {
		const result = new Map<string, number>();
		const tasks = targets.map(async (target: ProviderAnalyticsTarget) => {
			try {
				if (target.providerRef.provider !== "dub") return;
				const query = target.providerRef.linkId
					? `linkId=${encodeURIComponent(target.providerRef.linkId)}`
					: target.providerRef.externalId
						? `externalId=${encodeURIComponent(`ext_${target.providerRef.externalId}`)}`
						: null;
				if (!query) return;
				const res = await fetchWithTimeout(`${DUB_API}/links/info?${query}`, {
					headers: { Authorization: `Bearer ${apiKey}` },
					timeout: 5_000,
				});
				if (res.ok) {
					const data = (await readProviderJson(res)) as { clicks: number };
					result.set(target.key, data.clicks ?? 0);
				}
			} catch {
				// A missing entry is retried by the durable poller.
			}
		});
		await Promise.allSettled(tasks);
		return result;
	},
};
