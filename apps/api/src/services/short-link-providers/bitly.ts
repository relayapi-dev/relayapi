import {
	readProviderJson,
	readProviderText,
} from "../../lib/provider-response";
/**
 * Bitly short link provider.
 *
 * Official docs: https://dev.bitly.com/api-reference/
 */
import { fetchWithTimeout } from "../../lib/fetch-timeout";
import type {
	BitlyProviderRef,
	ProviderAnalyticsTarget,
	ShortLinkProvider,
} from "./types";

const BITLY_API = "https://api-ssl.bitly.com/v4";

function bitlinkPath(bitlink: string): string {
	return bitlink
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
}

export const bitlyProvider: ShortLinkProvider = {
	providerType: "bitly",
	shortLinkDomain: "bit.ly",

	async shorten(apiKey, domain, url, intentId, providerMutation) {
		const request = () =>
			fetchWithTimeout(`${BITLY_API}/shorten`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					long_url: url,
					// A reused Bitlink may be shared with another operation and is not
					// safe to delete during erasure. Allocate one object for this intent.
					force_new_link: true,
					...(domain ? { domain } : {}),
				}),
				timeout: 5_000,
			});
		const res = providerMutation
			? await providerMutation.track("bitly.short_link.create", request)
			: await request();
		if (!res.ok) {
			const text = await readProviderText(res);
			throw new Error(`Bitly API error (${res.status}): ${text}`);
		}

		const data = (await readProviderJson(res)) as {
			id?: string;
			link?: string;
			custom_bitlinks?: string[];
		};
		let bitlink = data.id;
		if (!bitlink && data.link) {
			try {
				const parsed = new URL(data.link);
				bitlink = `${parsed.hostname}${parsed.pathname}`;
			} catch {
				// The lifecycle will report the invalid URL after identity recovery.
			}
		}
		if (!bitlink) {
			throw new Error("Bitly API returned an incomplete link identity");
		}
		return {
			// Retain the bitlink before validating the returned URL in the
			// lifecycle; a malformed response must not make cleanup impossible.
			shortUrl: data.link ?? "",
			providerRef: {
				provider: "bitly",
				intentId,
				bitlink,
				editedOrCustom: (data.custom_bitlinks?.length ?? 0) > 0,
			},
		};
	},

	async probeCredential(apiKey) {
		const res = await fetchWithTimeout(`${BITLY_API}/user`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			timeout: 5_000,
		});
		if (!res.ok) {
			throw new Error(`Bitly credential probe failed (${res.status})`);
		}
	},

	async deleteLink(apiKey, providerRef) {
		if (providerRef.provider !== "bitly") {
			return { kind: "unknown", reason: "bitly_provider_reference_mismatch" };
		}
		const ref = providerRef as BitlyProviderRef;
		if (!ref.bitlink) {
			return { kind: "unknown", reason: "bitly_provider_identity_missing" };
		}
		if (ref.editedOrCustom) {
			return {
				kind: "unsupported",
				reason: "bitly_edited_or_custom_link_cannot_be_deleted",
			};
		}
		const res = await fetchWithTimeout(
			`${BITLY_API}/bitlinks/${bitlinkPath(ref.bitlink)}`,
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
				reason: `bitly_delete_rejected_${res.status}`,
			};
		}
		return {
			kind: "unknown",
			reason: `bitly_delete_ambiguous_${res.status}`,
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
				if (target.providerRef.provider !== "bitly") return;
				const bitlink = target.providerRef.bitlink;
				if (!bitlink) return;
				const res = await fetchWithTimeout(
					`${BITLY_API}/bitlinks/${bitlinkPath(bitlink)}/clicks/summary?unit=day&units=-1`,
					{
						headers: { Authorization: `Bearer ${apiKey}` },
						timeout: 5_000,
					},
				);
				if (res.ok) {
					const data = (await readProviderJson(res)) as {
						total_clicks: number;
					};
					result.set(target.key, data.total_clicks ?? 0);
				}
			} catch {
				// A missing entry is retried by the durable poller.
			}
		});
		await Promise.allSettled(tasks);
		return result;
	},
};
