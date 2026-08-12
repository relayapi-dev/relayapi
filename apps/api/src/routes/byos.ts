import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { withCredentialMutationAuthority } from "../lib/credential-mutation-authority";
import { encryptToken } from "../lib/crypto";
import { isBlockedUrlWithDns } from "../lib/ssrf-guard";
import { markMutationInputNotApplied } from "../middleware/mutation-validation";
import { requireAllWorkspaceScopeMiddleware } from "../middleware/permissions";
import { ByosConfigResponse, ByosConfigSpec } from "../schemas/byos";
import { ErrorResponse } from "../schemas/common";
import {
	activateProbedByosCredentialInTransaction,
	ByosActivationConflictError,
	ByosConfigurationNotFoundError,
	type ByosConfigurationView,
	ByosObjectsExistError,
	ByosProbeInProgressError,
	getCurrentByosConfiguration,
	probeStagedByosConfiguration,
	removeUnusedByosConfiguration,
	stageByosConfigurationInTransaction,
} from "../services/byos-configuration";
import {
	StorageConfigurationError,
	StorageProviderError,
} from "../services/storage-locator";
import type { Env, Variables } from "../types";

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
app.use("*", requireAllWorkspaceScopeMiddleware);

function serialize(view: ByosConfigurationView) {
	const { location, credential } = view;
	return {
		id: location.id,
		location_id: location.id,
		credential_id: credential.id,
		provider: "s3" as const,
		endpoint: location.endpoint,
		bucket: location.bucket,
		region: location.region,
		key_prefix: location.keyPrefix,
		force_path_style: location.forcePathStyle,
		credential_version: credential.version,
		credentials_present: true as const,
		status: credential.state,
		last_tested_at: credential.lastTestedAt?.toISOString() ?? null,
		last_error_code: credential.lastErrorCode,
		activated_at: credential.activatedAt?.toISOString() ?? null,
		retired_at: credential.retiredAt?.toISOString() ?? null,
		created_at: credential.createdAt.toISOString(),
		updated_at: credential.updatedAt.toISOString(),
	};
}

const getConfig = createRoute({
	operationId: "getByosConfig",
	method: "get",
	path: "/",
	tags: ["BYOS"],
	summary: "Get the staged or active organization object-storage configuration",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description: "Redacted BYOS configuration",
			content: { "application/json": { schema: ByosConfigResponse } },
		},
		404: {
			description: "Not configured",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(getConfig, async (c) => {
	const view = await getCurrentByosConfiguration(c.get("db"), c.get("orgId"));
	if (!view) {
		return c.json(
			{ error: { code: "NOT_FOUND", message: "BYOS is not configured" } },
			404,
		);
	}
	return c.json(serialize(view), 200);
});

const putConfig = createRoute({
	operationId: "putByosConfig",
	method: "put",
	path: "/",
	tags: ["BYOS"],
	summary: "Stage a new object-storage location or credential version",
	security: [{ Bearer: [] }],
	request: {
		body: { content: { "application/json": { schema: ByosConfigSpec } } },
	},
	responses: {
		200: {
			description: "Credential staged; probe it before activation",
			content: { "application/json": { schema: ByosConfigResponse } },
		},
		400: {
			description: "Unsafe endpoint",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(putConfig, async (c) => {
	const body = c.req.valid("json");
	const endpoint = body.endpoint.replace(/\/+$/, "");
	if (await isBlockedUrlWithDns(endpoint)) {
		return c.json(
			{
				error: {
					code: "UNSAFE_BYOS_ENDPOINT",
					message: "BYOS endpoint must resolve exclusively to public addresses",
				},
			},
			400,
		);
	}
	const [encryptedAccessKeyId, encryptedSecretAccessKey] = await Promise.all([
		encryptToken(body.access_key_id, c.env.ENCRYPTION_KEY),
		encryptToken(body.secret_access_key, c.env.ENCRYPTION_KEY),
	]);
	const authority = await withCredentialMutationAuthority(
		c,
		{ requireAllWorkspaceScope: true },
		(tx) =>
			stageByosConfigurationInTransaction(tx, {
				organizationId: c.get("orgId"),
				endpoint,
				bucket: body.bucket,
				region: body.region,
				keyPrefix: body.key_prefix,
				forcePathStyle: body.force_path_style,
				encryptedAccessKeyId,
				encryptedSecretAccessKey,
			}),
	);
	if (!authority.ok) {
		markMutationInputNotApplied(c);
		return c.json(
			{ error: { code: authority.code, message: authority.message } } as never,
			authority.status as never,
		);
	}
	const view = authority.value;
	return c.json(serialize(view), 200);
});

function probeErrorCode(error: unknown): string {
	if (error instanceof StorageProviderError) {
		return `provider_http_${error.status}`;
	}
	if (error instanceof StorageConfigurationError) {
		return "configuration_invalid";
	}
	return "provider_unreachable";
}

const testConfig = createRoute({
	operationId: "testByosConfig",
	method: "post",
	path: "/test",
	tags: ["BYOS"],
	summary: "Probe and atomically activate the staged credential",
	security: [{ Bearer: [] }],
	responses: {
		200: {
			description:
				"Probe completed; failed stages leave the old active version intact",
			content: { "application/json": { schema: ByosConfigResponse } },
		},
		404: {
			description: "No staged credential",
			content: { "application/json": { schema: ErrorResponse } },
		},
		409: {
			description: "A probe or configuration replacement raced this request",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(testConfig, async (c) => {
	try {
		// Reject a stale/revoked issuer before claiming a stage or touching the
		// provider, but release the database locks before remote I/O.
		const preflight = await withCredentialMutationAuthority(
			c,
			{ requireAllWorkspaceScope: true },
			async () => true,
		);
		if (!preflight.ok) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: { code: preflight.code, message: preflight.message },
				} as never,
				preflight.status as never,
			);
		}

		const probe = await probeStagedByosConfiguration(
			c.get("db"),
			c.env,
			c.get("orgId"),
			probeErrorCode,
		);
		if (probe.kind === "failed") {
			return c.json(serialize(probe.view), 200);
		}

		// The successful provider probe is only evidence for this exact claim. The
		// final activation rechecks the exact key/principal/session and commits both
		// fences together, closing revoke/demotion races during the remote probe.
		const authority = await withCredentialMutationAuthority(
			c,
			{ requireAllWorkspaceScope: true },
			(tx) => activateProbedByosCredentialInTransaction(tx, probe.claim),
		);
		if (!authority.ok) {
			return c.json(
				{
					error: { code: authority.code, message: authority.message },
				} as never,
				authority.status as never,
			);
		}
		const view = authority.value;
		return c.json(serialize(view), 200);
	} catch (error) {
		if (error instanceof ByosConfigurationNotFoundError) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: {
						code: "NOT_FOUND",
						message: "No staged BYOS credential is available to test",
					},
				},
				404,
			);
		}
		if (error instanceof ByosProbeInProgressError) {
			markMutationInputNotApplied(c);
			return c.json(
				{
					error: {
						code: "BYOS_PROBE_IN_PROGRESS",
						message: "This staged credential is already being tested",
					},
				},
				409,
			);
		}
		if (error instanceof ByosActivationConflictError) {
			return c.json(
				{
					error: {
						code: "BYOS_ACTIVATION_CONFLICT",
						message:
							"The staged credential changed while it was being tested; retry the latest stage",
					},
				},
				409,
			);
		}
		throw error;
	}
});

const deleteConfig = createRoute({
	operationId: "deleteByosConfig",
	method: "delete",
	path: "/",
	tags: ["BYOS"],
	summary: "Delete BYOS locations and credentials after their objects are gone",
	security: [{ Bearer: [] }],
	responses: {
		204: { description: "Deleted" },
		409: {
			description: "BYOS objects still exist",
			content: { "application/json": { schema: ErrorResponse } },
		},
	},
});

app.openapi(deleteConfig, async (c) => {
	try {
		await removeUnusedByosConfiguration(c.get("db"), c.get("orgId"));
		return c.body(null, 204);
	} catch (error) {
		if (error instanceof ByosObjectsExistError) {
			return c.json(
				{
					error: {
						code: "BYOS_OBJECTS_EXIST",
						message:
							"Delete all BYOS-backed media before removing its historical locations and credentials",
					},
				},
				409,
			);
		}
		throw error;
	}
});

export default app;
