import { GRAPH_BASE } from "../config/api-versions";
import { readProviderJson, readProviderText } from "../lib/provider-response";
import {
	SocialProviderActionError,
	type SocialProviderActionResult,
} from "./social-provider-actions";

const PROVIDER_TIMEOUT_MS = 15_000;

export type WhatsAppAdminAccount = {
	phoneNumberId: string;
	wabaId: string | null;
	accessToken: string;
};

export type WhatsAppGroupProviderRecord = {
	id: string;
	subject?: string;
	description?: string | null;
	join_approval_mode?: "auto_approve" | "approval_required";
	participants?: Array<{
		wa_id?: string;
		user_id?: string;
		username?: string;
		country_code?: string;
	}>;
	total_participant_count?: number;
	creation_timestamp?: number | string;
	created_at?: number | string;
	suspended?: boolean;
	request_id?: string;
	[key: string]: unknown;
};

export type WhatsAppCapabilityState =
	| "supported"
	| "requires_eligibility"
	| "unavailable"
	| "unverified"
	| "not_yet_available";

function isDefinitive(status: number): boolean {
	return status >= 400 && status < 500 && ![408, 425, 429].includes(status);
}

async function waFetch(
	path: string,
	account: WhatsAppAdminAccount,
	init: RequestInit = {},
): Promise<Response> {
	let response: Response;
	try {
		response = await fetch(`${GRAPH_BASE.facebook}${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${account.accessToken}`,
				...(init.body ? { "Content-Type": "application/json" } : {}),
				...init.headers,
			},
			signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
		});
	} catch {
		throw new SocialProviderActionError(
			"WHATSAPP_OUTCOME_UNKNOWN",
			"WhatsApp transport failed after dispatch; outcome is unknown",
		);
	}
	return response;
}

async function waJson<T extends Record<string, unknown>>(
	path: string,
	account: WhatsAppAdminAccount,
	init: RequestInit = {},
	code = "WHATSAPP_REQUEST_REJECTED",
): Promise<T> {
	const response = await waFetch(path, account, init);
	if (!response.ok) {
		// Consume bounded diagnostics without persisting echoed message content,
		// invite links, phone numbers, usernames, or BSUIDs in operation errors.
		await readProviderText(response).catch(() => "");
		throw new SocialProviderActionError(
			code,
			`WhatsApp rejected the request: HTTP ${response.status}`,
			{ status: response.status, definitive: isDefinitive(response.status) },
		);
	}
	if (response.status === 204) return {} as T;
	return readProviderJson<T>(response);
}

function jsonBody(value: Record<string, unknown>): Pick<RequestInit, "body"> {
	return { body: JSON.stringify(value) };
}

function confirmationFailure(
	payload: Record<string, unknown>,
	rejectionCode: string,
	missingConfirmationMessage: string,
): never {
	const explicitlyRejected = payload.success === false;
	throw new SocialProviderActionError(
		explicitlyRejected ? rejectionCode : "WHATSAPP_PROVIDER_RESPONSE_INVALID",
		explicitlyRejected
			? "WhatsApp explicitly rejected the request"
			: missingConfirmationMessage,
		{
			...(explicitlyRejected ? { status: 400, definitive: true } : {}),
		},
	);
}

function requireConfirmation(
	payload: Record<string, unknown>,
	confirmed: boolean,
	rejectionCode: string,
	missingConfirmationMessage: string,
): void {
	// A logical rejection inside an HTTP 2xx response is still a rejection. It
	// must not be projected as a completed mutation merely because transport
	// succeeded. Conversely, an unrecognised 2xx body is outcome-unknown rather
	// than definitively unapplied, so recovery will not blindly replay it.
	if (payload.success === false || !confirmed) {
		confirmationFailure(payload, rejectionCode, missingConfirmationMessage);
	}
}

function explicitSuccessAcknowledgement(
	payload: Record<string, unknown>,
	rejectionCode: string,
	missingConfirmationMessage: string,
): Record<string, unknown> {
	requireConfirmation(
		payload,
		payload.success === true,
		rejectionCode,
		missingConfirmationMessage,
	);
	return { acknowledged: true, success: true };
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value
		: undefined;
}

function responseMessageId(
	payload: Record<string, unknown>,
): string | undefined {
	const messages = Array.isArray(payload.messages)
		? (payload.messages as Array<{ id?: unknown }>)
		: [];
	return nonEmptyString(messages[0]?.id);
}

function partialMutationResult(
	payload: Record<string, unknown>,
	options: {
		action: string;
		appliedField: string;
		failedField: string;
		rejectionCode: string;
	},
): Record<string, unknown> {
	const applied = payload[options.appliedField];
	const failed = payload[options.failedField];
	requireConfirmation(
		payload,
		payload.success === true || Array.isArray(applied) || Array.isArray(failed),
		options.rejectionCode,
		"WhatsApp did not return a participant-operation confirmation",
	);
	const appliedCount = Array.isArray(applied) ? applied.length : 0;
	const failedCount = Array.isArray(failed) ? failed.length : 0;
	return {
		action: options.action,
		applied_count: appliedCount,
		failed_count: failedCount,
		partial: failedCount > 0 && appliedCount > 0,
	};
}

async function probeWhatsAppReadCapability(
	account: WhatsAppAdminAccount,
	path: string,
): Promise<WhatsAppCapabilityState> {
	try {
		const response = await waFetch(path, account);
		await readProviderText(response).catch(() => "");
		if (response.ok) return "supported";
		if ([401, 403, 404].includes(response.status)) return "unavailable";
		// A generic 400 is not proof of OBA/coexistence eligibility. Likewise,
		// transient provider/rate-limit errors cannot prove account support.
		return "unverified";
	} catch {
		return "unverified";
	}
}

export async function probeWhatsAppAdminCapabilities(
	account: WhatsAppAdminAccount,
): Promise<{
	groups: WhatsAppCapabilityState;
	block_users: WhatsAppCapabilityState;
	business_username: WhatsAppCapabilityState;
	template_library: WhatsAppCapabilityState;
	template_edit: WhatsAppCapabilityState;
	bsuid_webhooks: WhatsAppCapabilityState;
	bsuid_outbound: WhatsAppCapabilityState;
}> {
	const [groups, blockUsers, businessUsername, templateLibrary] =
		await Promise.all([
			probeWhatsAppReadCapability(
				account,
				`/${encodeURIComponent(account.phoneNumberId)}/groups?limit=1`,
			),
			probeWhatsAppReadCapability(
				account,
				`/${encodeURIComponent(account.phoneNumberId)}/block_users?limit=1`,
			),
			probeWhatsAppReadCapability(
				account,
				`/${encodeURIComponent(account.phoneNumberId)}/username_suggestions`,
			),
			probeWhatsAppReadCapability(account, "/message_template_library?limit=1"),
		]);
	const wabaEligibility: WhatsAppCapabilityState = account.wabaId
		? "requires_eligibility"
		: "unavailable";
	return {
		groups,
		block_users: blockUsers,
		business_username: businessUsername,
		template_library: templateLibrary,
		// These write/webhook features have no non-mutating endpoint that proves
		// the exact account's entitlement and app configuration.
		template_edit: wabaEligibility,
		bsuid_webhooks: wabaEligibility,
		bsuid_outbound: "requires_eligibility",
	};
}

export async function probeWhatsAppGroups(
	account: WhatsAppAdminAccount,
): Promise<WhatsAppCapabilityState> {
	return probeWhatsAppReadCapability(
		account,
		`/${encodeURIComponent(account.phoneNumberId)}/groups?limit=1`,
	);
}

export async function listWhatsAppGroups(
	account: WhatsAppAdminAccount,
	query: { limit: number; after?: string; before?: string },
): Promise<{
	groups: WhatsAppGroupProviderRecord[];
	paging?: Record<string, unknown>;
}> {
	const params = new URLSearchParams({ limit: String(query.limit) });
	if (query.after) params.set("after", query.after);
	if (query.before) params.set("before", query.before);
	const payload = await waJson<{
		data?:
			| { groups?: WhatsAppGroupProviderRecord[] }
			| WhatsAppGroupProviderRecord[];
		paging?: Record<string, unknown>;
	}>(
		`/${encodeURIComponent(account.phoneNumberId)}/groups?${params.toString()}`,
		account,
		{},
		"WHATSAPP_GROUPS_UNAVAILABLE",
	);
	const groups = Array.isArray(payload.data)
		? payload.data
		: (payload.data?.groups ?? []);
	return { groups, ...(payload.paging ? { paging: payload.paging } : {}) };
}

export async function getWhatsAppGroup(
	account: WhatsAppAdminAccount,
	providerGroupId: string,
	fields: string,
): Promise<WhatsAppGroupProviderRecord> {
	return waJson<WhatsAppGroupProviderRecord>(
		`/${encodeURIComponent(providerGroupId)}?fields=${encodeURIComponent(fields)}`,
		account,
		{},
		"WHATSAPP_GROUP_NOT_FOUND",
	);
}

export async function createWhatsAppGroup(
	account: WhatsAppAdminAccount,
	body: {
		subject: string;
		description?: string;
		join_approval_mode: "auto_approve" | "approval_required";
	},
): Promise<SocialProviderActionResult> {
	const payload = await waJson<Record<string, unknown>>(
		`/${encodeURIComponent(account.phoneNumberId)}/groups`,
		account,
		{
			method: "POST",
			...jsonBody({ messaging_product: "whatsapp", ...body }),
		},
		"WHATSAPP_GROUP_CREATE_REJECTED",
	);
	const providerId =
		nonEmptyString(payload.id) ?? nonEmptyString(payload.group_id);
	const requestId = nonEmptyString(payload.request_id);
	requireConfirmation(
		payload,
		Boolean(providerId || requestId),
		"WHATSAPP_GROUP_CREATE_REJECTED",
		"WhatsApp acknowledged group creation without returning a group or request ID",
	);
	return {
		...(providerId ? { providerId } : {}),
		...(requestId ? { providerOperationId: requestId } : {}),
		providerResult: { acknowledged: true },
	};
}

export async function updateWhatsAppGroup(
	account: WhatsAppAdminAccount,
	providerGroupId: string,
	body: { subject?: string; description?: string },
): Promise<SocialProviderActionResult> {
	const payload = await waJson<Record<string, unknown>>(
		`/${encodeURIComponent(providerGroupId)}`,
		account,
		{
			method: "POST",
			...jsonBody({ messaging_product: "whatsapp", ...body }),
		},
		"WHATSAPP_GROUP_UPDATE_REJECTED",
	);
	return {
		providerId: providerGroupId,
		providerResult: explicitSuccessAcknowledgement(
			payload,
			"WHATSAPP_GROUP_UPDATE_REJECTED",
			"WhatsApp did not confirm the group update",
		),
	};
}

export async function deleteWhatsAppGroup(
	account: WhatsAppAdminAccount,
	providerGroupId: string,
): Promise<SocialProviderActionResult> {
	const payload = await waJson<Record<string, unknown>>(
		`/${encodeURIComponent(providerGroupId)}`,
		account,
		{ method: "DELETE" },
		"WHATSAPP_GROUP_DELETE_REJECTED",
	);
	return {
		providerId: providerGroupId,
		providerResult: explicitSuccessAcknowledgement(
			payload,
			"WHATSAPP_GROUP_DELETE_REJECTED",
			"WhatsApp did not confirm the group deletion",
		),
	};
}

export async function getWhatsAppGroupInviteLink(
	account: WhatsAppAdminAccount,
	providerGroupId: string,
): Promise<{ messaging_product?: string; invite_link: string }> {
	return waJson<{ messaging_product?: string; invite_link: string }>(
		`/${encodeURIComponent(providerGroupId)}/invite_link`,
		account,
		{},
		"WHATSAPP_INVITE_LINK_REJECTED",
	);
}

export async function resetWhatsAppGroupInviteLink(
	account: WhatsAppAdminAccount,
	providerGroupId: string,
): Promise<SocialProviderActionResult> {
	const payload = await waJson<Record<string, unknown>>(
		`/${encodeURIComponent(providerGroupId)}/invite_link`,
		account,
		{
			method: "POST",
			...jsonBody({ messaging_product: "whatsapp" }),
		},
		"WHATSAPP_INVITE_LINK_RESET_REJECTED",
	);
	const inviteLink = nonEmptyString(payload.invite_link);
	requireConfirmation(
		payload,
		Boolean(inviteLink),
		"WHATSAPP_INVITE_LINK_RESET_REJECTED",
		"WhatsApp did not return the rotated group invite link",
	);
	return {
		providerId: providerGroupId,
		providerResult: {
			messaging_product: payload.messaging_product,
			invite_link_rotated: true,
		},
		transient: { invite_link: inviteLink },
	};
}

export async function listWhatsAppJoinRequests(
	account: WhatsAppAdminAccount,
	providerGroupId: string,
	query: { limit: number; after?: string; before?: string },
): Promise<Record<string, unknown>> {
	const params = new URLSearchParams({ limit: String(query.limit) });
	if (query.after) params.set("after", query.after);
	if (query.before) params.set("before", query.before);
	return waJson(
		`/${encodeURIComponent(providerGroupId)}/join_requests?${params.toString()}`,
		account,
		{},
		"WHATSAPP_JOIN_REQUESTS_REJECTED",
	);
}

export async function resolveWhatsAppJoinRequests(
	account: WhatsAppAdminAccount,
	providerGroupId: string,
	joinRequestIds: string[],
	action: "approve" | "reject",
): Promise<SocialProviderActionResult> {
	const payload = await waJson<Record<string, unknown>>(
		`/${encodeURIComponent(providerGroupId)}/join_requests`,
		account,
		{
			method: action === "approve" ? "POST" : "DELETE",
			...jsonBody({
				messaging_product: "whatsapp",
				join_requests: joinRequestIds,
			}),
		},
		`WHATSAPP_JOIN_${action.toUpperCase()}_REJECTED`,
	);
	return {
		providerId: providerGroupId,
		providerResult: partialMutationResult(payload, {
			action,
			appliedField:
				action === "approve"
					? "approved_join_requests"
					: "rejected_join_requests",
			failedField: "failed_join_requests",
			rejectionCode: `WHATSAPP_JOIN_${action.toUpperCase()}_REJECTED`,
		}),
	};
}

export async function removeWhatsAppGroupParticipants(
	account: WhatsAppAdminAccount,
	providerGroupId: string,
	participants: Array<{ user: string }>,
): Promise<SocialProviderActionResult> {
	const payload = await waJson<Record<string, unknown>>(
		`/${encodeURIComponent(providerGroupId)}/participants`,
		account,
		{
			method: "DELETE",
			...jsonBody({ messaging_product: "whatsapp", participants }),
		},
		"WHATSAPP_PARTICIPANT_REMOVE_REJECTED",
	);
	return {
		providerId: providerGroupId,
		providerResult: partialMutationResult(payload, {
			action: "remove",
			appliedField: "removed_participants",
			failedField: "failed_participants",
			rejectionCode: "WHATSAPP_PARTICIPANT_REMOVE_REJECTED",
		}),
	};
}

export async function sendWhatsAppGroupMessage(
	account: WhatsAppAdminAccount,
	providerGroupId: string,
	body:
		| { type: "text"; text: Record<string, unknown> }
		| {
				type: "image" | "video" | "document" | "audio";
				media: Record<string, unknown>;
		  }
		| { type: "template"; template: Record<string, unknown> },
): Promise<SocialProviderActionResult> {
	const content =
		body.type === "text"
			? { text: body.text }
			: body.type === "template"
				? { template: body.template }
				: { [body.type]: body.media };
	const payload = await waJson<Record<string, unknown>>(
		`/${encodeURIComponent(account.phoneNumberId)}/messages`,
		account,
		{
			method: "POST",
			...jsonBody({
				messaging_product: "whatsapp",
				recipient_type: "group",
				to: providerGroupId,
				type: body.type,
				...content,
			}),
		},
		"WHATSAPP_GROUP_MESSAGE_REJECTED",
	);
	const messageId = responseMessageId(payload);
	requireConfirmation(
		payload,
		Boolean(messageId),
		"WHATSAPP_GROUP_MESSAGE_REJECTED",
		"WhatsApp acknowledged the group message without returning a message ID",
	);
	return {
		providerId: messageId,
		providerResult: { acknowledged: true },
	};
}

export async function pinWhatsAppGroupMessage(
	account: WhatsAppAdminAccount,
	providerGroupId: string,
	body: {
		message_id: string;
		action: "pin" | "unpin";
		expiration_days?: number;
	},
): Promise<SocialProviderActionResult> {
	const payload = await waJson<Record<string, unknown>>(
		`/${encodeURIComponent(account.phoneNumberId)}/messages`,
		account,
		{
			method: "POST",
			...jsonBody({
				messaging_product: "whatsapp",
				recipient_type: "group",
				to: providerGroupId,
				type: "pin",
				pin: {
					type: body.action,
					message_id: body.message_id,
					...(body.expiration_days !== undefined
						? { expiration_days: body.expiration_days }
						: {}),
				},
			}),
		},
		"WHATSAPP_GROUP_PIN_REJECTED",
	);
	requireConfirmation(
		payload,
		Boolean(responseMessageId(payload)),
		"WHATSAPP_GROUP_PIN_REJECTED",
		"WhatsApp acknowledged the pin operation without returning a message ID",
	);
	return {
		providerId: body.message_id,
		providerResult: { acknowledged: true },
	};
}

export async function listBlockedWhatsAppUsers(
	account: WhatsAppAdminAccount,
	query: { limit: number; after?: string; before?: string },
): Promise<Record<string, unknown>> {
	const params = new URLSearchParams({ limit: String(query.limit) });
	if (query.after) params.set("after", query.after);
	if (query.before) params.set("before", query.before);
	return waJson(
		`/${encodeURIComponent(account.phoneNumberId)}/block_users?${params.toString()}`,
		account,
		{},
		"WHATSAPP_BLOCK_LIST_REJECTED",
	);
}

export async function mutateBlockedWhatsAppUsers(
	account: WhatsAppAdminAccount,
	users: Array<{ user: string }>,
	action: "block" | "unblock",
): Promise<SocialProviderActionResult> {
	const response = await waFetch(
		`/${encodeURIComponent(account.phoneNumberId)}/block_users`,
		account,
		{
			method: action === "block" ? "POST" : "DELETE",
			...jsonBody({ messaging_product: "whatsapp", block_users: users }),
		},
	);
	let payload: Record<string, unknown>;
	try {
		payload = await readProviderJson<Record<string, unknown>>(response);
	} catch {
		if (response.ok) {
			throw new SocialProviderActionError(
				"WHATSAPP_PROVIDER_RESPONSE_INVALID",
				"WhatsApp did not return a block-list mutation confirmation",
			);
		}
		payload = {};
	}
	const outcomes = payload.block_users as
		| { added_users?: unknown[]; removed_users?: unknown[] }
		| undefined;
	const applied =
		action === "block" ? outcomes?.added_users : outcomes?.removed_users;
	const failedUsers = (outcomes as { failed_users?: unknown[] } | undefined)
		?.failed_users;
	if (!response.ok && (!Array.isArray(applied) || applied.length === 0)) {
		throw new SocialProviderActionError(
			"WHATSAPP_BLOCK_MUTATION_REJECTED",
			`WhatsApp rejected the ${action} request: HTTP ${response.status}`,
			{ status: response.status, definitive: isDefinitive(response.status) },
		);
	}
	if (response.ok) {
		requireConfirmation(
			payload,
			payload.success === true ||
				Array.isArray(applied) ||
				Array.isArray(failedUsers),
			"WHATSAPP_BLOCK_MUTATION_REJECTED",
			"WhatsApp did not return a block-list mutation confirmation",
		);
	}
	const failed = Array.isArray(failedUsers) ? failedUsers : [];
	return {
		// Do not retain phone numbers/BSUIDs from the provider echo in the durable
		// operation payload. Callers already know their inputs; counts and error
		// objects are sufficient to reconcile partial success.
		providerResult: {
			action,
			applied_count: Array.isArray(applied) ? applied.length : 0,
			failed_count: failed.length,
			partial: failed.length > 0,
		},
	};
}

export async function getWhatsAppBusinessUsername(
	account: WhatsAppAdminAccount,
): Promise<Record<string, unknown>> {
	return waJson(
		`/${encodeURIComponent(account.phoneNumberId)}/username`,
		account,
		{},
		"WHATSAPP_USERNAME_REJECTED",
	);
}

export async function setWhatsAppBusinessUsername(
	account: WhatsAppAdminAccount,
	body: { username: string },
): Promise<SocialProviderActionResult> {
	const payload = await waJson<Record<string, unknown>>(
		`/${encodeURIComponent(account.phoneNumberId)}/username`,
		account,
		{ method: "POST", ...jsonBody(body) },
		"WHATSAPP_USERNAME_SET_REJECTED",
	);
	return {
		providerResult: explicitSuccessAcknowledgement(
			payload,
			"WHATSAPP_USERNAME_SET_REJECTED",
			"WhatsApp did not confirm the business username update",
		),
	};
}

export async function deleteWhatsAppBusinessUsername(
	account: WhatsAppAdminAccount,
): Promise<SocialProviderActionResult> {
	const payload = await waJson<Record<string, unknown>>(
		`/${encodeURIComponent(account.phoneNumberId)}/username`,
		account,
		{ method: "DELETE" },
		"WHATSAPP_USERNAME_DELETE_REJECTED",
	);
	return {
		providerResult: explicitSuccessAcknowledgement(
			payload,
			"WHATSAPP_USERNAME_DELETE_REJECTED",
			"WhatsApp did not confirm the business username deletion",
		),
	};
}

export async function getWhatsAppUsernameSuggestions(
	account: WhatsAppAdminAccount,
): Promise<Record<string, unknown>> {
	return waJson(
		`/${encodeURIComponent(account.phoneNumberId)}/username_suggestions`,
		account,
		{},
		"WHATSAPP_USERNAME_SUGGESTIONS_REJECTED",
	);
}

function requireWaba(account: WhatsAppAdminAccount): string {
	if (!account.wabaId) {
		throw new SocialProviderActionError(
			"WHATSAPP_WABA_REQUIRED",
			"The connected account does not contain a WhatsApp Business Account ID",
			{ status: 400, definitive: true },
		);
	}
	return account.wabaId;
}

export async function listWhatsAppTemplateLibrary(
	account: WhatsAppAdminAccount,
	query: Record<string, string | number | undefined>,
): Promise<Record<string, unknown>> {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value !== undefined) params.set(key, String(value));
	}
	return waJson(
		`/message_template_library${params.size ? `?${params.toString()}` : ""}`,
		account,
		{},
		"WHATSAPP_TEMPLATE_LIBRARY_REJECTED",
	);
}

export async function createWhatsAppTemplateFromLibrary(
	account: WhatsAppAdminAccount,
	body: Record<string, unknown>,
): Promise<SocialProviderActionResult> {
	const payload = await waJson<Record<string, unknown>>(
		`/${encodeURIComponent(requireWaba(account))}/message_templates`,
		account,
		{ method: "POST", ...jsonBody(body) },
		"WHATSAPP_TEMPLATE_CREATE_REJECTED",
	);
	const templateId = nonEmptyString(payload.id);
	requireConfirmation(
		payload,
		Boolean(templateId),
		"WHATSAPP_TEMPLATE_CREATE_REJECTED",
		"WhatsApp acknowledged template creation without returning a template ID",
	);
	return {
		providerId: templateId,
		providerResult: { acknowledged: true },
	};
}

async function assertTemplateOwnership(
	account: WhatsAppAdminAccount,
	templateId: string,
): Promise<void> {
	const payload = await waJson<{
		id?: string;
		whatsapp_business_account?: { id?: string } | string;
	}>(
		`/${encodeURIComponent(templateId)}?fields=id,whatsapp_business_account`,
		account,
		{},
		"WHATSAPP_TEMPLATE_NOT_FOUND",
	);
	const owner =
		typeof payload.whatsapp_business_account === "string"
			? payload.whatsapp_business_account
			: payload.whatsapp_business_account?.id;
	if (!owner || owner !== requireWaba(account)) {
		throw new SocialProviderActionError(
			"WHATSAPP_TEMPLATE_NOT_FOUND",
			"The template does not belong to the connected WhatsApp account",
			{ status: 404, definitive: true },
		);
	}
}

export async function editWhatsAppTemplate(
	account: WhatsAppAdminAccount,
	templateId: string,
	body: Record<string, unknown>,
): Promise<SocialProviderActionResult> {
	await assertTemplateOwnership(account, templateId);
	const payload = await waJson<Record<string, unknown>>(
		`/${encodeURIComponent(templateId)}`,
		account,
		{ method: "POST", ...jsonBody(body) },
		"WHATSAPP_TEMPLATE_EDIT_REJECTED",
	);
	return {
		providerId: templateId,
		providerResult: explicitSuccessAcknowledgement(
			payload,
			"WHATSAPP_TEMPLATE_EDIT_REJECTED",
			"WhatsApp did not confirm the template edit",
		),
	};
}
