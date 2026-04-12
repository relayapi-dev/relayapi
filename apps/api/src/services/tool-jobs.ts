/**
 * KV-backed job state management for async tool jobs.
 * Jobs have a 1-hour TTL (download URLs are ephemeral anyway).
 */

export interface ToolJob {
	job_id: string;
	org_id: string;
	status: "processing" | "completed" | "failed";
	type: "download" | "transcript";
	created_at: string;
	completed_at?: string;
	result?: Record<string, unknown>;
	error?: string;
	error_code?: string;
}

const JOB_TTL = 3600; // 1 hour

function jobKey(jobId: string): string {
	return `tool-job:${jobId}`;
}

export async function createToolJob(
	kv: KVNamespace,
	jobId: string,
	orgId: string,
	type: "download" | "transcript",
): Promise<void> {
	const job: ToolJob = {
		job_id: jobId,
		org_id: orgId,
		status: "processing",
		type,
		created_at: new Date().toISOString(),
	};
	await kv.put(jobKey(jobId), JSON.stringify(job), {
		expirationTtl: JOB_TTL,
	});
}

export async function completeToolJob(
	kv: KVNamespace,
	jobId: string,
	result: Record<string, unknown>,
): Promise<void> {
	const existing = await getToolJob(kv, jobId);
	if (!existing) return;

	const updated: ToolJob = {
		...existing,
		status: "completed",
		completed_at: new Date().toISOString(),
		result,
	};
	await kv.put(jobKey(jobId), JSON.stringify(updated), {
		expirationTtl: JOB_TTL,
	});
}

export async function failToolJob(
	kv: KVNamespace,
	jobId: string,
	error: string,
	errorCode?: string,
): Promise<void> {
	const existing = await getToolJob(kv, jobId);
	if (!existing) return;

	const updated: ToolJob = {
		...existing,
		status: "failed",
		completed_at: new Date().toISOString(),
		error,
		error_code: errorCode ?? "EXTRACTION_FAILED",
	};
	await kv.put(jobKey(jobId), JSON.stringify(updated), {
		expirationTtl: JOB_TTL,
	});
}

export async function getToolJob(
	kv: KVNamespace,
	jobId: string,
): Promise<ToolJob | null> {
	return kv.get<ToolJob>(jobKey(jobId), "json");
}
