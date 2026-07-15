import { fetchWithTimeout } from "./fetch-timeout";

const DNS_LOOKUP_TIMEOUT_MS = 2_500;
const DOH_ENDPOINTS = [
	"https://dns.google/resolve",
	"https://cloudflare-dns.com/dns-query",
] as const;

export type PublicUrlSafety = "allowed" | "blocked" | "indeterminate";

/**
 * IANA special-purpose IPv4 space that is not globally reachable, plus
 * multicast and the protocol-reserved high block. Keep this list aligned with
 * https://www.iana.org/assignments/iana-ipv4-special-registry/.
 *
 * 192.0.0.9 and 192.0.0.10 are the two globally reachable exceptions inside
 * 192.0.0.0/24 and are handled before this table is consulted.
 */
const NON_GLOBAL_IPV4_RANGES = [
	[0x00000000, 8], // 0.0.0.0/8 - current network / unspecified
	[0x0a000000, 8], // 10.0.0.0/8 - private use
	[0x64400000, 10], // 100.64.0.0/10 - shared address space (CGNAT)
	[0x7f000000, 8], // 127.0.0.0/8 - loopback
	[0xa9fe0000, 16], // 169.254.0.0/16 - link local
	[0xac100000, 12], // 172.16.0.0/12 - private use
	[0xc0000000, 24], // 192.0.0.0/24 - IETF protocol assignments
	[0xc0000200, 24], // 192.0.2.0/24 - documentation
	[0xc0586300, 24], // 192.88.99.0/24 - deprecated relay anycast
	[0xc0a80000, 16], // 192.168.0.0/16 - private use
	[0xc6120000, 15], // 198.18.0.0/15 - benchmarking
	[0xc6336400, 24], // 198.51.100.0/24 - documentation
	[0xcb007100, 24], // 203.0.113.0/24 - documentation
	[0xe0000000, 4], // 224.0.0.0/4 - multicast
	[0xf0000000, 4], // 240.0.0.0/4 - reserved / limited broadcast
] as const;

const PCP_ANYCAST_IPV4 = 0xc0000009; // 192.0.0.9
const TURN_ANYCAST_IPV4 = 0xc000000a; // 192.0.0.10

// Precomputed prefixes keep the hot classification path allocation-free.
const WELL_KNOWN_NAT64 = [0x0064, 0xff9b, 0, 0, 0, 0, 0, 0] as const;
const GLOBAL_UNICAST_IPV6 = [0x2000, 0, 0, 0, 0, 0, 0, 0] as const;
const IETF_ASSIGNMENTS_IPV6 = [0x2001, 0, 0, 0, 0, 0, 0, 0] as const;
const PCP_ANYCAST_IPV6 = [0x2001, 0x0001, 0, 0, 0, 0, 0, 1] as const;
const TURN_ANYCAST_IPV6 = [0x2001, 0x0001, 0, 0, 0, 0, 0, 2] as const;
const DNS_SD_ANYCAST_IPV6 = [0x2001, 0x0001, 0, 0, 0, 0, 0, 3] as const;
const AMT_IPV6 = [0x2001, 0x0003, 0, 0, 0, 0, 0, 0] as const;
const AS112_IPV6 = [0x2001, 0x0004, 0x0112, 0, 0, 0, 0, 0] as const;
const ORCHID_V2_IPV6 = [0x2001, 0x0020, 0, 0, 0, 0, 0, 0] as const;
const DRONE_DET_IPV6 = [0x2001, 0x0030, 0, 0, 0, 0, 0, 0] as const;
const DOCUMENTATION_IPV6 = [0x2001, 0x0db8, 0, 0, 0, 0, 0, 0] as const;
const SIX_TO_FOUR_IPV6 = [0x2002, 0, 0, 0, 0, 0, 0, 0] as const;
const DOCUMENTATION_V2_IPV6 = [0x3fff, 0, 0, 0, 0, 0, 0, 0] as const;

const BLOCKED_HOSTNAMES = new Set([
	"instance-data",
	"metadata",
	"metadata.google",
	"metadata.google.internal",
]);

const CLOUDFLARE_R2_HOST = /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/;

/**
 * Relay-generated R2 presigns always target Cloudflare's fixed public R2
 * service. Skipping two DoH subrequests for this exact shape avoids repeating
 * DNS work for every provider that streams the same media, without creating an
 * allow-cache or a DNS-rebinding window for user-controlled hosts. R2 still
 * authenticates the SigV4 query before returning an object.
 */
export function isRelayR2PresignedUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		if (
			parsed.protocol !== "https:" ||
			parsed.username !== "" ||
			parsed.password !== "" ||
			(parsed.port !== "" && parsed.port !== "443") ||
			!CLOUDFLARE_R2_HOST.test(parsed.hostname.toLowerCase()) ||
			!parsed.pathname.startsWith("/relayapi-media/")
		) {
			return false;
		}
		return (
			parsed.searchParams.get("X-Amz-Algorithm") === "AWS4-HMAC-SHA256" &&
			parsed.searchParams.has("X-Amz-Credential") &&
			parsed.searchParams.has("X-Amz-Date") &&
			parsed.searchParams.has("X-Amz-Expires") &&
			parsed.searchParams.has("X-Amz-SignedHeaders") &&
			parsed.searchParams.has("X-Amz-Signature")
		);
	} catch {
		return false;
	}
}

function ipv4ToInt(ip: string): number | null {
	const parts = ip.split(".");
	if (parts.length !== 4) return null;

	const octets = parts.map((part) => {
		if (!/^\d{1,3}$/.test(part)) return Number.NaN;
		return Number.parseInt(part, 10);
	});
	if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) {
		return null;
	}

	return (
		(((octets[0] ?? 0) << 24) |
			((octets[1] ?? 0) << 16) |
			((octets[2] ?? 0) << 8) |
			(octets[3] ?? 0)) >>>
		0
	);
}

function matchesIpv4Prefix(
	ip: number,
	network: number,
	prefixLength: number,
): boolean {
	const mask = (0xffffffff << (32 - prefixLength)) >>> 0;
	return (ip & mask) >>> 0 === (network & mask) >>> 0;
}

function isGlobalIPv4(ip: number): boolean {
	if (ip === PCP_ANYCAST_IPV4 || ip === TURN_ANYCAST_IPV4) return true;
	return !NON_GLOBAL_IPV4_RANGES.some(([network, prefixLength]) =>
		matchesIpv4Prefix(ip, network, prefixLength),
	);
}

/** Parse an IPv6 literal into eight 16-bit segments. */
function expandIPv6(address: string): number[] | null {
	let value = address.toLowerCase();
	if (value.startsWith("[") && value.endsWith("]")) {
		value = value.slice(1, -1);
	}
	// Zone identifiers are meaningful only to the local host and must never be
	// accepted as public destinations.
	if (value.includes("%")) return null;

	const compressionIndex = value.indexOf("::");
	if (compressionIndex !== -1 && compressionIndex !== value.lastIndexOf("::")) {
		return null;
	}

	const parsePart = (part: string): number[] | null => {
		if (!part) return [];
		const tokens = part.split(":");
		const segments: number[] = [];
		for (const [index, token] of tokens.entries()) {
			if (token.includes(".")) {
				if (index !== tokens.length - 1) return null;
				const ipv4 = ipv4ToInt(token);
				if (ipv4 === null) return null;
				segments.push((ipv4 >>> 16) & 0xffff, ipv4 & 0xffff);
				continue;
			}
			if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
			segments.push(Number.parseInt(token, 16));
		}
		return segments;
	};

	if (compressionIndex === -1) {
		const segments = parsePart(value);
		return segments?.length === 8 ? segments : null;
	}

	const head = parsePart(value.slice(0, compressionIndex));
	const tail = parsePart(value.slice(compressionIndex + 2));
	if (!head || !tail) return null;
	const zeroCount = 8 - head.length - tail.length;
	if (zeroCount < 1) return null;
	return [...head, ...Array<number>(zeroCount).fill(0), ...tail];
}

function matchesIpv6Prefix(
	address: readonly number[],
	network: readonly number[],
	prefixLength: number,
): boolean {
	const completeSegments = Math.floor(prefixLength / 16);
	for (let i = 0; i < completeSegments; i++) {
		if (address[i] !== network[i]) return false;
	}

	const remainingBits = prefixLength % 16;
	if (remainingBits === 0) return true;
	const mask = (0xffff << (16 - remainingBits)) & 0xffff;
	return (
		((address[completeSegments] ?? 0) & mask) ===
		((network[completeSegments] ?? 0) & mask)
	);
}

function isExactIpv6(
	address: readonly number[],
	expected: readonly number[],
): boolean {
	return address.every((segment, index) => segment === expected[index]);
}

/**
 * Allow only IANA globally reachable IPv6 space. The primary public allocation
 * is 2000::/3; the explicit cases below account for non-global reservations and
 * the globally reachable well-known NAT64 prefix outside that block.
 */
function isGlobalIPv6(address: readonly number[]): boolean {
	if (matchesIpv6Prefix(address, WELL_KNOWN_NAT64, 96)) {
		const embeddedIpv4 = (((address[6] ?? 0) << 16) | (address[7] ?? 0)) >>> 0;
		return isGlobalIPv4(embeddedIpv4);
	}

	if (!matchesIpv6Prefix(address, GLOBAL_UNICAST_IPV6, 3)) return false;

	if (matchesIpv6Prefix(address, IETF_ASSIGNMENTS_IPV6, 23)) {
		if (
			isExactIpv6(address, PCP_ANYCAST_IPV6) ||
			isExactIpv6(address, TURN_ANYCAST_IPV6) ||
			isExactIpv6(address, DNS_SD_ANYCAST_IPV6)
		) {
			return true;
		}

		if (matchesIpv6Prefix(address, AMT_IPV6, 32)) {
			return true; // AMT
		}
		if (matchesIpv6Prefix(address, AS112_IPV6, 48)) {
			return true; // AS112-v6
		}
		if (matchesIpv6Prefix(address, ORCHID_V2_IPV6, 28)) {
			return true; // ORCHIDv2
		}
		if (matchesIpv6Prefix(address, DRONE_DET_IPV6, 28)) {
			return true; // Drone Remote ID entity tags
		}

		// This includes unspecified IETF assignments, benchmarking, deprecated
		// ORCHID, and transition space whose global reachability is not guaranteed.
		return false;
	}

	if (matchesIpv6Prefix(address, DOCUMENTATION_IPV6, 32)) {
		return false; // documentation
	}
	if (matchesIpv6Prefix(address, SIX_TO_FOUR_IPV6, 16)) {
		return false; // deprecated 6to4 transition space
	}
	if (matchesIpv6Prefix(address, DOCUMENTATION_V2_IPV6, 20)) {
		return false; // documentation
	}

	return true;
}

function isBlockedHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/\.$/, "");
	return (
		normalized === "localhost" ||
		normalized.endsWith(".localhost") ||
		BLOCKED_HOSTNAMES.has(normalized)
	);
}

function classifyIpAddress(
	hostname: string,
): "global" | "non-global" | "not-ip" {
	const ipv4 = ipv4ToInt(hostname);
	if (ipv4 !== null) return isGlobalIPv4(ipv4) ? "global" : "non-global";

	const ipv6 = expandIPv6(hostname);
	if (ipv6 !== null) return isGlobalIPv6(ipv6) ? "global" : "non-global";
	return "not-ip";
}

interface DnsAnswer {
	type?: number;
	data?: string;
}

interface DnsResponse {
	Status?: number;
	TC?: boolean;
	Answer?: DnsAnswer[];
}

async function lookupDnsRecords(
	endpoint: string,
	hostname: string,
	recordType: "A" | "AAAA",
	signal?: AbortSignal,
): Promise<string[]> {
	const response = await fetchWithTimeout(
		`${endpoint}?name=${encodeURIComponent(hostname)}&type=${recordType}`,
		{
			headers: { Accept: "application/dns-json" },
			redirect: "error",
			timeout: DNS_LOOKUP_TIMEOUT_MS,
			timeoutThroughBody: true,
			signal,
		},
	);
	if (!response.ok) {
		throw new Error(`DNS lookup failed with status ${response.status}`);
	}

	const payload = (await response.json()) as DnsResponse;
	if (payload.Status !== undefined && payload.Status !== 0) {
		throw new Error(`DNS lookup returned status ${payload.Status}`);
	}
	if (payload.TC === true)
		throw new Error("DNS lookup returned a truncated response");

	const expectedType = recordType === "A" ? 1 : 28;
	return (payload.Answer ?? [])
		.filter((answer) => answer.type === expectedType)
		.map((answer) => {
			if (typeof answer.data !== "string") {
				throw new Error("DNS lookup returned a malformed address record");
			}
			return answer.data.trim();
		});
}

async function classifyDnsResolution(
	hostname: string,
	signal?: AbortSignal,
): Promise<PublicUrlSafety> {
	const normalizedHost = hostname.toLowerCase().replace(/\.$/, "");

	// Do not cache an allowed resolution. The runtime performs its own lookup for
	// fetch(), so reusing an old public answer creates a larger DNS-rebinding
	// window. Workers cannot pin arbitrary external hosts with resolveOverride
	// (it only applies when both hosts are in the Worker's zone). A and AAAA remain
	// parallel and the second resolver is fallback-only, preserving the
	// two-subrequest fast path.
	for (const endpoint of DOH_ENDPOINTS) {
		try {
			const [ipv4Answers, ipv6Answers] = await Promise.all([
				lookupDnsRecords(endpoint, normalizedHost, "A", signal),
				lookupDnsRecords(endpoint, normalizedHost, "AAAA", signal),
			]);
			if (ipv4Answers.length === 0 && ipv6Answers.length === 0) continue;
			return ipv4Answers.some(
				(answer) => classifyIpAddress(answer) !== "global",
			) || ipv6Answers.some((answer) => classifyIpAddress(answer) !== "global")
				? "blocked"
				: "allowed";
		} catch {
			if (signal?.aborted) throw signal.reason;
			// Fail over to the second independent resolver. Both failing is unsafe.
		}
	}

	return "indeterminate";
}

/** Reject malformed, non-HTTP, local-name, and non-global literal destinations. */
export function isBlockedUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
			return true;
		if (!parsed.hostname || isBlockedHostname(parsed.hostname)) return true;

		return classifyIpAddress(parsed.hostname) === "non-global";
	} catch {
		return true;
	}
}

/** Distinguish confirmed private destinations from transient DNS uncertainty. */
export async function classifyPublicUrlWithDns(
	url: string,
	options: { signal?: AbortSignal } = {},
): Promise<PublicUrlSafety> {
	if (isBlockedUrl(url)) return "blocked";

	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
		if (!hostname) return "blocked";

		const classification = classifyIpAddress(hostname);
		if (classification === "global") return "allowed";
		if (classification === "non-global") return "blocked";
		return await classifyDnsResolution(hostname, options.signal);
	} catch {
		if (options.signal?.aborted) throw options.signal.reason;
		return "indeterminate";
	}
}

/** Fail closed for callers that only need a yes/no safety decision. */
export async function isBlockedUrlWithDns(
	url: string,
	options: { signal?: AbortSignal } = {},
): Promise<boolean> {
	return (await classifyPublicUrlWithDns(url, options)) !== "allowed";
}
