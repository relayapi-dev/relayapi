type TargetName = "api" | "app" | "docs";

export type Target = {
	httpsUrl: string;
	requireBrowserPolicy: boolean;
};

const targets: Record<TargetName, Target> = {
	api: {
		httpsUrl: "https://api.relayapi.dev/health",
		requireBrowserPolicy: false,
	},
	app: {
		httpsUrl: "https://relayapi.dev/app",
		requireBrowserPolicy: true,
	},
	docs: {
		httpsUrl: "https://docs.relayapi.dev/",
		requireBrowserPolicy: true,
	},
};

export function assertHttpsRedirect(
	response: Response,
	expectedUrl: URL,
): void {
	if (response.status !== 301 && response.status !== 308) {
		throw new Error(
			`${expectedUrl.hostname} must redirect HTTP with status 301 or 308`,
		);
	}
	const location = response.headers.get("location");
	if (!location)
		throw new Error(`${expectedUrl.hostname} redirect has no location`);
	const redirected = new URL(location, expectedUrl);
	const expectedHttpsUrl = new URL(expectedUrl);
	expectedHttpsUrl.protocol = "https:";
	if (
		redirected.origin !== expectedHttpsUrl.origin ||
		redirected.username !== "" ||
		redirected.password !== "" ||
		redirected.pathname !== expectedUrl.pathname ||
		redirected.search !== expectedUrl.search ||
		redirected.hash !== ""
	) {
		throw new Error(`${expectedUrl.hostname} redirected to an unexpected URL`);
	}
}

export function assertSecurityHeaders(
	response: Response,
	target: Target,
): void {
	if (response.status < 200 || response.status >= 400) {
		throw new Error(`HTTPS smoke returned HTTP ${response.status}`);
	}
	const required: Array<[string, (value: string) => boolean]> = [
		[
			"strict-transport-security",
			(value) => {
				const maxAge = Number(/(?:^|;)\s*max-age=(\d+)/i.exec(value)?.[1]);
				return (
					Number.isFinite(maxAge) &&
					maxAge >= 31_536_000 &&
					/(?:^|;)\s*includeSubDomains(?:;|$)/i.test(value)
				);
			},
		],
		["x-content-type-options", (value) => value.toLowerCase() === "nosniff"],
		[
			"referrer-policy",
			(value) =>
				/^(?:no-referrer|same-origin|strict-origin|strict-origin-when-cross-origin)$/i.test(
					value.trim(),
				),
		],
	];
	for (const [name, valid] of required) {
		const value = response.headers.get(name) ?? "";
		if (!valid(value)) throw new Error(`HTTPS response is missing ${name}`);
	}

	const csp = response.headers.get("content-security-policy") ?? "";
	const frameOptions = response.headers.get("x-frame-options") ?? "";
	const frameAncestors =
		/(?:^|;)\s*frame-ancestors\s+([^;]+)/i.exec(csp)?.[1]?.trim() ?? "";
	if (
		!/^'(?:none|self)'$/i.test(frameAncestors) &&
		!/^(DENY|SAMEORIGIN)$/i.test(frameOptions)
	) {
		throw new Error("HTTPS response is missing frame protection");
	}
	if (target.requireBrowserPolicy) {
		if (!csp)
			throw new Error("Browser response is missing content-security-policy");
		for (const directive of [
			/default-src\s+[^;]+/i,
			/base-uri\s+'(?:none|self)'/i,
			/object-src\s+'none'/i,
			/frame-ancestors\s+'(?:none|self)'/i,
		]) {
			if (!directive.test(csp)) {
				throw new Error("Browser content-security-policy is incomplete");
			}
		}
		const permissions = response.headers.get("permissions-policy") ?? "";
		if (
			!["camera", "microphone", "geolocation"].every((feature) =>
				new RegExp(`(?:^|,)\\s*${feature}=\\(\\)`, "i").test(permissions),
			)
		) {
			throw new Error("Browser response is missing permissions-policy");
		}
		if (response.headers.has("x-powered-by")) {
			throw new Error("Browser response exposes x-powered-by");
		}
	}
}

export async function verifyProductionEdge(
	targetName: TargetName,
): Promise<void> {
	const target = targets[targetName];
	const httpsUrl = new URL(target.httpsUrl);
	const httpUrl = new URL(httpsUrl);
	httpUrl.protocol = "http:";
	const options: RequestInit = {
		redirect: "manual",
		headers: { "user-agent": "relayapi-edge-verifier/1" },
		signal: AbortSignal.timeout(15_000),
	};
	const httpResponse = await fetch(httpUrl, options);
	assertHttpsRedirect(httpResponse, httpUrl);
	await httpResponse.body?.cancel();

	const httpsResponse = await fetch(httpsUrl, options);
	assertSecurityHeaders(httpsResponse, target);
	await httpsResponse.body?.cancel();
	console.log(`${targetName} production edge policy passed.`);
}

if (import.meta.main) {
	const targetName = process.argv[2];
	if (targetName !== "api" && targetName !== "app" && targetName !== "docs") {
		throw new Error("Usage: verify-production-edge.ts api|app|docs");
	}
	await verifyProductionEdge(targetName);
}
