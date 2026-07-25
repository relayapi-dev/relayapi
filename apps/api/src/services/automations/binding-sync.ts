import {
	automationBindings,
	createDb,
	type Database,
	socialAccounts,
} from "@relayapi/db";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { GRAPH_BASE } from "../../config/api-versions";
import { decryptAccountToken } from "../../lib/account-token-crypto";
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
	await env.SYNC_QUEUE.send({
		type: "sync_automation_binding",
		binding_id: binding.id,
		organization_id: binding.organizationId,
		revision: binding.syncRevision,
	} satisfies SyncAutomationBindingMessage);
	await db
		.update(automationBindings)
		.set({ lastEnqueuedAt: new Date() })
		.where(
			and(
				eq(automationBindings.id, binding.id),
				eq(automationBindings.syncRevision, binding.syncRevision),
			),
		);
}

export async function reconcileAutomationBindingSyncs(
	env: Env,
): Promise<number> {
	const db = createDb(env.HYPERDRIVE.connectionString);
	const rows = await db
		.select({
			id: automationBindings.id,
			organizationId: automationBindings.organizationId,
			syncRevision: automationBindings.syncRevision,
		})
		.from(automationBindings)
		.where(
			and(
				sql`${automationBindings.bindingType} IN ('get_started', 'main_menu', 'ice_breaker')`,
				sql`${automationBindings.lastSyncedRevision} < ${automationBindings.syncRevision}`,
				or(
					isNull(automationBindings.lastEnqueuedAt),
					// Retry every unacknowledged revision after its backoff window. Do
					// not require a newer row update: a queue message can be accepted and
					// then exhausted/lost without touching `updated_at`, and that is the
					// exact failure mode this reconciler must repair.
					sql`${automationBindings.lastEnqueuedAt} < now() - (
						INTERVAL '30 seconds' * power(2, LEAST(${automationBindings.syncAttempts}, 7))
					)`,
				),
			),
		)
		.limit(100);
	if (rows.length === 0) return 0;
	await env.SYNC_QUEUE.sendBatch(
		rows.map((row) => ({
			body: {
				type: "sync_automation_binding" as const,
				binding_id: row.id,
				organization_id: row.organizationId,
				revision: row.syncRevision,
			},
		})),
	);
	const enqueuedAt = new Date();
	for (const row of rows) {
		await db
			.update(automationBindings)
			.set({ lastEnqueuedAt: enqueuedAt })
			.where(
				and(
					eq(automationBindings.id, row.id),
					eq(automationBindings.syncRevision, row.syncRevision),
				),
			);
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
	error: unknown,
): Promise<void> {
	await db
		.update(automationBindings)
		.set({
			status: "sync_failed",
			syncAttempts: sql`${automationBindings.syncAttempts} + 1`,
			syncError:
				error instanceof Error ? error.message.slice(0, 1_000) : String(error),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(automationBindings.id, message.binding_id),
				eq(automationBindings.syncRevision, message.revision),
			),
		);
}

export async function syncAutomationBinding(
	env: Env,
	message: SyncAutomationBindingMessage,
): Promise<void> {
	const db = createDb(env.HYPERDRIVE.connectionString);
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
	if (!row || row.binding.syncRevision !== message.revision) return;
	if (
		row.binding.bindingType !== "get_started" &&
		row.binding.bindingType !== "main_menu" &&
		row.binding.bindingType !== "ice_breaker"
	) {
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
			await recordSyncFailure(db, message, error);
			throw error;
		}
	}
	if (!row.account.accessToken || row.account.lifecycleStatus !== "active") {
		const error = new Error(
			"binding sync account is inactive or missing a token",
		);
		await recordSyncFailure(db, message, error);
		throw error;
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
		await recordSyncFailure(db, message, error);
		throw error;
	}
	if (!token) {
		const error = new Error("binding sync token could not be decrypted");
		await recordSyncFailure(db, message, error);
		throw error;
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
		await recordSyncFailure(db, message, error);
		throw error;
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
			await recordSyncFailure(db, message, error);
			throw error;
		}
		providerConfig = parsedConfig.data as Record<string, unknown>;
		const channelConfigError = getBindingConfigChannelError(
			bindingType,
			row.binding.channel,
			providerConfig,
		);
		if (channelConfigError) {
			const error = new Error(channelConfigError);
			await recordSyncFailure(db, message, error);
			throw error;
		}
		if (
			bindingType === "main_menu" &&
			(providerConfig as { items: unknown[] }).items.length > 20
		) {
			const error = new Error(
				"Messenger persistent menus support at most 20 items",
			);
			await recordSyncFailure(db, message, error);
			throw error;
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

	try {
		const response = await fetchImpl(request.endpoint, {
			method: request.method,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: request.body ? JSON.stringify(request.body) : undefined,
		});
		const detail = await response.text();
		if (!response.ok) {
			throw new Error(
				`Meta messenger_profile sync failed (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ""}`,
			);
		}
		if (row.binding.desiredActive) {
			await db
				.update(automationBindings)
				.set({
					status: "active",
					lastSyncedAt: new Date(),
					lastSyncedRevision: message.revision,
					syncAttempts: sql`${automationBindings.syncAttempts} + 1`,
					syncError: null,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(automationBindings.id, message.binding_id),
						eq(automationBindings.syncRevision, message.revision),
					),
				);
		} else if (row.binding.deleteAfterSync) {
			// A provider deletion is acknowledged before the local row is removed.
			// The revision guard prevents an old DELETE delivery from erasing a row
			// that was re-enabled or edited while the request was in flight.
			await db
				.delete(automationBindings)
				.where(
					and(
						eq(automationBindings.id, message.binding_id),
						eq(automationBindings.syncRevision, message.revision),
						eq(automationBindings.desiredActive, false),
					),
				);
		} else {
			await db
				.update(automationBindings)
				.set({
					status: "paused",
					lastSyncedAt: new Date(),
					lastSyncedRevision: message.revision,
					syncAttempts: sql`${automationBindings.syncAttempts} + 1`,
					syncError: null,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(automationBindings.id, message.binding_id),
						eq(automationBindings.syncRevision, message.revision),
						eq(automationBindings.desiredActive, false),
						eq(automationBindings.deleteAfterSync, false),
					),
				);
		}
	} catch (error) {
		await recordSyncFailure(db, message, error);
		throw error;
	}
}
