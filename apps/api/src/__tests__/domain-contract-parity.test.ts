import { describe, expect, it } from "bun:test";
import {
	AD_AUDIENCE_TYPES,
	AI_KNOWLEDGE_SOURCE_TYPES,
	AUTOMATION_BINDING_TYPES,
	AUTOMATION_ENTRYPOINT_KINDS,
	CROSS_POST_ACTION_TYPES,
	CUSTOM_FIELD_TYPES,
	IDEA_MEDIA_TYPES,
	INBOX_CONVERSATION_TYPES,
	INBOX_DIRECTIONS,
	INBOX_NOTE_ACTOR_TYPES,
	INVITE_TOKEN_ROLES,
} from "@relayapi/db";
import { CreateAudienceBody } from "../schemas/ads";
import { KnowledgeDocumentResponse } from "../schemas/ai-knowledge";
import {
	BindingConfigByType,
	BindingTypeSchema,
} from "../schemas/automation-bindings";
import {
	EntrypointConfigByKind,
	EntrypointKindSchema,
} from "../schemas/automation-entrypoints";
import { CrossPostActionTypeEnum } from "../schemas/cross-post-actions";
import { CustomFieldType } from "../schemas/custom-fields";
import { IdeaMediaResponse } from "../schemas/ideas";
import {
	ConversationTypeEnum,
	InboxDirectionEnum,
} from "../schemas/inbox-feed";
import { InboxNote } from "../schemas/inbox-notes";
import { InviteTokenRoleSchema } from "../schemas/invite";

describe("durable domain API parity", () => {
	it("keeps public Zod enums equal to the canonical database domains", () => {
		expect(CustomFieldType.options).toEqual([...CUSTOM_FIELD_TYPES]);
		expect(EntrypointKindSchema.options).toEqual([
			...AUTOMATION_ENTRYPOINT_KINDS,
		]);
		expect(BindingTypeSchema.options).toEqual([...AUTOMATION_BINDING_TYPES]);
		expect(InviteTokenRoleSchema.options).toEqual([...INVITE_TOKEN_ROLES]);
		expect(InboxDirectionEnum.options).toEqual([...INBOX_DIRECTIONS]);
		expect(ConversationTypeEnum.options).toEqual([...INBOX_CONVERSATION_TYPES]);
		expect(CrossPostActionTypeEnum.options).toEqual([
			...CROSS_POST_ACTION_TYPES,
		]);
		expect(CreateAudienceBody.shape.type.options).toEqual([
			...AD_AUDIENCE_TYPES,
		]);
		expect(IdeaMediaResponse.shape.type.options).toEqual([...IDEA_MEDIA_TYPES]);
		expect(KnowledgeDocumentResponse.shape.source_type.options).toEqual([
			...AI_KNOWLEDGE_SOURCE_TYPES,
		]);
		expect(InboxNote.shape.actor_type.options).toEqual([
			...INBOX_NOTE_ACTOR_TYPES,
		]);
	});

	it("requires exhaustive config validation for every authorable automation kind", () => {
		expect(Object.keys(EntrypointConfigByKind).sort()).toEqual(
			[...AUTOMATION_ENTRYPOINT_KINDS].sort(),
		);
		expect(Object.keys(BindingConfigByType).sort()).toEqual(
			[...AUTOMATION_BINDING_TYPES].sort(),
		);
	});

	it("does not preserve the retired conversation_starter compatibility value", () => {
		expect(BindingTypeSchema.safeParse("conversation_starter").success).toBe(
			false,
		);
	});
});
