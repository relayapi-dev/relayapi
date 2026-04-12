import { fetchWithTimeout } from "./fetch-timeout";

/** SSRF protection: reject URLs pointing to private/reserved IP ranges */
const BLOCKED_URL_PATTERNS = [
	/^https?:\/\/localhost/i,
	/^https?:\/\/127\./,
	/^https?:\/\/0\./,
	/^https?:\/\/10\./,
	/^https?:\/\/172\.(1[6-9]|2\d|3[01])\./,
	/^https?:\/\/192\.168\./,
	/^https?:\/\/169\.254\./,
	/^https?:\/\/\[::1\]/,
	/^https?:\/\/\[fc/i,
	/^https?:\/\/\[fd/i,
	/^https?:\/\/\[fe80:/i,
	/^https?:\/\/metadata\.google/i,
	/^https?:\/\/100\.100\.100\.200/,
];
const DNS_LOOKUP_TTL_MS = 5 * 60_000;
const DNS_LOOKUP_TIMEOUT_MS = 2_500;
const DOH_ENDPOINTS = [
	"https://dns.google/resolve",
	"https://cloudflare-dns.com/dns-query",
];
const dnsLookupCache = new Map<string, { blocked: boolean; expiresAtMs: number }>();

/**
 * Check if a decimal-encoded IP (e.g. http://2130706433) resolves to a private range.
 * Browsers and curl interpret bare integers as IPs: 2130706433 = 127.0.0.1.
 */
function isPrivateIPDecimal(hostname: string): boolean {
	// Decimal integer IP (e.g. 2130706433)
	if (/^\d+$/.test(hostname)) {
		const num = Number(hostname);
		if (num >= 0 && num <= 0xffffffff) {
			return isPrivateIPv4(num);
		}
	}

	// Octal IP components (e.g. 0177.0.0.1 = 127.0.0.1)
	if (/^0\d/.test(hostname) || hostname.includes(".0")) {
		const parts = hostname.split(".");
		if (parts.length === 4 && parts.every((p) => /^0?\d+$/.test(p))) {
			const octets = parts.map((p) =>
				p.startsWith("0") && p.length > 1 ? parseInt(p, 8) : parseInt(p, 10),
			);
			if (octets.every((o) => o >= 0 && o <= 255)) {
				const num = (octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!;
				return isPrivateIPv4(num >>> 0);
			}
		}
	}

	// Hex IP (e.g. 0x7f000001)
	if (/^0x[0-9a-f]+$/i.test(hostname)) {
		const num = parseInt(hostname, 16);
		if (num >= 0 && num <= 0xffffffff) {
			return isPrivateIPv4(num);
		}
	}

	return false;
}

/** Check if a 32-bit integer falls within private/reserved IPv4 ranges */
function isPrivateIPv4(ip: number): boolean {
	return (
		(ip >>> 24) === 127 || // 127.0.0.0/8
		(ip >>> 24) === 10 || // 10.0.0.0/8
		(ip >>> 24) === 0 || // 0.0.0.0/8
		(ip >>> 20) === 0xac1 || // 172.16.0.0/12 (0xAC1 = 172.16 >> 4)
		(ip >>> 16) === 0xc0a8 || // 192.168.0.0/16
		(ip >>> 16) === 0xa9fe || // 169.254.0.0/16
		ip === 0x646464c8 // 100.100.100.200
	);
}

function isIPv4Address(hostname: string): boolean {
	return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

function ipv4ToInt(ip: string): number | null {
	const parts = ip.split(".");
	if (parts.length !== 4) return null;
	const octets = parts.map((part) => Number.parseInt(part, 10));
	if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
		return null;
	}
	return (
		((octets[0] ?? 0) << 24)
		| ((octets[1] ?? 0) << 16)
		| ((octets[2] ?? 0) << 8)
		| (octets[3] ?? 0)
	) >>> 0;
}

function expandIPv6(address: string): number[] | null {
	let ip = address.toLowerCase();
	if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
	if (ip.includes("%")) ip = ip.split("%")[0] ?? ip;

	let ipv4Tail: number[] = [];
	if (ip.includes(".")) {
		const lastColon = ip.lastIndexOf(":");
		if (lastColon === -1) return null;
		const ipv4Part = ip.slice(lastColon + 1);
		const ipv4Int = ipv4ToInt(ipv4Part);
		if (ipv4Int === null) return null;
		ipv4Tail = [(ipv4Int >>> 16) & 0xffff, ipv4Int & 0xffff];
		ip = ip.slice(0, lastColon);
		if (ip.endsWith(":")) ip = ip.slice(0, -1);
	}

	const [headRaw, tailRaw] = ip.split("::");
	if (ip.split("::").length > 2) return null;

	const parseSide = (value: string | undefined): number[] => {
		if (!value) return [];
		return value
			.split(":")
			.filter(Boolean)
			.map((part) => Number.parseInt(part, 16));
	};

	const head = parseSide(headRaw);
	const tail = parseSide(tailRaw);
	if ([...head, ...tail].some((part) => Number.isNaN(part) || part < 0 || part > 0xffff)) {
		return null;
	}

	const missing = 8 - (head.length + tail.length + ipv4Tail.length);
	if (missing < 0) return null;
	if (!ip.includes("::") && missing !== 0) return null;

	return [...head, ...Array(missing).fill(0), ...tail, ...ipv4Tail];
}

function isPrivateIPv6(address: string): boolean {
	const segments = expandIPv6(address);
	if (!segments || segments.length !== 8) return false;

	const first = segments[0] ?? 0;
	const isLoopback = segments.slice(0, 7).every((segment) => segment === 0) && segments[7] === 1;
	if (isLoopback) return true;

	if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7
	if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10

	const isMappedIpv4 =
		segments[0] === 0
		&& segments[1] === 0
		&& segments[2] === 0
		&& segments[3] === 0
		&& segments[4] === 0
		&& segments[5] === 0xffff;
	if (isMappedIpv4) {
		const ipv4 = ((segments[6] ?? 0) << 16) | (segments[7] ?? 0);
		return isPrivateIPv4(ipv4 >>> 0);
	}

	return false;
}

function isIpAddress(hostname: string): boolean {
	return isIPv4Address(hostname) || hostname.includes(":");
}

interface DnsAnswer {
	type?: number;
	data?: string;
}

interface DnsResponse {
	Answer?: DnsAnswer[];
}

async function lookupDnsRecords(
	endpoint: string,
	hostname: string,
	recordType: "A" | "AAAA",
): Promise<string[]> {
	const response = await fetchWithTimeout(
		`${endpoint}?name=${encodeURIComponent(hostname)}&type=${recordType}`,
		{
			headers: { Accept: "application/dns-json" },
			redirect: "error",
			timeout: DNS_LOOKUP_TIMEOUT_MS,
		},
	);
	if (!response.ok) {
		throw new Error(`DNS lookup failed with status ${response.status}`);
	}

	const expectedType = recordType === "A" ? 1 : 28;
	const payload = (await response.json()) as DnsResponse;
	return (payload.Answer ?? [])
		.filter((answer) => answer.type === expectedType && typeof answer.data === "string")
		.map((answer) => answer.data!.trim());
}

async function hasPrivateDnsResolution(hostname: string): Promise<boolean> {
	const normalizedHost = hostname.toLowerCase().replace(/\.$/, "");
	const now = Date.now();
	const cached = dnsLookupCache.get(normalizedHost);
	if (cached && cached.expiresAtMs > now) {
		return cached.blocked;
	}
	if (cached) dnsLookupCache.delete(normalizedHost);

	let sawSuccessfulLookup = false;
	for (const endpoint of DOH_ENDPOINTS) {
		try {
			const [ipv4Answers, ipv6Answers] = await Promise.all([
				lookupDnsRecords(endpoint, normalizedHost, "A"),
				lookupDnsRecords(endpoint, normalizedHost, "AAAA"),
			]);
			sawSuccessfulLookup = true;
			const blocked =
				ipv4Answers.some((ip) => {
					const value = ipv4ToInt(ip);
					return value !== null && isPrivateIPv4(value);
				})
				|| ipv6Answers.some((ip) => isPrivateIPv6(ip));
			dnsLookupCache.set(normalizedHost, {
				blocked,
				expiresAtMs: now + DNS_LOOKUP_TTL_MS,
			});
			return blocked;
		} catch {
			continue;
		}
	}

	const blocked = !sawSuccessfulLookup;
	dnsLookupCache.set(normalizedHost, {
		blocked,
		expiresAtMs: now + 30_000,
	});
	return blocked;
}

/**
 * Detect IPv6-mapped IPv4 private addresses.
 * E.g. [::ffff:127.0.0.1] or [::ffff:7f00:1]
 */
function isIPv6MappedPrivate(hostname: string): boolean {
	const match = hostname.match(/^\[::ffff:(.+)\]$/i);
	if (!match) return false;
	const mapped = match[1]!;

	// Dotted form: ::ffff:127.0.0.1
	if (mapped.includes(".")) {
		return isBlockedUrl(`http://${mapped}`);
	}

	// Hex form: ::ffff:7f00:0001
	const hexParts = mapped.split(":");
	if (hexParts.length === 2) {
		const num = (parseInt(hexParts[0]!, 16) << 16) | parseInt(hexParts[1]!, 16);
		return isPrivateIPv4(num >>> 0);
	}

	return false;
}

export function isBlockedUrl(url: string): boolean {
	if (BLOCKED_URL_PATTERNS.some((p) => p.test(url))) return true;

	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname;

		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
		if (!hostname) return true;

		if (isPrivateIPDecimal(hostname)) return true;
		if (isIPv6MappedPrivate(hostname)) return true;
	} catch {
		// Invalid URL — block it to be safe
		return true;
	}

	return false;
}

export async function isBlockedUrlWithDns(url: string): Promise<boolean> {
	if (isBlockedUrl(url)) return true;

	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname.toLowerCase();
		if (!hostname) return true;
		if (isIpAddress(hostname)) return false;
		return await hasPrivateDnsResolution(hostname);
	} catch {
		return true;
	}
}
