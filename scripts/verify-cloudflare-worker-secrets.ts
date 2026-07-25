import resources from "../apps/api/production-resources.json";
import {
	evaluateCompleteSecretGroups,
	type SecretFileSpec,
	secretGroups,
	unexpectedCloudflareSecretNames,
} from "./secrets";

type CloudflareTarget = "api" | "app";

type SecretBinding = {
	name?: string;
	type?: string;
};

type ApiEnvelope<T> = {
	success?: boolean;
	result?: T;
};

const workerNames: Record<CloudflareTarget, string> = {
	api: resources.workerName,
	app: "relayapi-app",
};

function targetSpec(target: CloudflareTarget): SecretFileSpec {
	const spec = secretGroups.production.files.find(
		(candidate) => candidate.cloudflareTarget === target,
	);
	if (!spec) throw new Error(`No production secret manifest for ${target}`);
	return spec;
}

export function assertWorkerSecretBindings(
	spec: SecretFileSpec,
	bindings: SecretBinding[],
	expectedNames?: readonly string[],
	allowMissingExpected = false,
): void {
	const invalidTypes = bindings
		.filter((binding) => binding.type !== "secret_text")
		.map(
			(binding) =>
				`${binding.name ?? "<unnamed>"}:${binding.type ?? "<missing>"}`,
		)
		.sort();
	const names = new Set(
		bindings
			.filter((binding) => binding.type === "secret_text")
			.map((binding) => binding.name)
			.filter((name): name is string => typeof name === "string"),
	);
	const failures: string[] = [];
	if (invalidTypes.length > 0) {
		failures.push(
			`unsupported Worker secret binding types: ${invalidTypes.join(", ")}`,
		);
	}
	const missing = spec.required.filter((name) => !names.has(name));
	if (missing.length > 0 && !allowMissingExpected) {
		failures.push(`missing required bindings: ${missing.join(", ")}`);
	}
	if (!allowMissingExpected) {
		const { states, orphanedKeys } = evaluateCompleteSecretGroups(
			spec.completeGroups,
			names,
		);
		for (const { group, present, triggered } of states) {
			if (triggered && present.length !== group.length) {
				failures.push(
					`partially configured group missing: ${group
						.filter((name) => !names.has(name))
						.join(", ")}`,
				);
			}
		}
		if (orphanedKeys.length > 0) {
			failures.push(
				`grouped bindings without a complete provider group: ${orphanedKeys.join(", ")}`,
			);
		}
	}
	const unexpected = unexpectedCloudflareSecretNames(spec, bindings);
	if (unexpected.length > 0) {
		failures.push(
			`bindings outside target allowlist: ${unexpected.join(", ")}`,
		);
	}
	if (expectedNames) {
		const actual = [...names].sort();
		const expected = [...new Set(expectedNames)].sort();
		const unexpectedIntent = actual.filter((name) => !expected.includes(name));
		const missingIntent = expected.filter((name) => !actual.includes(name));
		if (
			unexpectedIntent.length > 0 ||
			(!allowMissingExpected && missingIntent.length > 0)
		) {
			failures.push(
				`live bindings do not ${allowMissingExpected ? "form a safe subset of" : "exactly match"} encrypted vault intent (expected: ${expected.join(", ")}; actual: ${actual.join(", ")})`,
			);
		}
	}
	if (failures.length > 0) {
		throw new Error(`Worker secret policy failed: ${failures.join("; ")}`);
	}
}

function credentials(): { token: string; accountId: string } {
	const token = process.env.CLOUDFLARE_API_TOKEN;
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
	if (!token || !accountId) {
		throw new Error(
			"CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required",
		);
	}
	if (/\s/.test(token) || accountId !== resources.accountId) {
		throw new Error("Refusing unexpected Cloudflare credentials");
	}
	return { token, accountId };
}

export async function verifyWorkerSecrets(
	target: CloudflareTarget,
	expectedNames?: readonly string[],
	allowMissingExpected = false,
): Promise<void> {
	const spec = targetSpec(target);
	const { token, accountId } = credentials();
	let response: Response;
	try {
		response = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerNames[target]}/secrets`,
			{
				headers: { Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(15_000),
			},
		);
	} catch {
		throw new Error(
			"Cloudflare Worker secret verification could not be completed",
		);
	}
	if (!response.ok) {
		throw new Error(
			`Cloudflare Worker secret verification failed (${response.status})`,
		);
	}
	const envelope = (await response.json()) as ApiEnvelope<SecretBinding[]>;
	if (!envelope.success || !Array.isArray(envelope.result)) {
		throw new Error("Cloudflare Worker secret verification returned an error");
	}
	assertWorkerSecretBindings(
		spec,
		envelope.result,
		expectedNames,
		allowMissingExpected,
	);
	console.log(`Verified required production secret bindings for ${target}.`);
}

if (import.meta.main) {
	const target = process.argv[2];
	if (target !== "api" && target !== "app") {
		throw new Error("Usage: verify-cloudflare-worker-secrets.ts api|app");
	}
	await verifyWorkerSecrets(target);
}
