#!/usr/bin/env bun

import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const LOCKFILE = join(ROOT, "bun.lock");
const POLICY_FILE = join(import.meta.dir, "dependency-audit-exceptions.json");
const MAX_EXCEPTION_DAYS = 30;

type DependencyClass = "runtime" | "development";
type DependencyBlock = Record<string, string>;

interface PackageJson {
	name?: string;
	dependencies?: DependencyBlock;
	devDependencies?: DependencyBlock;
	optionalDependencies?: DependencyBlock;
	peerDependencies?: DependencyBlock;
}

interface LockMetadata {
	dependencies?: DependencyBlock;
	optionalDependencies?: DependencyBlock;
	peerDependencies?: DependencyBlock;
}

interface LockInstance {
	key: string;
	name: string;
	version: string;
	metadata: LockMetadata;
	workspacePath?: string;
}

interface AuditAdvisory {
	id: number;
	url: string;
	title: string;
	severity: string;
	vulnerable_versions: string;
}

export interface AuditFinding {
	advisory: string;
	package: string;
	version: string;
	dependencyPath: string;
	artifact: string;
	dependencyClass: DependencyClass;
	severity: string;
	title: string;
	url: string;
}

export interface AuditException {
	advisory: string;
	package: string;
	version: string;
	dependencyPath: string;
	artifact: string;
	dependencyClass: DependencyClass;
	expiresOn: string;
	reason: string;
}

export interface AuditPolicy {
	schemaVersion: 1;
	reviewedOn: string;
	documentation: string;
	exceptions: AuditException[];
}

export interface AuditEvaluation {
	unmatched: AuditFinding[];
	expired: Array<{ finding: AuditFinding; exception: AuditException }>;
	stale: AuditException[];
	policyErrors: string[];
	allowed: AuditFinding[];
}

const MAX_LOCKFILE_PACKAGE_LINE_LENGTH = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function advisoryId(url: string): string {
	const id = url.split("/").at(-1);
	if (!id || !/^(GHSA|CVE)-[A-Za-z0-9-]+$/.test(id)) {
		throw new Error(`Unsupported advisory URL: ${url}`);
	}
	return id;
}

function findingKey(
	finding: Pick<
		AuditFinding,
		| "advisory"
		| "package"
		| "version"
		| "dependencyPath"
		| "artifact"
		| "dependencyClass"
	>,
): string {
	return [
		finding.advisory,
		finding.package,
		finding.version,
		finding.dependencyPath,
		finding.artifact,
		finding.dependencyClass,
	].join("\u0000");
}

function parseDate(value: string): number | undefined {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
	const time = Date.parse(`${value}T00:00:00.000Z`);
	if (!Number.isFinite(time)) return undefined;
	return new Date(time).toISOString().slice(0, 10) === value ? time : undefined;
}

function utcDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}

export function evaluateAudit(
	findings: AuditFinding[],
	policy: AuditPolicy,
	now = new Date(),
): AuditEvaluation {
	const policyErrors: string[] = [];
	const reviewedOn = parseDate(policy.reviewedOn);
	const today = parseDate(utcDate(now));

	if (policy.schemaVersion !== 1) {
		policyErrors.push(
			`Unsupported policy schemaVersion: ${policy.schemaVersion}`,
		);
	}
	if (reviewedOn === undefined) {
		policyErrors.push(`Invalid reviewedOn date: ${policy.reviewedOn}`);
	} else if (today !== undefined && reviewedOn > today) {
		policyErrors.push(
			`reviewedOn cannot be in the future: ${policy.reviewedOn}`,
		);
	}
	if (!policy.documentation?.trim()) {
		policyErrors.push(
			"Policy documentation must explain the exception contract.",
		);
	}

	const exceptions = new Map<string, AuditException>();
	for (const [index, exception] of policy.exceptions.entries()) {
		const label = `exceptions[${index}]`;
		const required = [
			"advisory",
			"package",
			"version",
			"dependencyPath",
			"artifact",
			"expiresOn",
			"reason",
		] as const;
		for (const field of required) {
			if (!exception[field]?.trim())
				policyErrors.push(`${label}.${field} is required.`);
		}
		if (!["runtime", "development"].includes(exception.dependencyClass)) {
			policyErrors.push(
				`${label}.dependencyClass must be runtime or development.`,
			);
		}

		const expiresOn = parseDate(exception.expiresOn);
		if (expiresOn === undefined) {
			policyErrors.push(`${label}.expiresOn is not a valid YYYY-MM-DD date.`);
		} else if (reviewedOn !== undefined) {
			const durationDays = (expiresOn - reviewedOn) / 86_400_000;
			if (durationDays < 0) {
				policyErrors.push(`${label}.expiresOn precedes reviewedOn.`);
			} else if (durationDays > MAX_EXCEPTION_DAYS) {
				policyErrors.push(
					`${label} lasts ${durationDays} days; the maximum is ${MAX_EXCEPTION_DAYS}.`,
				);
			}
		}

		const key = findingKey(exception);
		if (exceptions.has(key))
			policyErrors.push(`${label} duplicates an earlier exception.`);
		exceptions.set(key, exception);
	}

	const current = new Map(
		findings.map((finding) => [findingKey(finding), finding]),
	);
	const unmatched: AuditFinding[] = [];
	const expired: Array<{ finding: AuditFinding; exception: AuditException }> =
		[];
	const allowed: AuditFinding[] = [];

	for (const [key, finding] of current) {
		const exception = exceptions.get(key);
		if (!exception) {
			unmatched.push(finding);
			continue;
		}
		const expiresOn = parseDate(exception.expiresOn);
		// An exception is valid through its expiresOn date in UTC.
		if (expiresOn === undefined || (today !== undefined && today > expiresOn)) {
			expired.push({ finding, exception });
		} else {
			allowed.push(finding);
		}
	}

	const stale = [...exceptions.entries()]
		.filter(([key]) => !current.has(key))
		.map(([, exception]) => exception);

	return { unmatched, expired, stale, policyErrors, allowed };
}

interface LockfilePackageLine {
	key: string;
	value: string;
}

function isInlineJsonWhitespace(value: string | undefined): boolean {
	return value === " " || value === "\t" || value === "\r";
}

/** Parse one single-line Bun package entry in bounded linear time. */
function parseLockfilePackageLine(
	line: string,
	lineNumber: number,
): LockfilePackageLine | undefined {
	if (!line.startsWith('    "')) return undefined;
	if (line.length > MAX_LOCKFILE_PACKAGE_LINE_LENGTH) {
		throw new Error(
			`bun.lock package entry at line ${lineNumber} exceeds ${MAX_LOCKFILE_PACKAGE_LINE_LENGTH} characters.`,
		);
	}

	let keyEnd = -1;
	for (let index = 5; index < line.length; index += 1) {
		if (line[index] === "\\") {
			index += 1;
			continue;
		}
		if (line[index] === '"') {
			keyEnd = index;
			break;
		}
	}
	if (keyEnd < 0 || line[keyEnd + 1] !== ":") {
		throw new Error(`Cannot parse bun.lock entry at line ${lineNumber}.`);
	}

	let valueStart = keyEnd + 2;
	while (isInlineJsonWhitespace(line[valueStart])) valueStart += 1;
	if (line[valueStart] !== "[") return undefined;

	let valueEnd = line.length;
	while (isInlineJsonWhitespace(line[valueEnd - 1])) valueEnd -= 1;
	if (line[valueEnd - 1] === ",") {
		valueEnd -= 1;
		while (isInlineJsonWhitespace(line[valueEnd - 1])) valueEnd -= 1;
	}
	if (line[valueEnd - 1] !== "]") {
		throw new Error(
			`Cannot parse bun.lock package entry at line ${lineNumber}.`,
		);
	}

	return {
		key: line.slice(4, keyEnd + 1),
		value: line.slice(valueStart, valueEnd),
	};
}

export function parseLockfile(text: string): Map<string, LockInstance> {
	const instances = new Map<string, LockInstance>();
	for (const [index, line] of text.split("\n").entries()) {
		const entry = parseLockfilePackageLine(line, index + 1);
		if (!entry) continue;

		let key: unknown;
		let rawValue: unknown;
		try {
			key = JSON.parse(entry.key);
			rawValue = JSON.parse(entry.value);
		} catch (error) {
			throw new Error(
				`Cannot parse bun.lock package entry at line ${index + 1}.`,
				{ cause: error },
			);
		}
		if (
			typeof key !== "string" ||
			!key ||
			!Array.isArray(rawValue) ||
			typeof rawValue[0] !== "string"
		)
			continue;

		const resolution = rawValue[0];
		const separator = resolution.lastIndexOf("@");
		if (separator <= 0)
			throw new Error(`Invalid bun.lock resolution: ${resolution}`);
		const name = resolution.slice(0, separator);
		const version = resolution.slice(separator + 1);
		const metadata = isRecord(rawValue[2]) ? (rawValue[2] as LockMetadata) : {};
		const workspacePath = version.startsWith("workspace:")
			? version.slice("workspace:".length)
			: undefined;

		instances.set(key, { key, name, version, metadata, workspacePath });
	}
	if (instances.size === 0)
		throw new Error("No package entries found in bun.lock.");
	return instances;
}

function parentInstanceKey(
	instances: Map<string, LockInstance>,
	instance: LockInstance,
): string | undefined {
	let slash = instance.key.lastIndexOf("/");
	while (slash > 0) {
		const candidate = instance.key.slice(0, slash);
		if (instances.has(candidate)) return candidate;
		slash = instance.key.lastIndexOf("/", slash - 1);
	}
	return undefined;
}

function resolveDependency(
	instances: Map<string, LockInstance>,
	fromKey: string | undefined,
	dependency: string,
): LockInstance | undefined {
	let cursor = fromKey;
	while (cursor) {
		const nested = instances.get(`${cursor}/${dependency}`);
		if (nested) return nested;
		const current = instances.get(cursor);
		if (!current) break;
		cursor = parentInstanceKey(instances, current);
	}
	return instances.get(dependency);
}

function allPackageDependencies(
	metadata: LockMetadata,
): Array<{ name: string; required: boolean }> {
	return [
		...Object.keys(metadata.dependencies ?? {}).map((name) => ({
			name,
			required: true,
		})),
		...Object.keys(metadata.optionalDependencies ?? {}).map((name) => ({
			name,
			required: false,
		})),
		...Object.keys(metadata.peerDependencies ?? {}).map((name) => ({
			name,
			required: false,
		})),
	];
}

function compareFindings(a: AuditFinding, b: AuditFinding): number {
	return (
		a.advisory.localeCompare(b.advisory) ||
		a.package.localeCompare(b.package) ||
		a.version.localeCompare(b.version) ||
		a.dependencyPath.localeCompare(b.dependencyPath) ||
		a.artifact.localeCompare(b.artifact) ||
		a.dependencyClass.localeCompare(b.dependencyClass)
	);
}

export async function collectFindings(
	audit: Record<string, AuditAdvisory[]>,
	lockfileText: string,
	root = ROOT,
): Promise<AuditFinding[]> {
	const instances = parseLockfile(lockfileText);
	const advisoriesByPackage = new Map(Object.entries(audit));
	const findings = new Map<string, AuditFinding>();
	const attributedInstances = new Set<string>();
	const workspaceManifests = new Map<string, PackageJson>();

	for (const instance of instances.values()) {
		if (!instance.workspacePath) continue;
		workspaceManifests.set(
			instance.key,
			(await Bun.file(
				join(root, instance.workspacePath, "package.json"),
			).json()) as PackageJson,
		);
	}

	const roots: Array<{
		artifact: string;
		manifest: PackageJson;
		fromKey?: string;
	}> = [
		{
			artifact: "repository-tooling",
			manifest: (await Bun.file(
				join(root, "package.json"),
			).json()) as PackageJson,
		},
	];
	for (const [key, manifest] of workspaceManifests) {
		const instance = instances.get(key);
		if (!instance?.workspacePath) continue;
		roots.push({ artifact: instance.workspacePath, manifest, fromKey: key });
	}

	for (const { artifact, manifest, fromKey } of roots) {
		for (const dependencyClass of ["runtime", "development"] as const) {
			const rootDependencies =
				dependencyClass === "runtime"
					? [
							...Object.keys(manifest.dependencies ?? {}).map((name) => ({
								name,
								required: true,
							})),
							...Object.keys(manifest.optionalDependencies ?? {}).map(
								(name) => ({
									name,
									required: false,
								}),
							),
						]
					: Object.keys(manifest.devDependencies ?? {}).map((name) => ({
							name,
							required: true,
						}));
			const queue: LockInstance[] = [];
			for (const dependency of rootDependencies) {
				const instance = resolveDependency(instances, fromKey, dependency.name);
				if (instance) {
					queue.push(instance);
				} else if (dependency.required) {
					throw new Error(
						`Cannot resolve ${artifact}/${dependencyClass} dependency ${dependency.name} in bun.lock.`,
					);
				}
			}
			const visited = new Set<string>();

			while (queue.length > 0) {
				const instance = queue.pop();
				if (!instance || visited.has(instance.key)) continue;
				visited.add(instance.key);

				if (!instance.workspacePath) {
					attributedInstances.add(instance.key);
					const advisories = advisoriesByPackage.get(instance.name) ?? [];
					for (const advisory of advisories) {
						if (
							!Bun.semver.satisfies(
								instance.version,
								advisory.vulnerable_versions,
							)
						)
							continue;
						const finding: AuditFinding = {
							advisory: advisoryId(advisory.url),
							package: instance.name,
							version: instance.version,
							dependencyPath: instance.key,
							artifact,
							dependencyClass,
							severity: advisory.severity,
							title: advisory.title,
							url: advisory.url,
						};
						findings.set(findingKey(finding), finding);
					}
				}

				const metadata = instance.workspacePath
					? (workspaceManifests.get(instance.key) ?? {})
					: instance.metadata;
				for (const dependency of allPackageDependencies(metadata)) {
					const child = resolveDependency(
						instances,
						instance.key,
						dependency.name,
					);
					if (child) {
						queue.push(child);
					} else if (dependency.required) {
						throw new Error(
							`Cannot resolve ${instance.key} dependency ${dependency.name} in bun.lock.`,
						);
					}
				}
			}
		}
	}

	for (const [packageName, advisories] of advisoriesByPackage) {
		for (const advisory of advisories) {
			const matchingInstances = [...instances.values()].filter(
				(instance) =>
					instance.name === packageName &&
					!instance.workspacePath &&
					Bun.semver.satisfies(instance.version, advisory.vulnerable_versions),
			);
			if (matchingInstances.length === 0) {
				throw new Error(
					`Audit advisory ${advisoryId(advisory.url)} for ${packageName} did not match a bun.lock instance.`,
				);
			}
			for (const instance of matchingInstances) {
				if (!attributedInstances.has(instance.key)) {
					throw new Error(
						`Vulnerable lock instance ${instance.key}@${instance.version} could not be attributed to an artifact.`,
					);
				}
			}
		}
	}

	return [...findings.values()].sort(compareFindings);
}

function validateAuditJson(value: unknown): Record<string, AuditAdvisory[]> {
	if (!isRecord(value)) throw new Error("bun audit JSON must be an object.");
	const result: Record<string, AuditAdvisory[]> = {};
	for (const [packageName, rawAdvisories] of Object.entries(value)) {
		if (!Array.isArray(rawAdvisories)) {
			throw new Error(`bun audit entry for ${packageName} must be an array.`);
		}
		result[packageName] = rawAdvisories.map((raw, index) => {
			if (
				!isRecord(raw) ||
				typeof raw.id !== "number" ||
				typeof raw.url !== "string" ||
				typeof raw.title !== "string" ||
				typeof raw.severity !== "string" ||
				typeof raw.vulnerable_versions !== "string"
			) {
				throw new Error(
					`Invalid bun audit advisory at ${packageName}[${index}].`,
				);
			}
			return raw as unknown as AuditAdvisory;
		});
	}
	return result;
}

async function runBunAudit(): Promise<Record<string, AuditAdvisory[]>> {
	const process = Bun.spawn(["bun", "audit", "--json"], {
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch (error) {
		throw new Error(
			`bun audit did not return valid JSON (exit ${exitCode}): ${stderr.trim()}`,
			{
				cause: error,
			},
		);
	}
	if (exitCode !== 0 && exitCode !== 1) {
		throw new Error(`bun audit failed with exit ${exitCode}: ${stderr.trim()}`);
	}
	const audit = validateAuditJson(parsed);
	if (exitCode === 1 && Object.keys(audit).length === 0) {
		throw new Error(`bun audit exited 1 without findings: ${stderr.trim()}`);
	}
	return audit;
}

function formatFinding(finding: AuditFinding): string {
	return (
		`${finding.advisory} ${finding.package}@${finding.version} ` +
		`[${finding.artifact}/${finding.dependencyClass}] path=${finding.dependencyPath}`
	);
}

async function main(): Promise<void> {
	const audit = await runBunAudit();
	const findings = await collectFindings(
		audit,
		await Bun.file(LOCKFILE).text(),
	);
	if (process.argv.includes("--list-current")) {
		console.log(JSON.stringify(findings, null, 2));
		return;
	}

	const policy = (await Bun.file(POLICY_FILE).json()) as AuditPolicy;
	const evaluation = evaluateAudit(findings, policy);
	for (const error of evaluation.policyErrors)
		console.error(`POLICY: ${error}`);
	for (const finding of evaluation.unmatched)
		console.error(`NEW: ${formatFinding(finding)}`);
	for (const { finding, exception } of evaluation.expired) {
		console.error(`EXPIRED ${exception.expiresOn}: ${formatFinding(finding)}`);
	}
	for (const exception of evaluation.stale) {
		console.error(
			`STALE: ${formatFinding({ ...exception, severity: "", title: "", url: "" })}`,
		);
	}

	const failed =
		evaluation.policyErrors.length > 0 ||
		evaluation.unmatched.length > 0 ||
		evaluation.expired.length > 0 ||
		evaluation.stale.length > 0;
	if (failed) {
		console.error(
			`Dependency audit failed: ${evaluation.unmatched.length} new, ` +
				`${evaluation.expired.length} expired, ${evaluation.stale.length} stale, ` +
				`${evaluation.policyErrors.length} policy errors.`,
		);
		process.exit(1);
	}

	console.log(
		`Dependency audit passed: ${evaluation.allowed.length} exact finding scopes have ` +
			"current, time-bounded exceptions; no new advisories or artifact paths.",
	);
}

if (import.meta.main) {
	await main();
}
