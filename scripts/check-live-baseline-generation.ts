import { appendFile } from "node:fs/promises";
import { BASELINE_GENERATION } from "@relayapi/config";
import baselineBuildPolicy from "../packages/db/baseline-build-policy.json";
import generationMetadata from "../packages/db/baseline-generation.json";

type ApiEnvelope<T> = {
	success?: boolean;
	result?: T;
};

type DeploymentList = {
	deployments?: Array<{
		versions?: Array<{ version_id?: string; percentage?: number }>;
	}>;
};

type VersionDetail = {
	annotations?: {
		"workers/tag"?: string;
		"workers/message"?: string;
	};
	resources?: {
		bindings?: Array<{
			name?: string;
			type?: string;
			text?: string;
		}>;
	};
};

export type WorkerTarget = "api" | "app";
export type WorkerHoldReason =
	| "worker_absent"
	| "no_active_deployment"
	| "split_deployment"
	| "active_version_absent"
	| "unversioned"
	| "malformed_generation";

export type LiveWorkerInspection =
	| {
			status: "ready";
			target: WorkerTarget;
			workerName: string;
			versionId: string;
			generation: number;
			tag: string | null;
			message: string | null;
	  }
	| {
			status: "hold";
			target: WorkerTarget;
			workerName: string;
			reason: WorkerHoldReason;
			detail: string;
	  };

export type CutoverStampAttestation = {
	ok: boolean;
	workers: Record<WorkerTarget, LiveWorkerInspection>;
	holds: Array<{ target: WorkerTarget; reason: string }>;
};

export type WorkerGenerationAttestation = {
	ok: boolean;
	generation: number;
	workers: Record<WorkerTarget, LiveWorkerInspection>;
	holds: Array<{ target: WorkerTarget; reason: string }>;
};

export type BaselineGenerationDecision = {
	allowed: boolean;
	applicationGeneration: number;
	repositoryGeneration: number;
	liveGeneration: number | null;
	reason: "match" | "initial-bootstrap" | "generation-mismatch";
};

export const BASELINE_WORKERS = {
	api: "relayapi",
	app: "relayapi-app",
} as const satisfies Record<WorkerTarget, string>;

class CloudflareHttpError extends Error {
	constructor(readonly status: number) {
		super(`Baseline generation guard received Cloudflare HTTP ${status}`);
	}
}

export function resolveApplicationBaselineGeneration(input: {
	applicationGeneration: number;
	repositoryGeneration: number;
	repositoryLifecycle: string;
	policyLifecycle: string;
	authorizedFromGeneration: number;
	authorizedToGeneration: number;
}): number {
	if (
		!Number.isSafeInteger(input.applicationGeneration) ||
		input.applicationGeneration < 1
	) {
		throw new Error(
			"Application baseline generation must be a positive integer",
		);
	}
	if (input.applicationGeneration === input.repositoryGeneration) {
		return input.applicationGeneration;
	}
	const isPreparedAuthorizedCutover =
		input.repositoryLifecycle === "sealed" &&
		input.policyLifecycle === "sealed" &&
		input.repositoryGeneration === input.authorizedFromGeneration &&
		input.applicationGeneration === input.authorizedToGeneration &&
		input.authorizedToGeneration === input.authorizedFromGeneration + 1;
	if (!isPreparedAuthorizedCutover) {
		throw new Error(
			"Application baseline generation is not the repository generation or its authorized immediate cutover target",
		);
	}
	return input.applicationGeneration;
}

function activeVersionId(value: DeploymentList): {
	versionId?: string;
	reason?: WorkerHoldReason;
} {
	const versions = value.deployments?.[0]?.versions;
	if (!versions || versions.length === 0) {
		return { reason: "no_active_deployment" };
	}
	if (versions.length !== 1 || versions[0]?.percentage !== 100) {
		return { reason: "split_deployment" };
	}
	if (!versions[0].version_id) return { reason: "active_version_absent" };
	return { versionId: versions[0].version_id };
}

export function decideBaselineGeneration(input: {
	applicationGeneration: number;
	repositoryGeneration: number;
	liveGeneration: number | null;
	allowInitialBootstrap: boolean;
}): BaselineGenerationDecision {
	if (
		!Number.isSafeInteger(input.applicationGeneration) ||
		input.applicationGeneration < 1
	) {
		throw new Error(
			"Application baseline generation must be a positive integer",
		);
	}
	if (
		!Number.isSafeInteger(input.repositoryGeneration) ||
		input.repositoryGeneration < 1
	) {
		throw new Error(
			"Repository baseline generation must be a positive integer",
		);
	}
	if (
		input.liveGeneration !== null &&
		(!Number.isSafeInteger(input.liveGeneration) || input.liveGeneration < 1)
	) {
		throw new Error("Live baseline generation must be a positive integer");
	}
	if (input.applicationGeneration !== input.repositoryGeneration) {
		return {
			allowed: false,
			applicationGeneration: input.applicationGeneration,
			repositoryGeneration: input.repositoryGeneration,
			liveGeneration: input.liveGeneration,
			reason: "generation-mismatch",
		};
	}
	if (input.liveGeneration === input.repositoryGeneration) {
		return {
			allowed: true,
			applicationGeneration: input.applicationGeneration,
			repositoryGeneration: input.repositoryGeneration,
			liveGeneration: input.liveGeneration,
			reason: "match",
		};
	}
	if (
		input.allowInitialBootstrap &&
		input.repositoryGeneration === 1 &&
		input.liveGeneration === null
	) {
		return {
			allowed: true,
			applicationGeneration: input.applicationGeneration,
			repositoryGeneration: 1,
			liveGeneration: null,
			reason: "initial-bootstrap",
		};
	}
	return {
		allowed: false,
		applicationGeneration: input.applicationGeneration,
		repositoryGeneration: input.repositoryGeneration,
		liveGeneration: input.liveGeneration,
		reason: "generation-mismatch",
	};
}

export function formatDecisionWarning(
	decision: BaselineGenerationDecision,
): string | null {
	if (decision.allowed || decision.reason !== "generation-mismatch") {
		return null;
	}
	return [
		"::warning title=Baseline generation deploy held::",
		`Automatic deploy held: application target generation ${decision.applicationGeneration}, `,
		`repository generation ${decision.repositoryGeneration}, and live API generation `,
		`${decision.liveGeneration ?? "unversioned"} are not mutually compatible. `,
		"Use the protected pre-live baseline cutover workflow to advance generations.",
	].join("");
}

async function getCloudflare<T>(path: string, token: string): Promise<T> {
	let response: Response;
	try {
		response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(15_000),
		});
	} catch {
		throw new Error("Baseline generation guard could not reach Cloudflare");
	}
	if (!response.ok) {
		throw new CloudflareHttpError(response.status);
	}
	const envelope = (await response.json()) as ApiEnvelope<T>;
	if (!envelope.success || envelope.result === undefined) {
		throw new Error(
			"Baseline generation guard received a Cloudflare API error",
		);
	}
	return envelope.result;
}

export async function inspectLiveWorker(
	accountId: string,
	token: string,
	target: WorkerTarget,
): Promise<LiveWorkerInspection> {
	const workerName = BASELINE_WORKERS[target];
	const encodedAccount = encodeURIComponent(accountId);
	const encodedWorker = encodeURIComponent(workerName);
	const base = `/accounts/${encodedAccount}/workers/scripts/${encodedWorker}`;
	let deployments: DeploymentList;
	try {
		deployments = await getCloudflare<DeploymentList>(
			`${base}/deployments`,
			token,
		);
	} catch (error) {
		if (error instanceof CloudflareHttpError && error.status === 404) {
			return {
				status: "hold",
				target,
				workerName,
				reason: "worker_absent",
				detail: `Worker ${workerName} does not exist`,
			};
		}
		throw error;
	}
	const active = activeVersionId(deployments);
	if (!active.versionId) {
		const reason = active.reason ?? "active_version_absent";
		return {
			status: "hold",
			target,
			workerName,
			reason,
			detail: `Worker ${workerName} has no single active version at 100% traffic`,
		};
	}
	let version: VersionDetail;
	try {
		version = await getCloudflare<VersionDetail>(
			`${base}/versions/${encodeURIComponent(active.versionId)}`,
			token,
		);
	} catch (error) {
		if (error instanceof CloudflareHttpError && error.status === 404) {
			return {
				status: "hold",
				target,
				workerName,
				reason: "active_version_absent",
				detail: `Worker ${workerName} active version ${active.versionId} is absent`,
			};
		}
		throw error;
	}
	const matches = (version.resources?.bindings ?? []).filter(
		(binding) =>
			binding.name === "BASELINE_GENERATION" && binding.type === "plain_text",
	);
	if (matches.length === 0) {
		return {
			status: "hold",
			target,
			workerName,
			reason: "unversioned",
			detail: `Worker ${workerName} has no BASELINE_GENERATION binding`,
		};
	}
	if (matches.length !== 1 || !/^[1-9]\d*$/.test(matches[0]?.text ?? "")) {
		return {
			status: "hold",
			target,
			workerName,
			reason: "malformed_generation",
			detail: `Worker ${workerName} has a malformed BASELINE_GENERATION binding`,
		};
	}
	return {
		status: "ready",
		target,
		workerName,
		versionId: active.versionId,
		generation: Number(matches[0]?.text),
		tag: version.annotations?.["workers/tag"] ?? null,
		message: version.annotations?.["workers/message"] ?? null,
	};
}

export async function attestCutoverStamp(input: {
	accountId: string;
	token: string;
	sourceCommitSha: string;
	apiVersionId: string;
	appVersionId: string;
}): Promise<CutoverStampAttestation> {
	if (!/^[0-9a-f]{40}$/i.test(input.sourceCommitSha)) {
		throw new Error("Generation-1 stamp source commit must be a full Git SHA");
	}
	for (const [label, value] of [
		["API", input.apiVersionId],
		["App", input.appVersionId],
	] as const) {
		if (!value.trim() || /\s/.test(value)) {
			throw new Error(`${label} generation-1 stamp version ID is required`);
		}
	}
	const [api, app] = await Promise.all([
		inspectLiveWorker(input.accountId, input.token, "api"),
		inspectLiveWorker(input.accountId, input.token, "app"),
	]);
	const workers = { api, app };
	const expectedVersionIds = {
		api: input.apiVersionId,
		app: input.appVersionId,
	};
	const expectedTag = `baseline-1-stamp-${input.sourceCommitSha.toLowerCase()}`;
	const expectedMessage = `Generation 1 stamp ${input.sourceCommitSha.toLowerCase()}`;
	const holds: CutoverStampAttestation["holds"] = [];
	for (const target of ["api", "app"] as const) {
		const worker = workers[target];
		if (worker.status === "hold") {
			holds.push({ target, reason: worker.reason });
			continue;
		}
		if (worker.generation !== 1) {
			holds.push({ target, reason: `generation_${worker.generation}` });
		}
		if (worker.versionId !== expectedVersionIds[target]) {
			holds.push({ target, reason: "version_id_mismatch" });
		}
		if (worker.tag !== expectedTag) {
			holds.push({ target, reason: "source_sha_tag_mismatch" });
		}
		if (worker.message !== expectedMessage) {
			holds.push({ target, reason: "source_sha_message_mismatch" });
		}
	}
	return { ok: holds.length === 0, workers, holds };
}

export async function attestWorkerGeneration(input: {
	accountId: string;
	token: string;
	generation: number;
}): Promise<WorkerGenerationAttestation> {
	if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
		throw new Error("Expected live Worker generation must be positive");
	}
	const [api, app] = await Promise.all([
		inspectLiveWorker(input.accountId, input.token, "api"),
		inspectLiveWorker(input.accountId, input.token, "app"),
	]);
	const workers = { api, app };
	const holds: WorkerGenerationAttestation["holds"] = [];
	for (const target of ["api", "app"] as const) {
		const worker = workers[target];
		if (worker.status === "hold") {
			holds.push({ target, reason: worker.reason });
		} else if (worker.generation !== input.generation) {
			holds.push({ target, reason: `generation_${worker.generation}` });
		}
	}
	return {
		ok: holds.length === 0,
		generation: input.generation,
		workers,
		holds,
	};
}

export async function readLiveBaselineGeneration(
	accountId: string,
	token: string,
): Promise<number | null> {
	const inspection = await inspectLiveWorker(accountId, token, "api");
	if (inspection.status === "ready") return inspection.generation;
	if (
		inspection.reason === "worker_absent" ||
		inspection.reason === "unversioned"
	) {
		return null;
	}
	throw new Error(
		`Live API Worker held (${inspection.reason}): ${inspection.detail}`,
	);
}

export async function writeDecision(
	decision: BaselineGenerationDecision,
): Promise<void> {
	const output = process.env.GITHUB_OUTPUT;
	if (output) {
		await appendFile(
			output,
			[
				`automatic_deploy_allowed=${decision.allowed}`,
				`application_generation=${decision.applicationGeneration}`,
				`repository_generation=${decision.repositoryGeneration}`,
				`live_generation=${decision.liveGeneration ?? "unversioned"}`,
				`reason=${decision.reason}`,
				"",
			].join("\n"),
		);
	}
	const warning = formatDecisionWarning(decision);
	if (warning) console.warn(warning);
	console.log(JSON.stringify(decision));
}

if (import.meta.main) {
	if (
		generationMetadata.lifecycle !== "sealed" ||
		!Number.isSafeInteger(generationMetadata.generation)
	) {
		throw new Error("Repository baseline generation metadata must be sealed");
	}
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
	const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
	if (!accountId || !token || /\s/.test(accountId) || /\s/.test(token)) {
		throw new Error("Cloudflare credentials are required for the deploy guard");
	}
	if (process.argv.includes("--require-live-generation-one")) {
		const attestation = await attestWorkerGeneration({
			accountId,
			token,
			generation: 1,
		});
		console.log(JSON.stringify(attestation));
		if (!attestation.ok) {
			throw new Error(
				`Live generation-1 Worker prerequisite held: ${attestation.holds
					.map(({ target, reason }) => `${target}:${reason}`)
					.join(", ")}`,
			);
		}
		process.exit(0);
	}
	if (process.argv.includes("--attest-cutover-stamp")) {
		const sourceCommitSha =
			process.env.EXPECTED_GENERATION_1_STAMP_COMMIT_SHA?.trim() ?? "";
		const apiVersionId =
			process.env.EXPECTED_GENERATION_1_API_VERSION_ID?.trim() ?? "";
		const appVersionId =
			process.env.EXPECTED_GENERATION_1_APP_VERSION_ID?.trim() ?? "";
		const attestation = await attestCutoverStamp({
			accountId,
			token,
			sourceCommitSha,
			apiVersionId,
			appVersionId,
		});
		const output = process.env.GITHUB_OUTPUT;
		if (output) {
			const lines = [
				`stamp_attested=${attestation.ok}`,
				...(["api", "app"] as const).flatMap((target) => {
					const worker = attestation.workers[target];
					return worker.status === "ready"
						? [
								`${target}_worker_status=ready`,
								`${target}_worker_version_id=${worker.versionId}`,
								`${target}_worker_generation=${worker.generation}`,
							]
						: [
								`${target}_worker_status=hold`,
								`${target}_worker_hold_reason=${worker.reason}`,
							];
				}),
				"",
			];
			await appendFile(output, lines.join("\n"));
		}
		console.log(JSON.stringify(attestation));
		if (!attestation.ok) {
			throw new Error(
				`Generation-1 cutover stamp attestation held: ${attestation.holds
					.map(({ target, reason }) => `${target}:${reason}`)
					.join(", ")}`,
			);
		}
		process.exit(0);
	}
	const liveGeneration = await readLiveBaselineGeneration(accountId, token);
	const applicationGeneration = resolveApplicationBaselineGeneration({
		applicationGeneration: BASELINE_GENERATION,
		repositoryGeneration: generationMetadata.generation,
		repositoryLifecycle: generationMetadata.lifecycle,
		policyLifecycle: baselineBuildPolicy.lifecycle,
		authorizedFromGeneration:
			baselineBuildPolicy.authorizedCollapse.fromGeneration,
		authorizedToGeneration: baselineBuildPolicy.authorizedCollapse.toGeneration,
	});
	await writeDecision(
		decideBaselineGeneration({
			applicationGeneration,
			repositoryGeneration: generationMetadata.generation,
			liveGeneration,
			allowInitialBootstrap: process.argv.includes(
				"--allow-initial-generation-bootstrap",
			),
		}),
	);
}
