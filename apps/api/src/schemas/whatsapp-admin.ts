import { z } from "@hono/zod-openapi";
import { RequiredSocialMutationHeaders } from "./social-actions";

export { RequiredSocialMutationHeaders as RequiredWhatsAppMutationHeaders };

const RelayResourceId = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9_-]+$/, "Invalid Relay resource ID");

const ProviderOpaqueId = z
	.string()
	.min(1)
	.max(512)
	.refine(
		(value) =>
			!/[\s/?#\\]/.test(value) &&
			[...value].every((character) => {
				const code = character.codePointAt(0) ?? 0;
				return code > 31 && code !== 127;
			}),
		"Provider IDs cannot contain whitespace, path separators, or controls",
	);

export const WhatsAppAccountQuery = z.object({
	account_id: RelayResourceId.describe("Relay WhatsApp account ID"),
});

const WhatsAppCapabilityState = z.enum([
	"supported",
	"requires_eligibility",
	"unavailable",
	"unverified",
	"not_yet_available",
]);

export const WhatsAppCapabilitiesResponse = z.object({
	account_id: z.string(),
	capabilities: z.object({
		groups: WhatsAppCapabilityState,
		block_users: WhatsAppCapabilityState,
		business_username: WhatsAppCapabilityState,
		template_library: WhatsAppCapabilityState,
		template_edit: WhatsAppCapabilityState,
		bsuid_webhooks: WhatsAppCapabilityState,
		bsuid_outbound: WhatsAppCapabilityState,
	}),
	requirements: z.array(z.string()),
	checked_at: z.string().datetime(),
});

export const WhatsAppGroupParams = z.object({
	group_id: ProviderOpaqueId,
});

export const WhatsAppGroupQuery = WhatsAppAccountQuery.extend({
	fields: z
		.string()
		.default("subject,description,participants,join_approval_mode")
		.refine(
			(value) =>
				value
					.split(",")
					.every((field) =>
						[
							"subject",
							"description",
							"participants",
							"join_approval_mode",
							"total_participant_count",
							"creation_timestamp",
							"suspended",
						].includes(field.trim()),
					),
			"Unsupported group field",
		),
});

export const ListWhatsAppGroupsQuery = WhatsAppAccountQuery.extend({
	limit: z.coerce.number().int().min(1).max(1024).default(25),
	after: z.string().optional(),
	before: z.string().optional(),
});

export const CreateWhatsAppGroupBody = z.object({
	account_id: RelayResourceId,
	subject: z.string().trim().min(1).max(128),
	description: z.string().max(2048).optional(),
	join_approval_mode: z
		.enum(["auto_approve", "approval_required"])
		.default("auto_approve"),
});

export const UpdateWhatsAppGroupBody = z
	.object({
		account_id: RelayResourceId,
		subject: z.string().trim().min(1).max(128).optional(),
		description: z.string().max(2048).optional(),
	})
	.refine(
		(body) => body.subject !== undefined || body.description !== undefined,
		"At least one group setting is required",
	);

export const WhatsAppGroupResponse = z.object({
	relay_group_id: z.string().optional(),
	id: z.string(),
	messaging_product: z.string().optional(),
	subject: z.string().optional(),
	description: z.string().nullable().optional(),
	join_approval_mode: z.enum(["auto_approve", "approval_required"]).optional(),
	participants: z
		.array(
			z
				.object({
					wa_id: z.string().optional(),
					user_id: z.string().optional(),
					username: z.string().optional(),
					country_code: z.string().optional(),
				})
				.refine(
					(value) => value.wa_id !== undefined || value.user_id !== undefined,
					"Participant identity is required",
				),
		)
		.optional(),
	total_participant_count: z.number().int().nonnegative().optional(),
	creation_timestamp: z.union([z.number().int(), z.string()]).optional(),
	created_at: z.union([z.number().int(), z.string()]).optional(),
	suspended: z.boolean().optional(),
	invite_link: z.string().url().optional(),
	request_id: z.string().optional(),
});

export const WhatsAppGroupListResponse = z.object({
	data: z.array(WhatsAppGroupResponse),
	paging: z.record(z.string(), z.unknown()).optional(),
});

export const JoinRequestsQuery = WhatsAppAccountQuery.extend({
	limit: z.coerce.number().int().min(1).max(1024).default(25),
	after: z.string().optional(),
	before: z.string().optional(),
});

export const JoinRequestResponse = z.object({
	join_request_id: z.string(),
	wa_id: z.string().optional(),
	user_id: z.string().optional(),
	username: z.string().optional(),
	country_code: z.string().optional(),
	creation_timestamp: z.union([z.string(), z.number().int()]),
});

export const JoinRequestListResponse = z.object({
	data: z.array(JoinRequestResponse),
	paging: z.record(z.string(), z.unknown()).optional(),
});

export const ResolveJoinRequestsBody = z.object({
	account_id: RelayResourceId,
	join_request_ids: z.array(z.string().min(1)).min(1).max(100),
});

export const RemoveGroupParticipantsBody = z.object({
	account_id: RelayResourceId,
	participants: z
		.array(z.object({ user: z.string().min(1).max(256) }))
		.min(1)
		.max(8),
});

const WhatsAppMediaReference = z
	.object({
		id: z.string().optional(),
		link: z.string().url().optional(),
	})
	.refine(
		(media) =>
			Number(media.id !== undefined) + Number(media.link !== undefined) === 1,
		"Exactly one of media.id or media.link is required",
	);

export const GroupMessageBody = z.discriminatedUnion("type", [
	z.object({
		account_id: RelayResourceId,
		type: z.literal("text"),
		text: z.object({
			body: z.string().min(1).max(4096),
			preview_url: z.boolean().optional(),
		}),
	}),
	z.object({
		account_id: RelayResourceId,
		type: z.enum(["image", "video"]),
		media: WhatsAppMediaReference.and(
			z.object({ caption: z.string().optional() }),
		),
	}),
	z.object({
		account_id: RelayResourceId,
		type: z.literal("document"),
		media: WhatsAppMediaReference.and(
			z.object({
				caption: z.string().optional(),
				filename: z.string().optional(),
			}),
		),
	}),
	z.object({
		account_id: RelayResourceId,
		type: z.literal("audio"),
		media: WhatsAppMediaReference,
	}),
	z.object({
		account_id: RelayResourceId,
		type: z.literal("template"),
		template: z.object({
			name: z.string(),
			language: z.object({ code: z.string() }),
			components: z.array(z.record(z.string(), z.unknown())).optional(),
		}),
	}),
]);

export const GroupPinBody = z
	.object({
		account_id: RelayResourceId,
		message_id: ProviderOpaqueId,
		action: z.enum(["pin", "unpin"]),
		expiration_days: z.number().int().min(1).max(30).optional(),
	})
	.refine(
		(body) =>
			(body.action === "pin" && body.expiration_days !== undefined) ||
			(body.action === "unpin" && body.expiration_days === undefined),
		"expiration_days is required for pin and must be omitted for unpin",
	);

export const InviteLinkResponse = z.object({
	messaging_product: z.string().optional(),
	invite_link: z.string().url(),
});

export const BlockUsersQuery = WhatsAppAccountQuery.extend({
	limit: z.coerce.number().int().min(1).max(1000).default(100),
	after: z.string().optional(),
	before: z.string().optional(),
});

export const BlockUsersBody = z.object({
	account_id: RelayResourceId,
	users: z
		.array(z.object({ user: z.string().min(1).max(256) }))
		.min(1)
		.max(1000),
});

export const BlockUserResult = z.object({
	input: z.string().optional(),
	wa_id: z.string().optional(),
	user_id: z.string().optional(),
	message: z.string().optional(),
	code: z.number().int().optional(),
	details: z.string().optional(),
});

export const BlockUsersResponse = z.object({
	block_users: z.object({
		added_users: z.array(BlockUserResult).optional(),
		removed_users: z.array(BlockUserResult).optional(),
		failed_users: z.array(BlockUserResult).optional(),
	}),
});

export const BlockedUsersResponse = z.object({
	data: z.array(
		z.object({
			wa_id: z.string().optional(),
			user_id: z.string().optional(),
			username: z.string().optional(),
			country_code: z.string().optional(),
		}),
	),
	paging: z.record(z.string(), z.unknown()).optional(),
});

export const BusinessUsernameResponse = z.object({
	username: z.string().optional(),
	status: z.enum(["ACTIVE", "RESERVED"]).optional(),
	requested_username: z.string().optional(),
	success: z.boolean().optional(),
});

export const SetBusinessUsernameBody = z.object({
	account_id: RelayResourceId,
	username: z
		.string()
		.min(3)
		.max(35)
		.regex(/^[a-z0-9._]+$/i)
		.refine((value) => /[a-z]/i.test(value), "Username must include a letter")
		.refine(
			(value) => !value.startsWith(".") && !value.endsWith("."),
			"Username cannot start or end with a period",
		)
		.refine(
			(value) => !value.includes(".."),
			"Username cannot contain consecutive periods",
		)
		.refine(
			(value) => !value.toLowerCase().startsWith("www"),
			"Username cannot start with www",
		)
		.refine(
			(value) => !/\.[a-z]{2,}$/i.test(value),
			"Username cannot end with a domain suffix",
		),
});

export const UsernameSuggestionsResponse = z.object({
	data: z.array(z.object({ username_suggestions: z.array(z.string()) })),
});

export const TemplateLibraryQuery = WhatsAppAccountQuery.extend({
	name_or_content: z.string().max(512).optional(),
	category: z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"]).optional(),
	topic: z.string().max(128).optional(),
	usecase: z.string().max(128).optional(),
	industry: z.string().max(128).optional(),
	language: z.string().max(32).optional(),
	limit: z.coerce.number().int().min(1).max(250).optional(),
	after: z.string().optional(),
	before: z.string().optional(),
});

export const TemplateLibraryResponse = z.object({
	data: z.array(z.record(z.string(), z.unknown())),
	paging: z.record(z.string(), z.unknown()).optional(),
});

export const CreateTemplateFromLibraryBody = z.object({
	account_id: RelayResourceId,
	name: z
		.string()
		.min(1)
		.max(512)
		.regex(/^[a-z0-9_]+$/),
	language: z.string().min(2).max(32),
	category: z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"]),
	library_template_name: z.string().min(1).max(512),
	library_template_button_inputs: z
		.array(z.record(z.string(), z.unknown()))
		.optional(),
	library_template_body_inputs: z
		.array(z.record(z.string(), z.unknown()))
		.optional(),
});

export const EditTemplateBody = z
	.object({
		account_id: RelayResourceId,
		components: z.array(z.record(z.string(), z.unknown())).optional(),
		category: z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"]).optional(),
		parameter_format: z.enum(["POSITIONAL", "NAMED"]).optional(),
		message_send_ttl_seconds: z.number().int().positive().optional(),
		cta_url_link_tracking_opted_out: z.boolean().optional(),
	})
	.refine(
		(body) => Object.keys(body).some((key) => key !== "account_id"),
		"At least one editable template field is required",
	);

export const TemplateIdParams = z.object({
	template_id: ProviderOpaqueId,
});

export const MetaSuccessResponse = z.object({
	success: z.boolean().optional(),
	id: z.string().optional(),
	status: z.string().optional(),
	request_id: z.string().optional(),
	messaging_product: z.string().optional(),
	messages: z.array(z.object({ id: z.string() })).optional(),
});
