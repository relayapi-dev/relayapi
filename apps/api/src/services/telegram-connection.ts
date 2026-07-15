import {
	type Database,
	organization,
	socialAccounts,
	telegramConnectionChallenges,
} from "@relayapi/db";
import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { parseApiKeyWorkspaceScope } from "../lib/api-key-workspace-scope";
import { readResponseBytes } from "../lib/fetch-public-url";
import { validatePersistedOperationalScope } from "../lib/request-access";
import { canAccessWorkspaceScope } from "../lib/workspace-scope";
import type { Env } from "../types";
import {
	dispatchWebhookEvent,
	enqueuePersistedWebhookEvent,
	persistWebhookEventInTransaction,
} from "./webhook-delivery";

const CHALLENGE_TTL_MS = 15 * 60 * 1000;
const TELEGRAM_RESPONSE_LIMIT = 64 * 1024;
const CHALLENGE_CLEANUP_BATCH_SIZE = 1_000;
const CHALLENGE_CLEANUP_MAX_BATCHES = 10;
const CHALLENGE_PATTERN = /^(RLAY-[A-F0-9]{12})\s+(@[A-Za-z0-9_]{5,32})$/;

type TelegramChat = {
	id: number;
	type: string;
	title?: string;
	username?: string;
};

type TelegramChatMember = { status: string };

type BotApiResponse<T> = {
	ok: boolean;
	result?: T;
};

export async function telegramChallengeId(code: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`telegram-connect\0${code}`),
	);
	return `tgc_${Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("")}`;
}

export function createTelegramChallengeCode(): string {
	const entropy = crypto.getRandomValues(new Uint8Array(6));
	return `RLAY-${Array.from(entropy, (byte) =>
		byte.toString(16).padStart(2, "0"),
	)
		.join("")
		.toUpperCase()}`;
}

export async function issueTelegramConnectionChallenge(
	db: Database,
	organizationId: string,
	apiKeyId: string,
	initialWorkspaceScope: "all" | string[],
	workspaceId: string | null,
): Promise<{ code: string; expiresAt: Date }> {
	const code = createTelegramChallengeCode();
	const id = await telegramChallengeId(code);
	const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
	await db.insert(telegramConnectionChallenges).values({
		id,
		organizationId,
		apiKeyId,
		initialWorkspaceScope,
		workspaceId,
		expiresAt,
	});
	return { code, expiresAt };
}

export async function readTelegramConnectionChallenge(
	db: Database,
	organizationId: string,
	code: string,
): Promise<{
	status: "pending" | "connected" | "expired";
	chatId?: string;
	chatTitle?: string;
	workspaceId?: string | null;
	apiKeyId?: string;
}> {
	const id = await telegramChallengeId(code);
	const [challenge] = await db
		.select()
		.from(telegramConnectionChallenges)
		.where(
			and(
				eq(telegramConnectionChallenges.id, id),
				eq(telegramConnectionChallenges.organizationId, organizationId),
			),
		)
		.limit(1);
	if (!challenge || challenge.expiresAt <= new Date())
		return { status: "expired" };
	if (challenge.status !== "connected") {
		return {
			status: "pending",
			workspaceId: challenge.workspaceId,
			apiKeyId: challenge.apiKeyId,
		};
	}
	return {
		status: "connected",
		chatId: challenge.chatId ?? undefined,
		chatTitle: challenge.chatTitle ?? undefined,
		workspaceId: challenge.workspaceId,
		apiKeyId: challenge.apiKeyId,
	};
}

/**
 * Remove expired bot capabilities in bounded, due-time-ordered batches. These
 * rows are short-lived workflow state, not durable connection history; cleanup
 * also ensures stale workspace foreign keys cannot obstruct later erasure.
 */
export async function cleanupExpiredTelegramConnectionChallenges(
	env: Env,
	limit = CHALLENGE_CLEANUP_BATCH_SIZE,
): Promise<number> {
	const db = (await import("@relayapi/db")).createDb(
		env.HYPERDRIVE.connectionString,
	);
	const boundedLimit = Math.max(
		1,
		Math.min(limit, CHALLENGE_CLEANUP_BATCH_SIZE),
	);
	const now = new Date();
	let deletedCount = 0;
	for (let batch = 0; batch < CHALLENGE_CLEANUP_MAX_BATCHES; batch++) {
		const expired = await db
			.select({ id: telegramConnectionChallenges.id })
			.from(telegramConnectionChallenges)
			.where(lte(telegramConnectionChallenges.expiresAt, now))
			.orderBy(
				asc(telegramConnectionChallenges.expiresAt),
				asc(telegramConnectionChallenges.id),
			)
			.limit(boundedLimit);
		if (expired.length === 0) break;

		const deleted = await db
			.delete(telegramConnectionChallenges)
			.where(
				inArray(
					telegramConnectionChallenges.id,
					expired.map((row) => row.id),
				),
			)
			.returning({ id: telegramConnectionChallenges.id });
		deletedCount += deleted.length;
		if (expired.length < boundedLimit) break;
	}
	return deletedCount;
}

async function callTelegramBotApi<T>(
	env: Env,
	method: "getChat" | "getChatMember",
	payload: Record<string, string | number>,
): Promise<T | null> {
	const token = env.TELEGRAM_BOT_TOKEN;
	if (!token) throw new Error("Telegram bot connection is not configured");
	const response = await fetch(
		`https://api.telegram.org/bot${token}/${method}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(10_000),
		},
	);
	if (response.status === 429 || response.status >= 500) {
		await response.body?.cancel();
		throw new Error(
			`Telegram Bot API temporarily unavailable (${response.status})`,
		);
	}
	const bytes = await readResponseBytes(response, TELEGRAM_RESPONSE_LIMIT);
	let parsed: BotApiResponse<T>;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes)) as BotApiResponse<T>;
	} catch {
		throw new Error("Telegram Bot API returned an invalid response");
	}
	return response.ok && parsed.ok && parsed.result ? parsed.result : null;
}

async function dispatchConnectedOccurrence(
	env: Env,
	db: Database,
	challengeId: string,
	account: typeof socialAccounts.$inferSelect,
): Promise<void> {
	await dispatchWebhookEvent(
		env,
		db,
		account.organizationId,
		"account.connected",
		{
			account_id: account.id,
			platform: account.platform,
			username: account.username,
			display_name: account.displayName,
		},
		{ occurrenceId: `telegram-challenge:${challengeId}:account-connected` },
	);
}

/**
 * Consume a private bot challenge only after Telegram confirms that the sender
 * administers the target chat. The challenge claim and account upsert commit in
 * one SQL transaction, so a crash cannot consume the code without the account.
 */
export async function processTelegramConnectionChallenge(
	env: Env,
	message: {
		text?: string;
		chat: { type: string };
		from: { id: number };
	},
): Promise<boolean> {
	const match = message.text?.trim().match(CHALLENGE_PATTERN);
	if (!match || message.chat.type !== "private") return false;
	const code = match[1];
	const chatReference = match[2];
	if (!code || !chatReference) return true;

	const db = (await import("@relayapi/db")).createDb(
		env.HYPERDRIVE.connectionString,
	);
	const challengeId = await telegramChallengeId(code);
	const [challenge] = await db
		.select()
		.from(telegramConnectionChallenges)
		.where(eq(telegramConnectionChallenges.id, challengeId))
		.limit(1);
	if (!challenge || challenge.expiresAt <= new Date()) return true;

	if (challenge.status === "connected" && challenge.accountId) {
		const [account] = await db
			.select()
			.from(socialAccounts)
			.where(eq(socialAccounts.id, challenge.accountId))
			.limit(1);
		if (account)
			await dispatchConnectedOccurrence(env, db, challengeId, account);
		return true;
	}

	const chat = await callTelegramBotApi<TelegramChat>(env, "getChat", {
		chat_id: chatReference,
	});
	if (!chat || !["channel", "group", "supergroup"].includes(chat.type)) {
		return true;
	}
	const member = await callTelegramBotApi<TelegramChatMember>(
		env,
		"getChatMember",
		{ chat_id: chat.id, user_id: message.from.id },
	);
	if (!member || !["creator", "administrator"].includes(member.status)) {
		return true;
	}

	const now = new Date();
	const outcome = await db.transaction(async (tx) => {
		// Tenant deletion takes an exclusive lock on this row before it snapshots
		// accounts. Taking the matching shared lock first makes the account upsert
		// and deletion deterministic without holding a transaction across Telegram
		// API calls.
		const [activeOrganization] = await tx
			.select({ id: organization.id })
			.from(organization)
			.where(
				and(
					eq(organization.id, challenge.organizationId),
					eq(organization.lifecycleStatus, "active"),
				),
			)
			.for("key share")
			.limit(1);
		if (!activeOrganization) return null;
		const initialWorkspaceScope = parseApiKeyWorkspaceScope({
			workspace_scope: challenge.initialWorkspaceScope,
		});
		if (initialWorkspaceScope === null) return null;
		const validation = await validatePersistedOperationalScope(
			tx as unknown as Database,
			{
				apiKeyId: challenge.apiKeyId,
				organizationId: challenge.organizationId,
				workspaceId: challenge.workspaceId,
				resourceName: "connected account",
			},
		);
		if (!validation.ok) return null;

		const [existingAccount] = await tx
			.select({
				id: socialAccounts.id,
				workspaceId: socialAccounts.workspaceId,
			})
			.from(socialAccounts)
			.where(
				and(
					eq(socialAccounts.organizationId, challenge.organizationId),
					eq(socialAccounts.platform, "telegram"),
					eq(socialAccounts.platformAccountId, String(chat.id)),
				),
			)
			.for("update")
			.limit(1);
		if (
			existingAccount &&
			challenge.workspaceId !== null &&
			existingAccount.workspaceId !== challenge.workspaceId
		) {
			return null;
		}
		const effectiveWorkspaceId =
			challenge.workspaceId === null && existingAccount
				? existingAccount.workspaceId
				: challenge.workspaceId;
		if (
			!canAccessWorkspaceScope(initialWorkspaceScope, effectiveWorkspaceId) ||
			!canAccessWorkspaceScope(
				validation.authorization.workspaceScope,
				effectiveWorkspaceId,
			)
		) {
			return null;
		}

		const [claimed] = await tx
			.update(telegramConnectionChallenges)
			.set({ status: "processing" })
			.where(
				and(
					eq(telegramConnectionChallenges.id, challengeId),
					eq(
						telegramConnectionChallenges.organizationId,
						activeOrganization.id,
					),
					eq(telegramConnectionChallenges.status, "pending"),
					gt(telegramConnectionChallenges.expiresAt, now),
				),
			)
			.returning({
				organizationId: telegramConnectionChallenges.organizationId,
				workspaceId: telegramConnectionChallenges.workspaceId,
			});
		if (!claimed) return null;

		const [savedAccount] = await tx
			.insert(socialAccounts)
			.values({
				organizationId: claimed.organizationId,
				workspaceId: effectiveWorkspaceId,
				platform: "telegram",
				platformAccountId: String(chat.id),
				username: chat.username ?? null,
				displayName: chat.title ?? chat.username ?? `Telegram ${chat.id}`,
			})
			.onConflictDoUpdate({
				target: [
					socialAccounts.organizationId,
					socialAccounts.platform,
					socialAccounts.platformAccountId,
				],
				set: {
					username: chat.username ?? null,
					displayName: chat.title ?? chat.username ?? `Telegram ${chat.id}`,
					lifecycleStatus: "active",
					updatedAt: now,
				},
				setWhere: sql`${socialAccounts.workspaceId} IS NOT DISTINCT FROM ${effectiveWorkspaceId}`,
			})
			.returning();
		if (!savedAccount) throw new Error("Telegram account could not be saved");
		await tx
			.update(telegramConnectionChallenges)
			.set({
				status: "connected",
				workspaceId: effectiveWorkspaceId,
				chatId: String(chat.id),
				chatTitle: chat.title ?? chat.username ?? null,
				accountId: savedAccount.id,
				completedAt: now,
			})
			.where(
				and(
					eq(telegramConnectionChallenges.id, challengeId),
					eq(telegramConnectionChallenges.status, "processing"),
				),
			);
		const persisted = await persistWebhookEventInTransaction(
			tx,
			savedAccount.organizationId,
			"account.connected",
			{
				account_id: savedAccount.id,
				platform: savedAccount.platform,
				username: savedAccount.username,
				display_name: savedAccount.displayName,
			},
			{ occurrenceId: `telegram-challenge:${challengeId}:account-connected` },
		);
		return { account: savedAccount, persisted };
	});
	if (outcome) {
		await enqueuePersistedWebhookEvent(env, db, outcome.persisted);
	}
	return true;
}
