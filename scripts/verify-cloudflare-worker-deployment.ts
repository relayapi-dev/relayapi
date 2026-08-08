import { BASELINE_GENERATION } from "@relayapi/config";

type TargetName = "app" | "docs";

type WorkerBinding = Record<string, unknown> & {
	name?: string;
	type?: string;
};

type VersionDetail = {
	resources?: {
		bindings?: WorkerBinding[];
		script_runtime?: {
			compatibility_date?: string;
			compatibility_flags?: string[];
			usage_model?: string;
		};
	};
};

type DeploymentList = {
	deployments?: Array<{
		versions?: Array<{ version_id?: string; percentage?: number }>;
	}>;
};

type WorkerDomain = {
	hostname?: string;
	service?: string;
	zone_name?: string;
};

type ApiEnvelope<T> = { success?: boolean; result?: T };

type TargetPolicy = {
	workerName: string;
	hostname: string;
	bindings: Record<string, Record<string, unknown>>;
	observability: Record<string, unknown>;
};

const ACCOUNT_ID = "3496f40fcd55a91da50ded8abea2cf7a";
const COMPATIBILITY_DATE = "2026-07-18";
const COMPATIBILITY_FLAGS = ["global_fetch_strictly_public", "nodejs_compat"];

const targets: Record<TargetName, TargetPolicy> = {
	app: {
		workerName: "relayapi-app",
		hostname: "relayapi.dev",
		bindings: {
			ASSETS: { type: "assets" },
			IDENTITY_DELETION_CONTRACT_VERSION: {
				type: "plain_text",
				text: "identity-deletion-v1",
			},
			BASELINE_GENERATION: {
				type: "plain_text",
				text: String(BASELINE_GENERATION),
			},
			AVATARS_BUCKET: {
				type: "r2_bucket",
				bucket_name: "relayapi-avatars",
			},
			EMAIL_INTENTS: {
				type: "service",
				service: "relayapi",
				entrypoint: "EmailIntentEntrypoint",
			},
			HYPERDRIVE: {
				type: "hyperdrive",
				id: "11180e4939824902a75753084dc6a8e9",
			},
			IMAGES: { type: "images" },
			KV: {
				type: "kv_namespace",
				namespace_id: "c4e14913be2b41628ef71ae12561f7e8",
			},
			PUBLIC_ASSETS: {
				type: "r2_bucket",
				bucket_name: "relayapi-public-assets",
			},
		},
		observability: {
			enabled: true,
			head_sampling_rate: 0.1,
			logs: {
				enabled: true,
				head_sampling_rate: 0.1,
				persist: true,
				invocation_logs: true,
			},
			traces: {
				enabled: false,
				persist: false,
				head_sampling_rate: 0.01,
			},
		},
	},
	docs: {
		workerName: "relayapi-docs",
		hostname: "docs.relayapi.dev",
		bindings: { ASSETS: { type: "assets" } },
		observability: { enabled: true },
	},
};

function matchesExpectedFields(
	actual: Record<string, unknown>,
	expected: Record<string, unknown>,
): boolean {
	for (const [key, expectedValue] of Object.entries(expected)) {
		const actualValue = actual[key];
		if (
			expectedValue &&
			typeof expectedValue === "object" &&
			!Array.isArray(expectedValue)
		) {
			if (
				!actualValue ||
				typeof actualValue !== "object" ||
				Array.isArray(actualValue) ||
				!matchesExpectedFields(
					actualValue as Record<string, unknown>,
					expectedValue as Record<string, unknown>,
				)
			) {
				return false;
			}
		} else if (actualValue !== expectedValue) {
			return false;
		}
	}
	return true;
}

export function assertWorkerDeployment(
	targetName: TargetName,
	version: VersionDetail,
	settings: Record<string, unknown>,
): void {
	const policy = targets[targetName];
	const allBindings = version.resources?.bindings ?? [];
	if (
		targetName === "docs" &&
		allBindings.some((binding) => binding.type?.startsWith("secret_"))
	) {
		throw new Error("docs Worker must not have secret bindings");
	}
	const bindings = allBindings.filter(
		(binding) => !binding.type?.startsWith("secret_"),
	);
	const actualNames = bindings
		.map((binding) => binding.name)
		.filter((name): name is string => typeof name === "string")
		.sort();
	const expectedNames = Object.keys(policy.bindings).sort();
	if (actualNames.join("\0") !== expectedNames.join("\0")) {
		throw new Error(`${targetName} non-secret Worker bindings drifted`);
	}
	for (const [name, expected] of Object.entries(policy.bindings)) {
		const matches = bindings.filter((binding) => binding.name === name);
		if (
			matches.length !== 1 ||
			!matchesExpectedFields(matches[0] ?? {}, expected)
		) {
			throw new Error(`${targetName} Worker binding ${name} drifted`);
		}
	}

	const runtime = version.resources?.script_runtime;
	if (
		runtime?.compatibility_date !== COMPATIBILITY_DATE ||
		[...(runtime.compatibility_flags ?? [])].sort().join("\0") !==
			[...COMPATIBILITY_FLAGS].sort().join("\0") ||
		runtime.usage_model !== "standard"
	) {
		throw new Error(`${targetName} Worker runtime policy drifted`);
	}
	if (
		!matchesExpectedFields(settings, {
			observability: policy.observability,
		})
	) {
		throw new Error(`${targetName} Worker observability policy drifted`);
	}
}

export function assertWorkerDomain(
	targetName: TargetName,
	domains: WorkerDomain[],
): void {
	const policy = targets[targetName];
	const matches = domains.filter(
		(domain) =>
			domain.hostname === policy.hostname &&
			domain.service === policy.workerName &&
			domain.zone_name === "relayapi.dev",
	);
	if (matches.length !== 1 || domains.length !== 1) {
		throw new Error(
			`${policy.hostname} is not mapped exactly once to ${policy.workerName}`,
		);
	}
}

function activeVersionId(value: DeploymentList): string {
	const versions = value.deployments?.[0]?.versions;
	if (
		versions?.length !== 1 ||
		versions[0]?.percentage !== 100 ||
		!versions[0].version_id
	) {
		throw new Error("Expected one active Worker version at 100% traffic");
	}
	return versions[0].version_id;
}

export async function verifyCloudflareWorkerDeployment(
	targetName: TargetName,
): Promise<void> {
	const policy = targets[targetName];
	const token = process.env.CLOUDFLARE_API_TOKEN;
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
	if (!token || accountId !== ACCOUNT_ID || /\s/.test(token)) {
		throw new Error("Expected production Cloudflare credentials are required");
	}
	const get = async <T>(path: string): Promise<T> => {
		let response: Response;
		try {
			response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
				headers: { Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(15_000),
			});
		} catch {
			throw new Error(`${targetName} Worker verification request failed`);
		}
		if (!response.ok) {
			throw new Error(
				`${targetName} Worker verification failed (${response.status})`,
			);
		}
		const envelope = (await response.json()) as ApiEnvelope<T>;
		if (!envelope.success || envelope.result === undefined) {
			throw new Error(`${targetName} Worker verification returned an error`);
		}
		return envelope.result;
	};
	const base = `/accounts/${ACCOUNT_ID}/workers/scripts/${policy.workerName}`;
	const deployments = await get<DeploymentList>(`${base}/deployments`);
	const versionId = activeVersionId(deployments);
	const expectedVersionId = process.env.EXPECTED_WORKER_VERSION_ID;
	if (!expectedVersionId || expectedVersionId !== versionId) {
		throw new Error(
			`${targetName} active version is not the reviewed release version`,
		);
	}
	const [version, settings, domains] = await Promise.all([
		get<VersionDetail>(`${base}/versions/${versionId}`),
		get<Record<string, unknown>>(`${base}/settings`),
		get<WorkerDomain[]>(
			`/accounts/${ACCOUNT_ID}/workers/domains?hostname=${encodeURIComponent(policy.hostname)}`,
		),
	]);
	assertWorkerDeployment(targetName, version, settings);
	assertWorkerDomain(targetName, domains);
	console.log(`${targetName} deployed Worker identity passed.`);
}

if (import.meta.main) {
	const targetName = process.argv[2];
	if (targetName !== "app" && targetName !== "docs") {
		throw new Error("Usage: verify-cloudflare-worker-deployment.ts app|docs");
	}
	await verifyCloudflareWorkerDeployment(targetName);
}
