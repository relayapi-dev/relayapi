import {
	automationBindings,
	createDb,
	type Database,
	socialAccounts,
} from "@relayapi/db";
import { and, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { GRAPH_BASE } from "../../config/api-versions";
import { decryptAccountToken } from "../../lib/account-token-crypto";
import {
	AUTOMATION_BINDING_MUTATION,
	exponentialBackoffSeconds,
} from "../../lib/async-policy";
import {
	BindingConfigByType,
	getBindingConfigChannelError,
	isBindingTypeSupportedOnChannel,
} from "../../schemas/automation-bindings";
import type { Env } from "../../types";
import type { SyncAutomationBindingMessage } from "../external-post-sync/types";

type ProviderBindingType = "get_started" | "main_menu" | "ice_breaker";

export async function enqueueAutomationBindingSync(
	db: Database,
	env: Env,
	binding: Pick<
		typeof automationBindings.$inferSelect,
		"id" | "organizationId" | "syncRevision"
	>,
): Promise<void> {
	const now = new Date();
	const leaseExpiresAt = new Date(
		now.getTime() + AUTOMATION_BINDING_MUTATION.leaseSeconds * 1000,
	);
	const [claimed] = await db
		.update(automationBindings)
		.set({
			syncDispatchGeneration: sql`${automationBindings.syncDispatchGeneration} + 1`,
			syncLeaseExpiresAt: leaseExpiresAt,
			syncStartedAt: null,
			updatedAt: now,
		})
		.where(
			and(
				eq(automationBindings.id, binding.id),
				eq(automationBindings.organizationId, binding.organizationId),
				eq(automationBindings.syncRevision, binding.syncRevision),
				sql`${automationBindings.lastSyncedRevision} < ${automationBindings.syncRevision}`,
				or(
					isNull(automationBindings.syncNextAttemptAt),
					lte(automationBindings.syncNextAttemptAt, now),
				),
				or(
					isNull(automationBindings.syncLeaseExpiresAt),
					lte(automationBindings.syncLeaseExpiresAt, now),
				),
				or(
					isNull(automationBindings.syncErrorClass),
					eq(automationBindings.syncErrorClass, "transient"),
				),
				sql`${automationBindings.syncAttempts} < ${AUTOMATION_BINDING_MUTATION.maxAutomaticAttempts}`,
			),
		)
		.returning({
			dispatchGeneration: automationBindings.syncDispatchGeneration,
		});
	if (!claimed) return;

	try {
		await env.SYNC_QUEUE.send({
			type: "sync_automation_binding",
			binding_id: binding.id,
			organization_id: binding.organizationId,
			revision: binding.syncRevision,
			dispatch_generation: claimed.dispatchGeneration,
		} satisfies SyncAutomationBindingMessage);
	} catch (error) {
		await db
			.update(automationBindings)
			.set({
				syncLeaseExpiresAt: null,
				syncStartedAt: null,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(automationBindings.id, binding.id),
					eq(automationBindings.syncRevision, binding.syncRevision),
					eq(
						automationBindings.syncDispatchGeneration,
						claimed.dispatchGeneration,
					),
					isNull(automationBindings.syncStartedAt),
				),
			);
		throw error;
	}
}

export async function reconcileAutomationBindingSyncs(
	env: Env,
): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const now = new Date();
	const leaseExpiresAt = new Date(
		now.getTime() + AUTOMATION_BINDING_MUTATION.leaseSeconds * 1000,
	);
	const rows = await db
		.update(automationBindings)
		.set({
			syncDispatchGeneration: sql`${automationBindings.syncDispatchGeneration} + 1`,
			syncLeaseExpiresAt: leaseExpiresAt,
			syncStartedAt: null,
			updatedAt: now,
		})
		.where(
			and(
				sql`${automationBindings.bindingType} IN ('get_started', 'main_menu', 'ice_breaker')`,
				sql`${automationBindings.lastSyncedRevision} < ${automationBindings.syncRevision}`,
				or(
					isNull(automationBindings.syncNextAttemptAt),
					lte(automationBindings.syncNextAttemptAt, now),
				),
				or(
					isNull(automationBindings.syncLeaseExpiresAt),
					lte(automationBindings.syncLeaseExpiresAt, now),
				),
				or(
					isNull(automationBindings.syncErrorClass),
					eq(automationBindings.syncErrorClass, "transient"),
				),
				sql`${automationBindings.syncAttempts} < ${AUTOMATION_BINDING_MUTATION.maxAutomaticAttempts}`,
				sql`${automationBindings.id} IN (
					SELECT ranked.id
					FROM (
						SELECT
							b.id,
							b.organization_id,
							b.sync_next_attempt_at,
							row_number() OVER (
								PARTITION BY b.organization_id
								ORDER BY b.sync_next_attempt_at NULLS FIRST, b.id
							) AS tenant_rank
						FROM automation_bindings b
						WHERE b.binding_type IN ('get_started', 'main_menu', 'ice_breaker')
							AND b.last_synced_revision < b.sync_revision
							AND (
								b.sync_next_attempt_at IS NULL
								OR b.sync_next_attempt_at <= ${now}
							)
							AND (
								b.sync_lease_expires_at IS NULL
								OR b.sync_lease_expires_at <= ${now}
							)
							AND (
								b.sync_error_class IS NULL
								OR b.sync_error_class = 'transient'
							)
							AND b.sync_attempts < ${AUTOMATION_BINDING_MUTATION.maxAutomaticAttempts}
					) ranked
					WHERE ranked.tenant_rank <= ${AUTOMATION_BINDING_MUTATION.maxClaimsPerTenant}
					ORDER BY
						ranked.tenant_rank,
						ranked.sync_next_attempt_at NULLS FIRST,
						ranked.organization_id,
						ranked.id
					LIMIT ${AUTOMATION_BINDING_MUTATION.maxClaimsPerRun}
				)`,
			),
		)
		.returning({
			id: automationBindings.id,
			organizationId: automationBindings.organizationId,
			syncRevision: automationBindings.syncRevision,
			dispatchGeneration: automationBindings.syncDispatchGeneration,
		});
	if (rows.length === 0) return 0;
	try {
		await env.SYNC_QUEUE.sendBatch(
			rows.map((row) => ({
				body: {
					type: "sync_automation_binding" as const,
					binding_id: row.id,
					organization_id: row.organizationId,
					revision: row.syncRevision,
					dispatch_generation: row.dispatchGeneration,
				},
			})),
		);
	} catch (error) {
		const ids = rows.map((row) => row.id);
		await db
			.update(automationBindings)
			.set({
				syncLeaseExpiresAt: null,
				syncStartedAt: null,
				updatedAt: new Date(),
			})
			.where(
				and(
					inArray(automationBindings.id, ids),
					isNull(automationBindings.syncStartedAt),
				),
			);
		throw error;
	}
	return rows.length;
}

export function metaBindingField(type: ProviderBindingType): string {
	if (type === "get_started") return "get_started";
	if (type === "main_menu") return "persistent_menu";
	return "ice_breakers";
}

export function buildMetaBindingPayload(
	type: ProviderBindingType,
	channel: string,
	config: Record<string, unknown>,
): Record<string, unknown> {
	if (type === "get_started") {
		return { get_started: { payload: config.payload } };
	}
	if (type === "ice_breaker") {
		return {
			platform: "instagram",
			ice_breakers: config.questions,
		};
	}
	const items =
		(config.items as Array<Record<string, unknown>> | undefined) ?? [];
	const instagram = channel === "instagram";
	return {
		...(instagram ? { platform: "instagram" } : {}),
		persistent_menu: [
			{
				locale: "default",
				...(instagram
					? {}
					: {
							composer_input_disabled: config.composer_input_disabled === true,
						}),
				call_to_actions: items.map((item) =>
					item.action === "url"
						? {
								type: "web_url",
								title: item.label,
								url: item.url,
								...(instagram ? {} : { webview_height_ratio: "full" }),
							}
						: {
								type: "postback",
								title: item.label,
								payload: item.payload,
							},
				),
			},
		],
	};
}

export function buildMetaBindingRequest(
	type: ProviderBindingType,
	channel: string,
	endpoint: string,
	config: Record<string, unknown>,
	desiredActive: boolean,
): {
	endpoint: string;
	method: "POST" | "DELETE";
	body?: Record<string, unknown>;
} {
	if (desiredActive) {
		return {
			endpoint,
			method: "POST",
			body: buildMetaBindingPayload(type, channel, config),
		};
	}

	const field = metaBindingField(type);
	if (channel === "instagram") {
		// Meta's Instagram Messenger Profile examples carry DELETE fields in the
		// query string, unlike the Facebook Messenger example's JSON body.
		const url = new URL(endpoint);
		url.searchParams.set("fields", `['${field}']`);
		return { endpoint: url.toString(), method: "DELETE" };
	}
	return {
		endpoint,
		method: "DELETE",
		body: { fields: [field] },
	};
}

async function recordSyncFailure(
	db: Database,
	message: SyncAutomationBindingMessage,
	claimStartedAt: Date,
	attempts: number,
	error: unknown,
	errorClass: "transient" | "permanent" | "unknown",
	requestMayHaveBeenSentAt?: Date,
): Promise<void> {
	const failedAt = new Date();
	const delaySeconds = exponentialBackoffSeconds(
		attempts,
		AUTOMATION_BINDING_MUTATION.retry,
		`${message.binding_id}:${message.revision}:${attempts}`,
	);
	const budgetExhausted =
		attempts >= AUTOMATION_BINDING_MUTATION.maxAutomaticAttempts;
	const detail = error instanceof Error ? error.message : String(error);
	await db
		.update(automationBindings)
		.set({
			status: "sync_failed",
			syncLeaseExpiresAt: null,
			syncStartedAt: null,
			syncNextAttemptAt:
				errorClass === "transient" && !budgetExhausted
					? new Date(failedAt.getTime() + delaySeconds * 1000)
					: null,
			syncRequestMayHaveBeenSentAt:
				errorClass === "unknown"
					? (requestMayHaveBeenSentAt ?? failedAt)
					: null,
			syncError: (budgetExhausted && errorClass === "transient"
				? `Automatic binding-sync attempt budget reached; ${detail}`
				: detail
			).slice(0, 1_000),
			syncErrorAt: failedAt,
			syncErrorClass:
				budgetExhausted && errorClass === "transient"
					? "permanent"
					: errorClass,
			updatedAt: failedAt,
		})
		.where(
			and(
				eq(automationBindings.id, message.binding_id),
				eq(automationBindings.organizationId, message.organization_id),
				eq(automationBindings.syncRevision, message.revision),
				eq(
					automationBindings.syncDispatchGeneration,
					message.dispatch_generation,
				),
				eq(automationBindings.syncStartedAt, claimStartedAt),
			),
		);
}

export async function syncAutomationBinding(
	env: Env,
	message: SyncAutomationBindingMessage,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const claimStartedAt = new Date();
	const [claim] = await db
		.update(automationBindings)
		.set({
			syncStartedAt: claimStartedAt,
			syncAttempts: sql`${automationBindings.syncAttempts} + 1`,
			updatedAt: claimStartedAt,
		})
		.where(
			and(
				eq(automationBindings.id, message.binding_id),
				eq(automationBindings.organizationId, message.organization_id),
				eq(automationBindings.syncRevision, message.revision),
				eq(
					automationBindings.syncDispatchGeneration,
					message.dispatch_generation,
				),
				isNull(automationBindings.syncStartedAt),
				gt(automationBindings.syncLeaseExpiresAt, claimStartedAt),
				sql`${automationBindings.syncAttempts} < ${AUTOMATION_BINDING_MUTATION.maxAutomaticAttempts}`,
				or(
					isNull(automationBindings.syncErrorClass),
					eq(automationBindings.syncErrorClass, "transient"),
				),
			),
		)
		.returning({ attempts: automationBindings.syncAttempts });
	if (!claim) return;

	const [row] = await db
		.select({ binding: automationBindings, account: socialAccounts })
		.from(automationBindings)
		.innerJoin(
			socialAccounts,
			and(
				eq(socialAccounts.id, automationBindings.socialAccountId),
				eq(socialAccounts.organizationId, automationBindings.organizationId),
				sql`${socialAccounts.workspaceId} IS NOT DISTINCT FROM ${automationBindings.workspaceId}`,
			),
		)
		.where(
			and(
				eq(automationBindings.id, message.binding_id),
				eq(automationBindings.organizationId, message.organization_id),
			),
		)
		.limit(1);
	if (!row || row.binding.syncRevision !== message.revision) {
		await recordSyncFailure(
			db,
			message,
			claimStartedAt,
			claim.attempts,
			new Error("Binding account relationship no longer resolves"),
			"permanent",
		);
		return;
	}
	if (
		row.binding.bindingType !== "get_started" &&
		row.binding.bindingType !== "main_menu" &&
		row.binding.bindingType !== "ice_breaker"
	) {
		await recordSyncFailure(
			db,
			message,
			claimStartedAt,
			claim.attempts,
			new Error(`Unsupported provider binding type ${row.binding.bindingType}`),
			"permanent",
		);
		return;
	}
	if (
		row.binding.desiredActive &&
		row.binding.bindingType === "main_menu" &&
		row.binding.channel === "facebook"
	) {
		const getStarted = await db.query.automationBindings.findFirst({
			where: and(
				eq(automationBindings.organizationId, row.binding.organizationId),
				eq(automationBindings.socialAccountId, row.binding.socialAccountId),
				eq(automationBindings.bindingType, "get_started"),
				eq(automationBindings.desiredActive, true),
				eq(automationBindings.status, "active"),
				sql`${automationBindings.lastSyncedRevision} = ${automationBindings.syncRevision}`,
			),
		});
		if (!getStarted) {
			const error = new Error(
				"Facebook main menu requires an active, synchronized Get Started binding",
			);
			await recordSyncFailure(
				db,
				message,
				claimStartedAt,
				claim.attempts,
				error,
				"transient",
			);
			return;
		}
	}
	if (!row.account.accessToken || row.account.lifecycleStatus !== "active") {
		const error = new Error(
			"binding sync account is inactive or missing a token",
		);
		await recordSyncFailure(
			db,
			message,
			claimStartedAt,
			claim.attempts,
			error,
			"permanent",
		);
		return;
	}
	let token: string | null;
	try {
		token = await decryptAccountToken(
			row.account.accessToken,
			env.ENCRYPTION_KEY,
			row.account.id,
			"access_token",
		);
	} catch (error) {
		await recordSyncFailure(
			db,
			message,
			claimStartedAt,
			claim.attempts,
			error,
			"permanent",
		);
		return;
	}
	if (!token) {
		const error = new Error("binding sync token could not be decrypted");
		await recordSyncFailure(
			db,
			message,
			claimStartedAt,
			claim.attempts,
			error,
			"permanent",
		);
		return;
	}

	const base =
		row.binding.channel === "instagram" && token.startsWith("IGAA")
			? GRAPH_BASE.instagram
			: GRAPH_BASE.facebook;
	const endpoint = `${base}/${row.account.platformAccountId}/messenger_profile`;
	const bindingType = row.binding.bindingType as ProviderBindingType;
	if (!isBindingTypeSupportedOnChannel(bindingType, row.binding.channel)) {
		const error = new Error(
			`${bindingType} is not supported on ${row.binding.channel}`,
		);
		await recordSyncFailure(
			db,
			message,
			claimStartedAt,
			claim.attempts,
			error,
			"permanent",
		);
		return;
	}
	let providerConfig: Record<string, unknown> = {};
	if (row.binding.desiredActive) {
		const parsedConfig = BindingConfigByType[bindingType]?.safeParse(
			row.binding.config ?? {},
		);
		if (!parsedConfig?.success) {
			const error = new Error(
				`binding config is invalid: ${parsedConfig?.error.issues.map((issue) => issue.message).join(", ") ?? "missing schema"}`,
			);
			await recordSyncFailure(
				db,
				message,
				claimStartedAt,
				claim.attempts,
				error,
				"permanent",
			);
			return;
		}
		providerConfig = parsedConfig.data as Record<string, unknown>;
		const channelConfigError = getBindingConfigChannelError(
			bindingType,
			row.binding.channel,
			providerConfig,
		);
		if (channelConfigError) {
			const error = new Error(channelConfigError);
			await recordSyncFailure(
				db,
				message,
				claimStartedAt,
				claim.attempts,
				error,
				"permanent",
			);
			return;
		}
		if (
			bindingType === "main_menu" &&
			(providerConfig as { items: unknown[] }).items.length > 20
		) {
			const error = new Error(
				"Messenger persistent menus support at most 20 items",
			);
			await recordSyncFailure(
				db,
				message,
				claimStartedAt,
				claim.attempts,
				error,
				"permanent",
			);
			return;
		}
	}
	const fetchImpl =
		(env as unknown as { bindingSyncFetch?: typeof fetch }).bindingSyncFetch ??
		globalThis.fetch;
	const request = buildMetaBindingRequest(
		bindingType,
		row.binding.channel,
		endpoint,
		providerConfig,
		row.binding.desiredActive,
	);

	const boundaryAt = new Date();
	const [boundaryMarked] = await db
		.update(automationBindings)
		.set({
			syncRequestMayHaveBeenSentAt: boundaryAt,
			updatedAt: boundaryAt,
		})
		.where(
			and(
				eq(automationBindings.id, message.binding_id),
				eq(automationBindings.organizationId, message.organization_id),
				eq(automationBindings.syncRevision, message.revision),
				eq(
					automationBindings.syncDispatchGeneration,
					message.dispatch_generation,
				),
				eq(automationBindings.syncStartedAt, claimStartedAt),
			),
		)
		.returning({ id: automationBindings.id });
	if (!boundaryMarked) return;

	let response: Response;
	try {
		response = await fetchImpl(request.endpoint, {
			method: request.method,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: request.body ? JSON.stringify(request.body) : undefined,
		});
	} catch (error) {
		// A transport failure after the durable boundary cannot prove whether the
		// remote mutation happened. Stop automatic retries for this revision.
		await recordSyncFailure(
			db,
			message,
			claimStartedAt,
			claim.attempts,
			error,
			"unknown",
			boundaryAt,
		);
		return;
	}

	const detail = await response.text();
	if (!response.ok) {
		const error = new Error(
			`Meta messenger_profile sync failed (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ""}`,
		);
		const errorClass =
			response.status === 408 ||
			response.status === 425 ||
			response.status === 429
				? "transient"
				: response.status >= 500
					? "unknown"
					: "permanent";
		await recordSyncFailure(
			db,
			message,
			claimStartedAt,
			claim.attempts,
			error,
			errorClass,
			boundaryAt,
		);
		return;
	}

	const completedAt = new Date();
	const terminalPatch = {
		lastSyncedAt: completedAt,
		lastSyncedRevision: message.revision,
		syncLeaseExpiresAt: null,
		syncStartedAt: null,
		syncRequestMayHaveBeenSentAt: null,
		syncNextAttemptAt: null,
		syncError: null,
		syncErrorClass: null,
		syncErrorAt: null,
		updatedAt: completedAt,
	};
	if (row.binding.desiredActive) {
		await db
			.update(automationBindings)
			.set({ ...terminalPatch, status: "active" })
			.where(
				and(
					eq(automationBindings.id, message.binding_id),
					eq(automationBindings.organizationId, message.organization_id),
					eq(automationBindings.syncRevision, message.revision),
					eq(
						automationBindings.syncDispatchGeneration,
						message.dispatch_generation,
					),
					eq(automationBindings.syncStartedAt, claimStartedAt),
				),
			);
	} else if (row.binding.deleteAfterSync) {
		// A provider deletion is acknowledged before the local row is removed.
		// The revision/generation guard prevents an old DELETE delivery from
		// erasing a row re-enabled while the request was in flight.
		await db
			.delete(automationBindings)
			.where(
				and(
					eq(automationBindings.id, message.binding_id),
					eq(automationBindings.organizationId, message.organization_id),
					eq(automationBindings.syncRevision, message.revision),
					eq(
						automationBindings.syncDispatchGeneration,
						message.dispatch_generation,
					),
					eq(automationBindings.syncStartedAt, claimStartedAt),
					eq(automationBindings.desiredActive, false),
				),
			);
	} else {
		await db
			.update(automationBindings)
			.set({ ...terminalPatch, status: "paused" })
			.where(
				and(
					eq(automationBindings.id, message.binding_id),
					eq(automationBindings.organizationId, message.organization_id),
					eq(automationBindings.syncRevision, message.revision),
					eq(
						automationBindings.syncDispatchGeneration,
						message.dispatch_generation,
					),
					eq(automationBindings.syncStartedAt, claimStartedAt),
					eq(automationBindings.desiredActive, false),
					eq(automationBindings.deleteAfterSync, false),
				),
			);
	}
}
